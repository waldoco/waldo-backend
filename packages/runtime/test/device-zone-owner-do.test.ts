import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_DEVICE_TIMEZONE_PATH, appDeviceTimezoneResultV1Schema } from '../../contracts/src/app/core';
import { appSubjectFor } from '../src/channels/app-api';
import { NIGHTLY_ID } from '../src/channels/episodes';
import { HEARTBEAT_ID } from '../src/channels/heartbeat';
import { traceBook } from '../src/channels/harness';
import { OPEN_OWNER_MARK_KEY } from '../src/identity/open-owner-hold';
import { claimStore } from '../src/memory/claims';
import { consentLedger, CURRENT_CONSENT_VERSION } from '../src/onboarding/consent-ledger';
import { ensureSchema } from '../src/tracer/schema';
import { MAIL_ONLY_GOOGLE } from './helpers/google-grant';

const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5b2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { saved: [] as string[], other: [] as string[] };

beforeEach(() => {
  wire.saved = []; wire.other = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'set_owner_settings') { wire.saved.push(asked.p_timezone!); return Response.json(true); }
    if (fn === 'release_open_owner') return Response.json(true);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read' || fn === 'assert_channel_presence') return Response.json(fn === 'assert_channel_presence' ? true : null);
    wire.other.push(url);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Runtime = Readonly<{ ready: Promise<unknown>; timezone: string; act(action: { action: string; id?: string; value?: string }): Promise<boolean | string> }>;
type Owner = Readonly<{ setup(channel: string): Runtime; fetch(request: Request): Promise<Response> }>;
type Stored = Readonly<{ zone?: string; confirmed?: boolean; held?: boolean }>;

const withAppOwner = async <T>(name: string, stored: Stored, run: (owner: Owner, state: DurableObjectState) => Promise<T>): Promise<T> => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  return runInDurableObject(stub, async (instance, state) => {
    const poolAlarm = vi.spyOn(instance as InstanceType<typeof OwnerDO>, 'alarm').mockResolvedValue(undefined);
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    if (stored.zone) state.storage.kv.put('timezone', stored.zone);
    if (stored.confirmed) state.storage.kv.put('timezone_confirmed', true);
    if (stored.held) state.storage.kv.put(OPEN_OWNER_MARK_KEY, 'held');
    await state.storage.put('google:accounts', MAIL_ONLY_GOOGLE);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'Asia/Tokyo', WALDO_OWNER_TELEGRAM_ID: undefined, ...(stored.held ? { APP_AGREEMENTS: '1' } : {}) }) as unknown as Owner;
    try { return await run(owner, state); } finally { await state.storage.deleteAlarm(); poolAlarm.mockRestore(); }
  });
};

const report = async (owner: Owner, name: string, timezone: string) => {
  const response = await owner.fetch(new Request(`https://telegram-owner${APP_DEVICE_TIMEZONE_PATH}`, {
    method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ timezone }),
  }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const nightlyZone = (state: DurableObjectState) => {
  const row = state.storage.sql.exec<{ recurrence: string | null }>('SELECT recurrence_json AS recurrence FROM schedule WHERE id = ?', NIGHTLY_ID).toArray()[0];
  return row?.recurrence ? (JSON.parse(row.recurrence) as { timezone?: string }).timezone : undefined;
};
const armed = (state: DurableObjectState, id: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM schedule WHERE id = ?', id).toArray()[0]?.status;

describe('the time zone follows the phone', () => {
  it('a new app owner\'s phone confirms their zone, so the Brief, nightly pass and heartbeat arm in it', async () => {
    await withAppOwner('device-zone-first', {}, async (owner, state) => {
      await owner.setup('app').ready;
      expect(armed(state, HEARTBEAT_ID)).toBeUndefined();
      const answer = await report(owner, 'device-zone-first', 'Asia/Kolkata');
      expect(answer).toEqual({ status: 200, body: { timezone: 'Asia/Kolkata', source: 'device', changed: true } });
      expect(appDeviceTimezoneResultV1Schema.safeParse(answer.body).success).toBe(true);
      expect(wire.saved).toEqual(['Asia/Kolkata']);
      expect(state.storage.kv.get('timezone_confirmed')).toBe(true);
      expect(nightlyZone(state)).toBe('Asia/Kolkata');
      expect(armed(state, HEARTBEAT_ID)).toBe('armed');
      expect(owner.setup('app').timezone).toBe('Asia/Kolkata');
    });
  });

  it('follows the phone when the owner travels, and a repeat of the same zone writes nothing', async () => {
    await withAppOwner('device-zone-travel', {}, async (owner, state) => {
      await owner.setup('app').ready;
      await report(owner, 'device-zone-travel', 'Asia/Kolkata');
      expect(await report(owner, 'device-zone-travel', 'Asia/Kolkata')).toEqual({ status: 200, body: { timezone: 'Asia/Kolkata', source: 'device', changed: false } });
      expect(await report(owner, 'device-zone-travel', 'Europe/London')).toEqual({ status: 200, body: { timezone: 'Europe/London', source: 'device', changed: true } });
      expect(wire.saved).toEqual(['Asia/Kolkata', 'Europe/London']);
      expect(nightlyZone(state)).toBe('Europe/London');
    });
  });

  it('a zone the owner chose wins over the phone, before and after the phone reported one', async () => {
    await withAppOwner('device-zone-owner-wins', {}, async (owner, state) => {
      await owner.setup('app').ready;
      await report(owner, 'device-zone-owner-wins', 'Asia/Kolkata');
      expect(await owner.setup('app').act({ action: 'timezone.set', value: 'America/New_York' })).toBe(true);
      expect(await report(owner, 'device-zone-owner-wins', 'Europe/London')).toEqual({ status: 200, body: { timezone: 'America/New_York', source: 'owner', changed: false } });
      expect(wire.saved).toEqual(['Asia/Kolkata', 'America/New_York']);
      expect(nightlyZone(state)).toBe('America/New_York');
    });
  });

  it('a zone confirmed before the phone could say so counts as the owner\'s own', async () => {
    await withAppOwner('device-zone-legacy', { zone: 'Europe/Paris', confirmed: true }, async (owner, state) => {
      await owner.setup('app').ready;
      expect(await report(owner, 'device-zone-legacy', 'Asia/Kolkata')).toEqual({ status: 200, body: { timezone: 'Europe/Paris', source: 'owner', changed: false } });
      expect(wire.saved).toEqual([]);
      expect(state.storage.kv.get('timezone')).toBe('Europe/Paris');
    });
  });

  it('refuses a name that is not an IANA zone, and changes nothing', async () => {
    await withAppOwner('device-zone-invalid', {}, async (owner, state) => {
      await owner.setup('app').ready;
      for (const timezone of ['EST', '+05:30', 'Mars/Olympus_Mons']) expect((await report(owner, 'device-zone-invalid', timezone)).status).toBe(400);
      expect(wire.saved).toEqual([]);
      expect(state.storage.kv.get('timezone_confirmed')).toBeUndefined();
    });
  });

  it('an owner held for their agreements is answered agreements_required, and the report goes through once they accept', async () => {
    await withAppOwner('device-zone-held', { held: true }, async (owner, state) => {
      expect(await report(owner, 'device-zone-held', 'Asia/Kolkata')).toEqual({ status: 409, body: { error: 'agreements_required' } });
      expect(wire.saved).toEqual([]);
      expect(state.storage.kv.get('timezone_confirmed')).toBeUndefined();
      expect(armed(state, NIGHTLY_ID)).toBeUndefined();
      const consent = consentLedger(state.storage.sql, { agreementsOffered: true, lookupOffered: false }), at = Date.now();
      consent.attestAge(at);
      consent.grant('terms', CURRENT_CONSENT_VERSION.terms, at);
      consent.grant('privacy_notice', CURRENT_CONSENT_VERSION.privacy_notice, at);
      expect(await report(owner, 'device-zone-held', 'Asia/Kolkata')).toEqual({ status: 200, body: { timezone: 'Asia/Kolkata', source: 'device', changed: true } });
      expect(nightlyZone(state)).toBe('Asia/Kolkata');
    });
  });
});
