import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';
import { GOOGLE_PROBE_MS } from '../src/connectors/google-circuit';
import { reconnectNoticeText } from '../src/connectors/google-reconnect';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// A Google grant that dies (a Testing-mode grant lapses after seven days) earns the owner one notice per failure episode,
// on the surface their proactive messages reach. Telegram carries a reconnect button; the app and WhatsApp have none, so their
// notice is plain text through the delivery outbox, saying where to reconnect, and no connect link is minted.
const EMAIL = 'owner@example.test';
const ACCOUNT = `local:${EMAIL}`;
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const OWNER_ID = '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const google = { GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', WALDO_OAUTH_STATE_SECRET: 'synthetic-state-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en' };
const SUBJECT = '15550004444';
const HOUR = 3_600_000;
const START = Date.parse('2031-03-04T09:00:00Z');

// The account's calendar read: the token refresh reports invalid_grant to the host and the read fails 401, or it works.
const grant = vi.hoisted(() => ({ dead: true }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, health: ((error: string) => void) | undefined, account: unknown) => ({
    account, events: async () => [], changedEvents: async () => [], newMail: async () => [],
    calendarPage: async () => {
      if (grant.dead) { health?.('google token failed: invalid_grant'); throw new original.GoogleError(401, 'google token failed: invalid_grant'); }
      health?.('');
      return { events: [], next_page_token: null, fetched_count: 0, account, observed_at: new Date().toISOString() };
    },
  }) };
});
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('the reconnect fixture forbids model calls'); } }; } }));
const { OwnerDO } = await import('../src/channels/owner-do');

const wire = { rpcs: [] as string[], whatsapp: [] as string[] };
beforeEach(() => {
  grant.dead = true; wire.rpcs = []; wire.whatsapp = [];
  vi.useFakeTimers({ toFake: ['Date'], now: START });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn) wire.rpcs.push(fn);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + HOUR });
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'connect_session_issue') return Response.json('session-1');
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'presence_hint') return Response.json(null);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_log_recent') return Response.json([]);
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; template?: { name: string }; text?: { body: string } };
      wire.whatsapp.push(body.type === 'template' ? `template:${body.template!.name}` : body.text!.body);
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to.replace(/^\+/, '') }], messages: [{ id: `wamid.out.${wire.whatsapp.length}` }] });
    }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

type Client = Readonly<{ calendarPage(): Promise<unknown> }>;
type Runtime = Readonly<{ ready: Promise<unknown>; google: Readonly<{ client(feature: string): Promise<Client | null> }> }>;
type Owner = Readonly<{ setup(channel: string): Runtime; fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
type World = Readonly<{
  owner: Owner; state: DurableObjectState;
  // One calendar read on `surface`, then the health note it leaves; false when the circuit kept the account out.
  read(surface: string): Promise<boolean>;
  notices(): FinalRecord[];
  hops(hop: string): number[];
  later(ms: number): void;
  // Alarm passes once the outbox's quarter-second hold on a new record is over.
  deliver(): Promise<void>;
}>;

const world = async (name: string, surface: 'app' | 'whatsapp', run: (w: World) => Promise<void>, windowOpen = true) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    const kv = state.storage.kv;
    kv.put('do_name', name);
    if (surface === 'app') kv.put('app_subject', String(appSubjectFor(name)));
    else { kv.put('whatsapp_subject', SUBJECT); kv.put('wa_last_inbound_ms', Date.now() - (windowOpen ? HOUR : 30 * HOUR)); }
    for (const card of ['card:brief', 'card:midday', 'card:close'] as const) dayPlanBook(state.storage.sql).save(new Date().toISOString().slice(0, 10), { card, time: null, reason: 'planned by the fixture' });
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: ACCOUNT, email: EMAIL, refresh_token: 'synthetic-offline-only', scopes: [CALENDAR] }]);
    const owner = new OwnerDO(state, { ...env, ...directory, ...google, ...(surface === 'whatsapp' ? whatsapp : {}), TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture',
      WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
    const hops = (hop: string) => state.storage.sql.exec<{ ok: number }>('SELECT ok FROM trace_log WHERE hop = ? ORDER BY id', hop).toArray().map(row => row.ok);
    const read = async (on: string) => {
      const runtime = owner.setup(on);
      await runtime.ready;
      const client = await runtime.google.client('calendar');
      if (!client) return false;
      await client.calendarPage().catch(() => undefined);
      // The health note runs after the read; wait until the account's health says what the read found.
      await vi.waitFor(async () => expect(Boolean((await state.storage.get<Record<string, string>>('google:health'))?.[ACCOUNT])).toBe(grant.dead), { timeout: 5_000, interval: 20 });
      await new Promise(resolve => setTimeout(resolve, 50));
      return true;
    };
    const notices = () => (kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []).filter(record => record.id.startsWith('google-reauth:'));
    const later = (ms: number) => { vi.setSystemTime(Date.now() + ms); };
    const deliver = async () => { later(1_000); kv.put('owner_alarm_last_v1', 0); await owner.alarm(); later(1_000); await owner.alarm(); };
    try { await run({ owner, state, read, notices, hops, later, deliver }); } finally { await state.storage.deleteAlarm(); }
  });
};
const appChat = async (owner: Owner, name: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64) } }));
  expect(response.status).toBe(200);
  return (await response.json() as { messages: { role: string; text: string }[] }).messages.filter(({ role }) => role === 'assistant').map(({ text }) => text);
};
const APP_NOTICE = reconnectNoticeText('app', EMAIL);

describe('a Google grant that stops working, on the app', () => {
  it('queues one plain notice for the owner\'s transcript and mints no link', async () => {
    const name = 'reauth-app-notice';
    await world(name, 'app', async w => {
      expect(await w.read('app')).toBe(true);
      await vi.waitFor(() => expect(w.hops('google_reauth_notice')).toEqual([1]), { timeout: 5_000, interval: 20 });
      const [notice, ...rest] = w.notices();
      expect(rest).toEqual([]);
      expect(notice).toMatchObject({ status: 'pending', ownerSubject: String(appSubjectFor(name)), payload: { chat_id: appSubjectFor(name), text: APP_NOTICE } });
      expect(notice!.trace, 'the record names the account by a digest, never by its address').not.toContain(EMAIL);
      expect(APP_NOTICE).toContain(EMAIL);
      expect(APP_NOTICE).toContain('Connections');
      expect(APP_NOTICE).not.toMatch(/https?:\/\//);
      expect(Object.keys(await w.state.storage.get<Record<string, number>>('google:reauth-noticed') ?? {})).toEqual([ACCOUNT]);
      expect(wire.rpcs).not.toContain('connect_session_issue');
      expect([...w.state.storage.kv.list({ prefix: 'connect_channel:' })]).toEqual([]);
      expect(w.hops('oauth_link_sent')).toEqual([]);
      expect(w.hops('google_reauth_notice_skipped')).toEqual([]);

      await w.deliver();
      expect(await appChat(w.owner, name)).toEqual([APP_NOTICE]);
      expect(w.notices().map(record => record.status)).toEqual(['delivered']);
    });
  });

  it('stays silent while the grant keeps failing: each probe the circuit lets through is the same episode', async () => {
    const name = 'reauth-app-episode';
    await world(name, 'app', async w => {
      await w.read('app');
      await vi.waitFor(() => expect(w.notices()).toHaveLength(1), { timeout: 5_000, interval: 20 });
      expect(await w.read('app'), 'a failing grant is probed once').toBe(true);
      expect(await w.read('app'), 'then the circuit keeps the account out').toBe(false);
      w.later(GOOGLE_PROBE_MS + 1);
      expect(await w.read('app'), 'the probe window lets one read through').toBe(true);
      await w.deliver();
      expect(w.notices()).toHaveLength(1);
      expect(await appChat(w.owner, name)).toEqual([APP_NOTICE]);
      expect(w.hops('google_reauth_notice')).toEqual([1]);
    });
  });

  it('a grant that recovers and then dies again starts a new episode with its own notice', async () => {
    const name = 'reauth-app-recovered';
    await world(name, 'app', async w => {
      await w.read('app');
      await vi.waitFor(() => expect(w.notices()).toHaveLength(1), { timeout: 5_000, interval: 20 });
      await w.deliver();
      grant.dead = false;
      w.later(GOOGLE_PROBE_MS + 1);
      expect(await w.read('app')).toBe(true);
      await vi.waitFor(async () => expect(await w.state.storage.get('google:reauth-noticed')).toEqual({}), { timeout: 5_000, interval: 20 });
      grant.dead = true;
      w.later(60_000);
      expect(await w.read('app')).toBe(true);
      await vi.waitFor(() => expect(w.notices()).toHaveLength(2), { timeout: 5_000, interval: 20 });
      expect(new Set(w.notices().map(record => record.id)).size).toBe(2);
      await w.deliver();
      expect(await appChat(w.owner, name)).toEqual([APP_NOTICE, APP_NOTICE]);
    });
  });

  // The notice is queued in the owner object's serial order, never beside an alarm pass that drains the outbox. A grant that
  // recovers before its turn comes gets none, and the episode stays open for the next failure.
  it('waits its turn behind running work, and a grant that recovers meanwhile gets no notice', async () => {
    const name = 'reauth-app-recovered-first';
    await world(name, 'app', async w => {
      let release!: () => void;
      const busy = (w.owner as unknown as { serial(work: () => Promise<void>): Promise<void> }).serial(() => new Promise<void>(resolve => { release = resolve; }));
      await w.read('app');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(w.notices(), 'nothing is queued while other work runs').toEqual([]);
      grant.dead = false;
      expect(await w.read('app'), 'the first probe of a failing grant goes through').toBe(true);
      release(); await busy;
      await vi.waitFor(() => expect(w.hops('google_reauth_notice')).toEqual([1]), { timeout: 5_000, interval: 20 });
      expect(w.notices()).toEqual([]);
      expect(w.state.storage.sql.exec<{ note: string }>("SELECT note FROM trace_log WHERE hop = 'google_reauth_notice'").toArray()).toEqual([{ note: 'grant_recovered' }]);
      expect(await w.state.storage.get('google:reauth-noticed') ?? {}).toEqual({});
    });
  });

  // Reads that fail together each find the grant healthy when they note it, so each asks for a notice; the episode gets one.
  it('reads that fail together in one tick queue one notice, not one each', async () => {
    const name = 'reauth-app-concurrent';
    await world(name, 'app', async w => {
      let now = Date.now();
      const ticking = vi.spyOn(Date, 'now').mockImplementation(() => ++now);
      try {
        const runtime = w.owner.setup('app');
        await runtime.ready;
        const client = (await runtime.google.client('calendar'))!;
        await Promise.all([1, 2, 3].map(() => client.calendarPage().catch(() => undefined)));
        await vi.waitFor(() => expect(w.hops('google_reauth_notice').length).toBeGreaterThan(0), { timeout: 5_000, interval: 20 });
        await new Promise(resolve => setTimeout(resolve, 200));
        await (w.owner as unknown as { serial(work: () => Promise<void>): Promise<void> }).serial(async () => undefined);
      } finally { ticking.mockRestore(); }
      expect(w.notices()).toHaveLength(1);
      expect(w.state.storage.sql.exec<{ note: string }>("SELECT note FROM trace_log WHERE hop = 'google_reauth_notice'").toArray()).toEqual([{ note: 'queued' }]);
    });
  });

  it('an app the owner has since unlinked gets nothing delivered', async () => {
    const name = 'reauth-app-unlinked';
    await world(name, 'app', async w => {
      await w.read('app');
      await vi.waitFor(() => expect(w.notices()).toHaveLength(1), { timeout: 5_000, interval: 20 });
      w.state.storage.kv.put('app_unlinked', true);
      await w.deliver();
      expect(w.notices().map(record => record.status)).not.toContain('delivered');
    });
  });
});

describe('a Google grant that stops working, on WhatsApp', () => {
  it('inside the 24-hour window, sends one plain notice saying where to reconnect, with no link, once per episode', async () => {
    await world('reauth-whatsapp-open', 'whatsapp', async w => {
      await w.read('whatsapp');
      await vi.waitFor(() => expect(w.notices()).toHaveLength(1), { timeout: 5_000, interval: 20 });
      expect(w.notices().map(record => record.payload.text)).toEqual([reconnectNoticeText('console', EMAIL)]);
      expect(wire.rpcs).not.toContain('connect_session_issue');
      await w.deliver();
      expect(wire.whatsapp).toEqual([reconnectNoticeText('console', EMAIL)]);
      w.later(GOOGLE_PROBE_MS + 1);
      await w.read('whatsapp');
      await w.deliver();
      expect(wire.whatsapp).toHaveLength(1);
      expect(w.hops('google_reauth_notice')).toEqual([1]);
    });
  });

  it('outside the window, the notice waits for the owner instead of being dropped: it holds no link, so keeping it is safe', async () => {
    await world('reauth-whatsapp-closed', 'whatsapp', async w => {
      await w.read('whatsapp');
      await vi.waitFor(() => expect(w.notices()).toHaveLength(1), { timeout: 5_000, interval: 20 });
      await w.deliver();
      expect(wire.whatsapp.filter(sent => !sent.startsWith('template:'))).toEqual([]);
      expect(w.notices().map(record => record.status)).not.toContain('delivered');
      expect(Object.keys(await w.state.storage.get<Record<string, number>>('google:reauth-noticed') ?? {})).toEqual([ACCOUNT]);
      expect(wire.rpcs).not.toContain('connect_session_issue');
    }, false);
  });
});
