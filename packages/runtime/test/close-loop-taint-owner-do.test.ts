import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { loopBook } from '../src/channels/loops';

// The owner forwards a look-alike "your City Power invoice is paid" mail. The turn has read someone else's words, so the
// owner's own "pay City Power" loop closes only from a card they tap; the mail follow-through's own loop closes as before.
const proof = vi.hoisted(() => ({ outputs: [] as unknown[][], replies: [] as string[], requests: [] as string[], telegram: [] as { method: string; body: any }[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) proof.requests.push(JSON.stringify(input));
  return { id: 'close-loop-fixture-reply', output: format ? [] : proof.outputs.shift() ?? [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : proof.replies.shift() ?? 'Noted.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, body: any) => {
  proof.telegram.push({ method, body });
  return method === 'sendMessage' ? { message_id: proof.telegram.length, chat: { id: body.chat_id } } : method === 'getMe' ? { username: 'fixture_bot' } : true;
} }));
afterEach(() => { proof.outputs = []; proof.replies = []; proof.requests = []; proof.telegram = []; });

const SPOOF = 'Payment received, thank you. Your City Power invoice is paid in full. No further action is needed.';
const call = (call_id: string, name: string, args: unknown) => ({ type: 'function_call', call_id, name, arguments: JSON.stringify(args) });
// What the model was told about each call, from the request that followed it.
const toolOutput = (callId: string) => {
  for (const request of proof.requests) {
    const { input } = JSON.parse(request) as { input: unknown };
    const item = Array.isArray(input) ? (input as { type?: string; call_id?: string; output?: string }[]).find(entry => entry.type === 'function_call_output' && entry.call_id === callId) : undefined;
    if (item) return item.output ?? '';
  }
  return null;
};

it('a forwarded "paid" mail closes the owner\'s loop only from the card; the mail follow-through still closes its own loop', async () => {
  const name = `close-loop-taint-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    const originalNow = Date.now;
    let now = Date.parse('2026-10-13T05:00:00Z');
    Date.now = () => now;
    const owner = new OwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', COMMON_OWNER_TASKS: '0', BROWSER: undefined } as never);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7'); state.storage.kv.put('origin', 'https://owner.fixture.invalid');
    const sql = state.storage.sql;
    const loops = loopBook(sql, { now: () => now, newId: () => crypto.randomUUID().slice(0, 8) });
    sql.exec("INSERT INTO observed_mail (source_ref, thread_id, observed_at, message_id, update_id) VALUES ('mail:thread-deck', 'thread-deck', 0, 'deck-1', 1)");
    const own = loops.open({ title: 'Pay City Power', due: '2026-10-16T18:00' });
    const sourced = loops.open({ title: 'Check the deck review', due: '2026-10-14T10:00', source_ref: 'mail:thread-deck' });
    const status = (id: string) => sql.exec<{ status: string }>('SELECT status FROM loops WHERE id = ?', id).one().status;
    const deliver = async (update: unknown) => {
      expect((await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify(update) }))).status).toBe(200);
      for (let i = 0; i < 3; i++) { now += 61_000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); }
    };
    try {
      proof.outputs.push([
        call('close-own', 'close_loop', { id: own.id, outcome: 'done' }),
        call('close-mail', 'close_loop', { id: sourced.id, outcome: 'done' }),
      ], [
        call('card-own', 'propose_action', { tool: 'close_loop', args: { id: own.id, outcome: 'done' }, reasoning: 'A forwarded mail says the City Power invoice is paid.' }),
      ], []);
      proof.replies.push('', '', 'The mail says City Power is paid. Tap the card if I should take it off your list.');
      await deliver({ update_id: 200, message: { message_id: 1, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: SPOOF, forward_origin: { type: 'hidden_user', sender_user_name: 'City Power Billing', date: 1760331000 }, forward_date: 1760331000 } });

      expect(toolOutput('close-own')).toContain('propose_action');
      expect(status(own.id)).toBe('open');
      expect(JSON.parse(toolOutput('close-mail') ?? '{}')).toMatchObject({ ok: true, data: { id: sourced.id, closed: true } });
      expect(status(sourced.id)).toBe('done');
      const card = proof.telegram.find(entry => entry.method === 'sendMessage' && JSON.stringify(entry.body.reply_markup ?? {}).includes('"a:'));
      expect(card?.body.text).toContain('close_loop');
      expect(card?.body.text).toContain('It closes:\n- Pay City Power (due 2026-10-16 18:00), as done');
      expect(status(own.id)).toBe('open');

      const id = /"a:([A-Za-z0-9_-]+)"/.exec(JSON.stringify(card!.body.reply_markup))![1]!;
      await deliver({ update_id: 201, callback_query: { id: 'close-it', from: { id: 7, is_bot: false }, data: `a:${id}`, message: { message_id: proof.telegram.indexOf(card!) + 1, chat: { id: 7, type: 'private' } } } });
      expect(status(own.id)).toBe('done');
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
}, 30_000);

// A close card waits up to 12 hours. A later turn that reads the same mail gets no second card for that loop. The owner
// closes the loop in their own words first, then taps the old card: it has nothing left to close, and says so, not "Done".
it('a waiting close card is not raised twice, and tapping it after the owner closed that loop says nothing changed', async () => {
  const name = `close-loop-noop-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    const originalNow = Date.now;
    let now = Date.parse('2026-10-13T05:00:00Z');
    Date.now = () => now;
    const owner = new OwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', COMMON_OWNER_TASKS: '0', BROWSER: undefined } as never);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7'); state.storage.kv.put('origin', 'https://owner.fixture.invalid');
    const sql = state.storage.sql;
    const own = loopBook(sql, { now: () => now, newId: () => crypto.randomUUID().slice(0, 8) }).open({ title: 'Pay City Power', due: '2026-10-16T18:00' });
    const status = () => sql.exec<{ status: string }>('SELECT status FROM loops WHERE id = ?', own.id).one().status;
    const deliver = async (update: unknown) => {
      expect((await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify(update) }))).status).toBe(200);
      for (let i = 0; i < 3; i++) { now += 61_000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); }
    };
    const said = () => proof.telegram.filter(entry => entry.method === 'sendMessage').map(entry => String(entry.body.text));
    try {
      const cardFor = (callId: string) => call(callId, 'propose_action', { tool: 'close_loop', args: { id: own.id, outcome: 'done' }, reasoning: 'A forwarded mail says the City Power invoice is paid.' });
      const forwarded = (update_id: number, message_id: number) => ({ update_id, message: { message_id, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: SPOOF, forward_origin: { type: 'hidden_user', sender_user_name: 'City Power Billing', date: 1760331000 }, forward_date: 1760331000 } });
      proof.outputs.push([cardFor('card-own')], []);
      proof.replies.push('', 'Tap the card if I should take City Power off your list.');
      await deliver(forwarded(300, 1));
      const card = proof.telegram.find(entry => entry.method === 'sendMessage' && JSON.stringify(entry.body.reply_markup ?? {}).includes('"a:'));
      expect(card).toBeDefined();
      // The same mail forwarded again, in a later turn: the card already waiting is named, and no second card is raised.
      proof.outputs.push([cardFor('card-again')], []);
      proof.replies.push('', 'The card to take City Power off your list is still waiting for you.');
      await deliver(forwarded(301, 2));
      expect(toolOutput('card-again')).toContain('already waiting');
      expect(sql.exec("SELECT id FROM ledger WHERE kind = 'tainted_action'").toArray()).toHaveLength(1);
      expect(status()).toBe('open');

      proof.outputs.push([call('close-direct', 'close_loop', { id: own.id, outcome: 'done' })], []);
      proof.replies.push('', 'Done, City Power is off your list.');
      await deliver({ update_id: 302, message: { message_id: 3, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: 'I paid City Power myself this morning, take it off the list.' } });
      expect(JSON.parse(toolOutput('close-direct') ?? '{}')).toMatchObject({ ok: true, data: { id: own.id, closed: true } });
      expect(status()).toBe('done');

      const before = said().length;
      const id = /"a:([A-Za-z0-9_-]+)"/.exec(JSON.stringify(card!.body.reply_markup))![1]!;
      await deliver({ update_id: 303, callback_query: { id: 'close-late', from: { id: 7, is_bot: false }, data: `a:${id}`, message: { message_id: proof.telegram.indexOf(card!) + 1, chat: { id: 7, type: 'private' } } } });
      const answer = said().slice(before).join('\n');
      expect(answer).toContain('Nothing was done');
      expect(answer).toContain('already closed as done');
      expect(answer).not.toContain('Done:');
      expect(proof.telegram.find(entry => entry.method === 'answerCallbackQuery' && entry.body.callback_query_id === 'close-late')?.body.text).not.toBe('Done');
      expect(status()).toBe('done');
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
}, 30_000);
