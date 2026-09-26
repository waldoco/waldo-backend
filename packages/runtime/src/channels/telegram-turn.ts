import {
  acceptTrustedInvocation, buildSessionState, ConversationTree, OPENAI_PROVIDER, routingPolicySchema, WALDO_CHAT_MODEL,
  type ConnectIntent, type LLMTool, type LLMToolTurn, type ModelName,
} from '@waldo/contracts';
import type { ConversationModelMessage } from '@waldo/contracts';
import { runToolLoop, type LoopExit } from '../conversation/tool-loop';
import { CHILD_TOOL_NAMES, delegateTaskHandler, SUBAGENT_MAX_ROUNDS, SUBAGENT_SYSTEM_PROMPT } from '../conversation/subagent';
import { inMemoryToolOutputStore } from '../conversation/tool-output-store';
import { readToolOutputHandler } from '../tools/read-tool-output';
import { getContextHandler, type OwnerClock } from '../tools/live/get-context';
import { localTrustedBriefScheduleInput, localTrustedBriefTurnSnapshot, resolveRunLoopAdapters } from '../run-loop/adapters';
import { JoinedConversationPath } from '../conversation/joined-path';
import { OpenAIResponsesAdapter } from '../llm/openai';
import { InMemoryCircuitBreaker, RuntimeLLMProvider, type LLMGatewayAdapter } from '../llm/provider';
import { CLINICAL_REDIRECT, messagingSystemPrompt } from '../prompt/messaging-behavior';
import { DAY_PLAN_INSTRUCTION, DAY_PLAN_SCHEMA } from '../prompt/day-cards';
import { applyClaimOps, applyPromotion, CLAIM_OPS_SCHEMA, exchangeInput, MEMORY_INSTRUCTION, memoryPrompt, MIGRATION_INSTRUCTION, NIGHTLY_MEMORY_INSTRUCTION, nightlyInput, PROMOTION_INSTRUCTION, PROMOTION_SCHEMA, promotionInput, type ClaimStore } from '../memory/claims';
import { restoreConversation, type ConversationStore } from './conversation-store';
import { reactionInstruction, reactionSchema, TELEGRAM_REACTIONS } from './reactions';
import type { TelegramOwnerListenerOptions, TurnLogEntry, TurnTimer } from './telegram-listener';
import type { DispatchToolOptions, ToolDispatcherContext } from '../tools/dispatcher';
import { loadTelegramMedia, type MediaReaders } from './telegram-media';
import type { LLMAttachment } from '@waldo/contracts';
import { STOPPED_REPLY, turnControl } from './turn-control';
import { toolOutputLedger } from '../conversation/tool-output-ledger';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const MAX_TOOL_ROUNDS = 25;
const CLINICAL_FALLBACK = {
  text: "I can't advise on that one. A doctor or pharmacist can. If this is an emergency or you feel unsafe, call your local emergency number now.",
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, latency_ms: 0,
};

// Staging responder: the fixture invocation stands in for real per-user admission,
// which the production tenancy work replaces.
export const createTelegramResponder = (
  openaiApiKey: string,
  store?: ConversationStore,
  memory?: ClaimStore,
  log: (entry: TurnLogEntry) => void = () => undefined,
  readers: MediaReaders = {},
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
): Pick<TelegramOwnerListenerOptions, 'respond' | 'chooseReaction'> & { remind(id: string, chatId: number, note: string, time: TurnTimer): Promise<string>; prompt(id: string, chatId: number, said: string, time: TurnTimer): Promise<string>; consolidate(trace: string, day: string): Promise<string>; migrate(trace: string, input: string): Promise<string>; promote(trace: string): Promise<string>; planDay(trace: string, input: string): Promise<string>; control: typeof control } => {
  const fixture = localTrustedBriefScheduleInput();
  const accepted = acceptTrustedInvocation(fixture.admission);
  if (!accepted.ok) throw new Error('fixture admission failed');
  const invocation = accepted.value;
  const ownerId = invocation.verified_authority.principal_ref;
  const cacheKey = `waldo:${ownerId}`;
  const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' }, { toolOutputs: async () => toolLedger?.recent() ?? [] });
  // Tool outputs from the current turn; flushed to the ledger when the turn's entries persist.
  const pendingToolOutputs: Array<{ tool: string; ok: boolean; at: number; taint: 'external'; summary: string }> = [];
  const circuitBreaker = new InMemoryCircuitBreaker();
  const policy = routingPolicySchema.parse({ routes: [{ trigger: 'user_message', primary: { provider: OPENAI_PROVIDER, model, cache: 'none', max_tokens: 4096 }, fallback: [], floor: 'template' }], escalation: [], template_fallback: false });
  const offloadStore = offload ? inMemoryToolOutputStore() : undefined;
  const safety = {
    authenticatedUserId: ownerId, trigger: 'user_message' as const, canaryTokens: CANARIES,
    sourceTaint: null, toolArgSourceTaint: null,
    sanitise: adapters.safety.sanitise, medicalGate: adapters.safety.medicalGate,
    // Typed store provenance for the provider's retrieval receipts (owner review on #212).
    ...(offloadStore === undefined ? {} : { toolOutputStore: offloadStore }),
  };
  const handlers = [getContextHandler(clock), ...tools, ...(offloadStore === undefined ? [] : [readToolOutputHandler(offloadStore)])];
  const complete = async (trace: string, purpose: string, system: string, content: string | readonly ConversationModelMessage[], format?: Readonly<{ name: string; schema: Record<string, unknown> }>, attachments?: readonly LLMAttachment[], tools?: readonly LLMTool[], turns?: readonly LLMToolTurn[]) => {
    const started = Date.now();
    let reasoning: string | undefined;
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
      policy,
      renderRequest: () => ({
        cache_key: cacheKey,
        system, messages: userMessages.map(({ attachments: _names, ...message }) => message), max_tokens: 4096, temperature: 0.2,
        ...(format ? { response_format: format } : {}), ...(attachments ? { attachments: [...attachments] } : {}),
        ...(tools ? { tools: [...tools] } : {}), ...(turns?.length ? { tool_turns: [...turns] } : {}),
      }),
    }, safety);
    const input = JSON.stringify([{ role: 'system', content: system }, ...userMessages, ...(turns ?? [])]);
    if (!result.ok) log({ trace, hop: `llm_${purpose}`, ms: Date.now() - started, ok: false, code: [result.code, result.halted_by].filter(Boolean).join(':'), shape: { system_bytes: new TextEncoder().encode(system).byteLength, request_bytes: new TextEncoder().encode(input).byteLength }, text: { input } });
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
  let traceId = '';
  let pending: readonly LLMAttachment[] | undefined;
  const path = new JoinedConversationPath(adapters.contextComposer!, {
    complete: (request) => {
      const trace = traceId;
      // Subagent orchestration v1 (owner-delegated spec decisions 2026-09-26): the delegate_task
      // handler is built per turn so the spawn counter resets each turn and the spawner closes
      // over this turn's LLM step. The child runs a nested tool loop on the read-only subset
      // (CHILD_TOOL_NAMES) with its own round slice; flat by construction - children never get
      // delegate_task.
      const delegate = delegateTaskHandler(async (task) => {
        let exit: LoopExit = 'completed';
        const text = await runToolLoop({
          handlers: handlers.filter((handler) => (CHILD_TOOL_NAMES as readonly string[]).includes(handler.name)),
          maxSteps: SUBAGENT_MAX_ROUNDS,
          ctx: { ...safety, session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: Date.now() }) },
          onSettle: (settled) => { exit = settled; },
          step: (tools, turns) =>
            complete(trace, 'subagent', SUBAGENT_SYSTEM_PROMPT, [{ role: 'user', content: task }], undefined, undefined, tools, turns),
        });
        return { exit, text };
      });
      return runToolLoop({
        handlers: [...handlers, delegate],
        ...(offloadStore === undefined ? {} : { offload: offloadStore }),
        maxSteps: MAX_TOOL_ROUNDS,
        ctx: { ...safety, session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: Date.now() }) },
        step: async (tools, turns) => {
          const added = control.round();
          if (added === null) return { text: STOPPED_REPLY };
          const entries = [...request.messages];
          entries[entries.length - 1] = { ...entries[entries.length - 1]!, content: entries[entries.length - 1]!.content + added };
          return complete(trace, 'reply',
          [messagingSystemPrompt(handlers.map((handler) => handler.name)), ...(memory ? [memoryPrompt(memory)] : [])].join('\n\n'),
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
  }, tree);
  let parentId: string | null = null;
  let settling: Promise<unknown> = Promise.resolve();
  const restored = store ? restoreConversation(tree, store).then((leafId) => { parentId = leafId; }) : Promise.resolve();
  const converse = async (id: string, chatId: number, said: string, time: TurnTimer, fromOwner = false) => {
    traceId = id;
    control.begin(fromOwner);
    const publication = await time('joined_path', () => path.submit({
      authenticatedOwnerId: ownerId, invocation,
      context: { ...localTrustedBriefTurnSnapshot(), canary_tokens: CANARIES, replay_context_ref: null },
      userEntry: { id, ownerId, chatId: `telegram-${chatId}`, parentId, threadAnchorId: null, surface: 'telegram', modelPayload: said, appPayload: said, modelProjection: { mode: 'include' } },
      assistantEntryId: `${id}-reply`,
    })).finally(() => control.end());
    await store?.save([tree.get(id)!, tree.get(publication.leafId)!], publication.leafId);
    for (const entry of pendingToolOutputs.splice(0)) await toolLedger?.record(entry);
    parentId = publication.leafId;
    return publication.text;
  };
  return {
    async respond(turn, time) {
      await restored;
      await settling;
      const id = `tg-${turn.updateId}`;
      const media = turn.media ? await time('media', () => loadTelegramMedia(turn.media!, readers)) : undefined;
      pending = media?.attachment ? [media.attachment] : undefined;
      const said = [turn.text, media?.note].filter(Boolean).join('\n');
      const text = await converse(id, turn.chatId, said, time, true);
      const owner = [turn.text ?? '', ...control.end()].filter(Boolean).join('\n');
      if (memory) {
        const started = Date.now();
        settling = ask(id, 'memory', MEMORY_INSTRUCTION, exchangeInput(memory, owner, media?.note ?? '', text), { name: 'claim_ops', schema: CLAIM_OPS_SCHEMA })
          .then((raw) => log({ trace: id, hop: 'memory', ms: Date.now() - started, ok: true, detail: applyClaimOps(memory, raw, new Date().toISOString(), `owner, ${id}`) }))
          .catch((error: unknown) => log({ trace: id, hop: 'memory', ms: Date.now() - started, ok: false, error: String(error), code: 'provider_error' }));
      }
      return text;
    },
    async remind(id, chatId, note, time) {
      await restored;
      await settling;
      pending = undefined;
      return converse(id, chatId, `[Reminder due now, set earlier by the owner: "${note}"] Send them this reminder now, in your own words.`, time);
    },
    async prompt(id, chatId, said, time) {
      await restored;
      await settling;
      pending = undefined;
      return converse(id, chatId, said, time);
    },
    async consolidate(trace, day) {
      await settling;
      if (!memory) return 'no memory';
      const raw = await ask(trace, 'nightly_memory', NIGHTLY_MEMORY_INSTRUCTION, nightlyInput(memory, day), { name: 'claim_ops', schema: CLAIM_OPS_SCHEMA });
      return applyClaimOps(memory, raw, new Date().toISOString(), `owner, day of ${trace}`);
    },
    async migrate(trace, input) {
      if (!memory) return 'no memory';
      const raw = await ask(trace, 'memory_migration', MIGRATION_INSTRUCTION, input, { name: 'claim_ops', schema: CLAIM_OPS_SCHEMA });
      return applyClaimOps(memory, raw, new Date().toISOString());
    },
    async promote(trace) {
      await settling;
      if (!memory || memory.claims().length === 0) return 'no claims';
      const raw = await ask(trace, 'constellation', PROMOTION_INSTRUCTION, promotionInput(memory), { name: 'promotion', schema: PROMOTION_SCHEMA });
      return applyPromotion(memory, raw, new Date().toISOString());
    },
    control,
    planDay: (trace, input) => ask(trace, 'day_plan', DAY_PLAN_INSTRUCTION, memory ? `${memoryPrompt(memory)}\n\n${input}` : input, { name: 'day_plan', schema: DAY_PLAN_SCHEMA }),
    chooseReaction: async (turn) => (JSON.parse(await ask(`tg-${turn.updateId}`, 'reaction', reactionInstruction(TELEGRAM_REACTIONS), turn.text, { name: 'reaction', schema: reactionSchema(TELEGRAM_REACTIONS) })) as { reaction?: string }).reaction ?? null,
  };
};
