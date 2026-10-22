// Where proactive work goes for an owner on the app and WhatsApp, by the owner's setting, through the real alarm, scheduler,
// owner runtimes and delivery outbox: the app only (the default), WhatsApp only, or both with one WhatsApp copy of each app
// message. WhatsApp sends keep its 24-hour window; when WhatsApp is unlinked or no longer bound, messages waiting for it go
// to the app instead.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema } from '../../contracts/src/app/controls';
import type { CalendarChange, CalendarItem } from '../src/connectors/google';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { consoleAccess } from '../src/channels/console';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { cardDeliveries, dayPlanBook } from '../src/channels/day-cards';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { traceBook } from '../src/channels/harness';
import { armHeartbeat } from '../src/channels/heartbeat';
import { loopBook } from '../src/channels/loops';
import { PROACTIVE_SURFACE_KEY, WHATSAPP_COPY_FRESH_MS, WHATSAPP_COPY_PREFIX } from '../src/channels/proactive-surface';
import { reminderBook } from '../src/channels/reminders';
import { standingOrderBook } from '../src/channels/standing-orders';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';
import { updateBook } from '../src/channels/update-cards';
import { bindWhatsAppNumber, releaseWhatsAppOutbox } from '../src/channels/whatsapp-window';
import type { OutboxRoute } from '../src/channels/delivery-routes';
import type { TelegramFinalOutbox } from '../src/channels/telegram-final-outbox';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

const CARD_TEXT = 'Your morning is clear until noon.';
const UPDATE_TEXT = 'Your 10:30 moved to 11:00.';
const PREP_TEXT = 'Design review at 09:30. Bring the onboarding mocks; Pat is listed.';
const CHECK_BACK_TEXT = 'I looked for the invoice in your sent mail and found nothing yet. Want me to draft it?';
const REMINDER_TEXT = 'Time to call Sam.';
const ORDER_TEXT = 'Rain after 4 pm; the forecast changed since this morning.';
const fixture = vi.hoisted(() => ({ event: null as CalendarItem | null, changes: [] as CalendarChange[], reminderText: null as string | null }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => fixture.event ? [fixture.event] : [], newMail: async () => [], changedEvents: async () => fixture.changes, event: async () => fixture.event,
    calendarPage: async () => ({ events: fixture.event ? [fixture.event] : [], next_page_token: null, fetched_count: 1, account, observed_at: new Date().toISOString() }),
  }) };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const content = String(request.request.messages.at(-1)?.content ?? '');
    const format = request.request.response_format?.name;
    const text = format === 'task_source_scope' ? '{"decision":"retain","sources":[]}'
      : format === 'claim_ops' ? JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null })
      : content.includes('[Meeting prep decision') ? JSON.stringify({ kind: 'notify', text: PREP_TEXT })
      : content.includes('[Update check') ? UPDATE_TEXT
      : content.includes('[Scheduled card') ? CARD_TEXT
      : content.includes('[Reminder due now') ? fixture.reminderText ?? REMINDER_TEXT
      : content.includes('[Standing order due now') ? ORDER_TEXT
      : content.includes('[Check-back due now') ? CHECK_BACK_TEXT : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
const SUBJECT = '15550001111';
const NEW_SUBJECT = '15550002222';
const HASH = 'a'.repeat(64);
const AT = Date.parse('2026-10-03T09:00:00Z');
const DAY = '2026-10-03';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id', WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en' };
// presence: the directory's answer for the WhatsApp presence, or 'outage' when it cannot be reached.
const wire = { presence: true as boolean | 'outage', whatsapp: [] as string[], to: [] as string[], telegram: [] as string[], wamid: 0 };

beforeEach(() => {
  fixture.event = null; fixture.changes = []; fixture.reminderText = null;
  wire.presence = true; wire.whatsapp = []; wire.to = []; wire.telegram = []; wire.wamid = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'console_session_list') return Response.json([{ session: HASH, created_at: new Date(AT - 60_000).toISOString(), last_seen_at: new Date(AT).toISOString() }]);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') {
      if (asked.p_provider !== 'whatsapp') return Response.json(true);
      if (wire.presence === 'outage') throw new Error('directory unavailable');
      return Response.json(wire.presence);
    }
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (/^https:\/\/graph\.facebook\.com\/v[\d.]+\/fictional-phone-id\/messages$/.test(url)) {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; template?: { name: string }; text?: { body: string } };
      wire.whatsapp.push(body.type === 'template' ? `template:${body.template!.name}` : `text:${body.text!.body}`);
      wire.to.push(body.to);
      wire.wamid += 1;
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to.replace(/^\+/, '') }], messages: [{ id: `wamid.out.${wire.wamid}` }] });
    }
    if (/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/.test(url)) {
      const sent = JSON.parse(String(init?.body)) as { chat_id: number; text: string };
      wire.telegram.push(sent.text);
      return Response.json({ ok: true, result: { message_id: 40 + wire.telegram.length, chat: { id: sent.chat_id } } });
    }
    if (url.startsWith('https://api.telegram.org/')) return Response.json({ ok: true, result: true });
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
type Ctx = { now: number; name: string; appSubject: number };
type Binding = Readonly<{ app?: boolean; whatsapp?: boolean; telegram?: boolean; surface?: string; window?: 'open' | 'closed' }>;

// An owner with the app, a bound WhatsApp number and Google connected, the time zone confirmed and the clock pinned. The
// window is open when the owner wrote on WhatsApp an hour ago, closed when that was 30 hours ago. The jobs each runtime arms
// on its first build are cleared, so each test schedules exactly the work it means to run.
const withOwner = async (name: string, run: (owner: Owner, state: DurableObjectState, ctx: Ctx) => Promise<void>, binding: Binding = {}) => {
  const { app = true, whatsapp: bound = true, telegram = false, surface, window = 'open' } = binding;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now, ctx: Ctx = { now: AT, name, appSubject: appSubjectFor(name) };
    Date.now = () => ctx.now;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      const { kv } = state.storage;
      kv.put('do_name', name);
      if (app) kv.put('app_subject', String(ctx.appSubject));
      if (bound) bindWhatsAppNumber(kv, SUBJECT);
      if (telegram) kv.put('telegram_subject', '7');
      kv.put('timezone', 'UTC'); kv.put('timezone_confirmed', true);
      kv.put('wa_last_inbound_ms', AT - (window === 'open' ? 60 : 30 * 60) * 60_000);
      if (surface) kv.put(PROACTIVE_SURFACE_KEY, surface);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only',
        scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.readonly'] }]);
      const owner = new OwnerDO(state, { ...env, ...directory, ...whatsapp, TELEGRAM_BOT_TOKEN: telegram ? '7:synthetic-fixture' : undefined, OPENAI_API_KEY: 'synthetic-fixture',
        WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret',
        MAIL_SOURCE_FOLLOWUPS: '1', CALENDAR_GROUNDED_PREP: '1' }) as unknown as Owner;
      for (const [channel, on] of [['app', app], ['whatsapp', bound], ['telegram', telegram]] as const) if (on) await owner.setup(channel).ready;
      state.storage.sql.exec('DELETE FROM schedule');
      wire.whatsapp = []; wire.telegram = [];
      await run(owner, state, ctx);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};

const scheduler = (state: DurableObjectState) => new Scheduler(state.storage.sql, state.storage, productionDeps());
const dueBrief = async (state: DurableObjectState) => {
  dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
  await scheduler(state).schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 1000, dueAt: Date.now() - 1000, recurrence: null });
};
const dueSweep = (state: DurableObjectState) => scheduler(state).schedule({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot',
  payloadRefs: { id: BRIEF_SWEEP_ID }, occurrenceAt: Date.now() - 1000, dueAt: Date.now() - 1000, recurrence: { type: 'interval', every_ms: 10 * 60_000, phase_ms: 0 } });
const dueReminder = (state: DurableObjectState) => reminderBook(state.storage.sql, scheduler(state), { timezone: 'UTC', now: () => new Date(Date.now() - 3_600_000) }, () => 'rem-1')
  .set({ note: 'call Sam', at: new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 16), repeat: 'none' });
// A daily order set an hour ago for half an hour ago, so its first run is due now.
const dueOrder = (state: DurableObjectState) => standingOrderBook(state.storage.sql, scheduler(state), { timezone: 'UTC', now: () => new Date(Date.now() - 3_600_000) }, () => 'ord1')
  .set({ scope: 'check the forecast', trigger: 'daily', at: new Date(Date.now() - 30 * 60_000).toISOString().slice(11, 16), gate: 'act_and_report', escalation: 'log_only' });
const briefPlan = (state: DurableObjectState) => dayPlanBook(state.storage.sql).read(DAY).find(row => row.card === 'card:brief');
const briefLinked = (state: DurableObjectState) => cardDeliveries(state.storage.kv, DAY).has('card:brief');
const orderRuns = (state: DurableObjectState) => state.storage.sql.exec<{ status: string; summary: string | null }>(
  "SELECT status, summary FROM background_runs WHERE kind = 'standing_order' ORDER BY started_at").toArray();
const dueCheckBack = async (state: DurableObjectState) => {
  loopBook(state.storage.sql, { newId: () => 'loop-1', now: () => AT }).open({ title: 'Send the invoice', due: `${DAY}T08:00` });
  await armHeartbeat(scheduler(state), Date.now() - 60 * 60_000);
};
// One alarm pass over the scheduled work, then one over the delivery outbox.
const schedulePass = async (owner: Owner, state: DurableObjectState) => { state.storage.kv.put('owner_alarm_last_v1', 1); await owner.alarm(); };
const outboxPass = async (owner: Owner, state: DurableObjectState, ctx: Ctx) => { ctx.now += 1000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); };
const appChat = async (owner: Owner, ctx: Ctx) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': ctx.name, 'x-waldo-app-session-hash': HASH } }));
  expect(response.status).toBe(200);
  return (await response.json() as { messages: { id: string; role: string; text: string }[] }).messages;
};
const said = async (owner: Owner, ctx: Ctx) => (await appChat(owner, ctx)).map(({ role, text }) => ({ role, text }));
const outbox = (state: DurableObjectState) => state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? [];
// Meta reports that every WhatsApp message it accepted arrived on the phone: only then is a WhatsApp record delivered.
const arrived = async (owner: Owner, state: DurableObjectState) => {
  const ids = outbox(state).filter(record => record.status === 'accepted').flatMap(record => record.providerMessageIds ?? []).filter((id): id is string => !!id);
  const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-status', {
    method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT }, body: JSON.stringify({ delivered: ids.map(id => ({ id, at: Date.now() })) }) }));
  expect(response.status).toBe(200);
  await (owner as unknown as { serial(work: () => Promise<void>): Promise<void> }).serial(async () => undefined);
};
const copies = (state: DurableObjectState) => outbox(state).filter(record => record.id.startsWith(WHATSAPP_COPY_PREFIX));
const copyFailures = (state: DurableObjectState) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM trace_log WHERE hop = 'whatsapp_copy'").one().n;
const reminderRuns = (state: DurableObjectState, id: string) => state.storage.sql.exec<{ outcome: string; delivery: string | null }>('SELECT outcome, delivery FROM schedule_runs WHERE schedule_id = ? ORDER BY id', id).toArray();
const reminderNotes = (state: DurableObjectState) => state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM reminder_notes').one().n;
// What the console's WhatsApp unlink and a confirmed relink do: bindWhatsAppNumber, the one writer of the bound number, clears
// what belonged to the old one (keeping what the app will take for an owner with the app), and the runtimes are rebuilt.
const rebindWhatsApp = (owner: Owner, state: DurableObjectState, subject: string | null) => {
  const appBound = (owner as unknown as { appBound(): boolean }).appBound();
  state.storage.transactionSync(() => bindWhatsAppNumber(state.storage.kv, subject, appBound)); (owner as unknown as { runtimes: object }).runtimes = {};
};
const unlinkWhatsApp = (owner: Owner, state: DurableObjectState) => rebindWhatsApp(owner, state, null);

// Each outbox pass waits for a record that falls due 250 ms after it is queued, so these run past the 5 s default.
describe('the app only, the default', { timeout: 20_000 }, () => {
  it('the Brief reaches the app chat, nothing goes to WhatsApp, and the directory is never asked about WhatsApp', async () => {
    let asked = 0;
    await withOwner('surface-app-brief', async (owner, state, ctx) => {
      const counted = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input instanceof Request ? input.url : input).endsWith('/assert_channel_presence')) asked += 1;
        return counted(input, init);
      });
      await dueBrief(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(await said(owner, ctx)).toEqual([{ role: 'assistant', text: CARD_TEXT }]);
      expect(wire.whatsapp).toEqual([]);
      expect(outbox(state)).toEqual([]);
    });
    expect(asked).toBe(0);
  });

  it('the app read keeps its contract: the day view carries no WhatsApp setting', async () => {
    await withOwner('surface-app-contract', async (owner, _state, ctx) => {
      const response = await owner.fetch(new Request('https://telegram-owner/app/v1/controls?view=day', { headers: { 'x-waldo-do-name': ctx.name, 'x-waldo-app-session-hash': HASH } }));
      expect(response.status).toBe(200);
      const body = await response.json() as { data: Record<string, unknown> };
      expect(appControlProjectionV1Schema.safeParse(body).success).toBe(true);
      expect(Object.keys(body.data)).not.toContain('proactive_surface');
    }, { surface: 'both' });
  });
});

describe('WhatsApp only', { timeout: 20_000 }, () => {
  it('the Brief goes to WhatsApp and the app chat stays empty', async () => {
    await withOwner('surface-whatsapp-brief', async (owner, state, ctx) => {
      await dueBrief(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(wire.whatsapp).toEqual([`text:${CARD_TEXT}`]);
      expect(await said(owner, ctx)).toEqual([]);
    }, { surface: 'whatsapp' });
  });

  it('an update card goes to WhatsApp while meeting prep is on for the app', async () => {
    await withOwner('surface-whatsapp-update', async (owner, state, ctx) => {
      dayPlanBook(state.storage.sql).sent(DAY, 'card:brief');
      updateBook(state.storage.sql).mark('calendar_since', AT - 3_600_000);
      fixture.changes = [{ id: 'event-1', title: 'Changed event', status: 'confirmed', start: `${DAY}T11:00:00Z`, end: `${DAY}T11:30:00Z`, all_day: false, description: '', etag: 'r2',
        created: new Date(AT - 86_400_000).toISOString() } as CalendarChange];
      await dueSweep(state);
      await schedulePass(owner, state);
      expect(wire.whatsapp).toHaveLength(1);
      expect(wire.whatsapp[0]!.startsWith(`text:${UPDATE_TEXT}`)).toBe(true);
      expect(await said(owner, ctx)).toEqual([]);
    }, { surface: 'whatsapp' });
  });

  it('a reminder waits in the outbox for WhatsApp and is delivered there, settled as sent', async () => {
    await withOwner('surface-whatsapp-reminder', async (owner, state, ctx) => {
      const reminder = await dueReminder(state);
      await schedulePass(owner, state);
      expect(outbox(state).map(record => [record.payload.chat_id, record.status])).toEqual([[Number(SUBJECT), 'pending']]);
      await outboxPass(owner, state, ctx);
      expect(wire.whatsapp).toEqual([`text:${REMINDER_TEXT}`]);
      // Meta took it; the reminder counts as sent only once Meta reports it arrived.
      expect(outbox(state).map(record => record.status)).toEqual(['accepted']);
      expect(reminderRuns(state, reminder.id)).toEqual([{ outcome: 'running', delivery: 'pending' }]);
      await arrived(owner, state);
      expect(reminderRuns(state, reminder.id)).toEqual([{ outcome: 'ok', delivery: 'sent' }]);
      expect(await said(owner, ctx)).toEqual([]);
    }, { surface: 'whatsapp' });
  });

  it('a check-back queued for the app before the owner chose WhatsApp still reaches the app, and only there', async () => {
    await withOwner('surface-whatsapp-switched', async (owner, state, ctx) => {
      await dueCheckBack(state);
      await schedulePass(owner, state);
      expect(outbox(state).map(record => [record.payload.chat_id, record.status])).toEqual([[ctx.appSubject, 'pending']]);
      state.storage.kv.put(PROACTIVE_SURFACE_KEY, 'whatsapp');
      for (let pass = 0; pass < 2; pass += 1) await outboxPass(owner, state, ctx);
      expect(await said(owner, ctx)).toEqual([{ role: 'assistant', text: CHECK_BACK_TEXT }]);
      expect(outbox(state).map(record => record.status)).toEqual(['delivered']);
      expect(wire.whatsapp).toEqual([]);
    });
  });

  it('runs nothing while the directory cannot say whether WhatsApp is still bound, and goes to WhatsApp once it can', async () => {
    await withOwner('surface-whatsapp-outage', async (owner, state, ctx) => {
      await dueBrief(state);
      wire.presence = 'outage';
      await schedulePass(owner, state);
      expect(wire.whatsapp).toEqual([]);
      expect(await said(owner, ctx)).toEqual([]);
      wire.presence = true;
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(wire.whatsapp).toEqual([`text:${CARD_TEXT}`]);
      expect(await said(owner, ctx)).toEqual([]);
    }, { surface: 'whatsapp' });
  });
});

describe('the app and WhatsApp', { timeout: 20_000 }, () => {
  it('the Brief reaches the app chat and WhatsApp gets one copy, queued under the app message it copies and sent once', async () => {
    await withOwner('surface-both-brief', async (owner, state, ctx) => {
      await dueBrief(state);
      await schedulePass(owner, state);
      const [row] = await appChat(owner, ctx);
      expect(row).toMatchObject({ role: 'assistant', text: CARD_TEXT });
      expect(copies(state).map(record => [record.id, record.payload.chat_id, record.status])).toEqual([[`${WHATSAPP_COPY_PREFIX}${row!.id}`, Number(SUBJECT), 'pending']]);
      for (let pass = 0; pass < 3; pass += 1) await outboxPass(owner, state, ctx);
      expect(wire.whatsapp).toEqual([`text:${CARD_TEXT}`]);
      expect(copies(state).map(record => record.status)).toEqual(['accepted']);
      await arrived(owner, state);
      expect(copies(state).map(record => record.status)).toEqual(['delivered']);
      expect(await said(owner, ctx)).toEqual([{ role: 'assistant', text: CARD_TEXT }]);
    }, { surface: 'both' });
  });

  it('a check-back from the outbox reaches the app and WhatsApp gets one copy, which a repeated settlement does not queue again', async () => {
    await withOwner('surface-both-check-back', async (owner, state, ctx) => {
      await dueCheckBack(state);
      await schedulePass(owner, state);
      const heartbeat = outbox(state).find(record => record.heartbeat)!;
      expect(heartbeat.payload.chat_id).toBe(ctx.appSubject);
      await outboxPass(owner, state, ctx);
      expect(await said(owner, ctx)).toEqual([{ role: 'assistant', text: CHECK_BACK_TEXT }]);
      const delivered = outbox(state).find(record => record.id === heartbeat.id)!;
      expect(copies(state).map(record => [record.id, record.expiresAt])).toEqual([[`${WHATSAPP_COPY_PREFIX}${heartbeat.id}`, delivered.deliveredAt! + WHATSAPP_COPY_FRESH_MS]]);
      // A restart that lost the settled mark settles the check-back again; its copy is the same record, queued once.
      const rows = outbox(state);
      rows.find(record => record.id === heartbeat.id)!.settled = false;
      state.storage.kv.put(FINAL_OUTBOX_KEY, rows);
      for (let pass = 0; pass < 3; pass += 1) await outboxPass(owner, state, ctx);
      expect(wire.whatsapp).toEqual([`text:${CHECK_BACK_TEXT}`]);
      expect(copies(state).map(record => record.status)).toEqual(['accepted']);
      await arrived(owner, state);
      expect(copies(state).map(record => record.status)).toEqual(['delivered']);
      expect(copyFailures(state)).toBe(0);
      expect(await said(owner, ctx)).toEqual([{ role: 'assistant', text: CHECK_BACK_TEXT }]);
    }, { surface: 'both' });
  });

  it('a check-back the app could not write gets no WhatsApp copy', async () => {
    await withOwner('surface-both-check-back-failed', async (owner, state, ctx) => {
      await dueCheckBack(state);
      await schedulePass(owner, state);
      const heartbeat = outbox(state).find(record => record.heartbeat)!;
      vi.spyOn(OwnerDO.prototype as unknown as { appAssistantRow(): Promise<unknown> }, 'appAssistantRow').mockRejectedValueOnce(new Error('transcript write failed'));
      for (let pass = 0; pass < 3; pass += 1) await outboxPass(owner, state, ctx);
      expect(outbox(state).find(record => record.id === heartbeat.id)).toMatchObject({ status: 'quarantined', reason: 'send_unknown', settled: true });
      expect(copies(state)).toEqual([]);
      expect(wire.whatsapp).toEqual([]);
      expect(await said(owner, ctx)).toEqual([]);
    }, { surface: 'both' });
  });

  it('meeting prep reaches the app chat only', async () => {
    await withOwner('surface-both-prep', async (owner, state, ctx) => {
      fixture.event = { id: 'event-1', title: 'Design review', status: 'confirmed', start: `${DAY}T09:30:00Z`, end: `${DAY}T10:00:00Z`, all_day: false,
        description: 'Bring the onboarding mocks.', attendee_names: ['Pat'], attendees: 3, etag: 'r1' } as CalendarItem;
      await dueSweep(state);
      await schedulePass(owner, state);
      for (let pass = 0; pass < 2; pass += 1) await outboxPass(owner, state, ctx);
      expect(await said(owner, ctx)).toEqual([{ role: 'assistant', text: PREP_TEXT }]);
      expect(copies(state)).toEqual([]);
      expect(wire.whatsapp).toEqual([]);
    }, { surface: 'both' });
  });

  it('the Brief reaches the app with no copy while the directory no longer has the WhatsApp presence', async () => {
    await withOwner('surface-both-presence-lost', async (owner, state, ctx) => {
      wire.presence = false;
      await dueBrief(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(await said(owner, ctx)).toEqual([{ role: 'assistant', text: CARD_TEXT }]);
      expect(copies(state)).toEqual([]);
      expect(wire.whatsapp).toEqual([]);
    }, { surface: 'both' });
  });

  it('a copy left waiting for WhatsApp\'s closed window expires a day after the app message, so waiting copies cannot fill the outbox', async () => {
    await withOwner('surface-both-copy-expires', async (owner, state, ctx) => {
      await dueBrief(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(wire.whatsapp).toEqual(['template:waldo_update_ready']);
      const [copy] = copies(state);
      expect([copy!.status, copy!.expiresAt]).toEqual(['pending', AT + WHATSAPP_COPY_FRESH_MS]);
      ctx.now = copy!.expiresAt!;
      for (let pass = 0; pass < 2; pass += 1) await outboxPass(owner, state, ctx);
      // Expired and settled, the copy is a terminal record the outbox evicts when it needs room; a pending one is never evicted.
      expect(copies(state).map(record => [record.status, record.reason, record.settled])).toEqual([['blocked', 'expired', true]]);
      expect(wire.whatsapp).toEqual(['template:waldo_update_ready']);
      expect(await said(owner, ctx)).toEqual([{ role: 'assistant', text: CARD_TEXT }]);
    }, { surface: 'both', window: 'closed' });
  });

  it('a copy left for a number the owner replaced never reaches the new number, and the app keeps the one message', async () => {
    await withOwner('surface-both-rebind', async (owner, state, ctx) => {
      await dueBrief(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(wire.whatsapp).toEqual(['template:waldo_update_ready']);
      const [copy] = copies(state);
      // The owner links a new number and writes from it: its window opens, and the reply path first releases what waits for
      // WhatsApp, as runWhatsappClaimed does.
      rebindWhatsApp(owner, state, NEW_SUBJECT);
      state.storage.kv.put('wa_last_inbound_ms', ctx.now);
      const internal = owner as unknown as { setup(channel: 'whatsapp'): { finalOutbox: TelegramFinalOutbox; settleFinal(record: FinalRecord): Promise<void> }; outboxRoute(surface: 'whatsapp'): OutboxRoute };
      await releaseWhatsAppOutbox(internal.setup('whatsapp').finalOutbox, internal.outboxRoute('whatsapp'), internal.setup('whatsapp').settleFinal);
      for (let pass = 0; pass < 3; pass += 1) await outboxPass(owner, state, ctx);
      ctx.now = copy!.expiresAt!;
      for (let pass = 0; pass < 2; pass += 1) await outboxPass(owner, state, ctx);
      expect(copies(state).map(record => [record.payload.chat_id, record.status])).toEqual([[Number(SUBJECT), 'blocked']]);
      expect(wire.to).toEqual([`+${SUBJECT}`]);
      expect(wire.whatsapp).toEqual(['template:waldo_update_ready']);
      expect(await said(owner, ctx)).toEqual([{ role: 'assistant', text: CARD_TEXT }]);
    }, { surface: 'both', window: 'closed' });
  });

  it('a copy waiting for WhatsApp\'s window is not moved to the app when WhatsApp is unlinked: the app keeps the one message', async () => {
    await withOwner('surface-both-unlink', async (owner, state, ctx) => {
      await dueBrief(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(wire.whatsapp).toEqual(['template:waldo_update_ready']);
      unlinkWhatsApp(owner, state);
      for (let pass = 0; pass < 3; pass += 1) await outboxPass(owner, state, ctx);
      expect(await said(owner, ctx)).toEqual([{ role: 'assistant', text: CARD_TEXT }]);
      expect(copies(state).map(record => record.status)).not.toContain('delivered');
      expect(wire.whatsapp).toEqual(['template:waldo_update_ready']);
    }, { surface: 'both', window: 'closed' });
  });
});

describe('falling back to the app', { timeout: 20_000 }, () => {
  it.each([
    ['WhatsApp is unlinked', 'unlink'],
    ['the directory no longer has the WhatsApp presence', 'presence'],
    ['the owner switches to the app', 'setting'],
  ] as const)('a reminder held for WhatsApp\'s closed window goes to the app once when %s, and is settled as sent', async (_how, change) => {
    await withOwner(`surface-fallback-${change}`, async (owner, state, ctx) => {
      const reminder = await dueReminder(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(wire.whatsapp).toEqual(['template:waldo_update_ready']);
      expect(outbox(state).map(record => record.status)).toEqual(['pending']);
      if (change === 'unlink') unlinkWhatsApp(owner, state);
      else if (change === 'presence') wire.presence = false;
      else state.storage.kv.put(PROACTIVE_SURFACE_KEY, 'app');
      for (let pass = 0; pass < 3; pass += 1) await outboxPass(owner, state, ctx);
      expect(await said(owner, ctx)).toEqual([{ role: 'assistant', text: REMINDER_TEXT }]);
      expect(outbox(state).map(record => record.status)).toEqual(['delivered']);
      expect(reminderRuns(state, reminder.id)).toEqual([{ outcome: 'ok', delivery: 'sent' }]);
      expect(reminderNotes(state)).toBe(0);
      expect(wire.whatsapp).toEqual(['template:waldo_update_ready']);
    }, { surface: 'whatsapp', window: 'closed' });
  });

  // A text long enough that WhatsApp's shim sends it in two parts. Meta takes both and then refuses the tail for the window, so
  // the head is on the owner's phone and the record waits in the outbox for the tail.
  it.each([
    ['the owner switches to the app', 'setting'],
    ['WhatsApp is unlinked', 'unlink'],
  ] as const)('a split reminder whose head WhatsApp took is not sent to the app as its tail alone when %s', async (_how, change) => {
    const parts = ['a'.repeat(3000), 'b'.repeat(3000)];
    fixture.reminderText = parts.join('\n\n');
    await withOwner(`surface-split-${change}`, async (owner, state, ctx) => {
      const reminder = await dueReminder(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(wire.whatsapp).toEqual(parts.map(part => `text:${part}`));
      const refused = await owner.fetch(new Request('https://telegram-owner/whatsapp-status', {
        method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT }, body: JSON.stringify({ refused: [{ id: 'wamid.out.2', at: ctx.now }] }) }));
      expect(refused.status).toBe(200);
      await (owner as unknown as { serial(work: () => Promise<void>): Promise<void> }).serial(async () => undefined);
      expect(outbox(state)).toMatchObject([{ status: 'pending', providerMessageIds: ['wamid.out.1', null] }]);
      if (change === 'unlink') unlinkWhatsApp(owner, state);
      else state.storage.kv.put(PROACTIVE_SURFACE_KEY, 'app');
      for (let pass = 0; pass < 3; pass += 1) await outboxPass(owner, state, ctx);
      expect(await said(owner, ctx)).toEqual([]);
      expect(outbox(state)).toMatchObject([{ status: 'quarantined', providerMessageIds: ['wamid.out.1', null] }]);
      expect(reminderRuns(state, reminder.id)).toEqual([{ outcome: 'quarantined', delivery: 'failed' }]);
    }, { surface: 'whatsapp', window: 'open' });
  });

  it('a reminder the owner cancelled while it waited for WhatsApp is not sent to the app', async () => {
    await withOwner('surface-fallback-cancelled', async (owner, state, ctx) => {
      await dueReminder(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      state.storage.sql.exec('DELETE FROM reminder_notes');
      unlinkWhatsApp(owner, state);
      for (let pass = 0; pass < 3; pass += 1) await outboxPass(owner, state, ctx);
      expect(await said(owner, ctx)).toEqual([]);
      expect(outbox(state).map(record => record.status)).toEqual(['blocked']);
    }, { surface: 'whatsapp', window: 'closed' });
  });
});

// The rule: the default sends to the app when the owner has an app binding, and otherwise to the owner's only bound surface;
// an explicit choice overrides the default; a chosen surface that is not bound falls back to the one that is, so nothing is
// lost. An owner with neither surface gets nothing.
describe('where the Brief goes, for each setting and each binding', { timeout: 20_000 }, () => {
  const bindings = { both: { app: true, whatsapp: true }, app: { app: true, whatsapp: false }, whatsapp: { app: false, whatsapp: true }, neither: { app: false, whatsapp: false } } as const;
  const cases: readonly (readonly [keyof typeof bindings, string | undefined, readonly string[], readonly string[]])[] = [
    ['both', undefined, [CARD_TEXT], []],
    ['both', 'app', [CARD_TEXT], []],
    ['both', 'whatsapp', [], [`text:${CARD_TEXT}`]],
    ['both', 'both', [CARD_TEXT], [`text:${CARD_TEXT}`]],
    ...([undefined, 'app', 'whatsapp', 'both'] as const).flatMap(setting => [
      ['app', setting, [CARD_TEXT], []] as const,
      ['whatsapp', setting, [], [`text:${CARD_TEXT}`]] as const,
      ['neither', setting, [], []] as const,
    ]),
  ];
  it.each(cases)('bound on %s, setting %s: the app chat gets %j and WhatsApp %j', async (binding, setting, app, whatsapp) => {
    await withOwner(`surface-table-${binding}-${setting ?? 'default'}`, async (owner, state, ctx) => {
      await dueBrief(state);
      await schedulePass(owner, state);
      for (let pass = 0; pass < 3; pass += 1) await outboxPass(owner, state, ctx);
      expect((await said(owner, ctx)).map(message => message.text)).toEqual(app);
      expect(wire.whatsapp).toEqual(whatsapp);
    }, { ...bindings[binding], surface: setting });
  });
});

// Day cards and standing-order reports settle on the delivery that reaches the owner. Under both, that is the app's message:
// the plan row and the order's run read as sent then, and the WhatsApp copy is a record of its own, delivered only when it
// is. A card or report waiting for WhatsApp settles only when it arrives, on WhatsApp or, once WhatsApp no longer takes
// proactive work, on the app.
describe('day cards and standing-order reports', { timeout: 30_000 }, () => {
  it('under both with WhatsApp\'s window closed, the app delivery settles the Brief and the order\'s run, and the copies wait', async () => {
    await withOwner('surface-both-closed-jobs', async (owner, state, ctx) => {
      await dueBrief(state);
      await dueOrder(state);
      for (let pass = 0; pass < 2; pass += 1) await schedulePass(owner, state);
      for (let pass = 0; pass < 3; pass += 1) await outboxPass(owner, state, ctx);
      expect((await said(owner, ctx)).map(message => message.text).sort()).toEqual([ORDER_TEXT, CARD_TEXT].sort());
      expect(briefPlan(state)).toMatchObject({ sent: true, state: 'sent' });
      expect(briefLinked(state)).toBe(true);
      expect(orderRuns(state)).toEqual([{ status: 'completed', summary: 'order reported' }]);
      expect(copies(state).map(record => [record.payload.text, record.status]).sort()).toEqual([[CARD_TEXT, 'pending'], [ORDER_TEXT, 'pending']].sort());
      expect(outbox(state).filter(record => record.dayCard || record.standingOrder)).toEqual([]);
      expect(wire.whatsapp).toEqual(['template:waldo_update_ready']);
    }, { surface: 'both', window: 'closed' });
  });

  it.each([
    ['the owner switches to the app', 'setting'],
    ['WhatsApp is unlinked', 'unlink'],
  ] as const)('a Brief and a report waiting for WhatsApp\'s closed window go to the app once when %s, and settle there', async (_how, change) => {
    await withOwner(`surface-jobs-fallback-${change}`, async (owner, state, ctx) => {
      await dueBrief(state);
      await dueOrder(state);
      for (let pass = 0; pass < 2; pass += 1) await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(wire.whatsapp).toEqual(['template:waldo_update_ready']);
      expect(briefPlan(state)).toMatchObject({ sent: false });
      expect(orderRuns(state)).toEqual([{ status: 'running', summary: null }]);
      if (change === 'setting') state.storage.kv.put(PROACTIVE_SURFACE_KEY, 'app'); else unlinkWhatsApp(owner, state);
      for (let pass = 0; pass < 4; pass += 1) await outboxPass(owner, state, ctx);
      expect((await said(owner, ctx)).map(message => message.text).sort()).toEqual([ORDER_TEXT, CARD_TEXT].sort());
      expect(briefPlan(state)).toMatchObject({ sent: true, state: 'sent' });
      expect(briefLinked(state)).toBe(true);
      expect(orderRuns(state)).toEqual([{ status: 'completed', summary: 'order reported' }]);
      expect(outbox(state).filter(record => record.dayCard || record.standingOrder).map(record => record.status)).toEqual(['delivered', 'delivered']);
      expect(wire.whatsapp).toEqual(['template:waldo_update_ready']);
    }, { surface: 'whatsapp', window: 'closed' });
  });
});

describe('owners the setting does not route', { timeout: 20_000 }, () => {
  it('an owner linked on Telegram keeps the app with its Telegram copy and gets no WhatsApp copy', async () => {
    await withOwner('surface-telegram-owner', async (owner, state, ctx) => {
      await dueBrief(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(await said(owner, ctx)).toEqual([{ role: 'assistant', text: CARD_TEXT }]);
      expect(wire.telegram).toEqual([CARD_TEXT]);
      expect(copies(state)).toEqual([]);
      expect(wire.whatsapp).toEqual([]);
    }, { telegram: true, surface: 'both' });
  });

  it('an owner who has not used the app keeps WhatsApp under the default', async () => {
    await withOwner('surface-whatsapp-only-owner', async (owner, state, ctx) => {
      await dueBrief(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(wire.whatsapp).toEqual([`text:${CARD_TEXT}`]);
      expect(await said(owner, ctx)).toEqual([]);
    }, { app: false });
  });
});

// The console reads and saves the setting through the day view, under the owner session, its CSRF value and the read's revision.
describe('the console control', () => {
  const root = 'https://telegram-owner';
  type Read = { csrf: string; revision: string; data: { proactive_surface?: unknown } };
  const withConsole = async (name: string, run: (stub: DurableObjectStub, token: string) => Promise<void>) => {
    const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
    const token = await runInDurableObject(stub, (instance, state) => {
      Object.assign((instance as unknown as { env: Record<string, unknown> }).env, { TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key', ...whatsapp });
      state.storage.kv.put('do_name', name);
      bindWhatsAppNumber(state.storage.kv, SUBJECT);
      return consoleAccess(state.storage).grant();
    });
    await run(stub, token);
  };
  const read = async (stub: DurableObjectStub, token: string): Promise<Read> => {
    const response = await stub.fetch(`${root}${CONTROLS_PATH}?view=day`, { headers: { cookie: `waldo_console=${token}` } });
    expect(response.status).toBe(200);
    return response.json();
  };
  const post = (stub: DurableObjectStub, token: string, before: Read, fields: Record<string, string>) => stub.fetch(`${root}${CONTROL_ACTION_PATH}`, {
    method: 'POST', headers: { cookie: `waldo_console=${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: before.csrf, revision: before.revision, view: 'day', action: 'proactive_surface.set', ...fields }),
  });

  it('reads the setting with what the owner can be reached on, and saves a new value against a fresh read', async () => {
    await withConsole('surface-console-save', async (stub, token) => {
      const before = await read(stub, token);
      expect(before.data.proactive_surface).toEqual({ value: 'app', app_linked: false, whatsapp_linked: true, telegram_linked: false });
      const saved = await post(stub, token, before, { value: 'both', request_id: 'surface-request-01' });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ receipt: { state: 'recorded' }, duplicate: false });
      const after = await read(stub, token);
      expect(after.data.proactive_surface).toMatchObject({ value: 'both' });
      expect(after.revision).not.toBe(before.revision);
      await runInDurableObject(stub, (_instance, state) => expect(state.storage.kv.get(PROACTIVE_SURFACE_KEY)).toBe('both'));
      // A request against the read before the change is stale.
      expect((await post(stub, token, before, { value: 'whatsapp', request_id: 'surface-request-02' })).status).toBe(409);
      expect((await read(stub, token)).data.proactive_surface).toMatchObject({ value: 'both' });
    });
  });

  it('refuses a value it does not know and a request without the session\'s CSRF value, and changes nothing', async () => {
    await withConsole('surface-console-refuse', async (stub, token) => {
      const before = await read(stub, token);
      const unknown = await post(stub, token, before, { value: 'telegram', request_id: 'surface-request-03' });
      expect(unknown.status).toBe(409);
      expect(await unknown.json()).toMatchObject({ receipt: { state: 'rejected' } });
      expect((await post(stub, token, { ...before, csrf: 'wrong' }, { value: 'whatsapp', request_id: 'surface-request-04' })).status).toBe(403);
      expect((await read(stub, token)).data.proactive_surface).toMatchObject({ value: 'app' });
      await runInDurableObject(stub, (_instance, state) => expect(state.storage.kv.get(PROACTIVE_SURFACE_KEY)).toBeUndefined());
    });
  });
});
