// An event notice the app takes raises one push to the owner's devices, after its row is in the app chat, with the push's
// fixed line and never the event's own words. Quiet hours and a low proactivity volume hold the push, never the row. The
// directory and Expo answer from fixtures; every value is synthetic.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { PUSHES } from '../src/channels/expo-push';
import { traceBook } from '../src/channels/harness';
import { loopBook } from '../src/channels/loops';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5d6e7f80-91a2-4b3c-8d4e-5f60718293a4';
const AT = Date.parse('2026-10-03T12:00:00Z');
const TITLE = 'Deploy finished';
const INSTALLATION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' };
// written: whether the event's text was stored when Expo was asked.
const wire = { pushes: [] as { body: string; data: unknown }[], writtenAtPush: [] as boolean[], revoked: false, expo: 'ok' as 'ok' | 'fails', whatsappTexts: [] as string[] };
let written: () => boolean = () => false;

beforeEach(() => {
  wire.pushes = []; wire.writtenAtPush = []; wire.revoked = false; wire.expo = 'ok'; wire.whatsappTexts = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'owner_runtime_authority') return Response.json(wire.revoked ? null : { owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: JSON.parse(String(init?.body)).p_do_name, state_version: 1, admission_revision: '2' });
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'app_session_authority') { const asked = JSON.parse(String(init?.body)) as Record<string, string>; return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 }); }
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'app_push_targets') return Response.json([{ installation_id: INSTALLATION, device_epoch: 1, token: 'ExponentPushToken[synthetic-event]' }]);
    if (url === 'https://exp.host/--/api/v2/push/send') {
      wire.writtenAtPush.push(written());
      for (const message of JSON.parse(String(init?.body)) as { body: string; data: unknown }[]) wire.pushes.push({ body: message.body, data: message.data });
      if (wire.expo === 'fails') throw new Error('network down');
      return Response.json({ data: [{ status: 'ok', id: 'ticket-1' }] });
    }
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; text?: { body: string } };
      if (body.type === 'text') wire.whatsappTexts.push(body.text!.body);
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.out.${wire.whatsappTexts.length}` }] });
    }
    return Response.json(null);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = InstanceType<typeof OwnerDO>;
const NOTICE = `Event - uptime: ${TITLE}`;
const stored = (state: DurableObjectState) => JSON.stringify([...state.storage.kv.list()]).includes(NOTICE);
// The event notices in the owner's app chat, as the app reads it.
const appChat = async (owner: Owner, name: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64) } }));
  expect(response.status).toBe(200);
  return (await response.json() as { messages: { text: string }[] }).messages.map(message => message.text).filter(text => text === NOTICE);
};
// An app owner (or, with `on: 'whatsapp'`, a WhatsApp-only owner), the clock at noon UTC, Expo configured.
const ownerOn = (name: string, settings: Record<string, string>, work: (owner: Owner, state: DurableObjectState, name: string) => Promise<void>, on: 'app' | 'whatsapp' = 'app') =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    Date.now = () => AT;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      if (on === 'app') state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      else { state.storage.kv.put('whatsapp_subject', '15550008888'); state.storage.kv.put('wa_last_inbound_ms', AT - 3_600_000); }
      state.storage.kv.put('timezone', 'UTC');
      written = () => stored(state);
      const owner = new OwnerDO(state, { ...env, ...directory, ...whatsapp, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-fixture',
        WALDO_OWNER_TIMEZONE: 'UTC', EXPO_ACCESS_TOKEN: 'synthetic-expo-access', OWNER_SURFACE_DEFAULT: '1', ...settings } as never);
      await work(owner, state, name);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
const event = (owner: Owner, id: string) => owner.fetch(new Request('https://telegram-owner/event', { method: 'POST', body: JSON.stringify({ subject: 'fixture', kind: 'incident', title: TITLE }), headers: {
  'x-waldo-origin': 'https://waldo.fixture.invalid', 'x-waldo-event-source': 'uptime', 'x-waldo-event-notify': '1', 'x-waldo-event-delivery': `id:${id}`, 'x-waldo-event-digest': 'b'.repeat(64),
} }));
const runs = (state: DurableObjectState) => state.storage.sql.exec<{ status: string }>("SELECT status FROM background_runs WHERE kind = 'event'").toArray().map(row => row.status);
const pushCodes = (state: DurableObjectState) => state.storage.sql.exec<{ note: string | null }>("SELECT note FROM trace_log WHERE hop = 'app_push'").toArray().map(row => row.note);
const ON = { EVENT_PUSH: '1' };

describe('an event notice in the app chat', { timeout: 30_000 }, () => {
  it('pushes the event\'s fixed line once its row is in the app chat, never the event\'s own words', async () => {
    await ownerOn('event-push-app', ON, async (owner, state, name) => {
      expect((await event(owner, 'push-1')).status).toBe(200);
      expect(await appChat(owner, name)).toEqual([NOTICE]);
      expect(wire.pushes).toEqual([{ body: PUSHES.chat.body, data: { trigger: 'chat' } }]);
      expect(wire.writtenAtPush).toEqual([true]);
      expect(JSON.stringify(wire.pushes)).not.toContain(TITLE);
      expect(runs(state)).toEqual(['completed']);
    });
  });

  it('pushes once for an event delivered twice', async () => {
    await ownerOn('event-push-redelivered', ON, async (owner, state, name) => {
      await event(owner, 'push-twice');
      await event(owner, 'push-twice');
      expect(await appChat(owner, name)).toEqual([NOTICE]);
      expect(wire.pushes).toHaveLength(1);
    });
  });

  it('writes the row and pushes nothing in the owner\'s quiet hours', async () => {
    await ownerOn('event-push-quiet', ON, async (owner, state, name) => {
      loopBook(state.storage.sql, { newId: () => 'x', now: Date.now }).setProactivity({ quiet_start: '11:00', quiet_end: '13:00', volume: 'normal' });
      await event(owner, 'push-quiet');
      expect(await appChat(owner, name)).toEqual([NOTICE]);
      expect(wire.pushes).toEqual([]);
      expect(pushCodes(state)).toEqual(['quiet']);
    });
  });

  it('writes the row and pushes nothing for an owner who set Waldo\'s volume low', async () => {
    await ownerOn('event-push-low', ON, async (owner, state, name) => {
      loopBook(state.storage.sql, { newId: () => 'x', now: Date.now }).setProactivity({ quiet_start: null, quiet_end: null, volume: 'low' });
      await event(owner, 'push-low');
      expect(await appChat(owner, name)).toEqual([NOTICE]);
      expect(wire.pushes).toEqual([]);
    });
  });

  it('pushes nothing when the row could not be written: the directory no longer admits the owner on the app', async () => {
    await ownerOn('event-push-blocked', ON, async (owner, state, name) => {
      wire.revoked = true;
      await event(owner, 'push-blocked');
      expect(stored(state)).toBe(false);
      expect(wire.pushes).toEqual([]);
      expect(runs(state)).toEqual(['stopped']);
    });
  });

  it('keeps the event delivered when Expo cannot be reached', async () => {
    await ownerOn('event-push-expo-down', ON, async (owner, state, name) => {
      wire.expo = 'fails';
      await event(owner, 'push-expo-down');
      expect(await appChat(owner, name)).toEqual([NOTICE]);
      expect(runs(state)).toEqual(['completed']);
      expect(pushCodes(state)).toEqual(['send_failed']);
    });
  });

  it('pushes nothing for an owner whose event went to WhatsApp', async () => {
    await ownerOn('event-push-whatsapp', ON, async (owner) => {
      await event(owner, 'push-whatsapp');
      expect(wire.whatsappTexts).toEqual([NOTICE]);
      expect(wire.pushes).toEqual([]);
    }, 'whatsapp');
  });

  it('with the switch off, writes the row and pushes nothing', async () => {
    await ownerOn('event-push-off', { EVENT_PUSH: '0' }, async (owner, state, name) => {
      await event(owner, 'push-off');
      expect(await appChat(owner, name)).toEqual([NOTICE]);
      expect(wire.pushes).toEqual([]);
    });
  });
});
