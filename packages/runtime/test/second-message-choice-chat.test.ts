// The second-message seam on the chat surfaces, with WALDO_SECOND_MESSAGE=1: WhatsApp's running turn is shown the owner's
// newer text at its next round, and a fold closes that text's row with no turn or reply of its own. A message with a file is
// never offered. The model is the only fake (owner-do second-message seam; second-message.ts).
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { IMessageOwnerInbox } from '../src/channels/imessage/owner-inbox';
import { WhatsAppOwnerInbox } from '../src/channels/whatsapp-inbox';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

const model = vi.hoisted(() => ({ inputs: [] as string[], hold: null as null | Promise<void>, choice: 'fold' as 'fold' | 'queue' }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: { input?: unknown; text?: { format?: { name?: string } } }) => {
  const format = input.text?.format?.name;
  const respond = (output: unknown[], text = '') => ({ id: 'fixture', output_text: text, output, usage: { input_tokens: 1, output_tokens: 1 } });
  if (format) return respond([], format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : '{}');
  const said = JSON.stringify(input.input ?? '');
  model.inputs.push(said);
  const call = (id: string, args: object) => respond([{ type: 'function_call', id: `fc_${id}`, call_id: id, name: 'owner_message_heard', arguments: JSON.stringify(args) }]);
  if (!said.includes('flights to Goa') || (said.includes('raining in Pune') && !said.includes('While you were working'))) return respond([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply to the newer message.' }] }], 'Reply to the newer message.');
  if (!said.includes('function_call_output')) { if (model.hold) await model.hold; return call('probe', { message_id: 'whatsapp-0', choice: 'queue' }); }
  const offered = /(whatsapp-\d+) \(\d\d:\d\d\)/.exec(said)?.[1];
  if (offered && !said.includes('"answer"')) return call('answer', { message_id: offered, choice: model.choice });
  return respond([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply to both.' }] }], 'Reply to both.');
} }; } }));

afterEach(() => { vi.restoreAllMocks(); model.inputs = []; model.hold = null; model.choice = 'fold'; });

const SUBJECT = '15550002222';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const harness = (name: string, work: (world: { instance: OwnerDO; inbox: WhatsAppOwnerInbox; sent: string[]; quoted: (string | null)[] }) => Promise<void>, extra: Record<string, string> = {}) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const sent: string[] = [], quoted: (string | null)[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const body = String(input).startsWith('https://graph.facebook.com/') && init?.body ? JSON.parse(String(init.body)) as { text?: { body?: string }; context?: { message_id?: string }; typing_indicator?: unknown } : null;
      if (body && !body.typing_indicator && body.text?.body) { sent.push(body.text.body); quoted.push(body.context?.message_id ?? null); }
      return Response.json({ messages: [{ id: `wamid.out.${sent.length}` }] });
    });
    const instance = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WALDO_SECOND_MESSAGE: '1', ...extra });
    try { await work({ instance, inbox: new WhatsAppOwnerInbox(state.storage), sent, quoted }); } finally { await state.storage.deleteAlarm(); }
  });
const post = (instance: OwnerDO, id: string, message: object) => instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
  method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT }, body: JSON.stringify({ messages: [{ from: SUBJECT, id, ...message }] }),
}));
const states = (inbox: WhatsAppOwnerInbox) => inbox.records().map(row => [row.wamid, row.state]);
// A's first round is held until B is in the inbox; then the pass runs every turn it can.
const secondWhileFirstRuns = async (world: { instance: OwnerDO }, second: object) => {
  const gate = deferred(); model.hold = gate.promise;
  expect((await post(world.instance, 'wamid.fold.A', { type: 'text', text: { body: 'Find me three flights to Goa for Friday.' } })).status).toBe(200);
  const drained = drainWhatsAppTurns(world.instance);
  await vi.waitFor(() => expect(model.inputs).toHaveLength(1), { timeout: 10_000, interval: 20 });
  expect((await post(world.instance, 'wamid.fold.B', second)).status).toBe(200);
  gate.resolve();
  await drained;
};

it('WhatsApp fold: the newer text is offered at the next round, closes with no turn of its own, and the owner gets one reply', async () => {
  await harness('second-choice-whatsapp-fold', async world => {
    await secondWhileFirstRuns(world, { type: 'text', text: { body: 'Actually make it Saturday.' } });
    expect(model.inputs.some(said => said.includes('While you were working, the owner sent') && said.includes('Actually make it Saturday.'))).toBe(true);
    expect(world.sent).toEqual(['Reply to both.']);
    expect(states(world.inbox)).toEqual([['wamid.fold.A', 'completed'], ['wamid.fold.B', 'completed']]);
    expect(world.inbox.records().map(row => row.update)).toEqual([null, null]);
  });
});

it('WhatsApp queue: the newer text keeps its own turn and its own reply after the first', async () => {
  await harness('second-choice-whatsapp-queue', async world => {
    model.choice = 'queue';
    await secondWhileFirstRuns(world, { type: 'text', text: { body: 'Separately, is it raining in Pune?' } });
    expect(world.sent).toEqual(['Reply to both.', 'Reply to the newer message.']);
  });
});

it('a newer message with a file is never offered to the running turn: it runs as its own turn', async () => {
  await harness('second-choice-whatsapp-media', async world => {
    await secondWhileFirstRuns(world, { type: 'document', document: { id: 'media-1', filename: 'itinerary.pdf', mime_type: 'application/pdf' } });
    expect(model.inputs.some(said => said.includes('While you were working, the owner sent'))).toBe(false);
    expect(states(world.inbox).map(([, state]) => state)).toEqual(['completed', 'completed']);
  });
});

it('iMessage fold closes only a message still admitted, clears its words and leaves the running one alone', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('second-choice-imessage-fold')), async (_instance, state) => {
    const inbox = new IMessageOwnerInbox(state.storage);
    const admit = async (key: string, text: string) => {
      const admitted = await inbox.admit({ dedupKey: key, digest: '0'.repeat(64), text, conversationRef: 'imessage:fixture', binding: {} as never,
        bindingDigest: '0'.repeat(64), revision: 'fixture', environment: 'test', bridgeDoName: 'bridge', ownerDoName: 'owner', commandId: `command-${key}`, occurredAt: Date.now() });
      if (admitted.kind !== 'admitted') throw new Error(admitted.kind);
      return admitted.record;
    };
    const first = await admit('first', 'Find me three flights to Goa.'), second = await admit('second', 'Actually make it Saturday.');
    expect(inbox.claim(first.id, true)).not.toBeNull();
    expect(inbox.fold(first.id)).toBe(false);
    expect(inbox.fold(second.id)).toBe(true);
    expect(inbox.fold(second.id)).toBe(false);
    expect(inbox.records().map(row => [row.state, row.text])).toEqual([['running', 'Find me three flights to Goa.'], ['completed', '']]);
    await state.storage.deleteAlarm();
  });
});
