// Waldo's own sends (PROACTIVE_OVER_TELEGRAM) go where the owner chose, among the surfaces they are bound on, even while
// Telegram is still linked: Telegram gets them only when no other surface is bound. The deploy here runs a Telegram bot,
// whose sends are recorded. The model is scripted, the directory answers from fixtures, and WhatsApp's Graph API is the wire.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { PROACTIVE_SURFACE_KEY } from '../src/channels/proactive-surface';
import { reminderBook } from '../src/channels/reminders';
import { TelegramOwnerInbox } from '../src/channels/telegram-owner-inbox';
import { persistInboxWake } from '../src/scheduler/alarm-slot';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

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
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' };
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
    const owner = new OwnerDO(state, { ...env, ...directory, ...whatsapp, ...noTelegram, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', ...settings } as never);
    try { await work(owner, state); } finally { await state.storage.deleteAlarm(); }
  });

const event = (owner: Owner, id: string) => owner.fetch(new Request('https://telegram-owner/event', { method: 'POST', body: JSON.stringify({ subject: 'fixture', kind: 'incident', title: 'Deploy finished' }), headers: {
  'x-waldo-origin': 'https://waldo.fixture.invalid', 'x-waldo-event-source': 'uptime', 'x-waldo-event-notify': '1', 'x-waldo-event-delivery': `id:${id}`, 'x-waldo-event-digest': 'a'.repeat(64),
} }));
const eventOutcome = (state: DurableObjectState) => ({
  runs: state.storage.sql.exec<{ status: string }>("SELECT status FROM background_runs WHERE kind = 'event'").toArray().map(row => row.status),
  admission: state.storage.sql.exec<{ state: string }>('SELECT state FROM event_admissions').toArray().map(row => row.state),
});

const TELEGRAM = { TELEGRAM_BOT_TOKEN: '7:synthetic-fixture' };
const ON = { OWNER_SURFACE_DEFAULT: '1', PROACTIVE_OVER_TELEGRAM: '1', ...TELEGRAM }, OFF = { OWNER_SURFACE_DEFAULT: '1', ...TELEGRAM };
const linked = (name: string, extra: Record<string, string | number | boolean> = {}) =>
  ({ telegram_subject: '7', app_subject: String(appSubjectFor(name)), timezone: 'UTC', timezone_confirmed: true, ...extra });
const withWhatsApp = { whatsapp_subject: WA_SUBJECT, wa_last_inbound_ms: Date.now() - 60 * 60_000 };
const appRows = (state: DurableObjectState) => JSON.stringify([...state.storage.kv.list({ prefix: 'canonical-owner-v1:' })]);

const day = async (owner: Owner, state: DurableObjectState) => {
  const today = new Date().toISOString().slice(0, 10), scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
  dayPlanBook(state.storage.sql).save(today, { card: 'card:brief', time: '00:00', reason: 'planned by the fixture' });
  await scheduler.schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 1000, dueAt: Date.now() - 1000, recurrence: null });
  await reminderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date(Date.now() - 3_600_000) }, () => 'rem-choice')
    .set({ note: 'water the plants', at: new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 16), repeat: 'none' });
  for (let pass = 0; pass < 4; pass++) { await owner.alarm(); await state.storage.deleteAlarm(); await new Promise(resolve => setTimeout(resolve, 200)); }
  return today;
};

describe('Waldo\'s own sends for an owner still linked on Telegram', { timeout: 30_000 }, () => {
  it('an event goes to the app transcript when the owner chose the app, and nothing to Telegram', async () => {
    const name = 'choice-app-event';
    await ownerOn(name, linked(name), ON, async (owner, state) => {
      expect((await event(owner, 'app-ev')).status).toBe(200);
      expect(eventOutcome(state)).toEqual({ runs: ['completed'], admission: ['completed'] });
      expect(appRows(state)).toContain('Event - uptime: Deploy finished');
      expect(telegram.sends).toEqual([]);
    });
  });

  it('an event goes to WhatsApp when the owner chose WhatsApp, and nothing to Telegram', async () => {
    const name = 'choice-whatsapp-event';
    await ownerOn(name, linked(name, { ...withWhatsApp, [PROACTIVE_SURFACE_KEY]: 'whatsapp' }), ON, async (owner, state) => {
      expect((await event(owner, 'wa-ev')).status).toBe(200);
      expect(eventOutcome(state)).toEqual({ runs: ['completed'], admission: ['completed'] });
      expect(world.texts).toContain('Event - uptime: Deploy finished');
      expect(telegram.sends).toEqual([]);
    });
  });

  it('the Brief and a reminder go to the app and WhatsApp when the owner chose both, and nothing to Telegram', async () => {
    const name = 'choice-both-day';
    await ownerOn(name, linked(name, { ...withWhatsApp, [PROACTIVE_SURFACE_KEY]: 'both' }), ON, async (owner, state) => {
      const today = await day(owner, state);
      expect(dayPlanBook(state.storage.sql).read(today).find(card => card.card === 'card:brief')?.sent).toBe(true);
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM schedule WHERE kind = 'reminder'").toArray().map(row => row.status)).not.toContain('armed');
      expect(appRows(state)).toContain(REPLY);
      expect(world.texts.filter(text => text.includes(REPLY))).not.toEqual([]);
      expect(telegram.sends).toEqual([]);
    });
  });

  it('a message the owner writes on Telegram is still answered there while their proactive work goes to the app', async () => {
    const name = 'choice-telegram-reply';
    await ownerOn(name, linked(name), { ...ON, TELEGRAM_WEBHOOK_SECRET: 'synthetic-inbox-secret' }, async (owner, state) => {
      const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
      await inbox.admit({ bot: '7', subject: '7', doName: name }, 501, JSON.stringify({ update_id: 501,
        message: { message_id: 501, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, date: 1, text: 'What is on today?' } }));
      await (owner as unknown as { drainInbox(): Promise<void> }).drainInbox();
      const now = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        for (let pass = 1; pass <= 4 && (await inbox.records()).find(row => row.updateId === 501)?.state !== 'completed'; pass++) {
          vi.setSystemTime(now + pass * 1_000);
          await owner.alarm(); await state.storage.deleteAlarm();
        }
      } finally { vi.useRealTimers(); }
      expect((await inbox.records()).find(row => row.updateId === 501)?.state).toBe('completed');
      expect(telegram.sends).toContain('sendMessage');
    });
  });

  it('while the directory cannot answer, the pass is held for a full retry and nothing falls back to Telegram', async () => {
    const name = 'choice-directory-down';
    await ownerOn(name, linked(name), ON, async (owner, state) => {
      world.directoryDown = true;
      const today = await day(owner, state);
      expect((owner as unknown as { passOwed: boolean }).passOwed).toBe(true);
      expect(dayPlanBook(state.storage.sql).read(today).find(card => card.card === 'card:brief')?.sent).not.toBe(true);
      expect(telegram.sends).toEqual([]);
    });
  });

  it('an owner whose only surface is Telegram still gets their events and day there', async () => {
    await ownerOn('choice-telegram-only', { telegram_subject: '7', timezone: 'UTC', timezone_confirmed: true }, ON, async (owner, state) => {
      expect((await event(owner, 'tg-ev')).status).toBe(200);
      expect(eventOutcome(state)).toEqual({ runs: ['completed'], admission: ['completed'] });
      expect(telegram.sends).toEqual(['sendMessage']);
      await day(owner, state);
      expect(telegram.sends.filter(method => method === 'sendMessage').length).toBeGreaterThan(1);
      expect(world.texts).toEqual([]);
    });
  });

  it('with the switch off, an event for an owner linked on Telegram still goes to Telegram, as before', async () => {
    const name = 'choice-off-event';
    await ownerOn(name, linked(name), OFF, async (owner, state) => {
      expect((await event(owner, 'off-ev')).status).toBe(200);
      expect(telegram.sends).toEqual(['sendMessage']);
      expect(appRows(state)).not.toContain('Event - uptime: Deploy finished');
    });
  });
});
