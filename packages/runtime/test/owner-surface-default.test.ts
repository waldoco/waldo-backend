// A caller with no surface of its own (the console, Google consent, an event, the owner's runs) reaches the owner on the
// surface they actually have (OWNER_SURFACE_DEFAULT), not on Telegram by default. The deploy here has no Telegram bot at all.
// The model is scripted, the directory and Google answer from fixtures, and WhatsApp's Graph API is the wire.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { consoleAccess, CONSOLE_RUNS_PATH } from '../src/channels/console';
import { dayPlanBook } from '../src/channels/day-cards';
import { DASHBOARD_OVERVIEW_PATH } from '../src/channels/dashboard-overview';
import { GOOGLE_FINISH_PATH } from '../src/channels/google-oauth';
import { traceBook } from '../src/channels/harness';
import { PROACTIVE_SURFACE_KEY } from '../src/channels/proactive-surface';
import { reminderBook } from '../src/channels/reminders';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';
import { readConsentState } from '../src/connectors/google';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

// Every free-text model turn answers the same: the tests read what was delivered and recorded, not what a prompt says.
const REPLY = 'Fixture reply: two meetings, a free hour after lunch.';
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const reply = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return reply(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{}');
    return reply(REPLY);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const telegram = vi.hoisted(() => ({ sends: [] as string[] }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number }) => {
    telegram.sends.push(method);
    return method === 'sendMessage' ? { message_id: 91, chat: { id: payload.chat_id } } : true;
  } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4b3a2918-0716-4e5d-9c4b-3a2918070605';
const WA_SUBJECT = '15550007777';
const STATE_SECRET = 'fictional-surface-state-secret';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' };
const google = { GOOGLE_CLIENT_ID: 'surface-fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fictional-secret', WALDO_OAUTH_STATE_SECRET: STATE_SECRET };
const noTelegram = { TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_WEBHOOK_SECRET: undefined, WALDO_OWNER_TELEGRAM_ID: undefined };

const world = vi.hoisted(() => ({ texts: [] as string[], unlisted: [] as string[], directoryDown: false }));
beforeEach(() => {
  world.texts = []; world.unlisted = []; world.directoryDown = false; telegram.sends = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn && world.directoryDown) throw new Error('directory unavailable');
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: JSON.parse(String(init?.body)).p_do_name, state_version: 1, admission_revision: '2' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read' || fn === 'health_plane' || fn === 'presence_hint') return Response.json(null);
    if (fn === 'health_log_recent' || fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; text?: { body: string } };
      if (body.type === 'text') world.texts.push(body.text!.body);
      // Graph answers with the contact as bare digits, whatever form the request named it in.
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to.replace(/^\+/, '') }], messages: [{ id: `wamid.out.${world.texts.length}` }] });
    }
    // Google's code exchange and every Google call go through the directory's connector proxy, as deployed.
    if (url === 'https://directory.fixture.invalid/functions/v1/connector-proxy') {
      const op = (JSON.parse(String(init?.body)) as { op: string }).op;
      if (op === 'exchange') return Response.json({ id: 'conn-surface', email: 'owner@example.test', scopes: ['https://www.googleapis.com/auth/calendar.events'] });
      if (op === 'calendar_watch') return Response.json({ data: { channelId: 'surface-channel', resourceId: 'res-1', expiration: Date.now() + 86_400_000 } });
      return Response.json({ data: [] });
    }
    world.unlisted.push(fn ?? url);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = InstanceType<typeof OwnerDO>;
const ownerOn = (name: string, identity: Record<string, string | number | boolean>, settings: Record<string, string | undefined>, work: (owner: Owner, state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    for (const [key, value] of Object.entries(identity)) state.storage.kv.put(key, value);
    await state.storage.put('origin', 'https://waldo.fixture.invalid');
    const owner = new OwnerDO(state, { ...env, ...directory, ...whatsapp, ...google, ...noTelegram, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', ...settings } as never);
    try { await work(owner, state); } finally { await state.storage.deleteAlarm(); }
  });

const event = (owner: Owner, id: string) => owner.fetch(new Request('https://telegram-owner/event', { method: 'POST', body: JSON.stringify({ subject: 'fixture', kind: 'incident', title: 'Deploy finished' }), headers: {
  'x-waldo-origin': 'https://waldo.fixture.invalid', 'x-waldo-event-source': 'uptime', 'x-waldo-event-notify': '1', 'x-waldo-event-delivery': `id:${id}`, 'x-waldo-event-digest': 'a'.repeat(64),
} }));
const eventOutcome = (state: DurableObjectState) => ({
  runs: state.storage.sql.exec<{ status: string }>("SELECT status FROM background_runs WHERE kind = 'event'").toArray().map(row => row.status),
  admission: state.storage.sql.exec<{ state: string }>('SELECT state FROM event_admissions').toArray().map(row => row.state),
});
const console$ = async (owner: Owner, state: DurableObjectState) => {
  const cookie = `waldo_console=${await consoleAccess(state.storage).grant()}`;
  return (path: string, init: RequestInit = {}) => owner.fetch(new Request(`https://owner${path}`, { ...init, headers: { cookie, ...init.headers } }));
};
const ON = { OWNER_SURFACE_DEFAULT: '1' }, OFF = { OWNER_SURFACE_DEFAULT: '0' };
const whatsappOnly = { whatsapp_subject: WA_SUBJECT, wa_last_inbound_ms: Date.now() - 60 * 60_000 };

describe('an owner whose only surface is WhatsApp, on a deploy with no Telegram bot', { timeout: 30_000 }, () => {
  it('gets the day: the console and runs list load, Google connects from the console and says so on WhatsApp, an event and the Brief arrive', async () => {
    await ownerOn('surface-whatsapp-day', whatsappOnly, ON, async (owner, state) => {
      const consoleAt = await console$(owner, state);
      expect((await consoleAt(DASHBOARD_OVERVIEW_PATH)).status).toBe(200);
      expect((await consoleAt(CONSOLE_RUNS_PATH)).status).toBe(200);

      const read = await (await consoleAt('/console/dashboard/api/v1/controls?view=connections')).json() as { csrf: string; revision: string };
      const acted = await consoleAt('/console/dashboard/api/v1/actions', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: read.csrf, revision: read.revision, view: 'connections', action: 'google.connect', value: 'calendar', request_id: 'surface-google-0001' }) });
      const { receipt } = await acted.json() as { receipt: { state: string; navigation?: string } };
      expect(receipt.state).toBe('recorded');
      const started = await consoleAt(receipt.navigation!);
      expect(started.status).toBe(303);
      const consent = await readConsentState(STATE_SECRET, new URL(started.headers.get('location')!).searchParams.get('state')!);
      const finished = await owner.fetch(new Request(`https://telegram-owner${GOOGLE_FINISH_PATH}`, { method: 'POST', body: JSON.stringify({ nonce: consent!.nonce, code: 'fixture-code', error: null }) }));
      expect((await finished.json() as { outcome: { kind: string } }).outcome.kind).toBe('linked');
      expect(world.texts.filter(text => text.startsWith('Google is connected'))).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT note FROM trace_log WHERE hop = 'google_linked_notice'").toArray()).toEqual([]);

      expect((await event(owner, 'wa-1')).status).toBe(200);
      expect(eventOutcome(state)).toEqual({ runs: ['completed'], admission: ['completed'] });
      expect(world.texts).toContain('Event - uptime: Deploy finished');

      const today = new Date().toISOString().slice(0, 10), scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      dayPlanBook(state.storage.sql).save(today, { card: 'card:brief', time: '00:00', reason: 'planned by the fixture' });
      await scheduler.schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 1000, dueAt: Date.now() - 1000, recurrence: null });
      state.storage.kv.put('timezone', 'UTC'); state.storage.kv.put('timezone_confirmed', true);
      await reminderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date(Date.now() - 3_600_000) }, () => 'rem-surface')
        .set({ note: 'water the plants', at: new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 16), repeat: 'none' });
      const before = world.texts.length;
      const passes = async (count: number) => { for (let pass = 0; pass < count; pass++) { await owner.alarm(); await state.storage.deleteAlarm(); await new Promise(resolve => setTimeout(resolve, 200)); } };
      await passes(4);
      // A WhatsApp send settles on Meta's report that it arrived, as in production.
      const accepted = (state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []).filter(record => record.status === 'accepted').flatMap(record => record.providerMessageIds ?? []).filter((id): id is string => !!id);
      expect(accepted.length).toBeGreaterThan(0);
      expect((await owner.fetch(new Request('https://telegram-owner/whatsapp-status', { method: 'POST', headers: { 'x-waldo-whatsapp-subject': WA_SUBJECT },
        body: JSON.stringify({ delivered: accepted.map(id => ({ id, at: Date.now() })) }) }))).status).toBe(200);
      await passes(1);
      expect(dayPlanBook(state.storage.sql).read(today).find(card => card.card === 'card:brief')?.sent).toBe(true);
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM schedule WHERE kind = 'reminder'").toArray().map(row => row.status)).not.toContain('armed');
      expect(world.texts.slice(before).filter(text => text === REPLY)).toHaveLength(2);

      expect(telegram.sends).toEqual([]);
      expect(world.unlisted).toEqual([]);
    });
  });

  it('with the switch off, keeps today\'s Telegram default: the console cannot open a runtime and nothing is sent anywhere', async () => {
    await ownerOn('surface-whatsapp-off', whatsappOnly, OFF, async (owner, state) => {
      const consoleAt = await console$(owner, state);
      expect((await consoleAt(DASHBOARD_OVERVIEW_PATH)).status).toBe(503);
      expect(world.texts).toEqual([]);
      expect(telegram.sends).toEqual([]);
    });
  });

  it('holds an event that arrives outside WhatsApp\'s window for the owner, and records it as held, not as sent or unknown', async () => {
    await ownerOn('surface-whatsapp-held', { whatsapp_subject: WA_SUBJECT, wa_last_inbound_ms: Date.now() - 30 * 60 * 60_000 }, ON, async (owner, state) => {
      expect((await event(owner, 'wa-held')).status).toBe(200);
      expect(world.texts).not.toContain('Event - uptime: Deploy finished');
      expect(eventOutcome(state)).toEqual({ runs: ['completed'], admission: ['completed'] });
      const [run] = state.storage.sql.exec<{ summary: string }>("SELECT summary FROM background_runs WHERE kind = 'event'").toArray();
      expect(run!.summary).toContain('held');
    });
  });
});

describe('a harness command an owner sends on WhatsApp, on a deploy with no Telegram bot', { timeout: 30_000 }, () => {
  it('is answered on WhatsApp with the switch on', async () => {
    await ownerOn('surface-whatsapp-harness', { whatsapp_subject: WA_SUBJECT, wa_last_inbound_ms: Date.now() - 60_000 }, ON, async (owner) => {
      const admitted = await owner.fetch(new Request('https://telegram-owner/whatsapp-admit', { method: 'POST', headers: { 'x-waldo-whatsapp-subject': WA_SUBJECT },
        body: JSON.stringify({ messages: [{ from: WA_SUBJECT, id: 'wamid.in.trace', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: '/trace' } }] }) }));
      expect(admitted.status).toBe(200);
      await drainWhatsAppTurns(owner);
      expect(world.texts.length).toBeGreaterThan(0);
      expect(world.texts).not.toContain(REPLY);
      expect(telegram.sends).toEqual([]);
    });
  });
});

describe('the surface a caller without one reaches, with the switch on', () => {
  it('follows the owner\'s own choice of surface for proactive work over the app-first default', async () => {
    const name = 'surface-chose-whatsapp';
    await ownerOn(name, { app_subject: String(appSubjectFor(name)), ...whatsappOnly, [PROACTIVE_SURFACE_KEY]: 'whatsapp' }, ON, async (owner, state) => {
      expect((await event(owner, 'chose-1')).status).toBe(200);
      expect(eventOutcome(state)).toEqual({ runs: ['completed'], admission: ['completed'] });
      expect(world.texts).toContain('Event - uptime: Deploy finished');
    });
  });

  // An iMessage send outside the owner's own turn has no route; its caller acknowledges a send it only drops while a turn
  // runs, so a notice there is never recorded as sent.
  it('never acknowledges a notice on iMessage, even while an iMessage turn is running', async () => {
    await ownerOn('surface-imessage-turn', {}, ON, async (owner) => {
      const inner = owner as unknown as { activeIMessage: unknown; setup(channel: string): unknown; notifyOwner(surface: string, runtime: unknown, text: string): Promise<string> };
      inner.activeIMessage = { updateId: 1 };
      expect(await inner.notifyOwner('imessage', inner.setup('imessage'), 'Event - uptime: Deploy finished')).toBe('unroutable');
    });
  });

  it('stays Telegram for an owner still linked there, while the owner\'s choice does not decide (PROACTIVE_BY_CHOICE off)', async () => {
    await ownerOn('surface-telegram-linked', { telegram_subject: '7' }, { ...ON, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture' }, async (owner, state) => {
      expect((await event(owner, 'tg-1')).status).toBe(200);
      expect(eventOutcome(state)).toEqual({ runs: ['completed'], admission: ['completed'] });
      expect(telegram.sends).toEqual(['sendMessage']);
      expect(world.texts).toEqual([]);
    });
  });

  it('with the owner\'s choice deciding, writes the event of an owner still linked on Telegram where they chose, and nothing to Telegram', async () => {
    const name = 'surface-telegram-by-choice';
    await ownerOn(name, { telegram_subject: '7', app_subject: String(appSubjectFor(name)) }, { ...ON, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', PROACTIVE_BY_CHOICE: '1' }, async (owner, state) => {
      expect((await event(owner, 'tg-choice-1')).status).toBe(200);
      expect(eventOutcome(state)).toEqual({ runs: ['completed'], admission: ['completed'] });
      expect(JSON.stringify([...state.storage.kv.list()])).toContain('Event - uptime: Deploy finished');
      expect(telegram.sends).toEqual([]);
    });
  });

  it('with the owner\'s choice deciding, keeps an owner with no other surface on Telegram', async () => {
    await ownerOn('surface-telegram-only-by-choice', { telegram_subject: '7' }, { ...ON, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', PROACTIVE_BY_CHOICE: '1' }, async (owner, state) => {
      expect((await event(owner, 'tg-only-1')).status).toBe(200);
      expect(eventOutcome(state)).toEqual({ runs: ['completed'], admission: ['completed'] });
      expect(telegram.sends).toEqual(['sendMessage']);
    });
  });

  it('writes an app owner\'s event into their app transcript', async () => {
    const name = 'surface-app-only';
    await ownerOn(name, { app_subject: String(appSubjectFor(name)) }, ON, async (owner, state) => {
      expect((await event(owner, 'app-1')).status).toBe(200);
      expect(eventOutcome(state)).toEqual({ runs: ['completed'], admission: ['completed'] });
      expect(JSON.stringify([...state.storage.kv.list()])).toContain('Event - uptime: Deploy finished');
      expect(telegram.sends).toEqual([]);
    });
  });

  it('records an app owner\'s event as not sent while the directory cannot admit them, never as sent', async () => {
    const name = 'surface-app-outage';
    await ownerOn(name, { app_subject: String(appSubjectFor(name)) }, ON, async (owner, state) => {
      world.directoryDown = true;
      expect((await event(owner, 'app-down')).status).toBe(200);
      expect(eventOutcome(state)).toEqual({ runs: ['stopped'], admission: ['undelivered'] });
      expect(JSON.stringify([...state.storage.kv.list()])).not.toContain('Event - uptime: Deploy finished');
    });
  });

  it('opens the console for an owner with no surface bound yet, and sends their event nowhere', async () => {
    await ownerOn('surface-unbound', {}, ON, async (owner, state) => {
      expect((await (await console$(owner, state))(DASHBOARD_OVERVIEW_PATH)).status).toBe(200);
      expect((await event(owner, 'none-1')).status).toBe(200);
      expect(eventOutcome(state)).toEqual({ runs: ['stopped'], admission: ['undelivered'] });
      expect(world.texts).toEqual([]);
      expect(telegram.sends).toEqual([]);
    });
  });
});
