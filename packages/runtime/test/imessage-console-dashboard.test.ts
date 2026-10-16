import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { RECEIPT_BOOK_KEY } from '../src/channels/dashboard-control-actions';
import { routerSignature } from '../src/identity/owner-directory';
import { iMessageBridgeName } from '../src/channels/imessage/bridge-do';
import { IMessageFinalOutbox } from '../src/channels/imessage/final-outbox';
import { IMessageOwnerInbox } from '../src/channels/imessage/owner-inbox';
import { PROPOSED_LOCAL_TEST_POLICY } from '../src/channels/imessage/policy';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost } from './helpers/imessage-sim-host';

// iMessage setup in the new console: reads through the controls route, acts through the one
// control-action path. Every credential and handle is fictional.
vi.mock('openai', () => ({ default: class { responses = { create: async (input: { text?: { format?: { name?: string } } }) => {
  const format = input.text?.format?.name;
  return { id: 'scripted', output: [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : 'Scripted owner reply.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000', HOST_ORIGIN = 'https://imessage.fixture.invalid';
const SUBJECT = 'owner@example.invalid', CHAT = `iMessage;-;${SUBJECT}`;
type Read = { csrf: string; revision: string; data: { enabled: boolean; address: string | null; linked_hint: string | null; admin: boolean; actions: string[]; bridges: { id: string; kind: string; state: string; subject: string | null; chat: string | null; observed: boolean; actions: string[] }[] }; status: { bridges: { id: string; online: boolean; text_ready: boolean; sending_paused: boolean }[] } };
type Acted = { status: number; body: { receipt?: { state: string; message: string }; duplicate?: boolean; reveal?: { kind: string; value: string; send_url?: string }; error?: string }; location: string | null };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function world(o: { admin?: boolean } = {}) {
  const name = `imsg-dash-${crypto.randomUUID().slice(0, 8)}`;
  const owners: FixtureOwner[] = [{ do_name: name, owner_id: '40000000-0000-4000-8000-000000000001', state: 'active', state_version: 1, admission_revision: 1, admin: o.admin ?? false }];
  const fx = fixtureDirectory({ origin: ORIGIN, secret: SECRET, owners, extra: (fn, a) => {
    if (fn === 'console_session_touch') return Response.json(true);
    if (fn === 'health_context_read' || fn === 'health_plane') return Response.json(null);
    if (fn === 'admin_overview') return Response.json(owners.find((owner) => owner.do_name === a.p_do_name)?.admin ? { owners: [], invites: [] } : null);
    return null;
  } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const handled = await fx.fetcher(input as RequestInfo, init);
    if (handled) return handled;
    throw new Error(`forbidden egress ${new URL(String(input instanceof Request ? input.url : input)).origin}`);
  });
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  let session = '';
  await runInDurableObject(stub, async (_i, state) => { state.storage.kv.put('do_name', name); session = await consoleAccess(state.storage).grant(); });
  const cookie = `waldo_console=${session}; waldo_owner=${name}.session_fixture.${await routerSignature(SECRET, 0, `cookie.${name}.session_fixture`)}`;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const call = (request: Request) => worker.fetch(request, env, ctx);
  const read = async (): Promise<Read> => {
    const response = await call(new Request(`${HOST_ORIGIN}/console/dashboard/api/v1/controls?view=imessage`, { headers: { cookie, accept: 'application/json' } }));
    expect(response.status).toBe(200);
    return response.json();
  };
  let n = 0;
  const act = async (action: string, fields: Record<string, string> = {}, over: { csrf?: string; revision?: string; request_id?: string } = {}): Promise<Acted> => {
    const current = over.revision && over.csrf ? null : await read();
    const body = new URLSearchParams({ csrf: over.csrf ?? current!.csrf, revision: over.revision ?? current!.revision, view: 'imessage', action, request_id: over.request_id ?? `imsg-request-${++n}`, ...fields });
    const response = await call(new Request(`${HOST_ORIGIN}/console/dashboard/api/v1/actions`, { method: 'POST', redirect: 'manual', headers: { cookie, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body }));
    return { status: response.status, body: await response.json(), location: response.headers.get('location') };
  };
  const host = new SimulatedHost(call, HOST_ORIGIN);
  const settle = async () => { while (pending.length) await pending.shift(); };
  const bridgeStub = () => env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(iMessageBridgeName('test', host.bridgeId, host.accountId)));
  const pump = async (rounds = 6) => { for (let i = 0; i < rounds; i++) { await runDurableObjectAlarm(bridgeStub()); await settle(); await runDurableObjectAlarm(stub); await settle(); } };
  const book = () => runInDurableObject(stub, async (_i, state) => JSON.stringify(await state.storage.get(RECEIPT_BOOK_KEY) ?? null));
  const pairAndActivate = async () => {
    const code = (await act('imessage.pair')).body.reveal!.value;
    expect((await host.redeem(code)).status).toBe(200);
    const challenge = (await act('imessage.verify', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).body.reveal!.value;
    expect((await host.send(host.message(challenge))).status).toBe(200);
    expect((await act('imessage.activate', { id: host.bridgeId })).body.receipt).toMatchObject({ state: 'recorded' });
    expect((await host.heartbeat()).status).toBe(200); expect((await host.capabilities()).status).toBe(200);
  };
  return { name, fx, stub, call, cookie, read, act, host, pump, book, pairAndActivate };
}

it('pairs and activates a Mac host from the new console: each code is shown once, never stored, and works once', async () => {
  const w = await world();
  const opened = await w.call(new Request(`${HOST_ORIGIN}/console/imessage`, { redirect: 'manual', headers: { cookie: w.cookie } }));
  expect({ status: opened.status, location: opened.headers.get('location') }).toEqual({ status: 303, location: '/console#/connections/imessage' });
  const empty = await w.read();
  expect(empty.data).toEqual({ enabled: true, address: 'waldo@fixture.invalid', linked_hint: null, admin: false, actions: ['imessage.link', 'imessage.pair'], bridges: [] });

  const issued = await w.act('imessage.pair', {}, { request_id: 'imsg-pair-once' });
  expect(issued.status).toBe(200); expect(issued.location).toBeNull();
  const code = issued.body.reveal!.value;
  expect(issued.body.reveal).toEqual({ kind: 'host_code', value: expect.stringMatching(/^wim_[a-f0-9]{48}$/) });
  expect(await w.book()).not.toContain(code);
  const replay = await w.act('imessage.pair', {}, { csrf: empty.csrf, revision: empty.revision, request_id: 'imsg-pair-once' });
  expect(replay.body).toEqual({ receipt: issued.body.receipt, duplicate: true });
  expect(w.fx.invitations.size).toBe(1); // the replay minted nothing
  expect((await w.host.redeem(code)).status).toBe(200);
  expect((await w.host.redeem(code)).status).toBe(401);

  const pending = await w.read();
  expect(pending.data.bridges).toEqual([{ id: w.host.bridgeId, kind: 'owner', state: 'pending', subject: null, chat: null, observed: false, host_version: 'sim-host-1', actions: ['imessage.verify', 'imessage.revoke'] }]);
  expect((await w.act('imessage.activate', { id: w.host.bridgeId })).body).toMatchObject({ error: 'no_longer_eligible' });
  expect((await w.act('imessage.verify', { id: w.host.bridgeId, subject: SUBJECT, chat: 'SMS;-;owner@example.invalid' })).body).toMatchObject({ receipt: { state: 'rejected' } });
  const verified = await w.act('imessage.verify', { id: w.host.bridgeId, subject: SUBJECT, chat: CHAT });
  const challenge = verified.body.reveal!.value;
  expect(verified.body.reveal).toEqual({ kind: 'challenge', value: expect.stringMatching(/^wic_[a-f0-9]{48}$/) });
  expect(verified.body.receipt!.message).not.toContain(SUBJECT);
  expect(await w.book()).not.toContain(challenge);
  expect((await w.host.send(w.host.message(challenge, { senderHandle: 'alias@example.invalid' }))).status).toBe(401);
  expect((await w.host.send(w.host.message(challenge))).status).toBe(200);

  const observed = await w.read();
  expect(observed.data.bridges[0]).toMatchObject({ subject: SUBJECT, chat: CHAT, observed: true, actions: ['imessage.verify', 'imessage.activate', 'imessage.revoke'] });
  // Activation confirms the sender and chat the read recorded, whatever the form says.
  expect((await w.act('imessage.activate', { id: w.host.bridgeId, sender: 'alias@example.invalid' })).status).toBe(400);
  expect((await w.act('imessage.activate', { id: w.host.bridgeId, subject: 'alias@example.invalid', chat: 'iMessage;-;alias@example.invalid' })).body.receipt).toMatchObject({ state: 'recorded' });
  expect(w.fx.bridges.get(w.host.bridgeId)?.state).toBe('active');
  expect([...w.fx.presences.values()].map((p) => [p.subject, p.active])).toEqual([[SUBJECT, true]]);
  expect((await w.host.heartbeat()).status).toBe(200); expect((await w.host.capabilities()).status).toBe(200);
  const active = await w.read();
  expect(active.data.bridges[0]).toMatchObject({ state: 'active', actions: ['imessage.revoke'] });
  expect(active.status.bridges).toEqual([{ id: w.host.bridgeId, online: true, text_ready: true, sending_paused: false }]);
});

it('refuses a wrong CSRF, a stale read and a shared-number pairing from a non-operator without minting anything', async () => {
  const w = await world();
  const current = await w.read();
  expect((await w.act('imessage.pair', {}, { csrf: 'wrong', revision: current.revision })).status).toBe(403);
  expect((await w.act('imessage.pair', {}, { csrf: current.csrf, revision: 'f'.repeat(64) })).body).toMatchObject({ error: 'stale_read' });
  expect((await w.act('imessage.pair_shared')).body).toMatchObject({ error: 'no_longer_eligible' });
  expect(w.fx.invitations.size).toBe(0);
  expect(w.fx.calls).not.toContain('imessage_issue_shared_invitation');
  expect(w.fx.calls).not.toContain('imessage_issue_invitation');

  const operator = await world({ admin: true });
  expect((await operator.read()).data).toMatchObject({ admin: true, actions: ['imessage.link', 'imessage.pair', 'imessage.pair_shared'] });
  const shared = await operator.act('imessage.pair_shared');
  expect(shared.body.reveal).toEqual({ kind: 'host_code', value: expect.stringMatching(/^wim_[a-f0-9]{48}$/) });
  expect([...operator.fx.invitations.values()].map((i) => i.kind)).toEqual(['shared']);
});

it('refuses an expired host code', async () => {
  const w = await world();
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], now: t0 });
  const code = (await w.act('imessage.pair')).body.reveal!.value;
  vi.setSystemTime(t0 + PROPOSED_LOCAL_TEST_POLICY.setupLifetimeMs + 1_000);
  expect((await w.host.redeem(code)).status).toBe(401);
  expect((await w.read()).data.bridges).toEqual([]);
});

it('issues an iMessage link code for this owner only, shown once with the one-tap Messages link', async () => {
  const w = await world();
  const issued = await w.act('imessage.link');
  const code = /^waldo ([A-HJ-NP-Z2-9]{10})$/.exec(issued.body.reveal?.value ?? '')?.[1];
  expect(code).toBeTruthy();
  expect(issued.body.reveal).toEqual({ kind: 'link_code', value: `waldo ${code}`, send_url: `sms:waldo@fixture.invalid&body=waldo%20${code}` });
  expect([...w.fx.linkCodes.values()]).toEqual([expect.objectContaining({ owner: w.name, provider: 'imessage', used: false })]);
  expect(await w.book()).not.toContain(code!);
});

it('unlinks the linked handle, and only as a top-level action', async () => {
  const w = await world();
  w.fx.presences.set('presence-fixture', { id: 'presence-fixture', owner: w.name, subject: '+15550001234', active: true, provider: 'imessage' });
  const linked = await w.read();
  expect(linked.data).toMatchObject({ linked_hint: '1234', actions: ['imessage.link', 'imessage.unlink', 'imessage.pair'] });
  expect(JSON.stringify(linked)).not.toContain('+15550001234');
  expect((await w.act('imessage.unlink', { id: 'presence-fixture' })).body).toMatchObject({ error: 'no_longer_eligible' });
  expect((await w.act('imessage.unlink')).body.receipt).toEqual({ state: 'recorded', message: 'iMessage unlinked. Texts from that number no longer reach your Waldo.' });
  expect(w.fx.presences.get('presence-fixture')?.active).toBe(false);
  expect((await w.read()).data).toMatchObject({ linked_hint: null, actions: ['imessage.link', 'imessage.pair'] });
});

it('revoking from the new console withdraws a queued reply and shuts the host out', async () => {
  const w = await world();
  await w.pairAndActivate();
  expect((await w.host.send(w.host.message('Queued then revoked'))).status).toBe(200);
  await w.pump();
  expect((await runInDurableObject(w.stub, async (_i, state) => new IMessageFinalOutbox(state.storage).records()))[0]).toMatchObject({ state: 'queued' });
  expect((await w.act('imessage.revoke', { id: w.host.bridgeId })).body.receipt).toEqual({ state: 'recorded', message: 'Mac host revoked. It can no longer send or receive for your Waldo.' });
  await w.pump(2);
  expect((await runInDurableObject(w.stub, async (_i, state) => new IMessageFinalOutbox(state.storage).records()))[0]).toMatchObject({ state: 'settled', result: { state: 'rejected', disposition: 'not_started', reason: 'binding_revoked' } });
  expect((await w.host.heartbeat()).status).toBe(401);
  expect((await w.host.pull()).status).toBe(401);
  expect(w.host.nativeSends).toHaveLength(0);
  expect((await w.read()).data.bridges[0]).toMatchObject({ state: 'revoked', actions: [] });
  expect((await w.act('imessage.revoke', { id: w.host.bridgeId })).body).toMatchObject({ error: 'no_longer_eligible' });
});

it('revoking from the new console closes texts from that host still waiting in the owner inbox', async () => {
  const w = await world();
  await w.pairAndActivate();
  // An hour on, so the waiting record's own wake cannot run it before the revoke does.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_600_000 });
  const bridgeDoName = iMessageBridgeName('test', w.host.bridgeId, w.host.accountId);
  await runInDurableObject(w.stub, async (_i, state) => {
    const admitted = await new IMessageOwnerInbox(state.storage).admit({ dedupKey: 'waiting-text', digest: '0'.repeat(64), text: 'Still waiting', conversationRef: 'imessage:fixture', binding: {} as never,
      bindingDigest: '0'.repeat(64), revision: 'fixture', environment: 'test', bridgeDoName, ownerDoName: w.name, commandId: 'waiting-command', occurredAt: Date.now() });
    expect(admitted.kind).toBe('admitted');
  });
  expect((await w.act('imessage.revoke', { id: w.host.bridgeId })).body.receipt).toMatchObject({ state: 'recorded' });
  const [record] = await runInDurableObject(w.stub, async (_i, state) => new IMessageOwnerInbox(state.storage).records());
  expect(record).toMatchObject({ dedupKey: 'waiting-text', state: 'revoked', closedReason: 'authority_revoked', text: '' });
});
