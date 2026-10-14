import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { routerSignature } from '../src/identity/owner-directory';
import { iMessageBridgeName, LINK_REPLIES, onboardingReply, SYSTEM_OWNER_ID } from '../src/channels/imessage/bridge-do';
import { IMessageOwnerInbox } from '../src/channels/imessage/owner-inbox';
import { IMessageFinalOutbox } from '../src/channels/imessage/final-outbox';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost, type Delivery } from './helpers/imessage-sim-host';

// Owner rule (2026-10-14): every person talks only to their own Waldo; a sender with no Waldo is sent
// the onboarding link. One shared Waldo number serves everyone through each sender's own presence.

const proof = vi.hoisted(() => ({ turns: [] as string[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) proof.turns.push(JSON.stringify(input.input ?? ''));
  return { id: 'scripted', output: [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : 'Scripted owner reply.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000', HOST_ORIGIN = 'https://imessage.fixture.invalid';
const ONBOARDING = 'https://onboarding.fixture.invalid/waitlist';
const OP = 'operator@icloud.invalid', ALICE = 'alice@icloud.invalid', BOB = '+15550000002', STRANGER = 'stranger@icloud.invalid';
const forbiddenEgress: string[] = [];
afterEach(() => { vi.restoreAllMocks(); proof.turns = []; });

async function world() {
  const id = crypto.randomUUID().slice(0, 8);
  const owners: FixtureOwner[] = [
    { do_name: `imsg-op-${id}`, owner_id: '30000000-0000-4000-8000-000000000001', state: 'active', state_version: 1, admission_revision: 1, admin: true },
    { do_name: `imsg-alice-${id}`, owner_id: '30000000-0000-4000-8000-000000000002', state: 'active', state_version: 1, admission_revision: 1 },
    { do_name: `imsg-bob-${id}`, owner_id: '30000000-0000-4000-8000-000000000003', state: 'active', state_version: 1, admission_revision: 1 },
  ];
  const fx = fixtureDirectory({ origin: ORIGIN, secret: SECRET, owners, extra: (fn, a) => {
    if (fn === 'console_session_touch') return Response.json(true);
    if (fn === 'health_context_read' || fn === 'health_plane') return Response.json(null);
    if (fn === 'admin_overview') return Response.json(owners.find((o) => o.do_name === a.p_do_name)?.admin ? { owners: [], invites: [] } : null);
    return null;
  } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const handled = await fx.fetcher(input as RequestInfo, init);
    if (handled) return handled;
    const url = String(input instanceof Request ? input.url : input);
    forbiddenEgress.push(url);
    throw new Error(`forbidden egress ${new URL(url).origin}`);
  });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const call = (request: Request) => worker.fetch(request, env, ctx);
  const settle = async () => { while (pending.length) await pending.shift(); };
  const consoleFor = async (name: string) => {
    const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
    let session = '', csrf = '';
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.kv.put('do_name', name);
      session = await consoleAccess(state.storage).grant();
      csrf = (await consoleAccess(state.storage).session(session))!.csrf;
    });
    const cookie = `waldo_console=${session}; waldo_owner=${name}.session_fixture.${await routerSignature(SECRET, 0, `cookie.${name}.session_fixture`)}`;
    const action = (actionName: string, fields: Record<string, string> = {}) => {
      const form = new FormData(); form.set('action', actionName); form.set('csrf', csrf);
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return call(new Request(`${HOST_ORIGIN}/console/action`, { method: 'POST', body: form, headers: { cookie }, redirect: 'manual' }));
    };
    const page = () => call(new Request(`${HOST_ORIGIN}/console/imessage`, { headers: { cookie } }));
    return { stub, action, page, name };
  };
  const [op, alice, bob] = [await consoleFor(owners[0]!.do_name), await consoleFor(owners[1]!.do_name), await consoleFor(owners[2]!.do_name)];
  const host = new SimulatedHost(call, HOST_ORIGIN);
  const bridgeStub = () => env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(iMessageBridgeName('test', host.bridgeId, host.accountId)));
  const pump = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) {
      await runDurableObjectAlarm(bridgeStub()); await settle();
      for (const o of [op, alice, bob]) { await runDurableObjectAlarm(o.stub); await settle(); }
    }
  };
  /** Pull the one outstanding command, run it on the simulated host and post its result. */
  const deliverNext = async (): Promise<{ text: string; chatGuid: string; ownerId: string; delivery: Delivery } | null> => {
    const { delivery } = await host.pull();
    if (!delivery) return null;
    const command = JSON.parse(delivery.body);
    const result = await host.execute(delivery);
    expect(result.state).toBe('local_recorded');
    expect((await host.postResult(delivery, result)).status).toBe(200);
    await pump(2);
    return { text: command.text, chatGuid: command.target.chatGuid, ownerId: command.binding.ownerId, delivery };
  };
  const sharedLive = async () => {
    const code = (await (await op.action('imessage.pair_shared')).text()).split('\n')[0]!;
    expect(code).toMatch(/^wim_[a-f0-9]{48}$/);
    expect((await host.redeem(code)).status).toBe(200);
    const challenge = (await (await op.action('imessage.verify', { id: host.bridgeId, subject: OP, chat: `iMessage;-;${OP}` })).text()).split('\n')[0]!;
    expect((await host.send(host.message(challenge, { senderHandle: OP }))).status).toBe(200);
    expect((await op.action('imessage.activate_shared', { id: host.bridgeId, subject: OP, chat: `iMessage;-;${OP}` })).status).toBe(303);
    expect((await host.heartbeat()).status).toBe(200);
    expect((await host.capabilities()).status).toBe(200);
  };
  const linkCode = async (o: typeof alice) => {
    const text = await (await o.action('imessage.link')).text();
    const code = /^waldo ([A-Z2-9]{10})\n/.exec(text)?.[1];
    expect(code, text).toBeTruthy();
    return code!;
  };
  const inbox = async (o: typeof alice) => runInDurableObject(o.stub, async (_i, state) => new IMessageOwnerInbox(state.storage).records());
  const outbox = async (o: typeof alice) => runInDurableObject(o.stub, async (_i, state) => new IMessageFinalOutbox(state.storage).records());
  return { fx, op, alice, bob, host, call, pump, deliverNext, sharedLive, linkCode, inbox, outbox, bridgeStub, owners };
}

it('the shared Waldo number routes every sender to their own Waldo only', async () => {
  const w = await world();
  await w.sharedLive();
  expect([...w.fx.bridges.values()][0]).toMatchObject({ kind: 'shared', state: 'active', presence_id: null });
  // Each owner links their own handle with "waldo CODE" from their own console.
  for (const [o, handle] of [[w.alice, ALICE], [w.bob, BOB]] as const) {
    const code = await w.linkCode(o);
    expect((await w.host.send(w.host.message(`waldo ${code}`, { senderHandle: handle }))).status).toBe(200);
    await w.pump();
    const linked = await w.deliverNext();
    expect(linked).toMatchObject({ text: LINK_REPLIES.redeemed, chatGuid: `iMessage;-;${handle}`, ownerId: SYSTEM_OWNER_ID });
  }
  expect(proof.turns).toHaveLength(0); // linking is never a turn
  // Alice's text reaches Alice's Waldo; the reply goes back to Alice's own chat.
  expect((await w.host.send(w.host.message('Alice asks something', { senderHandle: ALICE }))).status).toBe(200);
  await w.pump();
  const toAlice = await w.deliverNext();
  expect(toAlice).toMatchObject({ text: 'Scripted owner reply.', chatGuid: `iMessage;-;${ALICE}`, ownerId: w.owners[1]!.owner_id });
  // Bob's text reaches Bob's Waldo only.
  expect((await w.host.send(w.host.message('Bob asks something', { senderHandle: BOB }))).status).toBe(200);
  await w.pump();
  const toBob = await w.deliverNext();
  expect(toBob).toMatchObject({ text: 'Scripted owner reply.', chatGuid: `iMessage;-;${BOB}`, ownerId: w.owners[2]!.owner_id });
  expect(proof.turns).toHaveLength(2);
  expect(proof.turns[0]).toContain('Alice asks something'); expect(proof.turns[0]).not.toContain('Bob asks');
  expect(proof.turns[1]).toContain('Bob asks something'); expect(proof.turns[1]).not.toContain('Alice asks');
  // Each owner's inbox holds only their own turn; the operator's holds none.
  expect((await w.inbox(w.alice)).map((r) => r.binding.subject)).toEqual([ALICE]);
  expect((await w.inbox(w.bob)).map((r) => r.binding.subject)).toEqual([BOB]);
  expect(await w.inbox(w.op)).toEqual([]);
  expect((await w.outbox(w.alice))[0]).toMatchObject({ state: 'settled', subject: ALICE, result: { state: 'local_recorded' } });
  expect(forbiddenEgress).toEqual([]);
});

it('a sender with no Waldo gets one onboarding reply (then nothing for 30 days) and never reaches anyone', async () => {
  const w = await world();
  await w.sharedLive();
  expect((await w.host.send(w.host.message('hello waldo', { senderHandle: STRANGER }))).status).toBe(200);
  await w.pump();
  expect(await w.deliverNext()).toMatchObject({ text: onboardingReply(ONBOARDING), chatGuid: `iMessage;-;${STRANGER}`, ownerId: SYSTEM_OWNER_ID });
  expect((await w.host.send(w.host.message('are you there?', { senderHandle: STRANGER }))).status).toBe(200);
  await w.pump();
  expect(await w.deliverNext()).toBeNull(); // throttled: one onboarding reply per sender per 30 days
  // A wrong code gets the fixed failure text; nothing links.
  expect((await w.host.send(w.host.message('waldo ABCDEFGHJK', { senderHandle: STRANGER }))).status).toBe(200);
  await w.pump();
  expect(await w.deliverNext()).toMatchObject({ text: LINK_REPLIES.rejected, chatGuid: `iMessage;-;${STRANGER}` });
  expect(proof.turns).toHaveLength(0);
  for (const o of [w.op, w.alice, w.bob]) expect(await w.inbox(o)).toEqual([]);
  expect([...w.fx.presences.values()].some((p) => p.subject === STRANGER)).toBe(false);
  // Stranger text is not kept: the bridge settles it acknowledged with its body dropped.
  const events = await runInDurableObject(w.bridgeStub(), async (_i, state) => state.storage.sql.exec<{ state: string; reason: string; body: string }>('SELECT state, reason, body FROM events').toArray());
  const stranger = events.filter((e) => e.reason?.startsWith('stranger_') || e.reason?.startsWith('link_'));
  expect(stranger.map((e) => e.reason)).toEqual(['stranger_onboarded', 'stranger_throttled', 'link_failed']);
  expect(stranger.every((e) => e.state === 'acknowledged' && e.body === '')).toBe(true);
  expect(forbiddenEgress).toEqual([]);
});

it('a group or a chat that is not the sender\'s own direct chat never routes, even for a linked sender', async () => {
  const w = await world();
  await w.sharedLive();
  const code = await w.linkCode(w.alice);
  await w.host.send(w.host.message(`waldo ${code}`, { senderHandle: ALICE })); await w.pump(); await w.deliverNext();
  expect((await w.host.send(w.host.message('in a group', { senderHandle: ALICE, chatGuid: 'iMessage;+;chat-group', isGroup: true }))).status).toBe(200);
  expect((await w.host.send(w.host.message('someone else\'s chat', { senderHandle: ALICE, chatGuid: `iMessage;-;${BOB}` }))).status).toBe(200);
  await w.pump();
  expect(await w.deliverNext()).toBeNull();
  expect(proof.turns).toHaveLength(0);
  expect(await w.inbox(w.alice)).toEqual([]);
});

it('the console shows link codes to every owner and the shared-number controls only to the operator', async () => {
  const w = await world();
  const opPage = await (await w.op.page()).text(), alicePage = await (await w.alice.page()).text();
  expect(opPage).toContain('imessage.pair_shared'); expect(alicePage).not.toContain('imessage.pair_shared');
  expect(alicePage).toContain('imessage.link');
  expect(await (await w.alice.action('imessage.pair_shared')).text()).toContain('Unable'); // the database refuses a non-admin
  const code = await w.linkCode(w.alice);
  expect([...w.fx.linkCodes.values()].filter((c) => c.provider === 'imessage' && c.owner === w.alice.name && !c.used)).toHaveLength(1);
  expect(code).toMatch(/^[A-Z2-9]{10}$/);
});

it('linking through the shared number replaces the owner\'s own per-owner Mac bridge', async () => {
  const w = await world();
  // Alice first runs her own per-owner bridge (the pre-shared setup).
  const own = new SimulatedHost(w.call, HOST_ORIGIN);
  const code = (await (await w.alice.action('imessage.pair')).text()).split('\n')[0]!;
  expect((await own.redeem(code)).status).toBe(200);
  const challenge = (await (await w.alice.action('imessage.verify', { id: own.bridgeId, subject: ALICE, chat: `iMessage;-;${ALICE}` })).text()).split('\n')[0]!;
  expect((await own.send(own.message(challenge, { senderHandle: ALICE }))).status).toBe(200);
  expect((await w.alice.action('imessage.activate', { id: own.bridgeId, subject: ALICE, chat: `iMessage;-;${ALICE}` })).status).toBe(303);
  expect((await own.heartbeat()).status).toBe(200);
  // The shared number goes live and Alice links the same handle there.
  await w.sharedLive();
  const link = await w.linkCode(w.alice);
  await w.host.send(w.host.message(`waldo ${link}`, { senderHandle: ALICE })); await w.pump();
  expect(await w.deliverNext()).toMatchObject({ text: LINK_REPLIES.redeemed });
  expect(proof.turns).toHaveLength(0); // the code was a link action, not a turn, even for an already linked sender
  // Her old per-owner bridge lost its presence: its host is told to stop.
  expect((await own.heartbeat()).status).toBe(401);
  // Her texts now arrive through the shared number, to her own Waldo.
  await w.host.send(w.host.message('through the shared number', { senderHandle: ALICE })); await w.pump();
  expect(await w.deliverNext()).toMatchObject({ chatGuid: `iMessage;-;${ALICE}`, ownerId: w.owners[1]!.owner_id });
});
