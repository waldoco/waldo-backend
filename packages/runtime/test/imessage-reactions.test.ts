// iMessage tapbacks, both ways, through the signed bridge, the owner DO and a scripted model. Inbound, the owner's tapback
// on a message Waldo sent them is one line their next turn reads: it starts no turn and never reaches an approval.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { routerSignature } from '../src/identity/owner-directory';
import { iMessageBridgeName } from '../src/channels/imessage/bridge-do';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost } from './helpers/imessage-sim-host';

const proof = vi.hoisted(() => ({ turns: [] as string[], reply: 'Scripted owner reply.', outputs: [] as any[][] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) proof.turns.push(JSON.stringify(input.input ?? ''));
  if (format === 'progress_note') return { id: 'scripted', output: [], output_text: JSON.stringify({ note: null }), usage: { input_tokens: 1, output_tokens: 1 } };
  return { id: 'scripted', output: format ? [] : proof.outputs.shift() ?? [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : proof.reply, usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/connectors/google', async load => ({ ...await load<typeof import('../src/connectors/google')>(), googleClient: () => ({
  event: async (id: string) => ({ id, etag: 'etag-3pm', title: 'Design review', status: 'confirmed', start: '2030-01-02T15:00:00Z', end: '2030-01-02T16:00:00Z' }),
}) }));

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000';
const HOST_ORIGIN = 'https://imessage.fixture.invalid';
const SUBJECT = 'owner@example.invalid', CHAT = `iMessage;-;${SUBJECT}`;
const LOVED = '[Owner reacted ❤️ to your message: "Scripted owner reply."]';

afterEach(() => { vi.restoreAllMocks(); proof.turns = []; proof.outputs = []; });

async function world() {
  const ownerName = `imsg-reactions-${crypto.randomUUID()}`;
  const owners: FixtureOwner[] = [{ do_name: ownerName, owner_id: '10000000-0000-4000-8000-000000000001', state: 'active', state_version: 1, admission_revision: 1 }];
  const fx = fixtureDirectory({ origin: ORIGIN, secret: SECRET, owners, extra: (fn) => {
    if (fn === 'console_session_touch' || fn === 'console_session_open' || fn === 'console_session_open_for') return Response.json(true);
    if (fn === 'health_context_read' || fn === 'health_plane' || fn === 'admin_overview') return Response.json(null);
    return null;
  } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const handled = await fx.fetcher(input as RequestInfo, init);
    if (handled) return handled;
    throw new Error(`forbidden egress ${new URL(String(input instanceof Request ? input.url : input)).origin}`);
  });
  const ownerStub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(ownerName));
  let session = '', csrf = '';
  await runInDurableObject(ownerStub, async (_i, state) => {
    state.storage.kv.put('do_name', ownerName);
    session = await consoleAccess(state.storage).grant();
    csrf = (await consoleAccess(state.storage).session(session))!.csrf;
  });
  const cookie = `waldo_console=${session}; waldo_owner=${ownerName}.session_fixture.${await routerSignature(SECRET, 0, `cookie.${ownerName}.session_fixture`)}`;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const address = `2001:db8::${crypto.randomUUID().slice(0, 4)}`;
  const call = (request: Request) => {
    if (!request.headers.has('cf-connecting-ip')) request.headers.set('cf-connecting-ip', address);
    return worker.fetch(request, env, ctx);
  };
  const action = (name: string, fields: Record<string, string> = {}) => {
    const form = new FormData(); form.set('action', name); form.set('csrf', csrf);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return call(new Request(`${HOST_ORIGIN}/console/action`, { method: 'POST', body: form, headers: { cookie, origin: HOST_ORIGIN }, redirect: 'manual' }));
  };
  const host = new SimulatedHost(call, HOST_ORIGIN);
  const bridgeStub = () => env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(iMessageBridgeName('test', host.bridgeId, host.accountId)));
  const settle = async () => { while (pending.length) await pending.shift(); };
  const pump = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) { await runDurableObjectAlarm(bridgeStub()); await settle(); await runDurableObjectAlarm(ownerStub); await settle(); }
  };
  const activate = async () => {
    const code = (await (await action('imessage.pair')).text()).split('\n')[0]!;
    expect((await host.redeem(code)).status).toBe(200);
    const challenge = (await (await action('imessage.verify', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).text()).split('\n')[0]!;
    expect((await host.send(host.message(challenge))).status).toBe(200);
    expect((await action('imessage.activate', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(303);
    expect((await host.heartbeat()).status).toBe(200);
    expect((await host.capabilities()).status).toBe(200);
  };
  // The owner writes, Waldo's reply reaches the host and the host reports it sent: the reply's message guid.
  const exchange = async (text: string): Promise<string> => {
    expect((await host.send(host.message(text))).status).toBe(200);
    await pump();
    const { delivery } = await host.pull();
    const result = await host.execute(delivery!);
    expect((await host.postResult(delivery!, result)).status).toBe(200);
    await pump(2);
    if (result.state !== 'local_recorded') throw new Error(`reply not sent: ${result.state}`);
    return result.messageGuid;
  };
  const react = async (event: unknown) => { expect((await host.send(event)).status).toBe(200); await pump(); };
  // How the bridge settled each tapback it was handed, in order.
  const settled = () => runInDurableObject(bridgeStub(), async (_i, state) =>
    state.storage.sql.exec<{ reason: string }>("SELECT reason FROM events WHERE kind = 'reaction' ORDER BY seq").toArray().map(row => row.reason));
  return { ownerStub, host, pump, activate, exchange, react, settled };
}

// The owner's message the model read last, as the model saw it.
const ownerInput = (turn: string): string => {
  const items = JSON.parse(turn) as { role?: string; content?: unknown }[];
  const content = items.filter(item => item.role === 'user').at(-1)?.content;
  return typeof content === 'string' ? content : (content as { text?: string }[]).map(part => part.text ?? '').join('');
};
const count = (text: string, line: string) => text.split(line).length - 1;

it('the owner\'s tapback on Waldo\'s reply starts no turn; their next turn reads it as one line, and only that turn', async () => {
  const w = await world();
  await w.activate();
  const sent = await w.exchange('What should I focus on today?');
  expect(proof.turns).toHaveLength(1);
  await w.react(w.host.reaction(sent, 'love'));
  expect(proof.turns).toHaveLength(1);
  expect(await w.settled()).toEqual(['reaction_noted']);
  await w.exchange('Thanks, and after that?');
  expect(proof.turns).toHaveLength(2);
  const said = ownerInput(proof.turns[1]!);
  expect(count(said, LOVED)).toBe(1);
  expect(said).toContain('Thanks, and after that?');
  await w.exchange('Got it.');
  expect(ownerInput(proof.turns[2]!)).not.toContain('Owner reacted');
});

it('a tapback the owner takes back leaves no line', async () => {
  const w = await world();
  await w.activate();
  const sent = await w.exchange('Plan my morning.');
  await w.react(w.host.reaction(sent, 'love'));
  await w.react(w.host.reaction(sent, 'love', { action: 'remove' }));
  await w.exchange('Okay.');
  expect(proof.turns).toHaveLength(2);
  expect(ownerInput(proof.turns[1]!)).not.toContain('Owner reacted');
});

it('only the owner, in their bound chat, on a message Waldo sent them, leaves a line', async () => {
  const w = await world();
  await w.activate();
  const sent = await w.exchange('What is next?');
  const ownMessage = w.host.message('a message of the owner\'s own').messageGuid;
  await w.react(w.host.reaction(sent, 'like', { senderHandle: 'stranger@example.invalid', chatGuid: CHAT }));
  await w.react(w.host.reaction(sent, 'like', { chatGuid: 'iMessage;-;other@example.invalid' }));
  await w.react(w.host.reaction(sent, 'like', { isFromMe: true }));
  await w.react(w.host.reaction(ownMessage, 'like'));
  expect(proof.turns).toHaveLength(1);
  expect(await w.settled()).toEqual(['reaction_ignored', 'reaction_ignored', 'reaction_ignored', 'reaction_untracked']);
  await w.exchange('Thanks.');
  expect(ownerInput(proof.turns[1]!)).not.toContain('Owner reacted');
});

it('a tapback on the message that carries a pending card changes no approval, card or ledger row', async () => {
  const w = await world();
  await w.activate();
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    await state.storage.put('origin', HOST_ORIGIN);
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', scopes: null, refresh_token: 'fictional-not-a-token' }]);
  });
  proof.outputs.push([{ type: 'function_call', call_id: 'move-3pm', name: 'propose_calendar_change', arguments: JSON.stringify({ action: 'move', event_id: 'ev-3pm', title: 'Design review', start: '2030-01-02T16:00:00Z', end: '2030-01-02T17:00:00Z', reason: 'Owner asked to move it to 4' }) }], []);
  const card = await w.exchange('Move my 3pm to 4');
  const desk = () => runInDurableObject(w.ownerStub, async (_i, state) => ({
    ledger: state.storage.sql.exec('SELECT * FROM ledger ORDER BY id').toArray(),
    presentations: state.storage.sql.exec('SELECT * FROM approval_presentations ORDER BY approval_id, surface, message_ref').toArray(),
  }));
  const before = await desk();
  expect(before.ledger).toHaveLength(1);
  expect(before.ledger[0]).toMatchObject({ kind: 'calendar_change', decided_at: null });
  expect(['open', 'review_only', 'card_unconfirmed']).toContain(before.ledger[0]!.status);
  const modelCalls = proof.turns.length;
  for (const type of ['like', 'love', 'emphasis', 'dislike', 'question', 'laugh']) await w.react(w.host.reaction(card, type));
  expect(proof.turns).toHaveLength(modelCalls);
  expect(await w.settled()).toEqual(Array(6).fill('reaction_noted'));
  expect(await desk()).toEqual(before);
  await w.exchange('ok');
  expect(ownerInput(proof.turns.at(-1)!)).toContain('Owner reacted 👍 to your message');
  expect(await desk()).toEqual(before);
});
