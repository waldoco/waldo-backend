import {
  acceptTrustedInvocation, ConversationTree, OPENAI_GPT_5_NANO_MODEL, OPENAI_PROVIDER, routingPolicySchema,
} from '@waldo/contracts';
import { localTrustedBriefScheduleInput, resolveRunLoopAdapters } from '../run-loop/adapters';
import { JoinedConversationPath } from '../conversation/joined-path';
import { OpenAIGpt5NanoAdapter } from '../llm/openai';
import { RuntimeLLMProvider } from '../llm/provider';
import { messagingSystemPrompt } from '../prompt/messaging-behavior';
import { applyMemoryEdits, MEMORY_UPDATE_INSTRUCTION, memoryPrompt, memoryUpdateInput, type CoreFileStore } from '../memory/core-files';
import { restoreConversation, type ConversationStore } from './conversation-store';
import { reactionInstruction, TELEGRAM_REACTIONS } from './reactions';
import type { TelegramOwnerListenerOptions, TurnLogEntry } from './telegram-listener';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];

// Staging responder: the fixture invocation stands in for real per-user admission,
// which the production tenancy work replaces.
export const createTelegramResponder = (
  openaiApiKey: string,
  store?: ConversationStore,
  memory?: CoreFileStore,
  log: (entry: TurnLogEntry) => void = () => undefined,
): Pick<TelegramOwnerListenerOptions, 'respond' | 'chooseReaction'> => {
  const fixture = localTrustedBriefScheduleInput();
  const accepted = acceptTrustedInvocation(fixture.admission);
  if (!accepted.ok) throw new Error('fixture admission failed');
  const invocation = accepted.value;
  const ownerId = invocation.verified_authority.principal_ref;
  const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
  const runtime = new RuntimeLLMProvider({ gateway: new OpenAIGpt5NanoAdapter({ apiKey: openaiApiKey }) });
  const policy = routingPolicySchema.parse({ routes: [{ trigger: 'user_message', primary: { provider: OPENAI_PROVIDER, model: OPENAI_GPT_5_NANO_MODEL, cache: 'none', max_tokens: 4096 }, fallback: [], floor: 'template' }], escalation: [], template_fallback: false });
  const ask = async (system: string, content: string) => {
    const result = await runtime.complete({
      trigger: 'user_message',
      policy,
      renderRequest: () => ({ system, messages: [{ role: 'user' as const, content }], max_tokens: 4096, temperature: 0.2 }),
    }, {
      authenticatedUserId: ownerId, trigger: 'user_message', canaryTokens: CANARIES,
      sourceTaint: null, toolArgSourceTaint: null,
      sanitise: adapters.safety.sanitise, medicalGate: adapters.safety.medicalGate,
    });
    if (!result.ok) throw new Error(`live model failed: ${result.code} (${[result.halted_by, result.scribe?.reason].filter(Boolean).join(': ') || result.reason})`);
    return result.response.text;
  };
  const tree = new ConversationTree();
  const path = new JoinedConversationPath(adapters.contextComposer!, {
    complete: (request) => ask(
      [messagingSystemPrompt(request.system, request.tools), ...(memory ? [memoryPrompt(memory.read())] : [])].join('\n\n'),
      request.messages.join('\n'),
    ),
  }, tree);
  let parentId: string | null = null;
  const restored = store ? restoreConversation(tree, store).then((leafId) => { parentId = leafId; }) : Promise.resolve();
  return {
    async respond(turn, time) {
      await restored;
      const id = `tg-${turn.updateId}`;
      const publication = await time('joined_path', () => path.submit({
        authenticatedOwnerId: ownerId, invocation,
        context: { snapshot_ref: fixture.snapshot_ref, snapshot_at: fixture.snapshot_at, canary_tokens: CANARIES, replay_context_ref: null },
        userEntry: { id, ownerId, chatId: `telegram-${turn.chatId}`, parentId, threadAnchorId: null, surface: 'telegram', modelPayload: turn.text, appPayload: turn.text, modelProjection: { mode: 'include' } },
        assistantEntryId: `${id}-reply`,
      }));
      await store?.save([tree.get(id)!, tree.get(publication.leafId)!], publication.leafId);
      parentId = publication.leafId;
      if (memory) {
        const files = memory.read();
        const started = Date.now();
        void ask(MEMORY_UPDATE_INSTRUCTION, memoryUpdateInput(files, turn.text, publication.text))
          .then((raw) => log({ trace: id, hop: 'memory', ms: Date.now() - started, ok: true, detail: applyMemoryEdits(memory, raw, new Date().toISOString()).join(',') }))
          .catch((error: unknown) => log({ trace: id, hop: 'memory', ms: Date.now() - started, ok: false, error: String(error) }));
      }
      return publication.text;
    },
    chooseReaction: (turn) => ask(reactionInstruction(TELEGRAM_REACTIONS), turn.text),
  };
};
