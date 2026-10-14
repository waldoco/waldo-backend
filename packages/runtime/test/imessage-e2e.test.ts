import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { routerSignature } from '../src/identity/owner-directory';
import { iMessageBridgeName } from '../src/channels/imessage/bridge-do';
import { sha256Hex } from '../src/channels/imessage/crypto';
import { IMessageFinalOutbox } from '../src/channels/imessage/final-outbox';
import { IMessageOwnerInbox } from '../src/channels/imessage/owner-inbox';
import { BridgeStore } from '../src/channels/imessage/bridge-store';
import { PROPOSED_LOCAL_TEST_POLICY } from '../src/channels/imessage/policy';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost } from './helpers/imessage-sim-host';

// Scripted model: every non-structured responses.create call is one owner turn.
const proof = vi.hoisted(() => ({ turns: [] as string[], reply: 'Scripted owner reply.', hold: null as null | (() => Promise<void>), outputs: [] as any[][] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) { proof.turns.push(JSON.stringify(input.input ?? '')); if (proof.hold) { const h = proof.hold; proof.hold = null; await h(); } }
  return { id: 'scripted', output: format ? [] : proof.outputs.shift() ?? [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : proof.reply, usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/connectors/google', async load => ({ ...await load<typeof import('../src/connectors/google')>(), googleClient: () => ({
  event: async (id: string) => ({ id, etag: 'etag-3pm', title: 'Design review', status: 'confirmed', start: '2030-01-02T15:00:00Z', end: '2030-01-02T16:00:00Z' }),
}) }));

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000';
const HOST_ORIGIN = 'https://imessage.fixture.invalid';
const SUBJECT = 'owner@example.invalid', CHAT = `iMessage;-;${SUBJECT}`;
const forbiddenEgress: string[] = [];

afterEach(() => { vi.restoreAllMocks(); proof.turns = []; proof.hold = null; proof.outputs = []; });

async function world(ownerName = `imsg-owner-${crypto.randomUUID()}`, ownerId = '10000000-0000-4000-8000-000000000001') {
  const owners: FixtureOwner[] = [{ do_name: ownerName, owner_id: ownerId, state: 'active', state_version: 1, admission_revision: 1 }];
  const fx = fixtureDirectory({ origin: ORIGIN, secret: SECRET, owners, extra: (fn) => {
    if (fn === 'console_session_touch' || fn === 'console_session_open') return Response.json(true);
    if (fn === 'health_context_read' || fn === 'health_plane') return Response.json(null);
    return null;
  } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const handled = await fx.fetcher(input as RequestInfo, init);
    if (handled) return handled;
    const url = String(input instanceof Request ? input.url : input);
    forbiddenEgress.push(url);
    throw new Error(`forbidden egress ${new URL(url).origin}`);
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
  const call = (request: Request) => worker.fetch(request, env, ctx);
  const action = (name: string, fields: Record<string, string> = {}, token = csrf) => {
    const form = new FormData(); form.set('action', name); form.set('csrf', token);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return call(new Request('https://imessage.fixture.invalid/console/action', { method: 'POST', body: form, headers: { cookie }, redirect: 'manual' }));
  };
  const host = new SimulatedHost(call, HOST_ORIGIN);
  const bridgeStub = () => env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(iMessageBridgeName('test', host.bridgeId, host.accountId)));
  const settle = async () => { while (pending.length) await pending.shift(); };
  /** Drives both DOs' persisted wakes until no work is left (alarms are run explicitly). */
  const pump = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) { await runDurableObjectAlarm(bridgeStub()); await settle(); await runDurableObjectAlarm(ownerStub); await settle(); }
  };
  const pairAndActivate = async () => {
    const issued = await action('imessage.pair'); expect(issued.status).toBe(200); expect(issued.headers.get('cache-control')).toBe('no-store');
    const code = (await issued.text()).split('\n')[0]!;
    expect((await host.redeem(code)).status).toBe(200);
    const challenge = (await (await action('imessage.verify', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).text()).split('\n')[0]!;
    expect((await host.send(host.message(challenge))).status).toBe(200);
    expect((await action('imessage.activate', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(303);
    expect((await host.heartbeat()).status).toBe(200);
    expect((await host.capabilities()).status).toBe(200);
    return { code, challenge };
  };
  return { fx, ownerName, ownerStub, action, host, bridgeStub, call, pump, settle, pairAndActivate, csrf };
}

it('pairs with an owner-confirmed challenge; pending credentials reach no owner turn or command', async () => {
  const w = await world();
  expect((await w.action('imessage.pair', {}, 'wrong-csrf')).status).toBe(403);
  const code = (await (await w.action('imessage.pair')).text()).split('\n')[0]!;
  expect(code).toMatch(/^wim_[a-f0-9]{48}$/);
  const redeemed = await w.host.redeem(code);
  expect(redeemed.status).toBe(200);
  expect(redeemed.headers.get('cache-control')).toBe('no-store');
  expect(await redeemed.json()).toMatchObject({ version: 1, state: 'pending_verification', credential: { kind: 'hmac-sha256' } });
  expect((await w.host.redeem(code)).status).toBe(401); // one use
  // Pending scope: heartbeat/capability evidence only; no private turns or commands.
  expect((await w.host.heartbeat()).status).toBe(200);
  expect((await w.host.pull()).status).toBe(401);
  expect((await w.host.send(w.host.message('Hello before verification'))).status).toBe(401);
  const challenge = (await (await w.action('imessage.verify', { id: w.host.bridgeId, subject: SUBJECT, chat: CHAT })).text()).split('\n')[0]!;
  expect(challenge).toMatch(/^wic_[a-f0-9]{48}$/);
  expect((await w.host.send(w.host.message(challenge, { senderHandle: 'alias@example.invalid' }))).status).toBe(401);
  expect((await w.host.send(w.host.message(challenge, { chatGuid: 'iMessage;+;group' , isGroup: true }))).status).toBe(401);
  expect((await w.host.send(w.host.message('wic_' + 'a'.repeat(48)))).status).toBe(401);
  expect((await w.action('imessage.activate', { id: w.host.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(400); // nothing observed yet
  expect((await w.host.send(w.host.message(challenge))).status).toBe(200);
  expect((await w.action('imessage.activate', { id: w.host.bridgeId, subject: 'alias@example.invalid', chat: CHAT })).status).toBe(400);
  expect((await w.action('imessage.activate', { id: w.host.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(303);
  expect(proof.turns).toHaveLength(0);
  expect(w.fx.bridges.get(w.host.bridgeId)?.state).toBe('active');
});

it('a signed direct message runs one genuine owner turn and its frozen reply reaches the host exactly once', async () => {
  const w = await world();
  await w.pairAndActivate();
  const event = w.host.message('What should I focus on today?');
  const body = JSON.stringify(event);
  const ack = await w.host.send(event);
  expect(ack.status).toBe(200);
  expect(await ack.json()).toEqual({ admitted: true, eventId: event.eventId, digest: await sha256Hex(body) });
  await w.pump();
  expect(proof.turns).toHaveLength(1);
  const { delivery } = await w.host.pull();
  expect(delivery).not.toBeNull();
  const command = JSON.parse(delivery!.body);
  expect(command).toMatchObject({ operation: 'send', text: proof.reply, allowSMSFallback: false, service: 'iMessage', attachments: [],
    target: { bridgeId: w.host.bridgeId, accountId: w.host.accountId, chatGuid: CHAT }, binding: { subject: SUBJECT, chatGuid: CHAT, conversationKind: 'direct' } });
  const result = await w.host.execute(delivery!);
  expect(result.state).toBe('local_recorded');
  expect((await w.host.postResult(delivery!, result)).status).toBe(200);
  expect((await w.host.postResult(delivery!, result)).status).toBe(200); // identical terminal repeat
  await w.pump(2);
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    const rows = new IMessageFinalOutbox(state.storage).records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'settled', text: '', result: { state: 'local_recorded' } }); // settled: identity and result kept, reply text pruned
    expect(new IMessageOwnerInbox(state.storage).records()[0]).toMatchObject({ state: 'completed', closedReason: 'final_committed', text: '' });
  });
  expect(w.host.nativeSends).toHaveLength(1);
  // Lost ACK: identical body, fresh nonce/timestamp -> same receipt, no second turn or reply.
  const retried = await w.host.send(event);
  expect(retried.status).toBe(200);
  expect(await retried.json()).toEqual({ admitted: true, eventId: event.eventId, digest: await sha256Hex(body) });
  // Changed bytes at the same identity conflict.
  expect((await w.host.send({ ...event, text: 'changed' })).status).toBe(409);
  await w.pump(2);
  expect(proof.turns).toHaveLength(1);
  expect((await w.host.pull()).delivery).toBeNull();
  expect(forbiddenEgress).toEqual([]);
});

it('an approval proposed on an iMessage turn is shown only in the app; the iMessage reply stays plain text', async () => {
  const w = await world();
  await w.pairAndActivate();
  await runInDurableObject(w.ownerStub, async (_i, state) => { await state.storage.put('origin', 'https://imessage.fixture.invalid'); await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', scopes: null, refresh_token: 'fictional-not-a-token' }]); });
  proof.outputs.push([{ type: 'function_call', call_id: 'move-3pm', name: 'propose_calendar_change', arguments: JSON.stringify({ action: 'move', event_id: 'ev-3pm', title: 'Design review', start: '2030-01-02T16:00:00Z', end: '2030-01-02T17:00:00Z', reason: 'Owner asked to move it to 4' }) }], []);
  expect((await w.host.send(w.host.message('Move my 3pm to 4'))).status).toBe(200);
  await w.pump();
  await runInDurableObject(w.ownerStub, async (_i, state) => {
    const shown = state.storage.sql.exec<{ surface: string }>('SELECT surface FROM approval_presentations').toArray();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.map(row => row.surface)).toEqual(shown.map(() => 'app'));
  });
  const { delivery } = await w.host.pull();
  const command = JSON.parse(delivery!.body);
  expect(command).toMatchObject({ operation: 'send', attachments: [] });
  expect(command.text.startsWith(proof.reply)).toBe(true);
  expect(command.text).not.toMatch(/approve|Design review|waldo:\/\//i); // no card text, buttons or app link went to iMessage
  expect(forbiddenEgress).toEqual([]);
});

const outbox = async (stub: DurableObjectStub) => runInDurableObject(stub, async (_i, state) => new IMessageFinalOutbox(state.storage).records());
const inbox = async (stub: DurableObjectStub) => runInDurableObject(stub, async (_i, state) => new IMessageOwnerInbox(state.storage).records());
const replyFor = async (w: Awaited<ReturnType<typeof world>>, text: string) => {
  expect((await w.host.send(w.host.message(text))).status).toBe(200);
  await w.pump();
};

it('lost pull and result ACKs, bridge/owner eviction and terminal repeats never produce a second native send', async () => {
  const w = await world();
  await w.pairAndActivate();
  await replyFor(w, 'Remind me what I asked.');
  const first = (await w.host.pull()).delivery!;
  // Lost pull response: the same signed bytes, deliveryId and commitment come back as attempt 2.
  const again = (await w.host.pull()).delivery!;
  expect(again).toMatchObject({ deliveryId: first.deliveryId, attempt: first.attempt + 1, body: first.body, headers: first.headers, commitment: first.commitment });
  await evictDurableObject(w.bridgeStub());
  await evictDurableObject(w.ownerStub);
  const third = (await w.host.pull()).delivery!;
  expect(third).toMatchObject({ deliveryId: first.deliveryId, body: first.body, commitment: first.commitment });
  const r1 = await w.host.execute(first), r2 = await w.host.execute(third);
  expect(r2).toEqual(r1); // host journal deduplicates; no second native effect
  expect(w.host.nativeSends).toHaveLength(1);
  // Lost result ACK: the identical terminal result is accepted again; a different one is a retained conflict.
  expect((await w.host.postResult(first, r1)).status).toBe(200);
  expect((await w.host.postResult(first, r1)).status).toBe(200);
  expect((await w.host.postResult(first, { version: 1, commandId: r1.commandId, target: r1.target, state: 'rejected', disposition: 'not_started', reason: 'late_change' })).status).toBe(409);
  await w.pump(2);
  expect((await outbox(w.ownerStub))[0]).toMatchObject({ state: 'settled', result: { state: 'local_recorded' } });
  expect((await w.host.pull()).delivery).toBeNull();
  expect(proof.turns).toHaveLength(1);
});

it('deadlines and races keep proved not_started distinct from uncertain, and quarantine is permanent', async () => {
  const w = await world();
  await w.pairAndActivate();
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], now: t0 });
  try {
    // Never pulled within the delivery deadline -> withdrawn as proved not_started.
    await replyFor(w, 'First question');
    vi.setSystemTime(t0 + 21_000);
    expect((await w.host.heartbeat()).status).toBe(200); expect((await w.host.capabilities()).status).toBe(200);
    await w.pump(3);
    expect((await outbox(w.ownerStub))[0]).toMatchObject({ state: 'settled', result: { state: 'rejected', disposition: 'not_started', reason: 'host_not_pulled' } });
    expect((await w.host.pull()).delivery).toBeNull();
    // Pulled but no terminal result within the mutation deadline -> unknown, lane quarantined.
    await replyFor(w, 'Second question');
    const d = (await w.host.pull()).delivery!;
    const r = await w.host.execute(d);
    expect((await w.host.postResult(d, r, '0'.repeat(64))).status).toBe(409); // wrong digest never accepted
    expect((await w.host.postResult(d, { ...r, target: { ...r.target, chatGuid: 'iMessage;-;other@example.invalid' } })).status).toBe(409); // wrong target
    vi.setSystemTime(t0 + 21_000 + 31_000);
    expect((await w.host.heartbeat()).status).toBe(200); expect((await w.host.capabilities()).status).toBe(200);
    await w.pump(3);
    const rows = await outbox(w.ownerStub);
    expect(rows[1]).toMatchObject({ state: 'settled', result: { state: 'unknown', disposition: 'still_in_flight', reason: 'mutation_deadline' } });
    // A late valid result cannot clear quarantine or rewrite the authoritative outcome.
    expect((await w.host.postResult(d, r)).status).toBe(409);
    await evictDurableObject(w.bridgeStub());
    await replyFor(w, 'Third question');
    expect((await outbox(w.ownerStub))[2]).toMatchObject({ state: 'settled', result: { state: 'rejected', disposition: 'not_started', reason: 'mutation_lane_poisoned' } });
    const status = await w.bridgeStub().status();
    expect(status).toMatchObject({ quarantine: 'mutation_deadline', online: true });
    expect(w.host.nativeSends).toHaveLength(1);
    // Expired commitment: a host that checks it immediately before mutation refuses as not_started.
    expect((await w.host.execute({ ...d, deliveryId: d.deliveryId }, { now: d.commitment.expiresAtMs + 1 })).state).toBe('local_recorded'); // journaled: same result, no resend
    expect(w.host.nativeSends).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it('stale capabilities hold a frozen reply and then prove it not_started; nothing is resent', async () => {
  const w = await world();
  await w.pairAndActivate();
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], now: t0 });
  try {
    vi.setSystemTime(t0 + 91_000); // heartbeat and capability reports are now stale
    expect((await w.host.send(w.host.message('Are you there?'))).status).toBe(200);
    await w.pump(3);
    expect((await outbox(w.ownerStub))[0]).toMatchObject({ state: 'frozen' });
    expect((await w.host.pull()).delivery).toBeNull();
    vi.setSystemTime(t0 + 91_000 + 600_001);
    await w.pump(2);
    expect((await outbox(w.ownerStub))[0]).toMatchObject({ state: 'settled', result: { state: 'rejected', disposition: 'not_started', reason: 'bridge_unavailable' } });
    expect((await w.host.heartbeat()).status).toBe(200); expect((await w.host.capabilities()).status).toBe(200);
    expect((await w.host.pull()).delivery).toBeNull();
    expect(proof.turns).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it('revocation during the model await blocks publication and pull; revoked hosts are rejected; evidence is retained', async () => {
  const w = await world();
  await w.pairAndActivate();
  proof.hold = async () => { expect((await w.action('imessage.revoke', { id: w.host.bridgeId })).status).toBe(303); };
  expect((await w.host.send(w.host.message('Start something long'))).status).toBe(200);
  await w.pump();
  expect(proof.turns).toHaveLength(1);
  expect(await outbox(w.ownerStub)).toEqual([]); // no frozen reply after revoke
  expect((await inbox(w.ownerStub))[0]).toMatchObject({ state: 'revoked', closedReason: 'authority_revoked', effectsUnconfirmed: true });
  for (const r of [await w.host.heartbeat(), await w.host.send(w.host.message('after revoke')), await w.host.capabilities()]) expect(r.status).toBe(401);
  expect((await w.host.pull()).status).toBe(401);
  expect(await w.bridgeStub().status()).toMatchObject({ revoked: true });
  expect(w.host.nativeSends).toHaveLength(0);
  expect(w.fx.presences.size).toBe(1);
  expect([...w.fx.presences.values()][0]!.active).toBe(false);
});

it('revocation after a reply is queued withdraws it as not_started; a delivered reply stays uncertain evidence', async () => {
  const w = await world();
  await w.pairAndActivate();
  await replyFor(w, 'Queued then revoked');
  const queued = (await outbox(w.ownerStub))[0]!;
  expect(queued.state).toBe('queued');
  expect((await w.action('imessage.revoke', { id: w.host.bridgeId })).status).toBe(303);
  await w.pump(2);
  expect((await outbox(w.ownerStub))[0]).toMatchObject({ state: 'settled', result: { state: 'rejected', disposition: 'not_started', reason: 'binding_revoked' } });
  expect((await w.host.pull()).status).toBe(401);
  expect(w.host.nativeSends).toHaveLength(0);
});

it('groups, SMS/RCS, echoes, media, reactions, receipts and unknown senders are retained evidence, never owner turns', async () => {
  const w = await world();
  await w.pairAndActivate();
  const base = w.host.message('x');
  const events = [
    w.host.message('group text', { isGroup: true, chatGuid: 'iMessage;+;fixture-group', senderHandle: 'other@example.invalid' }),
    w.host.message('sms text', { service: 'SMS', chatGuid: 'SMS;-;+15550000001', senderHandle: '+15550000001' }),
    w.host.message('rcs text', { service: 'RCS', chatGuid: 'RCS;-;+15550000002', senderHandle: '+15550000002' }),
    w.host.message('my own echo', { isFromMe: true }),
    w.host.message('photo caption', { attachments: [{ reference: 'att-1', sourceMessageGuid: 'placeholder', filename: 'photo.png', mimeType: 'image/png', byteLength: 4, sha256: '0'.repeat(64), kind: 'image', nativeVoice: false }] }),
    w.host.message('stranger text', { senderHandle: 'stranger@example.invalid' }),
    { ...base, eventId: 'sim-reaction', kind: 'reaction', action: 'add', actorHandle: SUBJECT, reaction: { kind: 'standard', type: 'love' }, text: undefined, attachments: undefined,
      target: { bridgeId: w.host.bridgeId, accountId: w.host.accountId, chatGuid: CHAT, messageGuid: 'sim-guid-1', partIndex: 0 } },
    { ...base, eventId: 'sim-receipt', kind: 'receipt', state: 'delivered', text: undefined, attachments: undefined,
      target: { bridgeId: w.host.bridgeId, accountId: w.host.accountId, chatGuid: CHAT, messageGuid: 'sim-sent-unknown', partIndex: 0 } },
  ].map((e: any) => { if (e.attachments) e.attachments = e.attachments.map((a: any) => ({ ...a, sourceMessageGuid: e.messageGuid })); for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]; return e; });
  for (const e of events) expect((await w.host.send(e)).status, e.eventId).toBe(200);
  await w.pump();
  expect(proof.turns).toHaveLength(0);
  expect(await inbox(w.ownerStub)).toEqual([]);
  const counts = (await w.bridgeStub().status()).events;
  expect(counts).toMatchObject({ pending: 0, handed: 0 });
  expect((counts.acknowledged ?? 0) + (counts.held ?? 0)).toBe(events.length + 1); // + the setup challenge
  expect(w.fx.calls.filter(c => c === 'route_presence')).toHaveLength(0); // unknown senders never reach directory lookup
});

it('authentication: wrong key, foreign account, replay, stale and future signatures and malformed headers are refused before state', async () => {
  const a = await world(`imsg-owner-a-${crypto.randomUUID()}`, '10000000-0000-4000-8000-0000000000aa');
  await a.pairAndActivate();
  const body = JSON.stringify(a.host.message('hello'));
  expect((await a.host.signed('/events', body, { key: 'b'.repeat(64) })).status).toBe(401);
  expect((await a.host.signed('/events', body, { atMs: Date.now() + 60_000 })).status).toBe(401);
  expect((await a.host.signed('/events', body, { atMs: Date.now() - 61_000 })).status).toBe(401);
  expect((await a.host.signed('/heartbeat', JSON.stringify({ ...a.host.scope(), databaseGeneration: a.host.generation, status: 'online' }), { nonce: 'fixed-nonce' })).status).toBe(200);
  expect((await a.host.signed('/commands/pull', JSON.stringify(a.host.scope()), { nonce: 'fixed-nonce' })).status).toBe(401); // nonce replay
  // A foreign bridge id with this key: routes to a different DO whose canonical authority does not exist.
  expect((await a.host.signed('/commands/pull', JSON.stringify(a.host.scope()), { bridgeId: 'imb_' + '0'.repeat(32) })).status).toBe(401);
  const raw = (headers: Record<string, string>, path = '/events', method = 'POST', b: string | null = body) => a.call(new Request(`${HOST_ORIGIN}/channels/imessage/v1${path}`, { method, headers, ...(b === null ? {} : { body: b }) }));
  expect((await raw({ 'content-type': 'application/json', 'x-waldo-imessage-s2': '{"version":1}' })).status).toBe(401);
  expect((await raw({ 'content-type': 'application/json', 'x-waldo-imessage-s2': 'not json' })).status).toBe(401);
  expect((await raw({ 'content-type': 'text/plain' })).status).toBe(415);
  expect((await raw({ 'content-type': 'application/json' }, '/events', 'GET', null)).status).toBe(405);
  expect((await raw({ 'content-type': 'application/json' }, '/events?code=leak')).status).toBe(401);
  expect((await raw({ 'content-type': 'application/json' }, '/unknown')).status).toBe(404);
  expect((await raw({ 'content-type': 'application/json' }, '/events', 'POST', 'x'.repeat(128 * 1024 + 1))).status).toBe(413);
  expect(proof.turns).toHaveLength(0);
});

it('two owners on two bridges are isolated: keys, commands, replies and status never cross', async () => {
  const a = await world(`imsg-owner-a-${crypto.randomUUID()}`, '10000000-0000-4000-8000-0000000000a1');
  await a.pairAndActivate();
  // Second owner in the same directory, its own console session and simulated host.
  const bName = `imsg-owner-b-${crypto.randomUUID()}`;
  a.fx.owners.push({ do_name: bName, owner_id: '10000000-0000-4000-8000-0000000000b1', state: 'active', state_version: 1, admission_revision: 1 });
  const bStub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(bName));
  let bSession = '', bCsrf = '';
  await runInDurableObject(bStub, async (_i, state) => { state.storage.kv.put('do_name', bName); bSession = await consoleAccess(state.storage).grant(); bCsrf = (await consoleAccess(state.storage).session(bSession))!.csrf; });
  const bCookie = `waldo_console=${bSession}; waldo_owner=${bName}.session_fixture.${await routerSignature(SECRET, 0, `cookie.${bName}.session_fixture`)}`;
  const bAction = (name: string, fields: Record<string, string> = {}) => { const f = new FormData(); f.set('action', name); f.set('csrf', bCsrf); for (const [k, v] of Object.entries(fields)) f.set(k, v); return a.call(new Request(`${HOST_ORIGIN}/console/action`, { method: 'POST', body: f, headers: { cookie: bCookie }, redirect: 'manual' })); };
  const hostB = new SimulatedHost(a.call, HOST_ORIGIN);
  const code = (await (await bAction('imessage.pair')).text()).split('\n')[0]!;
  expect((await hostB.redeem(code)).status).toBe(200);
  // Owner B cannot verify, activate or revoke owner A's bridge.
  expect((await bAction('imessage.verify', { id: a.host.bridgeId, subject: 'b@example.invalid', chat: 'iMessage;-;b@example.invalid' })).status).toBe(400);
  expect((await bAction('imessage.revoke', { id: a.host.bridgeId })).status).toBe(400);
  // The same Apple sender already bound to owner A cannot be bound to owner B (conflict, not transfer).
  const challenge = (await (await bAction('imessage.verify', { id: hostB.bridgeId, subject: SUBJECT, chat: CHAT })).text()).split('\n')[0]!;
  expect((await hostB.send(hostB.message(challenge))).status).toBe(200);
  expect((await bAction('imessage.activate', { id: hostB.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(400);
  // A reply for owner A is only ever pulled by A's credential.
  await replyFor(a, 'Only for owner A');
  expect((await hostB.signed('/commands/pull', JSON.stringify({ version: 1, bridgeId: a.host.bridgeId, accountId: hostB.accountId }), { bridgeId: a.host.bridgeId })).status).toBe(401);
  expect((await hostB.pull()).status).toBe(401); // B is still pending: no commands at all
  const d = (await a.host.pull()).delivery!;
  expect(JSON.parse(d.body).binding.ownerId).toBe('10000000-0000-4000-8000-0000000000a1');
  expect(await inbox(bStub)).toEqual([]);
  expect(await outbox(bStub)).toEqual([]);
});

it('a host that sees an expired commitment returns not_started; the lane stays usable', async () => {
  const w = await world();
  await w.pairAndActivate();
  await replyFor(w, 'Late pull');
  const d = (await w.host.pull()).delivery!;
  const r = await w.host.execute(d, { now: d.commitment.expiresAtMs + 1 });
  expect(r).toMatchObject({ state: 'rejected', disposition: 'not_started', reason: 'commitment_expired' });
  expect((await w.host.postResult(d, r)).status).toBe(200);
  await w.pump(2);
  expect((await outbox(w.ownerStub))[0]).toMatchObject({ state: 'settled', result: { reason: 'commitment_expired' } });
  expect((await w.bridgeStub().status()).quarantine).toBeNull();
  await replyFor(w, 'Next one');
  expect((await w.host.pull()).delivery).not.toBeNull();
  expect(w.host.nativeSends).toHaveLength(0);
});

// ---- review rev3 follow-ups: pre-DO hardening, revoke at the cap, quarantine recovery ----------------------
const forged = (w: Awaited<ReturnType<typeof world>>, bridgeId: string, accountId: string, ip: string) => w.call(new Request(`${HOST_ORIGIN}/channels/imessage/v1/heartbeat`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip,
    'x-waldo-imessage-s2': JSON.stringify({ version: 1, bridgeId, accountId, atMs: Date.now(), nonce: crypto.randomUUID(), signature: '0'.repeat(64) }) },
  body: JSON.stringify({ version: 1, bridgeId, accountId, databaseGeneration: 'g', status: 'online' }) }));

it('non-minted ids never reach a bridge; an unknown tuple leaves no storage; one address is limited at the edge', async () => {
  const w = await world();
  await w.pairAndActivate();
  const lookups = () => w.fx.calls.filter((c) => c === 'imessage_bridge_authority').length, before = lookups();
  for (const [b, a] of [['not-minted', w.host.accountId], [w.host.bridgeId, 'ima_short'], [`IMB_${'a'.repeat(32)}`, w.host.accountId], [w.host.bridgeId, `${w.host.accountId}x`]])
    expect((await forged(w, b!, a!, '192.0.2.10')).status).toBe(401);
  expect(lookups()).toBe(before); // refused before any directory lookup or Durable Object
  const ghost = { bridgeId: `imb_${'a'.repeat(32)}`, accountId: `ima_${'b'.repeat(32)}` };
  expect((await forged(w, ghost.bridgeId, ghost.accountId, '192.0.2.11')).status).toBe(401);
  await runInDurableObject(env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(iMessageBridgeName('test', ghost.bridgeId, ghost.accountId))), async (_i, state) => {
    const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map((r) => r.name).filter((n) => !n.startsWith('_cf'));
    expect(tables).toEqual([]); // the unsigned request created no bridge tables
  });
  const ip = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
  const statuses: number[] = [];
  for (let i = 0; i < 130; i++) statuses.push((await forged(w, ghost.bridgeId, ghost.accountId, ip)).status);
  expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  expect(statuses.filter((s) => s !== 401 && s !== 429)).toEqual([]);
  expect((await w.host.heartbeat()).status).toBe(200); // another address is unaffected
});

it('a revoke on a full bridge store is still recorded and the host gets 401, not 503', async () => {
  const w = await world();
  await w.pairAndActivate();
  await runInDurableObject(w.bridgeStub(), async (_i, state) => {
    const now = Date.now(); // held evidence is never pruned early, so this store cannot recover by pruning
    for (let i = 0; i < PROPOSED_LOCAL_TEST_POLICY.maxRecords + 10; i++)
      state.storage.sql.exec("INSERT INTO events(generation,event_id,digest,body,kind,state,created_at) VALUES('fill',?,?,'','message','held',?)", `fill-${i}`, '0'.repeat(64), now);
  });
  expect((await w.host.heartbeat()).status).toBe(503); // backpressure while bound
  expect((await w.action('imessage.revoke', { id: w.host.bridgeId })).status).toBe(303);
  expect((await w.host.heartbeat()).status).toBe(401);
  expect((await w.host.pull()).status).toBe(401);
  await runInDurableObject(w.bridgeStub(), async (_i, state) => { expect(new BridgeStore(state.storage, PROPOSED_LOCAL_TEST_POLICY).revokedRevision()).not.toBeNull(); });
});

it('quarantine recovery is revoke + re-pair: the new bridge has a clean lane and replies flow again', async () => {
  const w = await world();
  await w.pairAndActivate();
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], now: t0 }); // one forward-only clock for the whole recovery
  try {
  await replyFor(w, 'Before the quarantine');
  expect((await w.host.pull()).delivery).not.toBeNull(); // pulled, never resulted
  vi.setSystemTime(t0 + PROPOSED_LOCAL_TEST_POLICY.mutationDeadlineMs + 2_000);
  expect((await w.host.heartbeat()).status).toBe(200);
  await w.pump(3);
  expect((await w.bridgeStub().status()).quarantine).toBe('mutation_deadline');
  await replyFor(w, 'Still quarantined');
  expect((await outbox(w.ownerStub)).at(-1)).toMatchObject({ state: 'settled', result: { reason: 'mutation_lane_poisoned' } });
  const old = { bridgeId: w.host.bridgeId, stub: w.bridgeStub() };
  expect((await w.action('imessage.revoke', { id: old.bridgeId })).status).toBe(303);
  // Fresh invitation -> new host identity -> new bridge Durable Object with an empty lane.
  const host = new SimulatedHost(w.call, HOST_ORIGIN);
  const code = (await (await w.action('imessage.pair')).text()).split('\n')[0]!;
  expect((await host.redeem(code)).status).toBe(200);
  expect(host.bridgeId).not.toBe(old.bridgeId);
  const challenge = (await (await w.action('imessage.verify', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).text()).split('\n')[0]!;
  expect((await host.send(host.message(challenge))).status).toBe(200);
  expect((await w.action('imessage.activate', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(303);
  expect((await host.heartbeat()).status).toBe(200); expect((await host.capabilities()).status).toBe(200);
  const stub = env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(iMessageBridgeName('test', host.bridgeId, host.accountId)));
  expect((await stub.status()).quarantine).toBeNull();
  expect((await host.send(host.message('After the re-pair'))).status).toBe(200);
  for (let i = 0; i < 6; i++) { await runDurableObjectAlarm(stub); await w.settle(); await runDurableObjectAlarm(w.ownerStub); await w.settle(); }
  const { delivery } = await host.pull();
  expect(delivery).not.toBeNull();
  const result = await host.execute(delivery!);
  expect(result.state).toBe('local_recorded');
  expect((await host.postResult(delivery!, result)).status).toBe(200);
  for (let i = 0; i < 3; i++) { await runDurableObjectAlarm(stub); await w.settle(); await runDurableObjectAlarm(w.ownerStub); await w.settle(); }
  expect((await outbox(w.ownerStub)).at(-1)).toMatchObject({ state: 'settled', result: { state: 'local_recorded' } });
  expect((await old.stub.status()).quarantine).toBe('mutation_deadline'); // the old lane keeps its evidence
  expect(forbiddenEgress).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it('an iMessage owner\'s own request queues the console link on the same bridge, ahead of the reply; the model never sees it', async () => {
  const w = await world();
  await w.pairAndActivate();
  await runInDurableObject(w.ownerStub, async (_i, state) => { await state.storage.put('origin', HOST_ORIGIN); });
  proof.outputs.push([{ type: 'function_call', call_id: 'console', name: 'send_console_link', arguments: '{}' }], []);
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], now: t0 });
  try {
  await replyFor(w, 'Send me my console link');
  // The link goes first and the reply waits behind it: the bridge holds one outstanding command at a time, and the
  // reply's handoff is retried once the link's delivery has settled.
  const first = (await w.host.pull()).delivery!;
  const link = JSON.parse(first.body);
  expect(link).toMatchObject({ operation: 'send', allowSMSFallback: false, attachments: [], target: { bridgeId: w.host.bridgeId, accountId: w.host.accountId, chatGuid: CHAT }, binding: { subject: SUBJECT, chatGuid: CHAT } });
  expect(link.text.startsWith(`Console (link works once, for 10 minutes): ${HOST_ORIGIN}/console?t=c1.`)).toBe(true);
  expect((await w.host.postResult(first, await w.host.execute(first))).status).toBe(200);
  vi.setSystemTime(t0 + 6_000);
  await w.pump(3);
  const second = (await w.host.pull()).delivery!;
  const reply = JSON.parse(second.body);
  expect(reply).toMatchObject({ operation: 'send', text: proof.reply, target: link.target, binding: link.binding });
  expect(reply.commandId).not.toBe(link.commandId);
  // One server-originated record beside the reply: same bridge, owner, revision and binding, its own command id.
  const [inbound] = await inbox(w.ownerStub);
  const rows = await outbox(w.ownerStub);
  const consoleRow = rows.find(row => row.replyRef === `console:${inbound!.id}`)!, replyRow = rows.find(row => row.replyRef === `reply:${inbound!.id}`)!;
  expect(consoleRow).toMatchObject({ bridgeDoName: replyRow.bridgeDoName, ownerDoName: replyRow.ownerDoName, revision: replyRow.revision, bindingDigest: replyRow.bindingDigest, commandId: link.commandId, state: 'settled', text: '' });
  expect(replyRow.commandId).toBe(reply.commandId);
  const ticket = new URL(link.text.slice(link.text.indexOf('https://'))).searchParams.get('t')!;
  const seen = proof.turns.join('\n').replaceAll('\\"', '"');
  expect(seen).toContain('"sent":true,"surface":"imessage"');
  expect(seen).not.toContain(ticket);
  // The ticket is the issuing owner's, and it opens the console once.
  const redeem = async () => (await w.call(new Request(`${HOST_ORIGIN}/console`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t: ticket }) }))).status;
  expect(await redeem()).toBe(303);
  expect(await redeem()).toBe(403);
  expect(w.host.nativeSends).toHaveLength(1);
  expect(forbiddenEgress).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it('an iMessage turn with no public origin on record mints nothing, says so, and still replies', async () => {
  const w = await world();
  await w.pairAndActivate();
  proof.outputs.push([{ type: 'function_call', call_id: 'console', name: 'send_console_link', arguments: '{}' }], []);
  await replyFor(w, 'Send me my console link');
  const only = (await w.host.pull()).delivery!;
  expect(JSON.parse(only.body).text).toBe(proof.reply);
  expect(proof.turns.join('\n').replaceAll('\\"', '"')).toContain('"sent":false,"reason":"unavailable"');
  await runInDurableObject(w.ownerStub, async (_i, state) => { expect(state.storage.kv.get('console:link')).toBeUndefined(); });
  expect((await outbox(w.ownerStub)).map(row => row.replyRef.split(':')[0])).toEqual(['reply']);
});

it('an iMessage forget whose topic matches nothing completes the turn, replies, and the next turn loads the message as the forget left it', async () => {
  const w = await world();
  await w.pairAndActivate();
  proof.outputs.push([{ type: 'function_call', call_id: 'forget', name: 'forget_memory', arguments: JSON.stringify({ topic: 'zebra stripes', scope_note: 'zebras' }) }], []);
  await replyFor(w, 'Forget zebra stripes');
  expect((await inbox(w.ownerStub))[0]).toMatchObject({ state: 'completed', closedReason: 'final_committed' });
  expect(proof.turns.join('\n')).toContain('No stored memory carries that topic or span');
  const first = (await w.host.pull()).delivery!;
  expect(JSON.parse(first.body).text.startsWith(proof.reply)).toBe(true);
  expect((await w.host.postResult(first, await w.host.execute(first))).status).toBe(200);
  await w.pump(2);
  await replyFor(w, 'What is on today?');
  expect((await inbox(w.ownerStub)).map(record => record.state)).toEqual(['completed', 'completed']);
  const next = proof.turns.at(-1)!;
  expect(next).toContain('Forget [forgotten]');
  expect(next).not.toContain('zebra stripes');
});
