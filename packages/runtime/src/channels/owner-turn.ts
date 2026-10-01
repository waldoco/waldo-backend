import { ownerContextHandler } from '../tools/live/owner-context';
import {
  acceptTrustedInvocation, buildSessionState, ConversationTree, OPENAI_GPT_6_LUNA_MODEL, OPENAI_PROVIDER, routingPolicySchema, WALDO_CHAT_MODEL,
  type ConnectIntent, type LLMTool, type LLMToolTurn, type ModelName,
} from '@waldo/contracts';
import type { ConversationModelMessage } from '@waldo/contracts';
import { PROBE_STRIPPED_TOOLS } from './probe-turn';
import { runToolLoop, type LoopExit } from '../conversation/tool-loop';
import { delegateTaskHandler, runChildLoop, SUBAGENT_SYSTEM_PROMPT, withDelegation } from '../conversation/subagent';
import { inMemoryToolOutputStore } from '../conversation/tool-output-store';
import { readToolOutputHandler } from '../tools/read-tool-output';
import { getContextHandler, type OwnerClock } from '../tools/live/get-context';
import { localTrustedBriefScheduleInput, localTrustedBriefTurnSnapshot, resolveRunLoopAdapters } from '../run-loop/adapters';
import type { ContextHealthMaterial } from '../context-composer/types';
import { JoinedConversationPath } from '../conversation/joined-path';
import { OpenAIResponsesAdapter } from '../llm/openai';
import { InMemoryCircuitBreaker, RuntimeLLMProvider, type LLMGatewayAdapter } from '../llm/provider';
import { CLINICAL_REDIRECT, messagingSystemPrompt, ownerClockLine } from '../prompt/messaging-behavior';
import { DAY_PLAN_INSTRUCTION, DAY_PLAN_SCHEMA } from '../prompt/day-cards';
import { applyClaimOps, applyPromotion, CLAIM_OPS_SCHEMA, exchangeInput, MEMORY_INSTRUCTION, memoryPrompt, turnMemoryPrompt, MIGRATION_INSTRUCTION, NIGHTLY_MEMORY_INSTRUCTION, nightlyInput, PROMOTION_INSTRUCTION, PROMOTION_SCHEMA, promotionInput, type ClaimStore } from '../memory/claims';
import { restoreConversation, type ConversationStore } from './conversation-store';
import { reactionInstruction, reactionSchema } from './reactions';
import type { TurnLogEntry, TurnTimer } from './owner-turn-types';
import type { OwnerResponder } from './owner-turn-envelope';
import type { DispatchToolOptions, ToolDispatcherContext } from '../tools/dispatcher';
import type { LLMAttachment } from '@waldo/contracts';
import { STOPPED_REPLY, turnControl } from './turn-control';
import type { RunBook } from './background-runs';
import { toolOutputLedger } from '../conversation/tool-output-ledger';

// The owner's approval line (owner direction 2026-09-27): first-party state - his own memory,
// tasks, sheets, drafts - proceeds without a per-action card. Anything that could reach another
// person or an outside service (messages, browser submits, MCP calls) needs his clear yes, so
// until those flows carry a proposal card the gate halts them with a typed reason instead of
// executing silently. send_message and call_mcp_tool carry cards now (their handlers propose to
// the approval desk and never execute directly), so they pass this gate; execute_action and
// delete/restore_message still halt. The taint gate still runs before this and blocks
// external-tainted privileged calls outright.
const EXTERNAL_REACH_TOOLS = new Set(['execute_action', 'delete_message', 'restore_message']);
export const ownerToolApproval = ({ tool }: { tool: string }): boolean => !EXTERNAL_REACH_TOOLS.has(tool);

// Session canaries are per-runtime tripwires: random 16-hex tokens derived when the owner
// runtime (DO session) boots, checked by the scribe against every fragment bound for the
// provider, and rotated when the runtime restarts. Hardcoding them in the repo made them
// public (useless as tripwires) and a false-positive source for any tool output quoting it.
const newSessionCanaryTokens = (): string[] =>
  Array.from({ length: 3 }, () => crypto.randomUUID().replaceAll('-', '').slice(0, 16));
const MAX_TOOL_ROUNDS = 25;
const CLINICAL_FALLBACK = {
  text: "I can't advise on that one. A doctor or pharmacist can. If this is an emergency or you feel unsafe, call your local emergency number now.",
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, latency_ms: 0,
};

// Staging responder: the fixture invocation stands in for real per-user admission,
// which the production tenancy work replaces.
export const createOwnerResponder = (
  openaiApiKey: string,
  store?: ConversationStore,
  memory?: ClaimStore,
  log: (entry: TurnLogEntry) => void = () => undefined,
  clock: OwnerClock = { timezone: 'UTC', now: () => new Date() },
  tools: DispatchToolOptions<ToolDispatcherContext>['handlers'] = [],
  model: ModelName = WALDO_CHAT_MODEL,
  offload = false,
  toolLedger?: ReturnType<typeof toolOutputLedger>,
  // S4 (CONNECT_FLOW_DESIGN 4.4): the channel's connect affordance. The responder calls it when a
  // tool reports auth_required; it mints the short link and sends the button. Optional so tests
  // and non-owner surfaces can run tools without a chat to offer in.
  offerConnect?: (intent: ConnectIntent) => Promise<boolean>,
  // L1 scenario harness: a scripted gateway replaces the OpenAI adapter so scenarios drive the
  // real pipeline without a live model. Production callers omit it.
  gateway?: LLMGatewayAdapter,
  // Forget support: redact forgotten claim text from the persisted rolling conversation window
  // (supplied by the owner DO, which owns the KV store). Counts only - never the text.
  redactConversation?: (texts: readonly string[]) => Promise<Readonly<{ rewritten: number; remaining: number }>>,
  // Staging probe confinement (Codex #230/#231 holds): while a capture-mode /probe-turn runs,
  // this slot suppresses memory persistence and strips the live provider handlers from the
  // turn's tool loop and system prompt. Inert for real turns; the DO owns the slot.
  probeGuard?: { suppressMemory: boolean; stripLiveTools: boolean },
  // A7: the owner's standing orders join every reply's system prompt (read-only context,
  // owner-authored via owner-confirmed turns). The supplier returns '' when none exist.
  standingOrders?: () => string,
  // A5b: delegate children record background-run rows (parent = this turn's trace). Optional:
  // the console and probes construct turns without the owner DO's run book.
  runs?: RunBook,
  // Memory-writer model (2026-09-27 staging receipt: nano hallucinated forget_claims that
  // wiped claims 1-6 and persisted a bare "yes" as a Gmail-fetch agreement). Memory writes
  // are durable state, so they escalate one rung under cheapest-passing: nano demonstrably
  // does not pass for claim_ops.
  memoryModel: ModelName = OPENAI_GPT_6_LUNA_MODEL,
  // Browse-tool egress: the owner DO passes the parsed WALDO_EGRESS_ALLOWLIST deploy config.
  // Undefined keeps the hook fail-closed - browse tools deny every destination until the owner
  // names hosts. The non-global-address blocks apply regardless.
  egressAllowlist?: readonly string[],
  // D5: derived health context (zones only) for the system prompt's health material. The
  // owner DO wires the signed-rail book; undefined composes with no health material.
  health?: (trace?: string) => Promise<ContextHealthMaterial | null>,
  reactionChoices: readonly string[] = [],
): OwnerResponder => {
  const fixture = localTrustedBriefScheduleInput();
  const accepted = acceptTrustedInvocation(fixture.admission);
  if (!accepted.ok) throw new Error('fixture admission failed');
  const invocation = accepted.value;
  const ownerId = invocation.verified_authority.principal_ref;
  const CANARIES = newSessionCanaryTokens();
  const cacheKey = `waldo:${ownerId}`;
  let traceId = '';
  const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' }, { toolOutputs: async () => toolLedger?.recent() ?? [], ...(health === undefined ? {} : { health: () => health(traceId) }) });
  // Tool outputs from the current turn; flushed to the ledger when the turn's entries persist.
  const pendingToolOutputs: Array<{ tool: string; ok: boolean; at: number; taint: 'external'; summary: string }> = [];
  const circuitBreaker = new InMemoryCircuitBreaker();
  const policy = routingPolicySchema.parse({ routes: [{ trigger: 'user_message', primary: { provider: OPENAI_PROVIDER, model, cache: 'none', max_tokens: 4096 }, fallback: [], floor: 'template' }], escalation: [], template_fallback: false });
  const offloadStore = offload ? inMemoryToolOutputStore() : undefined;
  const safety = {
    authenticatedUserId: ownerId, trigger: 'user_message' as const, canaryTokens: CANARIES,
    sourceTaint: null, toolArgSourceTaint: null, egressAllowlist,
    hasApproval: ownerToolApproval,
    sanitise: adapters.safety.sanitise, medicalGate: adapters.safety.medicalGate,
    // Typed store provenance for the provider's retrieval receipts (owner review on #212).
    ...(offloadStore === undefined ? {} : { toolOutputStore: offloadStore }),
  };
  const handlers = [getContextHandler(clock), ownerContextHandler(memory), ...tools, ...(offloadStore === undefined ? [] : [readToolOutputHandler(offloadStore)])];
  const complete = async (trace: string, purpose: string, system: string, content: string | readonly ConversationModelMessage[], format?: Readonly<{ name: string; schema: Record<string, unknown> }>, attachments?: readonly LLMAttachment[], tools?: readonly LLMTool[], turns?: readonly LLMToolTurn[], modelOverride?: ModelName) => {
    const started = Date.now();
    let reasoning: string | undefined;
    const effectivePolicy = modelOverride === undefined || modelOverride === model ? policy
      : routingPolicySchema.parse({ routes: [{ trigger: 'user_message', primary: { provider: OPENAI_PROVIDER, model: modelOverride, cache: 'none', max_tokens: 4096 }, fallback: [], floor: 'template' }], escalation: [], template_fallback: false });
    // Entries stay separate typed messages so the provider's degrade path can actually reduce:
    // when one historical entry is unrenderable, the retry carries only the current text instead
    // of the identical joined string. Roles come from the typed entry seam, never guessed here.
    const texts: readonly ConversationModelMessage[] = typeof content === 'string' ? [{ role: 'user', content }] : content;
    const userMessages = texts.map((message, index) => ({
      ...message,
      ...(attachments && index === texts.length - 1 ? { attachments: attachments.map((file) => `${file.kind}:${file.filename}`) } : {}),
    }));
    const adapter = gateway ?? new OpenAIResponsesAdapter({ apiKey: openaiApiKey, onResponseMetadata: (metadata) => { reasoning = metadata.reasoning; } });
    const result = await new RuntimeLLMProvider({ gateway: adapter, circuitBreaker }).complete({
      trigger: 'user_message',
      policy: effectivePolicy,
      renderRequest: () => ({
        cache_key: cacheKey,
        system, messages: userMessages.map(({ attachments: _names, ...message }) => message), max_tokens: 4096, temperature: 0.2,
        ...(format ? { response_format: format } : {}), ...(attachments ? { attachments: [...attachments] } : {}),
        ...(tools ? { tools: [...tools] } : {}), ...(turns?.length ? { tool_turns: [...turns] } : {}),
      }),
    }, safety);
    const input = JSON.stringify([{ role: 'system', content: system }, ...userMessages, ...(turns ?? [])]);
    if (!result.ok) log({ trace, hop: `llm_${purpose}`, ms: Date.now() - started, ok: false, code: [result.code, result.halted_by, result.scribe?.reason].filter(Boolean).join(':'), shape: { system_bytes: new TextEncoder().encode(system).byteLength, request_bytes: new TextEncoder().encode(input).byteLength }, text: { input } });
    else log({
      trace, hop: `llm_${purpose}`, ms: result.usage.latency_ms, ok: true,
      usage: { model: result.usage.model, input: result.usage.input_tokens, output: result.usage.output_tokens, cached: result.usage.cache_read_input_tokens },
      shape: { system_bytes: new TextEncoder().encode(system).byteLength, request_bytes: new TextEncoder().encode(input).byteLength },
      text: { input, output: result.response.text || JSON.stringify(result.response.tool_calls), ...(reasoning ? { reasoning } : {}) },
    });
    if (!result.ok && result.halted_by === 'medical_gate' && !system.endsWith(CLINICAL_REDIRECT)) {
      return complete(trace, `${purpose}_redirect`, `${system}\n\n${CLINICAL_REDIRECT}`, content, format, attachments, tools, turns);
    }
    if (!result.ok && result.halted_by === 'medical_gate') return { ...CLINICAL_FALLBACK, model };
    if (!result.ok) throw new Error(`live model failed: ${result.code} (${[result.halted_by, result.scribe?.destination, result.scribe?.reason].filter(Boolean).join(': ') || result.reason})`);
    return result.response;
  };
  const ask = async (...args: Parameters<typeof complete>) => (await complete(...args)).text;
  const control = turnControl();
  const tree = new ConversationTree();
  let pending: readonly LLMAttachment[] | undefined;
  // F1 receipt: the window observer fires only when history was actually dropped (content-free).
  const pathObservers = { onWindow: (stats: { kept: number; dropped: number; estimated_tokens: number; budget_tokens: number }) => { if (stats.dropped > 0) log({ trace: traceId, hop: 'context_window', ms: 0, ok: true, detail: `kept ${stats.kept} dropped ${stats.dropped} ~${stats.estimated_tokens}/${stats.budget_tokens} tokens` }); } };
  const path = new JoinedConversationPath(adapters.contextComposer!, {
    complete: (request) => {
      const trace = traceId;
      // Capture-mode probe turns run on the stripped handler set; delegation wraps that
      // same set so probe confinement applies to children too (children are read-only by
      // construction, and the strip list is not widened here).
      const activeHandlers = probeGuard?.stripLiveTools
        ? handlers.filter((handler) => !PROBE_STRIPPED_TOOLS.includes(handler.name))
        : handlers;
      // Subagent orchestration v1: the delegate_task handler is built per turn so the spawn
      // counter resets each turn and the spawner closes over this turn's LLM step. The child
      // runs a nested tool loop on the read-only subset (CHILD_TOOL_NAMES) with its own round
      // slice; flat by construction - children never get delegate_task.
      // One shared round budget per submitted turn: the parent loop and every child it spawns
      // draw from it, so the turn's stated cap is absolute (Codex #224 hold).
      const turnBudget = { remaining: MAX_TOOL_ROUNDS };
      const delegate = delegateTaskHandler(async (task) => {
        // A5b: one run row per spawned child; the exit classification lands on the row, and
        // the summary is the report's first line (capped by the book), never an error dump.
        const run = runs?.start('delegate_task', trace) ?? null;
        try {
          const result = await runChildLoop(task, {
          handlers: activeHandlers,
          budget: turnBudget,
          ctx: { ...safety, turnId: trace, session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: Date.now() }) },
          controlRound: () => control.round(),
          complete: (content, tools, turns) =>
            complete(trace, 'subagent', SUBAGENT_SYSTEM_PROMPT, [{ role: 'user', content }], undefined, undefined, tools as never, turns),
          onTool: (event) => {
            log({ trace, hop: `subagent_tool_${event.call.name}`, ms: event.ms, ok: event.ok, ...(event.error ? { error: event.error } : {}), ...(event.code ? { code: [event.code, event.reason].filter(Boolean).join(':') } : {}), ...(event.guard ? { guard: event.guard } : {}), text: { input: event.call.arguments, output: event.output } });
          },
        });
          if (run) runs?.finish(run.id, result.exit === 'completed' ? 'completed' : result.exit === 'stopped' ? 'stopped' : 'failed', (result.text.split('\n')[0] ?? '').slice(0, 120));
          return result;
        } catch (error) {
          if (run) runs?.finish(run.id, 'failed', String(error).slice(0, 120));
          throw error;
        }
      });
      const turnHandlers = withDelegation(activeHandlers, delegate, ownerTurnActive);
      return runToolLoop({
        handlers: turnHandlers,
        budget: turnBudget,
        ...(offloadStore === undefined ? {} : { offload: offloadStore }),
        maxSteps: MAX_TOOL_ROUNDS,
        ctx: { ...safety, turnId: trace, session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: Date.now() }) },
        step: async (tools, turns) => {
          const added = control.round();
          if (added === null) return { text: STOPPED_REPLY };
          // Steered additions are recorded before the round that answers them.
          const heard = control.heard();
          if (turnWriting && heard.length > recordedHeard) {
            const fresh = heard.slice(recordedHeard).join('\n');
            recordedHeard = heard.length;
            const status = await record(`${trace}-steer${recordedHeard}`, fresh, '');
            if (status !== 'saved') turnNotice = MEMORY_NOTICES[status];
          }
          const entries = [...request.messages];
          entries[entries.length - 1] = { ...entries[entries.length - 1]!, content: entries[entries.length - 1]!.content + added };
          const ordersSection = standingOrders?.() ?? '';
          return complete(trace, 'reply',
          [messagingSystemPrompt(turnHandlers.map((handler) => handler.name)), ownerClockLine(clock), ...(turnNotice ? [turnNotice] : []), ...(memory ? [turnMemoryPrompt(memory, entries[entries.length - 1]?.content ?? '')] : []), ...(ordersSection ? [ordersSection] : [])].join('\n\n'),
          entries,
          undefined,
          pending,
          tools,
          turns,
          );
        },
        onTool: (event) => {
          log({ trace, hop: `tool_${event.call.name}`, ms: event.ms, ok: event.ok, ...(event.error ? { error: event.error } : {}), ...(event.code ? { code: [event.code, event.reason].filter(Boolean).join(':') } : {}), ...(event.guard ? { guard: event.guard } : {}), text: { input: event.call.arguments, output: event.output } });
          pendingToolOutputs.push({ tool: event.call.name, ok: event.ok, at: Date.now(), taint: 'external', summary: event.output });
        },
        ...(offerConnect ? { onConnect: offerConnect } : {}),
      });
    },
  }, tree, undefined, pathObservers);
  let parentId: string | null = null;
  // Set by converse() for the duration of one submit: delegate_task rides owner chat turns
  // only, never reminder/scheduled machine turns that flow through the same closure.
  let ownerTurnActive = false;
  // The reply this turn just sent, so chooseReaction reacts to the exchange (gist of what the
  // owner saw) instead of the owner's message alone - the 😢-on-stress class (2026-09-27 sweep).
  let lastReply: string | undefined;
  // Per owner turn: whether memory writes are on, how many steered additions are already recorded,
  // and an ephemeral system notice. The notice rides the system prompt only, never owner history.
  let turnWriting = false;
  let recordedHeard = 0;
  let turnNotice = '';
  const restored = store ? restoreConversation(tree, store).then((leafId) => { parentId = leafId; }) : Promise.resolve();
  const converse = async (id: string, conversationRef: string, said: string, time: TurnTimer, fromOwner = false, surface = 'agent') => {
    traceId = id;
    ownerTurnActive = fromOwner;
    control.begin(fromOwner);
    const publication = await time('joined_path', () => path.submit({
      authenticatedOwnerId: ownerId, invocation,
      context: { ...localTrustedBriefTurnSnapshot(), canary_tokens: CANARIES, replay_context_ref: null },
      userEntry: { id, ownerId, chatId: conversationRef, parentId, threadAnchorId: null, surface, modelPayload: said, appPayload: said, modelProjection: { mode: 'include' } },
      assistantEntryId: `${id}-reply`,
    })).finally(() => { ownerTurnActive = false; control.end(); });
    await store?.save([tree.get(id)!, tree.get(publication.leafId)!], publication.leafId);
    for (const entry of pendingToolOutputs.splice(0)) await toolLedger?.record(entry);
    parentId = publication.leafId;
    const out = publication.text;
    lastReply = out;
    return out;
  };
  // 'failed': the writer never produced ops, nothing changed. 'uncertain': ops were being applied
  // or cleaned up when an error hit, so some of the write may have landed.
  const MEMORY_NOTICES = {
    failed: "Saving the owner's latest message to memory failed; nothing was stored. Say plainly that it was not saved.",
    uncertain: "Saving the owner's latest message to memory hit an error partway; it may be only partly stored. Say plainly that it may not have saved and offer to check.",
  } as const;
  const record = async (id: string, owner: string, shared: string): Promise<'saved' | 'failed' | 'uncertain'> => {
    if (!memory) return 'saved';
    const started = Date.now();
    memory.beginSettle(id, new Date().toISOString());
    let stage: 'failed' | 'uncertain' = 'failed';
    try {
      const raw = await ask(id, 'memory', MEMORY_INSTRUCTION, exchangeInput(memory, owner, shared, ''), { name: 'claim_ops', schema: CLAIM_OPS_SCHEMA }, undefined, undefined, undefined, memoryModel);
      stage = 'uncertain';
      let purged: readonly string[] = [];
      let purgeIds: readonly number[] = [];
      const detail = applyClaimOps(memory, raw, new Date().toISOString(), `owner, ${id}`, (texts, ids) => { purged = texts; purgeIds = ids; }, { owner, shared });
      const conv = purged.length && redactConversation ? await redactConversation(purged) : null;
      // Settle only once the KV conversation/ledger stores verify clean too; a KV
      // survivor leaves the claim 'purging' so a later retry can still find it.
      if (purgeIds.length && (conv === null || conv.remaining === 0)) memory.settle(purgeIds);
      const interrupted = memory.sweepInterruptedSettles(new Date(started - 10 * 60 * 1000).toISOString());
      log({ trace: id, hop: 'memory', ms: Date.now() - started, ok: true, detail: `${detail}${conv ? `; conv ${conv.rewritten} redacted${conv.remaining ? ` ${conv.remaining} left` : ''}` : ''}${interrupted ? ` interrupted${interrupted}` : ''}` });
      return 'saved';
    } catch (error) {
      log({ trace: id, hop: 'memory', ms: Date.now() - started, ok: false, error: String(error), code: 'provider_error', detail: stage });
      return stage;
    } finally {
      memory.endSettle(id);
    }
  };
  return {
    async respond(turn, time) {
      const memoryWrites = turn.memoryWrites !== false;
      await restored;
      const id = turn.traceId;
      const media = turn.attachment || turn.mediaNote ? { attachment: turn.attachment, note: turn.mediaNote } : undefined;
      pending = media?.attachment ? [media.attachment] : undefined;
      turnWriting = memory !== undefined && memoryWrites && !probeGuard?.suppressMemory;
      recordedHeard = 0;
      // Record before reply: the owner's words are written first, so the reply sees corrections
      // and never acknowledges a save that did not happen. A failed write goes to the reply
      // through the system prompt, not the owner's text, so history stays the owner's words.
      const status = turnWriting ? await record(id, turn.text ?? '', media?.note ?? '') : 'saved';
      turnNotice = status === 'saved' ? '' : MEMORY_NOTICES[status];
      const said = [turn.text, media?.note].filter(Boolean).join('\n');
      try {
        return await converse(id, turn.conversationRef, said, time, true, turn.surface);
      } finally {
        turnWriting = false;
        turnNotice = '';
      }
    },
    async remind(id, conversationRef, note, time, surface) {
      await restored;
      pending = undefined;
      return converse(id, conversationRef, `[Reminder due now, set earlier by the owner: "${note}"] Send the reminder briefly in your own words. Do not add a sentence explaining that they asked for it.`, time, false, surface);
    },
    async prompt(id, conversationRef, said, time, surface) {
      await restored;
      pending = undefined;
      return converse(id, conversationRef, said, time, false, surface);
    },
    async consolidate(trace, day, sides) {
      if (!memory) return 'no memory';
      const raw = await ask(trace, 'nightly_memory', NIGHTLY_MEMORY_INSTRUCTION, nightlyInput(memory, day), { name: 'claim_ops', schema: CLAIM_OPS_SCHEMA }, undefined, undefined, undefined, memoryModel);
      let purged: readonly string[] = [];
      let purgeIds: readonly number[] = [];
      // With speaker-split sides the full gate runs at night too (self-report holds, shared
      // taint, origin classes). Without them the mixed transcript is a fabrication check only.
      const grounding = sides ? { owner: sides.owner, waldo: sides.waldo } : { owner: day };
      const summary = applyClaimOps(memory, raw, new Date().toISOString(), `owner, day of ${trace}`, (texts, ids) => { purged = texts; purgeIds = ids; }, grounding);
      const conv = purged.length && redactConversation ? await redactConversation(purged) : null;
      if (purgeIds.length && (conv === null || conv.remaining === 0)) memory.settle(purgeIds);
      return `${summary}${conv ? `; conv ${conv.rewritten} redacted${conv.remaining ? ` ${conv.remaining} left` : ''}` : ''}`;
    },
    async migrate(trace, input) {
      if (!memory) return 'no memory';
      const raw = await ask(trace, 'memory_migration', MIGRATION_INSTRUCTION, input, { name: 'claim_ops', schema: CLAIM_OPS_SCHEMA }, undefined, undefined, undefined, memoryModel);
      let purged: readonly string[] = [];
      let purgeIds: readonly number[] = [];
      // Migration admits legacy facts only: the file payload can mention past forgets, so the
      // forget-intent gate is pinned shut here - nothing purges during a migration.
      const summary = applyClaimOps(memory, raw, new Date().toISOString(), 'owner agreed', (texts, ids) => { purged = texts; purgeIds = ids; }, { owner: input }, false);
      const conv = purged.length && redactConversation ? await redactConversation(purged) : null;
      if (purgeIds.length && (conv === null || conv.remaining === 0)) memory.settle(purgeIds);
      return `${summary}${conv ? `; conv ${conv.rewritten} redacted${conv.remaining ? ` ${conv.remaining} left` : ''}` : ''}`;
    },
    async promote(trace) {
      if (!memory || memory.claims().length === 0) return 'no claims';
      const raw = await ask(trace, 'constellation', PROMOTION_INSTRUCTION, promotionInput(memory), { name: 'promotion', schema: PROMOTION_SCHEMA });
      return applyPromotion(memory, raw, new Date().toISOString(), (receipt) => log({
        trace, hop: 'constellation_evidence', ms: 0, ok: true,
        code: receipt.reason ?? receipt.outcome,
        detail: `${receipt.outcome}:${receipt.reason ?? 'supported'}:${receipt.source_kind}:${receipt.count}`,
      }));
    },
    control,
    planDay: (trace, input) => ask(trace, 'day_plan', DAY_PLAN_INSTRUCTION, memory ? `${memoryPrompt(memory)}\n\n${input}` : input, { name: 'day_plan', schema: DAY_PLAN_SCHEMA }),
    chooseReaction: async (turn) => {
      const gist = lastReply === undefined ? turn.text : `${turn.text}\n\n[Your reply just sent: ${lastReply.slice(0, 500)}]`;
      return (JSON.parse(await ask(turn.traceId, 'reaction', reactionInstruction(reactionChoices), gist, { name: 'reaction', schema: reactionSchema(reactionChoices) })) as { reaction?: string }).reaction ?? null;
    },
  };
};
