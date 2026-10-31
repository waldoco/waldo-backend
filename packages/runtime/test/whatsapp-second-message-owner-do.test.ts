// What happens when the owner sends a second WhatsApp message while the first one's turn is still running: each message is a
// durable inbox row, the alarm runs them in order with the app's 15-minute deadline, and a turn that is cut off or fails gets
// one notice quoting the message it was for (docs/proposals/WALDO_SECOND_MESSAGE_DESIGN_2026-10-31.md, slices 3 and 6).
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { WA_UPDATE_BASE, WHATSAPP_PARTIAL_NOTICE, WHATSAPP_TYPING_REFRESH_MS } from '../src/channels/whatsapp-api';
import { WHATSAPP_INBOX_MAX_OPEN, WHATSAPP_TURN_DEADLINE_MS, WhatsAppOwnerInbox } from '../src/channels/whatsapp-inbox';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

// The first owner turn waits on `hold`; each reply names the turn it answers.
const model = vi.hoisted(() => ({ turns: [] as string[], hold: null as null | Promise<void> }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: { input?: unknown; text?: { format?: { name?: string } } }) => {
  const format = input.text?.format?.name;
  if (!format) {
    model.turns.push(JSON.stringify(input.input ?? ''));
    if (model.turns.length === 1 && model.hold) await model.hold;
  }
  const text = format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : `Reply to turn ${model.turns.length}.`;
  return { id: 'fixture', output_text: text, output: [], usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));

afterEach(() => { vi.restoreAllMocks(); model.turns = []; model.hold = null; });

const SUBJECT = '15550001111';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

type Sent = { text: string; quote: string | null };
type Typing = { id: string; at: number };
type World = { instance: OwnerDO; state: DurableObjectState; inbox: WhatsAppOwnerInbox; sent: Sent[]; typing: Typing[]; replies: () => string[] };
const harness = (name: string, work: (world: World) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const sent: Sent[] = [], typing: Typing[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const body = String(input).startsWith('https://graph.facebook.com/') && init?.body
        ? JSON.parse(String(init.body)) as { text?: { body?: string }; context?: { message_id?: string }; message_id?: string; typing_indicator?: unknown } : null;
      if (body?.typing_indicator) typing.push({ id: body.message_id!, at: Date.now() });
      else if (body) sent.push({ text: String(body.text?.body ?? ''), quote: body.context?.message_id ?? null });
      return Response.json({ messages: [{ id: `wamid.out.${sent.length}` }] });
    });
    const instance = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    const replies = () => sent.map(row => row.text).filter(text => text.startsWith('Reply to turn'));
    try { await work({ instance, state, inbox: new WhatsAppOwnerInbox(state.storage), sent, typing, replies }); } finally { await state.storage.deleteAlarm(); }
  });
const post = (instance: OwnerDO, id: string, body: string) => instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
  method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT },
  body: JSON.stringify({ messages: [{ from: SUBJECT, id, type: 'text', text: { body } }] }),
}));
const states = (inbox: WhatsAppOwnerInbox) => inbox.records().map(row => [row.wamid, row.state]);

it('B is a durable row while A runs: Meta gets its 200 at once, A is not steered, and the same pass answers both, A first', async () => {
  await harness('whatsapp-second-message-queue', async ({ instance, inbox, replies }) => {
    const gate = deferred(); model.hold = gate.promise;
    expect((await post(instance, 'wamid.second.A', 'Find me three flights to Goa for Friday.')).status).toBe(200);
    // Admission runs nothing: the turn waits for the alarm.
    expect(states(inbox)).toEqual([['wamid.second.A', 'admitted']]);
    expect(model.turns).toEqual([]);
    const drained = drainWhatsAppTurns(instance);
    await vi.waitFor(() => expect(model.turns).toHaveLength(1), { timeout: 10_000, interval: 20 });

    expect((await post(instance, 'wamid.second.B', 'Also, is it raining in Pune?')).status).toBe(200);
    expect(states(inbox)).toEqual([['wamid.second.A', 'running'], ['wamid.second.B', 'admitted']]);

    gate.resolve();
    await drained;
    expect(model.turns[0]).not.toContain('raining in Pune');
    expect(model.turns[1]).toContain('raining in Pune');
    expect(replies()).toEqual(['Reply to turn 1.', 'Reply to turn 2.']);
    expect(states(inbox)).toEqual([['wamid.second.A', 'completed'], ['wamid.second.B', 'completed']]);
    expect(inbox.records().map(row => row.update)).toEqual([null, null]);
  });
});

it('a turn that runs past the old 150 seconds still replies; one past its 15 minutes gets the notice quoting its message, then B runs', async () => {
  await harness('whatsapp-second-message-deadline', async ({ instance, sent, replies }) => {
    const realNow = Date.now.bind(Date);
    let ahead = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ahead);
    const first = deferred(); model.hold = first.promise;
    expect((await post(instance, 'wamid.long.A', 'Research the best Goa hotels for Friday.')).status).toBe(200);
    const drained = drainWhatsAppTurns(instance);
    await vi.waitFor(() => expect(model.turns).toHaveLength(1), { timeout: 10_000, interval: 20 });
    ahead = 151_000;
    first.resolve();
    await drained;
    expect(replies()).toEqual(['Reply to turn 1.']);
    expect(sent.map(row => row.text)).not.toContain(WHATSAPP_PARTIAL_NOTICE);

    model.turns = [];
    const second = deferred(); model.hold = second.promise;
    expect((await post(instance, 'wamid.long.C', 'Plan my whole week.')).status).toBe(200);
    const late = drainWhatsAppTurns(instance);
    await vi.waitFor(() => expect(model.turns).toHaveLength(1), { timeout: 10_000, interval: 20 });
    expect((await post(instance, 'wamid.long.D', 'Also, is it raining in Pune?')).status).toBe(200);
    ahead += WHATSAPP_TURN_DEADLINE_MS + 1_000;
    second.resolve();
    await late;
    const notice = sent.findIndex(row => row.text === WHATSAPP_PARTIAL_NOTICE);
    expect(sent[notice]).toEqual({ text: WHATSAPP_PARTIAL_NOTICE, quote: 'wamid.long.C' });
    expect(replies()).toEqual(['Reply to turn 1.', 'Reply to turn 2.']);
    expect(sent.findIndex(row => row.text === 'Reply to turn 2.')).toBeGreaterThan(notice);
  });
});

it('after an eviction, the turn that was running gets one notice quoting its message, and the message behind it is answered, not lost', async () => {
  await harness('whatsapp-second-message-eviction', async ({ instance, inbox, sent, replies }) => {
    expect((await post(instance, 'wamid.evict.A', 'Book me a table for Friday.')).status).toBe(200);
    expect((await post(instance, 'wamid.evict.B', 'Also, is it raining in Pune?')).status).toBe(200);
    // A was running in an instance that is gone: its attempt is live nowhere.
    inbox.claimNext(Date.now() + WHATSAPP_TURN_DEADLINE_MS);
    await drainWhatsAppTurns(instance);
    expect(sent.filter(row => row.text === WHATSAPP_PARTIAL_NOTICE)).toEqual([{ text: WHATSAPP_PARTIAL_NOTICE, quote: 'wamid.evict.A' }]);
    expect(model.turns).toHaveLength(1);
    expect(model.turns[0]).toContain('raining in Pune');
    expect(replies()).toEqual(['Reply to turn 1.']);
    expect(states(inbox)).toEqual([['wamid.evict.A', 'interrupted'], ['wamid.evict.B', 'completed']]);
    await drainWhatsAppTurns(instance);
    expect(sent.filter(row => row.text === WHATSAPP_PARTIAL_NOTICE)).toHaveLength(1);
  });
});

it('a row whose sender is no longer this owner\'s number runs fenced and closes without a notice; the drain goes on to the next row and stops', async () => {
  await harness('whatsapp-second-message-fenced-row', async ({ instance, state, inbox, sent, replies }) => {
    expect((await post(instance, 'wamid.fenced.B', 'Also, is it raining in Pune?')).status).toBe(200);
    // A row queued under a number that is no longer bound, ahead of B, as if the binding moved without its rows being revoked.
    const b = inbox.records()[0]!;
    state.storage.kv.put('whatsapp:inbox-record:wa-0', { ...b, id: 'wa-0', updateId: b.updateId - 1, wamid: 'wamid.fenced.A', subject: '15550009999',
      update: { ...b.update, message: { ...(b.update as { message: object }).message, text: 'Find me flights to Goa.' } } });
    await drainWhatsAppTurns(instance);
    expect(states(inbox)).toEqual([['wamid.fenced.A', 'interrupted'], ['wamid.fenced.B', 'completed']]);
    expect(sent.filter(row => row.text === WHATSAPP_PARTIAL_NOTICE)).toEqual([]);
    expect(replies()).toHaveLength(1);
    expect(model.turns.at(-1)).toContain('raining in Pune');
    expect(inbox.next()).toBeNull();
  });
});

it('a redelivered message makes no second row, and a full inbox answers 503 so Meta retries it', async () => {
  await harness('whatsapp-second-message-admission', async ({ instance, state, inbox }) => {
    expect((await post(instance, 'wamid.once', 'Hello')).status).toBe(200);
    expect((await post(instance, 'wamid.once', 'Hello')).status).toBe(200);
    expect(states(inbox)).toEqual([['wamid.once', 'admitted']]);
    state.storage.transactionSync(() => inbox.admit(Array.from({ length: WHATSAPP_INBOX_MAX_OPEN - 1 }, (_, index) => ({
      update: { update_id: WA_UPDATE_BASE + inbox.seq() + 1 + index, message: { text: `queued ${index}` } }, wamid: `wamid.queued.${index}` })), SUBJECT));
    expect((await post(instance, 'wamid.full', 'One too many')).status).toBe(503);
    expect(inbox.records().some(row => row.wamid === 'wamid.full')).toBe(false);
    expect(state.storage.kv.get('wamid:wamid.full')).toBeUndefined();
  });
});

it('unlinking the number closes what was queued for it: nothing runs for a number that is gone', async () => {
  await harness('whatsapp-second-message-unlink', async ({ instance, inbox }) => {
    expect((await post(instance, 'wamid.unlink.A', 'Find me flights to Goa.')).status).toBe(200);
    await (instance as unknown as { whatsappUnlinked(): Promise<void> }).whatsappUnlinked();
    expect(states(inbox)).toEqual([['wamid.unlink.A', 'revoked']]);
    await drainWhatsAppTurns(instance);
    expect(model.turns).toEqual([]);
  });
});

it('a literal forget redacts a message still waiting for its turn', async () => {
  await harness('whatsapp-second-message-forget', async ({ instance, inbox }) => {
    const gate = deferred(); model.hold = gate.promise;
    expect((await post(instance, 'wamid.forget.A', 'Find me flights to Goa.')).status).toBe(200);
    const drained = drainWhatsAppTurns(instance);
    await vi.waitFor(() => expect(model.turns).toHaveLength(1), { timeout: 10_000, interval: 20 });
    expect((await post(instance, 'wamid.forget.B', 'my locker code is 4417, remind me later')).status).toBe(200);
    // The forget purge's store list reaches the inbox, so a forget that cannot clean it would throw here.
    await (instance as unknown as { hideRetainedText(texts: readonly string[]): Promise<void> }).hideRetainedText(['4417']);
    expect(JSON.stringify(inbox.records().find(row => row.wamid === 'wamid.forget.B')?.update)).not.toContain('4417');
    gate.resolve();
    await drained;
  });
});

it('an alarm pass answers WhatsApp before any slower lane: mail, the app and iMessage drains, nightly work, sweeps and jobs wait behind it', async () => {
  await harness('whatsapp-second-message-lane-order', async ({ instance, replies }) => {
    expect((await post(instance, 'wamid.first.A', 'Find me flights to Goa.')).status).toBe(200);
    // Each slower lane notes how many WhatsApp replies were out when it began. The app drain opens the block that runs the
    // schedule's nightly work, sweeps and jobs, so nothing in that block can start before it.
    const began: string[] = [];
    for (const lane of ['expireAgentMail', 'reconcileAgentMailRules', 'drainApp', 'drainIMessage', 'drainAgentMail', 'drainJobs'])
      vi.spyOn(instance as unknown as Record<string, () => Promise<void>>, lane).mockImplementation(async () => { began.push(`${lane}:${replies().length}`); });
    const started = vi.spyOn(console, 'log');
    await instance.alarm();
    expect(replies()).toEqual(['Reply to turn 1.']);
    expect(began).toContain('drainApp:1');
    expect(began.every(entry => entry.endsWith(':1'))).toBe(true);
    const turnStart = started.mock.calls.map(([line]) => String(line)).find(line => line.includes('"hop":"whatsapp_turn_start"'));
    expect(JSON.parse(turnStart!)).toEqual({ hop: 'whatsapp_turn_start', ok: true, ms: expect.any(Number), queued: 0 });
  });
});

// Meta shows the indicator for 25 seconds or until the reply, so a gap longer than that reads as Waldo having stopped.
const META_TYPING_SHOWS_MS = 25_000;

it('keeps showing typing through a long turn, follows the owner to a second message, and stops with the reply', async () => {
  // The turn's clock jumps one refresh at a time, so a minute of work passes in a few seconds; the listener's 4-second ticks
  // are real, so each gap is the refresh plus at most one tick, the same worst case as production.
  const realNow = Date.now.bind(Date);
  let ahead = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ahead);
  await harness('whatsapp-second-message-typing', async ({ instance, typing, replies }) => {
    const gate = deferred(); model.hold = gate.promise;
    expect((await post(instance, 'wamid.typing.A', 'Find me three flights to Goa for Friday.')).status).toBe(200);
    const drained = drainWhatsAppTurns(instance);
    await vi.waitFor(() => expect(model.turns).toHaveLength(1), { timeout: 10_000, interval: 20 });
    expect(typing).toEqual([{ id: 'wamid.typing.A', at: expect.any(Number) }]);

    for (const step of [1, 2, 3]) {
      ahead += WHATSAPP_TYPING_REFRESH_MS;
      await vi.waitFor(() => expect(typing).toHaveLength(1 + step), { timeout: 6_000, interval: 50 });
    }
    expect(typing.every(call => call.id === 'wamid.typing.A')).toBe(true);

    // B is the owner's latest message now; the indicator moves onto it at the next tick while A is still running.
    expect((await post(instance, 'wamid.typing.B', 'Also, is it raining in Pune?')).status).toBe(200);
    await vi.waitFor(() => expect(typing.at(-1)?.id).toBe('wamid.typing.B'), { timeout: 6_000, interval: 50 });
    expect(replies()).toEqual([]);
    const during = typing.length;
    const gaps = typing.slice(1).map((call, index) => call.at - typing[index]!.at);
    expect(Math.max(...gaps)).toBeLessThan(META_TYPING_SHOWS_MS);

    gate.resolve();
    await drained;
    expect(replies()).toEqual(['Reply to turn 1.', 'Reply to turn 2.']);
    // With both replies sent, no tick is left running: a minute later nothing has asked Meta for typing again.
    const after = typing.length;
    expect(after).toBeGreaterThanOrEqual(during);
    ahead += 3 * WHATSAPP_TYPING_REFRESH_MS;
    await new Promise(done => setTimeout(done, 4_500));
    expect(typing).toHaveLength(after);
  });
}, 60_000);

it('gives a WhatsApp turn the app\'s 15 minutes', () => {
  expect(WHATSAPP_TURN_DEADLINE_MS).toBe(15 * 60_000);
});
