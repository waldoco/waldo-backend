import { readFile, writeFile } from 'node:fs/promises';
import {
  acceptTrustedInvocation, OPENAI_GPT_5_NANO_MODEL, OPENAI_PROVIDER, routingPolicySchema,
} from '@waldo/contracts';
import { localTrustedBriefScheduleInput, resolveRunLoopAdapters } from '../src/run-loop/adapters';
import { JoinedConversationPath, type JoinedConversationModel } from '../src/conversation/joined-path';
import { OpenAIGpt5NanoAdapter } from '../src/llm/openai';
import { RuntimeLLMProvider } from '../src/llm/provider';
import { TelegramPollingAdapter } from '../src/channels/telegram-polling';
import { TelegramOwnerListener } from '../src/channels/telegram-listener';
import { messagingSystemPrompt } from '../src/prompt/messaging-behavior';

const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
const ownerTelegramId = Number(process.env.WALDO_OWNER_TELEGRAM_ID ?? '0');
const offsetFile = process.env.WALDO_TELEGRAM_OFFSET_FILE ?? '/tmp/waldo-telegram-offset';
const telegram = async (method: string, body: object) => {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await response.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number };
  if (!json.ok) throw new Error(`telegram ${method} failed: ${json.error_code} ${json.description}`);
  return json.result;
};

const fixture = localTrustedBriefScheduleInput();
const accepted = acceptTrustedInvocation(fixture.admission);
if (!accepted.ok) throw new Error('fixture admission failed');
const invocation = accepted.value;
const ownerId = invocation.verified_authority.principal_ref;
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const runtime = new RuntimeLLMProvider({ gateway: new OpenAIGpt5NanoAdapter({ apiKey: process.env.OPENAI_API_KEY }) });
const canaries = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const model: JoinedConversationModel = {
  async complete(request) {
    const result = await runtime.complete({
      trigger: 'user_message',
      policy: routingPolicySchema.parse({ routes: [{ trigger: 'user_message', primary: { provider: OPENAI_PROVIDER, model: OPENAI_GPT_5_NANO_MODEL, cache: 'none', max_tokens: 4096 }, fallback: [], floor: 'template' }], escalation: [], template_fallback: false }),
      renderRequest: () => ({ system: messagingSystemPrompt(request.system, request.tools), messages: [{ role: 'user' as const, content: request.messages.join('\n') }], max_tokens: 4096, temperature: 0.2 }),
    }, {
      authenticatedUserId: ownerId, trigger: 'user_message', canaryTokens: canaries,
      sourceTaint: null, toolArgSourceTaint: null,
      sanitise: adapters.safety.sanitise, medicalGate: adapters.safety.medicalGate,
    });
    if (!result.ok) throw new Error(`live model failed: ${result.code}`);
    return result.response.text;
  },
};
const path = new JoinedConversationPath(adapters.contextComposer!, model);
let parentId: string | null = null;

const listener = new TelegramOwnerListener({
  ownerTelegramId,
  api: {
    setMessageReaction: (r) => telegram('setMessageReaction', r),
    sendChatAction: (r) => telegram('sendChatAction', r),
    sendMessage: (r) => telegram('sendMessage', r),
  },
  async respond(turn) {
    const id = `tg-${turn.updateId}`;
    const publication = await path.submit({
      authenticatedOwnerId: ownerId, invocation,
      context: { snapshot_ref: fixture.snapshot_ref, snapshot_at: fixture.snapshot_at, canary_tokens: canaries, replay_context_ref: null },
      userEntry: { id, ownerId, chatId: `telegram-${turn.chatId}`, parentId, threadAnchorId: null, surface: 'telegram', modelPayload: turn.text, appPayload: turn.text, modelProjection: { mode: 'include' } },
      assistantEntryId: `${id}-reply`,
    });
    parentId = publication.leafId;
    return publication.text;
  },
  saveOffset: (offset) => writeFile(offsetFile, String(offset)),
});

const stored = Number(await readFile(offsetFile, 'utf8').catch(() => process.env.WALDO_TELEGRAM_OFFSET ?? '0'));
const adapter = new TelegramPollingAdapter({ getUpdates: async (r) => await telegram('getUpdates', { ...r, allowed_updates: ['message'] }) as unknown[] }, stored);
console.log(new Date().toISOString(), 'listener started', { offset: adapter.offset() });
for (;;) {
  try {
    const outcomes = await listener.pollOnce(adapter, 25);
    if (outcomes.length > 0) console.log(new Date().toISOString(), 'turns', outcomes, { offset: adapter.offset() });
  } catch (error) {
    console.log(new Date().toISOString(), 'poll error', (error as Error).message.replace(/bot\d+:[\w-]+/g, 'bot<redacted>'));
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
