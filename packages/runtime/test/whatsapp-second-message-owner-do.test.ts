// Characterises what happens today when the owner sends a second WhatsApp message while the first one's turn is still running.
// These tests pin current behaviour, not the target design (docs/proposals/WALDO_SECOND_MESSAGE_DESIGN_2026-10-31.md).
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { TURN_TIMEOUT_MS } from '../src/channels/telegram-listener';
import { WHATSAPP_PARTIAL_NOTICE } from '../src/channels/whatsapp-api';

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

const harness = (name: string, work: (instance: OwnerDO, sent: string[], turns: ReturnType<typeof vi.spyOn>) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const sent: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).startsWith('https://graph.facebook.com/') && init?.body) sent.push(String((JSON.parse(String(init.body)) as { text?: { body?: string } }).text?.body ?? ''));
      return Response.json({ messages: [{ id: `wamid.out.${sent.length}` }] });
    });
    const instance = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    const turns = vi.spyOn(instance as unknown as { turn(update: { update_id: number }, channel: string): Promise<void> }, 'turn');
    try { await work(instance, sent, turns as never); } finally { await state.storage.deleteAlarm(); }
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

it('gives a WhatsApp turn 150 seconds, against 14 minutes on Telegram and 15 on the app and iMessage', () => {
  expect(TURN_TIMEOUT_MS).toBe(150_000);
});
