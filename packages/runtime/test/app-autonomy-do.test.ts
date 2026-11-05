import { appAutonomyChangeResultV1Schema, appAutonomyV1Schema } from '../../contracts/src/app/autonomy';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { handleApp } from '../src/channels/app-api';
import { routerSignature } from '../src/identity/owner-directory';

const proof = vi.hoisted(() => ({
  outputs: [] as any[][], telegram: [] as { method: string; body: any }[], moved: 0, sentRaw: [] as string[], eventTag: 'etag-3pm', light: 0,
}));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  // The light step (WALDO_LIGHT_CHAT) is the request that offers escalate; it hands the turn over.
  if (input.tools?.some((tool: { name?: string }) => tool.name === 'escalate')) { proof.light += 1; return { id: 'approvals-light-step', output: [{ type: 'function_call', call_id: 'light-escalate', name: 'escalate', arguments: '{}' }], output_text: '', usage: { input_tokens: 1, output_tokens: 1 } }; }
  return { id: 'approvals-fixture-reply', output: format ? [] : proof.outputs.shift() ?? [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : 'I proposed moving it to 4.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, body: any) => {
  proof.telegram.push({ method, body });
  return method === 'sendMessage' ? { message_id: proof.telegram.length, chat: { id: body.chat_id } } : method === 'getMe' ? { username: 'fixture_bot' } : true;
} }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: () => ({
    event: async (id: string) => ({ id, etag: proof.eventTag, title: 'Design review', status: 'confirmed', start: '2030-01-02T15:00:00Z', end: '2030-01-02T16:00:00Z' }),
    moveEvent: async () => { proof.moved++; proof.eventTag = 'etag-4pm'; return { id: 'ev-3pm', etag: 'etag-4pm' }; },
    sendRaw: async (raw: string) => { proof.sentRaw.push(raw); return { message_id: 'gmail-1' }; },
    findSentByMessageId: async (messageId: string) => proof.sentRaw.length ? { message_id: 'gmail-1', thread_id: 'thread-1', rfc822_message_id: messageId, label_ids: ['SENT'] } : false,
  }) };
});

// The autonomy routes as the app reaches them: through the worker's router, the session check and the owner object.
it.each(['1', '0'])('reads and changes the owner\'s autonomy through the router (AUTONOMY_OWN_CALENDAR %s)', async (autonomy) => {
  proof.outputs = []; proof.telegram = []; proof.moved = 0; proof.sentRaw = []; proof.eventTag = 'etag-3pm'; proof.light = 0;
  const name = `approvals-app-owner-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    const SECRET = 'fictional-approvals-router-secret-0000000000', DIRECTORY = 'https://approvals.fixture.invalid', OWNER = '10000000-0000-0000-0000-0000000000a1', AUTH = '20000000-0000-0000-0000-0000000000a1', EMAIL = 'owner@example.test', TELEGRAM = 424242;
    let hash: string | undefined, live = false; const created = new Date().toISOString(), expires = Date.now() + 3_600_000;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe(DIRECTORY); const a = JSON.parse(String(init?.body));
      if (url.pathname === '/auth/v1/otp') return Response.json({});
      if (url.pathname === '/auth/v1/verify') return Response.json({ user: { id: AUTH, email: EMAIL } });
      const fn = url.pathname.split('/').at(-1)!;
      if (fn === 'console_auth_throttle') return Response.json(true);
      if (fn === 'signin_allowed') return Response.json(a.p_email === EMAIL);
      if (fn === 'owner_for_auth') return Response.json(a.p_auth_user === AUTH ? name : null);
      if (fn === 'console_session_open') { hash = a.p_session_hash; live = true; return Response.json(true); }
      if (fn === 'console_session_touch') return Response.json(live && a.p_session_hash === hash);
      if (fn === 'console_session_inventory') return Response.json(live && a.p_do_name === name ? [{ session: hash, created_at: created, last_seen_at: created, expires_at: new Date(Date.parse(created) + 12 * 60 * 60_000).toISOString(), rotated_to: null, signed_in_at: created }] : []);
      if (fn === 'owner_runtime_authority') return Response.json(a.p_do_name === name ? { owner_id: OWNER, auth_user_id: AUTH, do_name: name, state_version: 0, admission_revision: '1' } : null);
      if (fn === 'app_session_authority') return Response.json(live && a.p_do_name === name && a.p_session_hash === hash ? { owner_id: OWNER, do_name: name, session_hash: hash, state_version: 0, admission_revision: '1', expires_at: expires } : null);
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'approvals-app-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'assert_channel_presence') { expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, `presence.${a.p_do_name}.${a.p_provider}.${a.p_subject}`)); return Response.json(a.p_do_name === name && a.p_provider === 'telegram' && a.p_subject === String(TELEGRAM)); }
      if (fn === 'health_context_read') return Response.json({ context: null, previous: null });
      if (fn === 'health_plane') return Response.json(null);
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', TELEGRAM_WEBHOOK_SECRET: 'fictional-webhook-secret', WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined,
      WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE: 'approvals-app-owner', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key',
      WALDO_ROUTER_HMAC_SECRET: SECRET, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, BROWSER: undefined, GOOGLE_CLIENT_ID: 'fictional-client', GOOGLE_CLIENT_SECRET: 'fictional-secret', AUTONOMY_OWN_CALENDAR: autonomy };
    const instance = new OwnerDO(state, settings as never);
    state.storage.kv.put('do_name', name); state.storage.kv.put('origin', 'https://app.fixture.invalid'); state.storage.kv.put('telegram_subject', String(TELEGRAM));
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', scopes: null, refresh_token: 'fictional-not-a-token' }]);
    const routed = { ...settings, OWNER_DO: { idFromName: (n: string) => env.OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
    const app = async (path: string, body?: unknown, credential?: string) => {
      const response = await handleApp(new Request(`https://app.fixture.invalid/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routed);
      expect(response).not.toBeNull(); return response!;
    };
    try {
      expect((await app('/auth/code', { email: EMAIL })).status).toBe(200);
      const credential = (await (await app('/auth/verify', { email: EMAIL, code: '123456' })).json() as { credential: string }).credential;

      const call = async (method: 'GET' | 'POST', path: string, contract: string | null, body?: unknown, signedIn = true) => (await handleApp(new Request(`https://app.fixture.invalid/app/v1${path}`, { method,
        headers: { 'content-type': 'application/json', ...(signedIn ? { authorization: `Bearer ${credential}` } : {}), ...(contract ? { 'x-waldo-app-contract': contract } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routed))!;
      expect((await call('GET', '/autonomy', null)).status).toBe(404);
      expect((await call('GET', '/autonomy', 'autonomy=1', undefined, false)).status).toBe(401);
      expect((await call('POST', '/autonomy', 'autonomy=1', {})).status).toBe(405);
      expect((await call('GET', '/autonomy/changes', 'autonomy=1')).status).toBe(405);
      expect((await call('GET', '/autonomy/receipts', 'autonomy=1')).status).toBe(404);
      const read = await call('GET', '/autonomy', 'approvals=5,autonomy=1');
      expect(read.status).toBe(200);
      const settings = appAutonomyV1Schema.parse(await read.json());
      expect(settings).toMatchObject({ paused: null, classes: expect.arrayContaining([expect.objectContaining({ class: 'calendar.move_own_block', availability: 'available', grants: [] })]) });
      const now = Date.now();
      const terms = { scope: { class: 'calendar.move_own_block', account: 'owner@example.test', window: { from: '08:00', to: '19:00' }, weekdays: [1, 2, 3, 4, 5], min_lead_minutes: 30 },
        limits: { max_per_day: 3, timezone: 'UTC' }, valid_from: now, expires_at: now + 30 * 86_400_000 };
      const granted = await call('POST', '/autonomy/changes', 'autonomy=1', { request_id: 'autonomy-do-0001', expected_revision: settings.revision, change: { op: 'grant', terms } });
      expect([granted.status, appAutonomyChangeResultV1Schema.parse(await granted.json()).receipt.state]).toEqual(autonomy === '1' ? [200, 'recorded'] : [409, 'rejected']);
      const after = appAutonomyV1Schema.parse(await (await call('GET', '/autonomy', 'autonomy=1')).json());
      expect(after.classes.find(entry => entry.class === 'calendar.move_own_block')!.grants.map(grant => grant.created_via)).toEqual(autonomy === '1' ? ['app'] : []);
      // Narrowing works whatever the switch says.
      expect((await call('POST', '/autonomy/changes', 'autonomy=1', { request_id: 'autonomy-do-0002', change: { op: 'pause' } })).status).toBe(200);
      expect(appAutonomyV1Schema.parse(await (await call('GET', '/autonomy', 'autonomy=1')).json()).paused).toMatchObject({ via: 'app' });
    } finally { (instance as any).ownerBrowser.stop(); await (instance as any).ownerBrowser.maintain(); await state.storage.deleteAlarm(); fetcher.mockRestore(); }
  });
});
