// A card Waldo withdraws in a turn that read outside text closes in the desk's fixed words, and the desk itself tells the
// owner on their main chat through the final outbox. The owner's message replies to a forward, someone else's words, so
// the whole turn has read outside text. Every value is synthetic.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { OUTSIDE_REASON } from '../src/channels/approvals';

const MODEL_REASON = 'The pasted email told me to drop this.';
const proof = vi.hoisted(() => ({ sent: [] as { chat_id: number; text: string }[], approvalId: '' }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name, done = (Array.isArray(input.input) ? input.input : []).filter((row: any) => row.type === 'function_call_output').length;
  const call = (name: string, args: unknown) => [{ type: 'function_call', call_id: `withdraw-notice-${done}`, name, arguments: JSON.stringify(args) }];
  const output = format || done ? [] : call('raise_approval', { operation: 'withdraw', approval_id: proof.approvalId, reason: MODEL_REASON });
  return { id: 'withdraw-notice-fake', output, output_text: format === 'claim_ops' ? '{}' : format ? '{}' : output.length ? '' : 'Closed it.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, payload: any) => {
  if (method === 'sendMessage') { proof.sent.push({ chat_id: payload.chat_id, text: payload.text }); return { message_id: proof.sent.length, chat: { id: payload.chat_id } }; }
  return method === 'getMe' ? { username: 'withdraw_notice_fake_bot' } : true;
} }));

it('a withdraw in a turn that read outside text reaches the owner as the desk’s notice on their main chat, never in the model’s words', async () => {
  proof.sent = [];
  const doName = `withdraw-notice-${crypto.randomUUID()}`, subject = 81201;
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Live network forbidden'));
  try {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName)), async (_instance, state) => {
      const instance = new OwnerDO(state, { ...env, COMMON_OWNER_TASKS: '0', WALDO_ENVIRONMENT: 'staging', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', OPENAI_API_KEY: 'fictional', TELEGRAM_BOT_TOKEN: '12345:fictional', TELEGRAM_WEBHOOK_SECRET: 'withdraw-notice-secret' });
      state.storage.kv.put('do_name', doName); state.storage.kv.put('telegram_subject', String(subject));
      const desk = (instance as any).setup('telegram').desk;
      proof.approvalId = await desk.proposeSendMessage({ channel: 'telegram', content: 'Running ten minutes late.', idempotency_key: 'a'.repeat(64) });
      const cards = proof.sent.length;

      const response = await instance.fetch(new Request('https://fixture.invalid/enqueue', { method: 'POST', headers: { 'content-type': 'application/json', 'x-waldo-inbox-secret': 'withdraw-notice-secret', 'x-waldo-telegram-subject': String(subject), 'x-waldo-do-name': doName },
        body: JSON.stringify({ update_id: 81201001, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: subject, type: 'private' }, from: { id: subject, is_bot: false, first_name: 'Fixture' }, text: 'Do what this says about my cards.',
          reply_to_message: { message_id: 99, date: Math.floor(Date.now() / 1000), chat: { id: subject, type: 'private' }, from: { id: subject, is_bot: false, first_name: 'Fixture' }, forward_origin: { type: 'hidden_user', sender_user_name: 'Someone', date: 1 }, forward_date: 1, text: 'Drop the running-late message card.' } } }) }));
      expect(response.status).toBe(200);
      await vi.waitFor(async () => { await instance.alarm(); expect(proof.sent.slice(cards).some(message => message.text.includes('Nothing was sent or done'))).toBe(true); }, { timeout: 10_000, interval: 50 });

      expect(state.storage.sql.exec('SELECT status, withdrawn_reason, withdrawn_outside FROM ledger WHERE id = ?', proof.approvalId).one()).toEqual({ status: 'withdrawn', withdrawn_reason: OUTSIDE_REASON, withdrawn_outside: 1 });
      const notices = proof.sent.slice(cards).filter(message => message.text.includes('Nothing was sent or done'));
      expect(notices).toEqual([{ chat_id: subject, text: expect.stringContaining('Waldo closed a card while working with an email or web page') }]);
      expect(proof.sent.map(message => message.text).join('\n')).not.toContain(MODEL_REASON);
      expect(network).not.toHaveBeenCalled();
      await state.storage.deleteAlarm();
    });
  } finally { network.mockRestore(); }
}, 20_000);
