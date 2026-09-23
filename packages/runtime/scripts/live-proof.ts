import { createHash } from 'node:crypto';
import {
  acceptTrustedInvocation, ActivityLedgerModule, ApprovalQueueModule,
  OPENAI_GPT_5_NANO_MODEL, OPENAI_PROVIDER, routingPolicySchema,
} from '@waldo/contracts';
import { localTrustedBriefScheduleInput, resolveRunLoopAdapters } from '../src/run-loop/adapters';
import { JoinedConversationPath, type JoinedConversationModel } from '../src/conversation/joined-path';
import { OpenAIGpt5NanoAdapter, type OpenAIResponseMetadata } from '../src/llm/openai';
import { RuntimeLLMProvider } from '../src/llm/provider';
import { TelegramPollingAdapter } from '../src/channels/telegram-polling';

const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
const ownerTelegramId = Number(process.env.WALDO_OWNER_TELEGRAM_ID ?? '0');
const telegram = async (method: string, body: object) => {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await response.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number };
  if (!json.ok) throw new Error(`telegram ${method} failed: ${json.error_code} ${json.description}`);
  return json.result;
};
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

const fixture = localTrustedBriefScheduleInput();
const accepted = acceptTrustedInvocation(fixture.admission);
if (!accepted.ok) throw new Error('fixture admission failed');
const invocation = accepted.value;
const ownerId = invocation.verified_authority.principal_ref;
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
let metadata: OpenAIResponseMetadata | undefined;
const runtime = new RuntimeLLMProvider({ gateway: new OpenAIGpt5NanoAdapter({ apiKey: process.env.OPENAI_API_KEY, onResponseMetadata: (m) => { metadata = m; } }) });
const model: JoinedConversationModel = {
  async complete(request) {
    const result = await runtime.complete({
      trigger: 'user_message',
      policy: routingPolicySchema.parse({ routes: [{ trigger: 'user_message', primary: { provider: OPENAI_PROVIDER, model: OPENAI_GPT_5_NANO_MODEL, cache: 'none', max_tokens: 4096 }, fallback: [], floor: 'template' }], escalation: [], template_fallback: false }),
      renderRequest: () => ({ system: request.system, messages: [{ role: 'user' as const, content: request.messages.join('\n') }], max_tokens: 4096, temperature: 0.2 }),
    }, {
      authenticatedUserId: ownerId, trigger: 'user_message',
      canaryTokens: ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'],
      sourceTaint: null, toolArgSourceTaint: null,
      sanitise: adapters.safety.sanitise, medicalGate: adapters.safety.medicalGate,
    });
    if (!result.ok) throw new Error(`live model failed: ${result.code} ${JSON.stringify((result as { error?: unknown }).error ?? null).slice(0, 300)}`);
    return result.response.text;
  },
};
const path = new JoinedConversationPath(adapters.contextComposer!, model);

let text = 'Live proof: reply with one short sentence confirming you received this.';
let chatId: number | null = null;
if (process.argv.includes('--telegram')) {
  if (!ownerTelegramId) throw new Error('WALDO_OWNER_TELEGRAM_ID is required for the Telegram round-trip');
  const poller = new TelegramPollingAdapter({ getUpdates: async (r) => await telegram('getUpdates', r) as unknown[] }, Number(process.env.WALDO_TELEGRAM_OFFSET ?? '0'));
  const polled = await poller.poll(Number(process.env.WALDO_TELEGRAM_WAIT ?? '25'));
  const turn = polled.accepted.filter((item) => item.senderId === ownerTelegramId && item.chatId === ownerTelegramId).at(-1);
  console.log('telegram poll', { nextOffset: polled.nextOffset, accepted: polled.accepted.length, dropped: polled.dropped, ownerTurn: !!turn });
  if (!turn) throw new Error('no owner Telegram message in this poll window');
  text = turn.text;
  chatId = turn.chatId;
}

const publication = await path.submit({
  authenticatedOwnerId: ownerId, invocation,
  context: { snapshot_ref: fixture.snapshot_ref, snapshot_at: fixture.snapshot_at, canary_tokens: ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'], replay_context_ref: null },
  userEntry: { id: 'live-user-1', ownerId, chatId: 'live-chat', parentId: null, threadAnchorId: null, surface: chatId ? 'telegram' : 'cli', modelPayload: text, appPayload: text, modelProjection: { mode: 'include' } },
  assistantEntryId: 'live-assistant-1',
});
console.log('joined path', { leafId: publication.leafId, promptDigest: publication.promptDigest, replyChars: publication.text.length, response: metadata && { id: metadata.response_id, model: metadata.model, in: metadata.input_tokens, out: metadata.output_tokens, ms: metadata.latency_ms } });
console.log('reply', publication.text);

if (chatId !== null) {
  const sent = await telegram('sendMessage', { chat_id: chatId, text: publication.text }) as { message_id: number };
  console.log('telegram send', { ok: true, messageId: sent.message_id });
}

const now = Date.now();
const approvals = new ApprovalQueueModule();
const activity = new ActivityLedgerModule();
const payload = JSON.stringify({ reply: publication.text, leaf: publication.leafId });
const approval = approvals.propose(ownerId, { approvalId: 'live-ap-1', ownerId, operation: 'channel.reply.send', effectClass: 'irreversible', payloadDigest: digest(payload), manifestDigest: digest(publication.promptDigest), generation: 1, summary: 'Send the live reply', telegramScope: false, createdAt: now, expiresAt: now + 600_000 });
activity.append(ownerId, { entryId: 'act-1', ownerId, subjectRef: approval.approvalId, kind: 'proposed', at: now, summary: approval.summary, evidenceRef: null, undoable: false });
let substitution = 'accepted';
try { approvals.decide(ownerId, { approvalId: 'live-ap-1', decision: 'approve', payloadDigest: digest(`${payload}x`), generation: 1, surface: 'app', at: now + 1 }); } catch (error) { substitution = (error as Error).message; }
let telegramSurface = 'accepted';
try { approvals.decide(ownerId, { approvalId: 'live-ap-1', decision: 'approve', payloadDigest: digest(payload), generation: 1, surface: 'telegram', at: now + 1 }); } catch (error) { telegramSurface = (error as Error).message; }
approvals.decide(ownerId, { approvalId: 'live-ap-1', decision: 'approve', payloadDigest: digest(payload), generation: 1, surface: 'app', at: now + 2 });
activity.append(ownerId, { entryId: 'act-2', ownerId, subjectRef: approval.approvalId, kind: 'approved', at: now + 2, summary: 'Approved in app', evidenceRef: null, undoable: false });
approvals.consume(ownerId, 'live-ap-1', digest(payload), 1, now + 3);
let replay = 'accepted';
try { approvals.consume(ownerId, 'live-ap-1', digest(payload), 1, now + 4); } catch (error) { replay = (error as Error).message; }
activity.append(ownerId, { entryId: 'act-3', ownerId, subjectRef: approval.approvalId, kind: 'completed', at: now + 5, summary: 'Reply recorded', evidenceRef: publication.leafId, undoable: false });
console.log('s7', { substitution, telegramSurface, replay, feed: activity.feed(ownerId).map((e) => e.kind), controls: activity.controls(ownerId, 'live-ap-1') });
