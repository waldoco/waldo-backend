// Characterises what happens today when the owner sends a second WhatsApp message while the first one's turn is still running.
// These tests pin current behaviour, not the target design (docs/proposals/WALDO_SECOND_MESSAGE_DESIGN_2026-10-31.md).
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { TURN_TIMEOUT_MS } from '../src/channels/telegram-listener';
import { WHATSAPP_PARTIAL_NOTICE, WHATSAPP_TYPING_REFRESH_MS } from '../src/channels/whatsapp-api';

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
const settle = (instance: OwnerDO) => Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

type Typing = { id: string; at: number };
const harness = (name: string, work: (instance: OwnerDO, sent: string[], turns: ReturnType<typeof vi.spyOn>, typing: Typing[]) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const sent: string[] = [], typing: Typing[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const body = String(input).startsWith('https://graph.facebook.com/') && init?.body ? JSON.parse(String(init.body)) as { text?: { body?: string }; message_id?: string; typing_indicator?: unknown } : null;
      if (body?.typing_indicator) typing.push({ id: body.message_id!, at: Date.now() });
      else if (body) sent.push(String(body.text?.body ?? ''));
      return Response.json({ messages: [{ id: `wamid.out.${sent.length}` }] });
    });
    const instance = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    const turns = vi.spyOn(instance as unknown as { turn(update: { update_id: number }, channel: string): Promise<void> }, 'turn');
    try { await work(instance, sent, turns as never, typing); } finally { await state.storage.deleteAlarm(); }
  });
const post = (instance: OwnerDO, id: string, body: string) => instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
  method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT },
  body: JSON.stringify({ messages: [{ from: SUBJECT, id, type: 'text', text: { body } }] }),
}));

it('queues B behind a running A: Meta gets its 200 at once, B waits in memory, A is not steered, and both replies go out, A first', async () => {
  await harness('whatsapp-second-message-queue', async (instance, sent, turns) => {
    const gate = deferred(); model.hold = gate.promise;
    expect((await post(instance, 'wamid.second.A', 'Find me three flights to Goa for Friday.')).status).toBe(200);
    await vi.waitFor(() => expect(model.turns).toHaveLength(1), { timeout: 10_000, interval: 20 });

    expect((await post(instance, 'wamid.second.B', 'Also, is it raining in Pune?')).status).toBe(200);
    // B's turn has not started: it is a promise behind A's on the owner's serial queue, with no durable row of its own.
    expect(turns).toHaveBeenCalledTimes(1);
    expect((instance as unknown as { whatsappInflight: Set<unknown> }).whatsappInflight.size).toBe(2);

    gate.resolve();
    await settle(instance);
    expect(turns).toHaveBeenCalledTimes(2);
    expect(model.turns[0]).not.toContain('raining in Pune');
    expect(model.turns[1]).toContain('raining in Pune');
    expect(sent.filter(text => text.startsWith('Reply to turn'))).toEqual(['Reply to turn 1.', 'Reply to turn 2.']);
  });
});

it('a first turn past its own deadline is closed with the partial notice and no reply, then B runs: from the chat it reads as A dropped for B', async () => {
  await harness('whatsapp-second-message-deadline', async (instance, sent) => {
    const gate = deferred(); model.hold = gate.promise;
    expect((await post(instance, 'wamid.deadline.A', 'Research the best Goa hotels for Friday.')).status).toBe(200);
    await vi.waitFor(() => expect(model.turns).toHaveLength(1), { timeout: 10_000, interval: 20 });
    expect((await post(instance, 'wamid.deadline.B', 'Also, is it raining in Pune?')).status).toBe(200);

    // A's model call outlives the turn's wall clock (TURN_TIMEOUT_MS), so its reply can no longer commit.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + TURN_TIMEOUT_MS + 1_000);
    gate.resolve();
    await settle(instance);

    expect(sent).toContain(WHATSAPP_PARTIAL_NOTICE);
    expect(sent).not.toContain('Reply to turn 1.');
    expect(sent).toContain('Reply to turn 2.');
    expect(sent.indexOf(WHATSAPP_PARTIAL_NOTICE)).toBeLessThan(sent.indexOf('Reply to turn 2.'));
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
  await harness('whatsapp-second-message-typing', async (instance, sent, _turns, typing) => {
    const gate = deferred(); model.hold = gate.promise;
    expect((await post(instance, 'wamid.typing.A', 'Find me three flights to Goa for Friday.')).status).toBe(200);
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
    expect(sent.filter(text => text.startsWith('Reply to turn'))).toEqual([]);
    const during = typing.length;
    const gaps = typing.slice(1).map((call, index) => call.at - typing[index]!.at);
    expect(Math.max(...gaps)).toBeLessThan(META_TYPING_SHOWS_MS);

    gate.resolve();
    await settle(instance);
    expect(sent.filter(text => text.startsWith('Reply to turn'))).toEqual(['Reply to turn 1.', 'Reply to turn 2.']);
    // With both replies sent, no tick is left running: a minute later nothing has asked Meta for typing again.
    const after = typing.length;
    expect(after).toBeGreaterThanOrEqual(during);
    ahead += 3 * WHATSAPP_TYPING_REFRESH_MS;
    await new Promise(done => setTimeout(done, 4_500));
    expect(typing).toHaveLength(after);
  });
}, 60_000);

it('gives a WhatsApp turn 150 seconds, against 14 minutes on Telegram and 15 on the app and iMessage', () => {
  expect(TURN_TIMEOUT_MS).toBe(150_000);
});
