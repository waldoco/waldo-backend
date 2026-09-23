import {
  acceptTrustedInvocation, buildSessionState, ConversationTree, OPENAI_PROVIDER, routingPolicySchema, WALDO_CHAT_MODEL,
  type LLMTool, type LLMToolTurn,
} from '@waldo/contracts';
import { runToolLoop } from '../conversation/tool-loop';
import { getContextHandler, type OwnerClock } from '../tools/live/get-context';
import { localTrustedBriefScheduleInput, resolveRunLoopAdapters } from '../run-loop/adapters';
import { JoinedConversationPath } from '../conversation/joined-path';
import { OpenAIResponsesAdapter } from '../llm/openai';
import { InMemoryCircuitBreaker, RuntimeLLMProvider } from '../llm/provider';
import { messagingSystemPrompt } from '../prompt/messaging-behavior';
import { applyMemoryEdits, MEMORY_EDITS_SCHEMA, MEMORY_UPDATE_INSTRUCTION, NIGHTLY_MEMORY_INSTRUCTION, nightlyMemoryInput, memoryPrompt, memoryUpdateInput, type CoreFileStore } from '../memory/core-files';
import { restoreConversation, type ConversationStore } from './conversation-store';
import { reactionInstruction, reactionSchema, TELEGRAM_REACTIONS } from './reactions';
import type { TelegramOwnerListenerOptions, TurnLogEntry, TurnTimer } from './telegram-listener';
import type { DispatchToolOptions, ToolDispatcherContext } from '../tools/dispatcher';
import { loadTelegramMedia, type MediaReaders } from './telegram-media';
import type { LLMAttachment } from '@waldo/contracts';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const MAX_TOOL_ROUNDS = 25;

// Staging responder: the fixture invocation stands in for real per-user admission,
// which the production tenancy work replaces.
export const createTelegramResponder = (
  openaiApiKey: string,
  store?: ConversationStore,
  memory?: CoreFileStore,
  log: (entry: TurnLogEntry) => void = () => undefined,
  readers: MediaReaders = {},
  clock: OwnerClock = { timezone: 'UTC', now: () => new Date() },
  tools: DispatchToolOptions<ToolDispatcherContext>['handlers'] = [],
): Pick<TelegramOwnerListenerOptions, 'respond' | 'chooseReaction'> & { remind(id: string, chatId: number, note: string, time: TurnTimer): Promise<string>; consolidate(trace: string, day: string): Promise<readonly string[]> } => {
  const fixture = localTrustedBriefScheduleInput();
  const accepted = acceptTrustedInvocation(fixture.admission);
  if (!accepted.ok) throw new Error('fixture admission failed');
  const invocation = accepted.value;
  const ownerId = invocation.verified_authority.principal_ref;
  const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
  const circuitBreaker = new InMemoryCircuitBreaker();
  const policy = routingPolicySchema.parse({ routes: [{ trigger: 'user_message', primary: { provider: OPENAI_PROVIDER, model: WALDO_CHAT_MODEL, cache: 'none', max_tokens: 4096 }, fallback: [], floor: 'template' }], escalation: [], template_fallback: false });
  const safety = {
    authenticatedUserId: ownerId, trigger: 'user_message' as const, canaryTokens: CANARIES,
    sourceTaint: null, toolArgSourceTaint: null,
    sanitise: adapters.safety.sanitise, medicalGate: adapters.safety.medicalGate,
  };
  const handlers = [getContextHandler(clock), ...tools];
  const complete = async (trace: string, purpose: string, system: string, content: string, format?: Readonly<{ name: string; schema: Record<string, unknown> }>, attachments?: readonly LLMAttachment[], tools?: readonly LLMTool[], turns?: readonly LLMToolTurn[]) => {
    const started = Date.now();
    let reasoning: string | undefined;
    const gateway = new OpenAIResponsesAdapter({ apiKey: openaiApiKey, onResponseMetadata: (metadata) => { reasoning = metadata.reasoning; } });
    const result = await new RuntimeLLMProvider({ gateway, circuitBreaker }).complete({
      trigger: 'user_message',
      policy,
      renderRequest: () => ({
        system, messages: [{ role: 'user' as const, content }], max_tokens: 4096, temperature: 0.2,
        ...(format ? { response_format: format } : {}), ...(attachments ? { attachments: [...attachments] } : {}),
        ...(tools ? { tools: [...tools] } : {}), ...(turns?.length ? { tool_turns: [...turns] } : {}),
      }),
    }, safety);
    const input = JSON.stringify([{ role: 'system', content: system }, { role: 'user', content, ...(attachments ? { attachments: attachments.map((file) => `${file.kind}:${file.filename}`) } : {}) }, ...(turns ?? [])]);
    if (!result.ok) log({ trace, hop: `llm_${purpose}`, ms: Date.now() - started, ok: false, error: [result.code, result.halted_by].filter(Boolean).join(':'), text: { input } });
    else log({
      trace, hop: `llm_${purpose}`, ms: result.usage.latency_ms, ok: true,
      usage: { model: result.usage.model, input: result.usage.input_tokens, output: result.usage.output_tokens, cached: result.usage.cache_read_input_tokens },
      text: { input, output: result.response.text || JSON.stringify(result.response.tool_calls), ...(reasoning ? { reasoning } : {}) },
    });
    if (!result.ok) throw new Error(`live model failed: ${result.code} (${[result.halted_by, result.scribe?.reason].filter(Boolean).join(': ') || result.reason})`);
    return result.response;
  };
  const ask = async (...args: Parameters<typeof complete>) => (await complete(...args)).text;
  const tree = new ConversationTree();
  let traceId = '';
  let pending: readonly LLMAttachment[] | undefined;
  const path = new JoinedConversationPath(adapters.contextComposer!, {
    complete: (request) => {
      const trace = traceId;
      return runToolLoop({
        handlers,
        maxSteps: MAX_TOOL_ROUNDS,
        ctx: { ...safety, session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: Date.now() }) },
        step: (tools, turns) => complete(trace, 'reply',
          [messagingSystemPrompt(handlers.map((handler) => handler.name)), ...(memory ? [memoryPrompt(memory.read())] : [])].join('\n\n'),
          request.messages.join('\n'),
          undefined,
          pending,
          tools,
          turns,
        ),
        onTool: (event) => log({ trace, hop: `tool_${event.call.name}`, ms: event.ms, ok: event.ok, text: { input: event.call.arguments, output: event.output } }),
      });
    },
  }, tree);
  let parentId: string | null = null;
  const restored = store ? restoreConversation(tree, store).then((leafId) => { parentId = leafId; }) : Promise.resolve();
  const converse = async (id: string, chatId: number, said: string, time: TurnTimer) => {
    traceId = id;
    const publication = await time('joined_path', () => path.submit({
      authenticatedOwnerId: ownerId, invocation,
      context: { snapshot_ref: fixture.snapshot_ref, snapshot_at: fixture.snapshot_at, canary_tokens: CANARIES, replay_context_ref: null },
      userEntry: { id, ownerId, chatId: `telegram-${chatId}`, parentId, threadAnchorId: null, surface: 'telegram', modelPayload: said, appPayload: said, modelProjection: { mode: 'include' } },
      assistantEntryId: `${id}-reply`,
    }));
    await store?.save([tree.get(id)!, tree.get(publication.leafId)!], publication.leafId);
    parentId = publication.leafId;
    return publication.text;
  };
  return {
    async respond(turn, time) {
      await restored;
      const id = `tg-${turn.updateId}`;
      const media = turn.media ? await time('media', () => loadTelegramMedia(turn.media!, readers)) : undefined;
      pending = media?.attachment ? [media.attachment] : undefined;
      const said = [turn.text, media?.note].filter(Boolean).join('\n');
      const text = await converse(id, turn.chatId, said, time);
      if (memory) {
        const files = memory.read();
        const started = Date.now();
        void ask(id, 'memory', MEMORY_UPDATE_INSTRUCTION, memoryUpdateInput(files, said, text), { name: 'memory_edits', schema: MEMORY_EDITS_SCHEMA })
          .then((raw) => log({ trace: id, hop: 'memory', ms: Date.now() - started, ok: true, detail: applyMemoryEdits(memory, raw, new Date().toISOString()).join(',') }))
          .catch((error: unknown) => log({ trace: id, hop: 'memory', ms: Date.now() - started, ok: false, error: String(error) }));
      }
      return text;
    },
    async remind(id, chatId, note, time) {
      await restored;
      pending = undefined;
      return converse(id, chatId, `[Reminder due now, set earlier by the owner: "${note}"] Send them this reminder now, in your own words.`, time);
    },
    async consolidate(trace, day) {
      if (!memory) return [];
      const raw = await ask(trace, 'nightly_memory', NIGHTLY_MEMORY_INSTRUCTION, nightlyMemoryInput(memory.read(), day), { name: 'memory_edits', schema: MEMORY_EDITS_SCHEMA });
      return applyMemoryEdits(memory, raw, new Date().toISOString());
    },
    chooseReaction: async (turn) => (JSON.parse(await ask(`tg-${turn.updateId}`, 'reaction', reactionInstruction(TELEGRAM_REACTIONS), turn.text, { name: 'reaction', schema: reactionSchema(TELEGRAM_REACTIONS) })) as { reaction?: string }).reaction ?? null,
  };
};
