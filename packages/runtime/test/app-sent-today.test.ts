// What Waldo sent first today and what became of each, in the app's day view (controls revision 26), through the Worker and the
// owner's Durable Object. Kinds, surfaces, times, outcomes and codes reach the app; no internal id and no words do. The list sits
// outside the day's revision: a send between a read and an action never makes the action stale. The clock is mocked: UTC.
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { APP_CONTROLS_SENT_TODAY_REVISION, appControlProjectionV1Schema } from '../../contracts/src/app/controls';
import { APP_CONTRACT_HEADER } from '../../contracts/src/app/core';
import { OwnerDO } from '../src/channels/owner-do';
import { handleApp } from '../src/channels/app-api';
import { recordAppSend, recordSendEnded } from '../src/channels/send-outcomes';
import type { FinalRecord } from '../src/channels/telegram-final-outbox';

vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => { throw Error('No Telegram binding exists'); } }));

const SECRET = 'fictional-sent-today-router-secret-000000000000', DIRECTORY = 'https://sent-today-app.fixture.invalid', ORIGIN = 'https://app.fixture.invalid';
const OWNER = '10000000-0000-0000-0000-000000000026', AUTH = '20000000-0000-0000-0000-000000000026', EMAIL = 'sent-today-owner@example.test', WHATSAPP = '15550001111';

type Directory = { whatsapp: 'linked' | 'not_linked' | 'down' };
type App = (path: string, body?: unknown) => Promise<Response>;
type World = { app: App; storage: DurableObjectStorage; directory: Directory };

const fixture = async (run: (world: World) => Promise<void>, options: { revision?: number; bound?: boolean; wake?: boolean; confirmed?: boolean } = {}) => {
  const name = `app-sent-today-owner-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    let hash: string | undefined, live = false;
    const created = new Date().toISOString(), expires = Date.now() + 3_600_000, directory: Directory = { whatsapp: 'linked' };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe(DIRECTORY); const a = JSON.parse(String(init?.body ?? '{}'));
      if (url.pathname === '/auth/v1/otp') return Response.json({});
      if (url.pathname === '/auth/v1/verify') return Response.json({ user: { id: AUTH, email: EMAIL } });
      const fn = url.pathname.split('/').at(-1)!;
      if (fn === 'presence_hint') {
        if (a.p_provider !== 'whatsapp') return Response.json(null);
        if (directory.whatsapp === 'down') return new Response('down', { status: 503 });
        return Response.json(directory.whatsapp === 'linked' ? '1111' : null);
      }
      if (fn === 'console_auth_throttle') return Response.json(true);
      if (fn === 'signin_allowed') return Response.json(a.p_email === EMAIL);
      if (fn === 'owner_for_auth') return Response.json(a.p_auth_user === AUTH && a.p_email === EMAIL ? name : null);
      if (fn === 'console_session_open') { hash = a.p_session_hash; live = true; return Response.json(true); }
      if (fn === 'console_session_touch') return Response.json(live && a.p_session_hash === hash);
      if (fn === 'console_session_inventory') return Response.json(live && a.p_do_name === name ? [{ session: hash, created_at: created, last_seen_at: created, expires_at: new Date(Date.parse(created) + 12 * 60 * 60_000).toISOString(), rotated_to: null, signed_in_at: created }] : []);
      if (fn === 'owner_runtime_authority') return Response.json(a.p_do_name === name ? { owner_id: OWNER, auth_user_id: AUTH, do_name: name, state_version: 0, admission_revision: '1' } : null);
      if (fn === 'app_session_authority') return Response.json(live && a.p_do_name === name && a.p_session_hash === hash ? { owner_id: OWNER, do_name: name, session_hash: hash, state_version: 0, admission_revision: '1', expires_at: expires } : null);
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'sent-today-app-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'health_plane' || fn === 'health_context_read') return Response.json(null);
      if (fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined, WALDO_ENVIRONMENT: 'staging',
      WALDO_OWNER_DO_NAMESPACE: 'sent-today-app-owner', WALDO_OWNER_TIMEZONE: 'UTC', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: SECRET,
      WHATSAPP_ACCESS_TOKEN: 'synthetic-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: '100000000000001', GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, WAKE_BRIEF: options.wake ? '1' : undefined };
    // A set-up owner: the zone is confirmed, so the app's runtime arms the day's own jobs.
    state.storage.kv.put('timezone', 'UTC'); if (options.confirmed !== false) state.storage.kv.put('timezone_confirmed', true);
    const instance = new OwnerDO(state, settings as never);
    if (options.bound !== false) state.storage.kv.put('whatsapp_subject', WHATSAPP);
    const routed = { ...settings, OWNER_DO: { idFromName: (n: string) => env.OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
    let credential: string | undefined;
    const app: App = async (path, body) => {
      const response = await handleApp(new Request(`${ORIGIN}/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', [APP_CONTRACT_HEADER]: `controls=${options.revision ?? APP_CONTROLS_SENT_TODAY_REVISION}`, ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routed);
      expect(response).not.toBeNull(); return response!;
    };
    try {
      expect((await app('/auth/code', { email: EMAIL })).status).toBe(200);
      credential = ((await (await app('/auth/verify', { email: EMAIL, code: '123456' })).json()) as { credential: string }).credential;
      await run({ app, storage: state.storage, directory });
    } finally { fetcher.mockRestore(); }
  });
};

const dayView = async (app: App) => {
  const response = await app('/controls?view=day');
  expect(response.status).toBe(200);
  return appControlProjectionV1Schema.parse(await response.json()) as { revision: string; data: { sent_today?: { items: Record<string, unknown>[]; total: number } } };
};
const NOW = Date.parse('2026-11-27T09:00:00Z');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());
const failed = (id: string, at: number): FinalRecord => ({ id, trace: 't', payload: { chat_id: 1, text: 'synthetic words that never reach the app' }, digest: 'd', ownerSubject: WHATSAPP,
  doName: 'owner', status: 'blocked', reason: 'whatsapp_payment_required', dueAt: 0, createdAt: at, attempts: 0, dayCard: { day: '2026-11-27', card: 'card:brief', foldUpTo: 0 } });

it('lists today\'s Waldo-first sends newest first, by kind, surface, outcome and code, with no id or words, and a new send leaves the day\'s revision as it was', async () => {
  await fixture(async ({ app, storage }) => {
    recordSendEnded(storage.kv, failed('day-card:2026-11-27:card:brief', NOW - 60 * 60_000), 'whatsapp', NOW - 60 * 60_000);
    recordAppSend(storage.kv, 'scheduled-a', 'day_card', NOW - 30 * 60_000);
    const before = await dayView(app);
    expect(before.data.sent_today).toEqual({ total: 2, items: [
      { kind: 'day_card', surface: 'app', at: NOW - 30 * 60_000, outcome: 'delivered' },
      { kind: 'day_card', surface: 'whatsapp', at: NOW - 60 * 60_000, outcome: 'failed', code: 'whatsapp_payment_required' },
    ] });
    expect(JSON.stringify(before.data.sent_today)).not.toMatch(/scheduled-a|day-card:|synthetic words/);
    recordAppSend(storage.kv, 'scheduled-b', 'message', NOW - 60_000);
    const after = await dayView(app);
    expect(after.data.sent_today?.total).toBe(3);
    expect(after.revision).toBe(before.revision);
  });
});

it('a build below revision 26 never receives the list', async () => {
  await fixture(async ({ app, storage }) => {
    recordAppSend(storage.kv, 'scheduled-a', 'day_card', NOW - 30 * 60_000);
    expect((await dayView(app)).data.sent_today).toBeUndefined();
  }, { revision: APP_CONTROLS_SENT_TODAY_REVISION - 1 });
});
