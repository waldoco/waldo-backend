import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema, appControlResultV1Schema } from '../../contracts/src/app/controls';
import { claimStore } from '../src/memory/claims';
import { ownerName, recordSignupName } from '../src/onboarding/first-run';
import { ensureSchema } from '../src/tracer/schema';

// S1: the owner's name and identity lines reach the app from controls=7, and Google disconnects from Connections.
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('identity fixture forbids model calls'); } }; } }));
const { OwnerDO } = await import('../src/channels/owner-do');
const SIGNED_IN = new Date().toISOString(), UNTIL = new Date(Date.now() + 3_600_000).toISOString();

const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9c';
const HASH = 'a'.repeat(64);
const EMAIL = 'priya.owner@example.test';
const PHONE = '+919876543210';
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const world = vi.hoisted(() => ({ email: null as unknown, emailStatus: 200, phone: null as unknown, revoked: 0 }));
beforeEach(() => {
  world.email = EMAIL; world.emailStatus = 200; world.phone = { phone: PHONE, verified: true, challenge: null }; world.revoked = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://oauth2.googleapis.com/revoke') { world.revoked += 1; return new Response('{}', { status: 200 }); }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'console_session_inventory') return Response.json([{ session: HASH, created_at: SIGNED_IN, last_seen_at: SIGNED_IN, expires_at: UNTIL, rotated_to: null, signed_in_at: SIGNED_IN }]);
    if (fn === 'owner_account_email') return world.emailStatus === 200 ? Response.json(world.email) : new Response('missing', { status: world.emailStatus });
    if (fn === 'owner_phone_state') return Response.json(world.phone);
    if (fn === 'assert_channel_presence') return Response.json(false);
    if (fn === 'health_context_read' || fn === 'health_plane') return Response.json(null);
    if (fn === 'google_connections' || fn === 'connections_list' || fn === 'health_log_recent') return Response.json([]);
    return Response.json(null);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const headers = (name: string, contract?: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, 'content-type': 'application/json', ...(contract ? { 'x-waldo-app-contract': contract } : {}) });
type Owner = InstanceType<typeof OwnerDO>;
const withOwner = (name: string, run: (owner: Owner, state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    ensureSchema(state.storage); state.storage.kv.put('do_name', name);
    await state.storage.put('origin', 'https://fixture.invalid');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' });
    try { await run(owner, state); } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
const read = async (owner: Owner, name: string, view: string, contract?: string) => {
  const response = await owner.fetch(new Request(`https://telegram-owner/app/v1/controls?view=${view}`, { headers: headers(name, contract) }));
  expect(response.status).toBe(200);
  return appControlProjectionV1Schema.parse(await response.json());
};
const act = (owner: Owner, name: string, body: object, contract?: string) =>
  owner.fetch(new Request('https://telegram-owner/app/v1/actions', { method: 'POST', headers: headers(name, contract), body: JSON.stringify(body) }));

it('serves the name the owner gave at setup, and nothing once the claim\'s text no longer matches it', async () => {
  await withOwner('identity-name-claim', async (_owner, state) => {
    const claims = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    expect(ownerName(claims)).toBeNull();
    expect(recordSignupName(claims, 'Priya', Date.now())).toBe(true);
    expect(ownerName(claims)).toBe('Priya');
    const saved = claims.claims().find(claim => claim.source_ref === 'owner, first run: name')!;
    expect(claims.correct(saved.id, { kind: 'preference', text: 'Likes tea and goes by anything', source: 'stated', evidence: 'edited by the owner', origin: 'owner', source_ref: 'owner, first run: name' }, new Date().toISOString())).toBe(true);
    expect(ownerName(claims)).toBeNull();
  });
});

it('the day view names the owner from controls=7, and a build below it receives the page it always did', async () => {
  await withOwner('identity-day', async (owner, state) => {
    recordSignupName(claimStore(state.storage.sql), 'Priya', Date.now());
    const seven = await read(owner, 'identity-day', 'day', 'controls=7');
    expect(seven.view === 'day' && seven.data.name).toBe('Priya');
    for (const contract of [undefined, 'controls=6', 'controls=3']) {
      const older = await read(owner, 'identity-day', 'day', contract);
      expect(older.view === 'day' && 'name' in older.data).toBe(false);
      expect(older.revision).toBe(seven.revision);
    }
  });
  await withOwner('identity-day-unnamed', async (owner) => {
    const seven = await read(owner, 'identity-day-unnamed', 'day', 'controls=7');
    expect(seven.view === 'day' && 'name' in seven.data).toBe(false);
  });
});

it('the account view carries the name, the sign-in email and a verified number from controls=7, under the same revision as before', async () => {
  await withOwner('identity-account', async (owner, state) => {
    recordSignupName(claimStore(state.storage.sql), 'Priya', Date.now());
    const seven = await read(owner, 'identity-account', 'account', 'controls=7');
    expect(seven.view === 'account' && seven.data).toEqual({ deletion_available: true, name: 'Priya', email: EMAIL, phone: PHONE });
    const older = await read(owner, 'identity-account', 'account', 'controls=6');
    expect(older.view === 'account' && older.data).toEqual({ deletion_available: true });
    expect(older.revision).toBe(seven.revision);
  });
});

it('an unverified number is not served, and an email the directory cannot give leaves its line out without failing the view', async () => {
  world.phone = { phone: PHONE, verified: false, challenge: null };
  await withOwner('identity-partial', async (owner) => {
    const unverified = await read(owner, 'identity-partial', 'account', 'controls=7');
    expect(unverified.view === 'account' && unverified.data).toEqual({ deletion_available: true, email: EMAIL });
    world.emailStatus = 404;
    const missing = await read(owner, 'identity-partial', 'account', 'controls=7');
    expect(missing.view === 'account' && missing.data).toEqual({ deletion_available: true });
    world.emailStatus = 200; world.email = 'not an address';
    const garbled = await read(owner, 'identity-partial', 'account', 'controls=7');
    expect(garbled.view === 'account' && garbled.data).toEqual({ deletion_available: true });
  });
});

const account = { id: 'local:priya.owner@example.test', email: EMAIL, scopes: [CALENDAR], refresh_token: '1//synthetic-local-refresh' };
const connections = (owner: Owner, name: string) => read(owner, name, 'connections', 'controls=7');
const disconnect = (owner: Owner, name: string, revision: string, request_id: string, contract = 'controls=7', id = account.id) =>
  act(owner, name, { view: 'connections', action: 'google.disconnect', id, revision, request_id }, contract);

it('disconnects a Google account from the app through the console\'s one revocation path, and records the receipt once', async () => {
  await withOwner('identity-google-disconnect', async (owner, state) => {
    await state.storage.put('google:accounts', [account]);
    const before = await connections(owner, 'identity-google-disconnect');
    expect(before.view === 'connections' && before.data.google.accounts.map(row => row.id)).toEqual([account.id]);
    const response = await disconnect(owner, 'identity-google-disconnect', before.revision, 'google-disc-0001');
    expect([response.status, await response.clone().json()]).toEqual([200, expect.anything()]);
    expect(appControlResultV1Schema.parse(await response.json())).toMatchObject({ request_id: 'google-disc-0001', receipt: { state: 'recorded' }, duplicate: false });
    expect(world.revoked).toBe(1);
    expect(await state.storage.get('google:accounts')).toEqual([]);
    const replay = await disconnect(owner, 'identity-google-disconnect', before.revision, 'google-disc-0001');
    expect(await replay.json()).toMatchObject({ receipt: { state: 'recorded' }, duplicate: true });
    expect(world.revoked).toBe(1);
    const after = await connections(owner, 'identity-google-disconnect');
    expect(after.view === 'connections' && after.data.google.accounts).toEqual([]);
  });
});

it('refuses a Google disconnect below controls=7, for an account Waldo does not hold, or on a stale read, and changes nothing', async () => {
  await withOwner('identity-google-refused', async (owner, state) => {
    await state.storage.put('google:accounts', [account]);
    const before = await connections(owner, 'identity-google-refused');
    for (const contract of ['controls=6', 'controls=1']) expect((await disconnect(owner, 'identity-google-refused', before.revision, 'google-disc-0002', contract)).status).toBe(400);
    expect((await disconnect(owner, 'identity-google-refused', before.revision, 'google-disc-0003', 'controls=7', 'local:someone.else@example.test')).status).toBe(409);
    expect((await disconnect(owner, 'identity-google-refused', 'b'.repeat(64), 'google-disc-0004')).status).toBe(409);
    expect((await act(owner, 'identity-google-refused', { view: 'connections', action: 'google.disconnect', revision: before.revision, request_id: 'google-disc-0005' }, 'controls=7')).status).toBe(400);
    expect(world.revoked).toBe(0);
    expect(await state.storage.get('google:accounts')).toEqual([account]);
  });
});
