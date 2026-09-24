import {
  acceptTrustedInvocation, buildSessionState, ConversationTree, OPENAI_PROVIDER, routingPolicySchema, WALDO_CHAT_MODEL,
  type LLMTool, type LLMToolTurn, type ModelName,
} from '@waldo/contracts';
import { runToolLoop } from '../conversation/tool-loop';
import { inMemoryToolOutputStore } from '../conversation/tool-output-store';
import { readToolOutputHandler } from '../tools/read-tool-output';
import { getContextHandler, type OwnerClock } from '../tools/live/get-context';
import { localTrustedBriefScheduleInput, resolveRunLoopAdapters } from '../run-loop/adapters';
import { JoinedConversationPath } from '../conversation/joined-path';
import { OpenAIResponsesAdapter } from '../llm/openai';
import { InMemoryCircuitBreaker, RuntimeLLMProvider } from '../llm/provider';
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
): Pick<TelegramOwnerListenerOptions, 'respond' | 'chooseReaction'> & { remind(id: string, chatId: number, note: string, time: TurnTimer): Promise<string>; prompt(id: string, chatId: number, said: string, time: TurnTimer): Promise<string>; consolidate(trace: string, day: string): Promise<string>; migrate(trace: string, input: string): Promise<string>; promote(trace: string): Promise<string>; planDay(trace: string, input: string): Promise<string>; control: typeof control } => {
  const fixture = localTrustedBriefScheduleInput();
  const accepted = acceptTrustedInvocation(fixture.admission);
  if (!accepted.ok) throw new Error('fixture admission failed');
  const invocation = accepted.value;
  const ownerId = invocation.verified_authority.principal_ref;
  const cacheKey = `waldo:${ownerId}`;
  const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
  const circuitBreaker = new InMemoryCircuitBreaker();
  const policy = routingPolicySchema.parse({ routes: [{ trigger: 'user_message', primary: { provider: OPENAI_PROVIDER, model, cache: 'none', max_tokens: 4096 }, fallback: [], floor: 'template' }], escalation: [], template_fallback: false });
  const safety = {
    authenticatedUserId: ownerId, trigger: 'user_message' as const, canaryTokens: CANARIES,
    sourceTaint: null, toolArgSourceTaint: null,
    sanitise: adapters.safety.sanitise, medicalGate: adapters.safety.medicalGate,
  };
  const offloadStore = offload ? inMemoryToolOutputStore() : undefined;
  const handlers = [getContextHandler(clock), ...tools, ...(offloadStore === undefined ? [] : [readToolOutputHandler(offloadStore)])];
  const complete = async (trace: string, purpose: string, system: string, content: string, format?: Readonly<{ name: string; schema: Record<string, unknown> }>, attachments?: readonly LLMAttachment[], tools?: readonly LLMTool[], turns?: readonly LLMToolTurn[]) => {
    const started = Date.now();
    let reasoning: string | undefined;
    const gateway = new OpenAIResponsesAdapter({ apiKey: openaiApiKey, onResponseMetadata: (metadata) => { reasoning = metadata.reasoning; } });
    const result = await new RuntimeLLMProvider({ gateway, circuitBreaker }).complete({
      trigger: 'user_message',
      policy,
      renderRequest: () => ({
        cache_key: cacheKey,
        system, messages: [{ role: 'user' as const, content }], max_tokens: 4096, temperature: 0.2,
        ...(format ? { response_format: format } : {}), ...(attachments ? { attachments: [...attachments] } : {}),
        ...(tools ? { tools: [...tools] } : {}), ...(turns?.length ? { tool_turns: [...turns] } : {}),
      }),
    }, safety);
    const input = JSON.stringify([{ role: 'system', content: system }, { role: 'user', content, ...(attachments ? { attachments: attachments.map((file) => `${file.kind}:${file.filename}`) } : {}) }, ...(turns ?? [])]);
    if (!result.ok) log({ trace, hop: `llm_${purpose}`, ms: Date.now() - started, ok: false, error: [result.code, result.halted_by].filter(Boolean).join(':'), shape: { system_bytes: new TextEncoder().encode(system).byteLength, request_bytes: new TextEncoder().encode(input).byteLength }, text: { input } });
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
    if (!result.ok) throw new Error(`live model failed: ${result.code} (${[result.halted_by, result.scribe?.reason].filter(Boolean).join(': ') || result.reason})`);
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
      return runToolLoop({
        handlers,
        ...(offloadStore === undefined ? {} : { offload: offloadStore }),
        maxSteps: MAX_TOOL_ROUNDS,
        ctx: { ...safety, session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: Date.now() }) },
        step: async (tools, turns) => {
          const added = control.round();
          if (added === null) return { text: STOPPED_REPLY };
          return complete(trace, 'reply',
          [messagingSystemPrompt(handlers.map((handler) => handler.name)), ...(memory ? [memoryPrompt(memory)] : [])].join('\n\n'),
          request.messages.join('\n') + added,
          undefined,
          pending,
          tools,
          turns,
          );
        },
        onTool: (event) => log({ trace, hop: `tool_${event.call.name}`, ms: event.ms, ok: event.ok, text: { input: event.call.arguments, output: event.output } }),
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
      context: { snapshot_ref: fixture.snapshot_ref, snapshot_at: fixture.snapshot_at, canary_tokens: CANARIES, replay_context_ref: null },
      userEntry: { id, ownerId, chatId: `telegram-${chatId}`, parentId, threadAnchorId: null, surface: 'telegram', modelPayload: said, appPayload: said, modelProjection: { mode: 'include' } },
      assistantEntryId: `${id}-reply`,
    })).finally(() => control.end());
    await store?.save([tree.get(id)!, tree.get(publication.leafId)!], publication.leafId);
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
          .catch((error: unknown) => log({ trace: id, hop: 'memory', ms: Date.now() - started, ok: false, error: String(error) }));
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
