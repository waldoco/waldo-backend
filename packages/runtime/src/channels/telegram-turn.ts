import {
  acceptTrustedInvocation, ConversationTree, OPENAI_PROVIDER, routingPolicySchema, WALDO_CHAT_MODEL,
} from '@waldo/contracts';
import { localTrustedBriefScheduleInput, resolveRunLoopAdapters } from '../run-loop/adapters';
import { JoinedConversationPath } from '../conversation/joined-path';
import { OpenAIResponsesAdapter } from '../llm/openai';
import { InMemoryCircuitBreaker, RuntimeLLMProvider } from '../llm/provider';
import { messagingSystemPrompt } from '../prompt/messaging-behavior';
import { applyMemoryEdits, MEMORY_EDITS_SCHEMA, MEMORY_UPDATE_INSTRUCTION, memoryPrompt, memoryUpdateInput, type CoreFileStore } from '../memory/core-files';
import { restoreConversation, type ConversationStore } from './conversation-store';
import { reactionInstruction, reactionSchema, TELEGRAM_REACTIONS } from './reactions';
import type { TelegramOwnerListenerOptions, TurnLogEntry } from './telegram-listener';
import { loadTelegramMedia, type MediaReaders } from './telegram-media';
import type { LLMAttachment } from '@waldo/contracts';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];

// Staging responder: the fixture invocation stands in for real per-user admission,
// which the production tenancy work replaces.
export const createTelegramResponder = (
  openaiApiKey: string,
  store?: ConversationStore,
  memory?: CoreFileStore,
  log: (entry: TurnLogEntry) => void = () => undefined,
  readers: MediaReaders = {},
): Pick<TelegramOwnerListenerOptions, 'respond' | 'chooseReaction'> => {
  const fixture = localTrustedBriefScheduleInput();
  const accepted = acceptTrustedInvocation(fixture.admission);
  if (!accepted.ok) throw new Error('fixture admission failed');
  const invocation = accepted.value;
  const ownerId = invocation.verified_authority.principal_ref;
  const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
  const circuitBreaker = new InMemoryCircuitBreaker();
  const policy = routingPolicySchema.parse({ routes: [{ trigger: 'user_message', primary: { provider: OPENAI_PROVIDER, model: WALDO_CHAT_MODEL, cache: 'none', max_tokens: 4096 }, fallback: [], floor: 'template' }], escalation: [], template_fallback: false });
  const ask = async (trace: string, purpose: string, system: string, content: string, format?: Readonly<{ name: string; schema: Record<string, unknown> }>, attachments?: readonly LLMAttachment[]) => {
    const started = Date.now();
    let reasoning: string | undefined;
    const gateway = new OpenAIResponsesAdapter({ apiKey: openaiApiKey, onResponseMetadata: (metadata) => { reasoning = metadata.reasoning; } });
    const result = await new RuntimeLLMProvider({ gateway, circuitBreaker }).complete({
      trigger: 'user_message',
      policy,
      renderRequest: () => ({ system, messages: [{ role: 'user' as const, content }], max_tokens: 4096, temperature: 0.2, ...(format ? { response_format: format } : {}), ...(attachments ? { attachments: [...attachments] } : {}) }),
    }, {
      authenticatedUserId: ownerId, trigger: 'user_message', canaryTokens: CANARIES,
      sourceTaint: null, toolArgSourceTaint: null,
      sanitise: adapters.safety.sanitise, medicalGate: adapters.safety.medicalGate,
    });
    const input = JSON.stringify([{ role: 'system', content: system }, { role: 'user', content, ...(attachments ? { attachments: attachments.map((file) => `${file.kind}:${file.filename}`) } : {}) }]);
    if (!result.ok) log({ trace, hop: `llm_${purpose}`, ms: Date.now() - started, ok: false, error: [result.code, result.halted_by].filter(Boolean).join(':'), text: { input } });
    else log({
      trace, hop: `llm_${purpose}`, ms: result.usage.latency_ms, ok: true,
      usage: { model: result.usage.model, input: result.usage.input_tokens, output: result.usage.output_tokens, cached: result.usage.cache_read_input_tokens },
      text: { input, output: result.response.text, ...(reasoning ? { reasoning } : {}) },
    });
    if (!result.ok) throw new Error(`live model failed: ${result.code} (${[result.halted_by, result.scribe?.reason].filter(Boolean).join(': ') || result.reason})`);
    return result.response.text;
  };
  const tree = new ConversationTree();
  let traceId = '';
  let pending: readonly LLMAttachment[] | undefined;
  const path = new JoinedConversationPath(adapters.contextComposer!, {
    complete: (request) => ask(traceId, 'reply',
      [messagingSystemPrompt(request.system, request.tools), ...(memory ? [memoryPrompt(memory.read())] : [])].join('\n\n'),
      request.messages.join('\n'),
      undefined,
      pending,
    ),
  }, tree);
  let parentId: string | null = null;
  const restored = store ? restoreConversation(tree, store).then((leafId) => { parentId = leafId; }) : Promise.resolve();
  return {
    async respond(turn, time) {
      await restored;
      const id = `tg-${turn.updateId}`;
      traceId = id;
      const media = turn.media ? await time('media', () => loadTelegramMedia(turn.media!, readers)) : undefined;
      pending = media?.attachment ? [media.attachment] : undefined;
      const said = [turn.text, media?.note].filter(Boolean).join('\n');
      const publication = await time('joined_path', () => path.submit({
        authenticatedOwnerId: ownerId, invocation,
        context: { snapshot_ref: fixture.snapshot_ref, snapshot_at: fixture.snapshot_at, canary_tokens: CANARIES, replay_context_ref: null },
        userEntry: { id, ownerId, chatId: `telegram-${turn.chatId}`, parentId, threadAnchorId: null, surface: 'telegram', modelPayload: said, appPayload: said, modelProjection: { mode: 'include' } },
        assistantEntryId: `${id}-reply`,
      }));
      await store?.save([tree.get(id)!, tree.get(publication.leafId)!], publication.leafId);
      parentId = publication.leafId;
      if (memory) {
        const files = memory.read();
        const started = Date.now();
        void ask(id, 'memory', MEMORY_UPDATE_INSTRUCTION, memoryUpdateInput(files, said, publication.text), { name: 'memory_edits', schema: MEMORY_EDITS_SCHEMA })
          .then((raw) => log({ trace: id, hop: 'memory', ms: Date.now() - started, ok: true, detail: applyMemoryEdits(memory, raw, new Date().toISOString()).join(',') }))
          .catch((error: unknown) => log({ trace: id, hop: 'memory', ms: Date.now() - started, ok: false, error: String(error) }));
      }
      return publication.text;
    },
    chooseReaction: async (turn) => (JSON.parse(await ask(`tg-${turn.updateId}`, 'reaction', reactionInstruction(TELEGRAM_REACTIONS), turn.text, { name: 'reaction', schema: reactionSchema(TELEGRAM_REACTIONS) })) as { reaction?: string }).reaction ?? null,
  };
};
