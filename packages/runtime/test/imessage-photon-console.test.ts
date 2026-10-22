import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { routerSignature } from '../src/identity/owner-directory';
import { enrolledReply, iMessageBridgeName, LINK_REPLIES, SYSTEM_OWNER_ID } from '../src/channels/imessage/bridge-do';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost } from './helpers/imessage-sim-host';

// The shared Waldo number on Photon: an operator connects Photon once, then each owner gets their own Waldo number
// from the console in one step. Photon's OAuth server and Dashboard API are answered here; every credential is fictional.

vi.mock('openai', () => ({ default: class { responses = { create: async (input: { text?: { format?: { name?: string } } }) => {
  const format = input.text?.format?.name;
  return { id: 'scripted', output: [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : 'Scripted owner reply.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000', HOST_ORIGIN = 'https://imessage.fixture.invalid';
const PHOTON = 'https://app.photon.codes', CONSOLE_URL = 'https://imessage.fixture.invalid/console/imessage';
const OP = '+15550000010', ALICE = '+15550000011';
afterEach(() => { vi.restoreAllMocks(); });

const photonObject = () => env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(JSON.stringify(['photon-oauth', 'test'])));
type PhotonUser = { id: string; phoneNumber: string; assignedPhoneNumber: string; email: string };
async function world() {
  const id = crypto.randomUUID().slice(0, 8);
  const owners: FixtureOwner[] = [
    { do_name: `photon-op-${id}`, owner_id: '60000000-0000-4000-8000-000000000001', state: 'active', state_version: 1, admission_revision: 1, admin: true, email: 'op@example.invalid' },
    { do_name: `photon-alice-${id}`, owner_id: '60000000-0000-4000-8000-000000000002', state: 'active', state_version: 1, admission_revision: 1, email: 'alice@example.invalid', phone: ALICE },
    { do_name: `photon-bob-${id}`, owner_id: '60000000-0000-4000-8000-000000000003', state: 'active', state_version: 1, admission_revision: 1, email: 'bob@example.invalid' },
  ];
  const fx = fixtureDirectory({ origin: ORIGIN, secret: SECRET, owners, extra: (fn, a) => {
    if (fn === 'console_session_touch' || fn === 'console_auth_throttle') return Response.json(true);
    if (fn === 'health_context_read' || fn === 'health_plane') return Response.json(null);
    if (fn === 'admin_overview') return Response.json(owners.find((o) => o.do_name === a.p_do_name)?.admin ? { owners: [], invites: [] } : null);
    return null;
  } });
  // Photon: token endpoint and the project's Spectrum users. Each create is assigned the next pool number.
  const photon = { users: [] as PhotonUser[], tokenCalls: [] as URLSearchParams[], creates: 0, refreshes: new Set<string>() };
  const answerPhoton = async (url: URL, init?: RequestInit): Promise<Response> => {
    if (url.pathname === '/api/auth/oauth2/token') {
      const form = new URLSearchParams(String(init?.body)); photon.tokenCalls.push(form);
      if (form.get('grant_type') === 'refresh_token' && !photon.refreshes.delete(form.get('refresh_token')!)) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const refresh = `refresh-${photon.tokenCalls.length}`; photon.refreshes.add(refresh);
      return Response.json({ access_token: `access-${photon.tokenCalls.length}`, token_type: 'Bearer', expires_in: 900, refresh_token: refresh });
    }
    if (url.pathname === '/api/projects/proj-fixture/spectrum/users') {
      if (!new Headers(init?.headers).get('authorization')?.startsWith('Bearer access-')) return new Response('', { status: 401 });
      if ((init?.method ?? 'GET') === 'GET') return Response.json(photon.users);
      const body = JSON.parse(String(init?.body)) as { phoneNumber: string; email: string; sendInvite: boolean };
      expect(body.sendInvite).toBe(false);
      const user = { id: `user-${++photon.creates}`, phoneNumber: body.phoneNumber, assignedPhoneNumber: `+1628555010${photon.creates}`, email: body.email };
      photon.users.push(user);
      return Response.json({ success: true, user });
    }
    return new Response('', { status: 404 });
  };
  const egress: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const handled = await fx.fetcher(input as RequestInfo, init);
    if (handled) return handled;
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === PHOTON) return answerPhoton(url, init);
    egress.push(url.origin);
    throw new Error(`forbidden egress ${url.origin}`);
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
    const get = (path: string, extra = '') => call(new Request(`${HOST_ORIGIN}${path}`, { headers: { cookie: extra ? `${cookie}; ${extra}` : cookie }, redirect: 'manual' }));
    const action = (actionName: string, fields: Record<string, string> = {}) => {
      const form = new FormData(); form.set('action', actionName); form.set('csrf', csrf);
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return call(new Request(`${HOST_ORIGIN}/console/action`, { method: 'POST', body: form, headers: { cookie }, redirect: 'manual' }));
    };
    type Controls = { csrf: string; revision: string; data: { address: string | null; phone: string | null; photon: string | null; actions: string[] } };
    const controls = async () => (await get('/console/dashboard/api/v1/controls?view=imessage')).json() as Promise<Controls>;
    let n = 0;
    const act = async (actionName: string, fields: Record<string, string> = {}) => {
      const current = await controls();
      const body = new URLSearchParams({ csrf: current.csrf, revision: current.revision, view: 'imessage', action: actionName, request_id: `photon-${name}-${++n}`, ...fields });
      const response = await call(new Request(`${HOST_ORIGIN}/console/dashboard/api/v1/actions`, { method: 'POST', redirect: 'manual', headers: { cookie, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body }));
      return { status: response.status, body: await response.json() as { receipt?: { state: string; message: string }; reveal?: { kind: string; value: string; to?: string } } };
    };
    return { stub, get, action, controls, act, name };
  };
  const [op, alice, bob] = [await consoleFor(owners[0]!.do_name), await consoleFor(owners[1]!.do_name), await consoleFor(owners[2]!.do_name)];
  // One Photon object per environment: each test starts with Photon disconnected.
  await runInDurableObject(photonObject(), async (_i, state) => { await state.storage.deleteAll(); });
  /** The operator's whole Photon sign-in, as the browser makes it. */
  const connectPhoton = async () => {
    const start = await op.get('/console/imessage/photon/start');
    expect(start.status).toBe(303);
    const authorize = new URL(start.headers.get('location')!);
    const binding = start.headers.get('set-cookie')!.split(';')[0]!;
    const callback = (cookie: string) => call(new Request(`${HOST_ORIGIN}/imessage/photon/callback?code=code-1&state=${authorize.searchParams.get('state')}`, { headers: cookie ? { cookie } : {} }));
    return { authorize, binding, callback };
  };
  const host = new SimulatedHost(call, HOST_ORIGIN);
  const bridgeStub = () => env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(iMessageBridgeName('test', host.bridgeId, host.accountId)));
  const pump = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) {
      await runDurableObjectAlarm(bridgeStub()); await settle();
      for (const o of [op, alice, bob]) { await runDurableObjectAlarm(o.stub); await settle(); }
    }
  };
  const deliverNext = async () => {
    const { delivery } = await host.pull();
    if (!delivery) return null;
    const command = JSON.parse(delivery.body);
    const result = await host.execute(delivery);
    expect((await host.postResult(delivery, result)).status).toBe(200);
    await pump(2);
    return { text: command.text as string, chatGuid: command.target.chatGuid as string, ownerId: command.binding.ownerId as string };
  };
  const sharedLive = async () => {
    const code = (await (await op.action('imessage.pair_shared')).text()).split('\n')[0]!;
    expect((await host.redeem(code)).status).toBe(200);
    const challenge = (await (await op.action('imessage.verify', { id: host.bridgeId, subject: OP, chat: `iMessage;-;${OP}` })).text()).split('\n')[0]!;
    expect((await host.send(host.message(challenge, { senderHandle: OP }))).status).toBe(200);
    expect((await op.action('imessage.activate_shared', { id: host.bridgeId, subject: OP, chat: `iMessage;-;${OP}` })).status).toBe(303);
    expect((await host.heartbeat()).status).toBe(200);
    expect((await host.capabilities()).status).toBe(200);
  };
  return { fx, photon, egress, op, alice, bob, call, connectPhoton, host, pump, deliverNext, sharedLive };
}

it('only an operator starts the Photon sign-in, and only the browser that started it can finish it, once', async () => {
  const w = await world();
  expect((await w.alice.get('/console/imessage/photon/start')).status).toBe(404);
  expect((await w.op.controls()).data.photon).toBe('disconnected');
  const { authorize, binding, callback } = await w.connectPhoton();
  expect(authorize.origin + authorize.pathname).toBe(`${PHOTON}/api/auth/oauth2/authorize`);
  expect(authorize.searchParams.get('redirect_uri')).toBe(`${HOST_ORIGIN}/imessage/photon/callback`);
  expect(binding).toMatch(/^__Secure-waldo-oauth-/);
  // A callback carried to another browser (no binding cookie) connects nothing and spends nothing.
  const unbound = await callback('');
  expect(unbound.status).toBe(403);
  expect(w.photon.tokenCalls).toHaveLength(0);
  const linked = await callback(binding);
  expect(linked.status).toBe(200);
  expect(await linked.text()).toContain('Photon connected');
  expect(w.photon.tokenCalls[0]!.get('grant_type')).toBe('authorization_code');
  expect((await callback(binding)).status).toBe(400); // the attempt was single use
  expect((await w.op.controls()).data.photon).toBe('connected');
  expect((await w.alice.controls()).data.photon).toBeNull(); // only operators see the connection
  expect(w.egress).toEqual([]);
});

it('an owner gets their own Waldo number in one step and links it with one text; an enrolled sender without a code is sent to their console', async () => {
  const w = await world();
  // Before Photon is connected, nothing is enrolled and nothing reaches Photon's users API.
  const early = await w.alice.act('imessage.enroll', { phone: ALICE });
  expect(early.body.receipt).toMatchObject({ state: 'rejected' });
  expect(early.body.receipt!.message).toContain('reconnect Photon');
  const { binding, callback } = await w.connectPhoton();
  expect((await callback(binding)).status).toBe(200);

  const before = await w.alice.controls();
  expect(before.data).toMatchObject({ address: null, phone: ALICE });
  expect(before.data.actions).toContain('imessage.enroll'); expect(before.data.actions).not.toContain('imessage.link');
  const enrolled = await w.alice.act('imessage.enroll', { phone: '+1 555 000 0011' });
  expect(enrolled.body.receipt).toMatchObject({ state: 'recorded' });
  expect(enrolled.body.reveal).toMatchObject({ kind: 'link_code', to: '+16285550101' });
  expect(w.photon.users).toEqual([expect.objectContaining({ phoneNumber: ALICE, assignedPhoneNumber: '+16285550101', email: 'alice@example.invalid' })]);
  const after = await w.alice.controls();
  expect(after.data.address).toBe('+16285550101'); expect(after.data.actions).toContain('imessage.link');
  // Enrolling the same number again is a no-op; another owner cannot take it.
  expect((await w.alice.act('imessage.enroll', { phone: ALICE })).body.reveal).toMatchObject({ to: '+16285550101' });
  expect(w.photon.creates).toBe(1);
  const taken = await w.bob.act('imessage.enroll', { phone: ALICE });
  expect(taken.body.receipt).toMatchObject({ state: 'rejected' }); expect(taken.body.receipt!.message).toContain('another Waldo account');

  // The shared number is live. Alice texts it without a code: she is told to finish in her console, and reaches no Waldo.
  await w.sharedLive();
  expect((await w.host.send(w.host.message('hi waldo', { senderHandle: ALICE }))).status).toBe(200);
  await w.pump();
  expect(await w.deliverNext()).toMatchObject({ text: enrolledReply(CONSOLE_URL), chatGuid: `iMessage;-;${ALICE}`, ownerId: SYSTEM_OWNER_ID });
  // The console's one-tap link names her own number; sending the code links her.
  const page = await (await w.alice.action('imessage.link')).text();
  const code = /waldo ([A-Z2-9]{10})</.exec(page)?.[1];
  expect(page).toContain(`sms:+16285550101&#38;body=waldo%20${code}`);
  expect((await w.host.send(w.host.message(`waldo ${code}`, { senderHandle: ALICE }))).status).toBe(200);
  await w.pump();
  expect(await w.deliverNext()).toMatchObject({ text: LINK_REPLIES.redeemed, chatGuid: `iMessage;-;${ALICE}` });
  expect(w.egress).toEqual([]);
});

it('a refresh token Photon refuses disconnects Photon instead of failing silently', async () => {
  const w = await world();
  const { binding, callback } = await w.connectPhoton();
  expect((await callback(binding)).status).toBe(200);
  w.photon.refreshes.clear(); // Photon no longer honours the stored refresh token
  await runInDurableObject(photonObject(), async (_i, state) => { state.storage.kv.delete('photon.access'); });
  const refused = await w.alice.act('imessage.enroll', { phone: ALICE });
  expect(refused.body.receipt!.message).toContain('reconnect Photon');
  expect((await w.op.controls()).data.photon).toBe('disconnected');
});
