import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { loopBook, loopsSection, openLoopsPrompt } from '../src/channels/loops';

// The owner tells Waldo in their own words that the interview a mail follow-up was tracking already happened. The model
// judges that this closes the item and calls close_loop on it; the item closes at once, and the ledger the next card reads
// lists it as done, not as open. The model is the only fake. Synthetic text only.
const proof = vi.hoisted(() => ({ outputs: [] as unknown[][], replies: [] as string[], requests: [] as string[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) proof.requests.push(JSON.stringify(input));
  return { id: 'mail-item-fixture-reply', output: format ? [] : proof.outputs.shift() ?? [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : proof.replies.shift() ?? 'Noted.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, body: any) =>
  method === 'sendMessage' ? { message_id: 1, chat: { id: body.chat_id } } : method === 'getMe' ? { username: 'fixture_bot' } : true }));
afterEach(() => { proof.outputs = []; proof.replies = []; proof.requests = []; });

const call = (call_id: string, name: string, args: unknown) => ({ type: 'function_call', call_id, name, arguments: JSON.stringify(args) });
const toolOutput = (callId: string) => {
  for (const request of proof.requests) {
    const { input } = JSON.parse(request) as { input: unknown };
    const item = Array.isArray(input) ? (input as { type?: string; call_id?: string; output?: string }[]).find(entry => entry.type === 'function_call_output' && entry.call_id === callId) : undefined;
    if (item) return item.output ?? '';
  }
  return null;
};

it('the owner saying a mail item is done closes it in that turn, and the next card\'s ledger no longer lists it as open', async () => {
  const name = `owner-closes-mail-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    const originalNow = Date.now;
    let now = Date.parse('2026-11-17T16:21:00Z');
    Date.now = () => now;
    const owner = new OwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', COMMON_OWNER_TASKS: '0', BROWSER: undefined } as never);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7'); state.storage.kv.put('origin', 'https://owner.fixture.invalid');
    const sql = state.storage.sql;
    const loops = loopBook(sql, { now: () => now, newId: () => crypto.randomUUID().slice(0, 8) });
    sql.exec("INSERT INTO observed_mail (source_ref, thread_id, observed_at, message_id, update_id) VALUES ('mail:thread-interview', 'thread-interview', 0, 'interview-1', 1)");
    const item = loops.open({ title: 'Confirm the interview slot with the recruiter', due: '2026-11-18T10:00', source_ref: 'mail:thread-interview' });
    // What the owner's turn reads with OWNER_CLOSES_MAIL_ITEMS on: the item, its id, its title quoted as data.
    expect(openLoopsPrompt(loops, 'UTC', 10_000, true)).toContain(`mail follow-up, completion unknown: "Confirm the interview slot with the recruiter" (due 2026-11-18 10:00) [${item.id}]`);
    try {
      proof.outputs.push([call('close-item', 'close_loop', { id: item.id, outcome: 'done' })], []);
      proof.replies.push('', 'Taken off your list.');
      expect((await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify(
        { update_id: 300, message: { message_id: 1, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: 'the interview already happened, that slot isn\'t open any more' } }) }))).status).toBe(200);
      for (let i = 0; i < 3; i++) { now += 61_000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); }

      expect(JSON.parse(toolOutput('close-item') ?? '{}')).toMatchObject({ ok: true, data: { id: item.id, closed: true } });
      expect(loops.get(item.id)?.status).toBe('done');
      const ledger = loopsSection(loops, 'UTC');
      expect(ledger).toContain('- nothing open');
      expect(ledger).not.toContain('completion unknown');
      expect(ledger).toContain('- done: Confirm the interview slot with the recruiter');
      expect(openLoopsPrompt(loops, 'UTC', 10_000, true)).toBe('');
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
}, 30_000);
