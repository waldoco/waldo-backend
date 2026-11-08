import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarChange, CalendarItem } from '../src/connectors/google';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { episodeIndex } from '../src/channels/episodes';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { traceBook } from '../src/channels/harness';
import { armHeartbeat } from '../src/channels/heartbeat';
import { reportMachineJobs } from './helpers/heartbeat-job';
import { loopBook } from '../src/channels/loops';
import { standingOrderBook } from '../src/channels/standing-orders';
import { FINAL_OUTBOX_KEY, TelegramFinalOutbox, type FinalRecord } from '../src/channels/telegram-final-outbox';
import { updateBook } from '../src/channels/update-cards';
import { claimStore } from '../src/memory/claims';
import { persistTransportWake } from '../src/scheduler/alarm-slot';
import { reminderBook } from '../src/channels/reminders';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// Proactive work for an owner on both Telegram and the app goes to the app, and Telegram gets one plain copy of it.
const CARD_TEXT = 'Your morning is clear until noon.';
const UPDATE_TEXT = 'Your 10:30 moved to 11:00.';
const FOLLOWUP_TEXT = 'Have you handled the deck review? Pat asked for it by 10.';
const PREP_TEXT = 'Design review at 09:30. Bring the onboarding mocks; Pat is listed.';
const ORDER_TEXT = 'Inbox triage done: two threads need you.';
const CHECK_BACK_TEXT = 'I looked for the invoice in your sent mail and found nothing yet. Want me to draft it?';
const NUDGE_TEXT = 'A nudge queued for the app.';
const REPLY_TEXT = 'Here is your answer.';
const REMINDER_TEXT = 'Time to call Sam, as you asked.';
const fixture = vi.hoisted(() => ({ event: null as CalendarItem | null, changes: [] as CalendarChange[], requests: [] as string[] }));
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
    const content = request.request.messages.at(-1)?.content ?? '';
    fixture.requests.push(String(content));
    const format = request.request.response_format?.name;
    const text = format === 'task_source_scope' ? '{"decision":"retain","sources":[]}'
      : format === 'claim_ops' ? JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null })
      : content.includes('[Meeting prep decision') ? JSON.stringify({ kind: 'notify', text: PREP_TEXT })
      : content.includes('[Mail follow-up check') ? FOLLOWUP_TEXT
      : content.includes('[Update check') ? UPDATE_TEXT
      : content.includes('[Scheduled card') ? CARD_TEXT
      : content.includes('[Standing order due now') ? ORDER_TEXT
      : content.includes('[Check-back due now') ? CHECK_BACK_TEXT
      : content.includes('[Reminder due now') ? REMINDER_TEXT : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const WHATSAPP = '15550004444';
const AT = Date.parse('2026-10-03T09:00:00Z');
const DAY = '2026-10-03';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
type Authority = 'current' | 'revoked' | 'outage' | 'error';
type Sent = { chat_id: number; text: string; reply_markup?: unknown };
// authorityAfter: the directory answers 'current' this many times, then `authority`.
const wire = { authority: 'current' as Authority, authorityAfter: 0, asked: 0, presence: true, telegram: 'ok' as 'ok' | 'fails', telegramSent: [] as Sent[], previews: [] as unknown[], whatsappSent: [] as string[], presenceDown: false, admittedBy: [] as string[] };

beforeEach(() => {
  fixture.event = null; fixture.changes = []; fixture.requests = [];
  wire.authority = 'current'; wire.authorityAfter = 0; wire.asked = 0; wire.presence = true; wire.telegram = 'ok'; wire.telegramSent = []; wire.previews = []; wire.whatsappSent = []; wire.presenceDown = false; wire.admittedBy = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') {
      wire.asked += 1;
      const answer = wire.asked > wire.authorityAfter ? wire.authority : 'current';
      if (answer === 'outage') throw new Error('directory unavailable');
      if (answer === 'error') return new Response('upstream unavailable', { status: 503 });
      return Response.json(answer === 'revoked' ? null : { owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    }
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return wire.presenceDown ? new Response('upstream unavailable', { status: 503 }) : Response.json(wire.presence);
    if (fn === 'common_owner_authority') { wire.admittedBy.push(asked.p_provider!); return presenceAuthority(OWNER_ID, init?.body); }
    if (/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/.test(url)) {
      const sent = JSON.parse(String(init?.body)) as Sent & { link_preview_options?: unknown };
      wire.previews.push(sent.link_preview_options);
      wire.telegramSent.push({ chat_id: sent.chat_id, text: sent.text, ...(sent.reply_markup === undefined ? {} : { reply_markup: sent.reply_markup }) });
      if (wire.telegram === 'fails') return Response.json({ ok: false, error_code: 500, description: 'Internal Server Error' }, { status: 500 });
      return Response.json({ ok: true, result: { message_id: 40 + wire.telegramSent.length, chat: { id: sent.chat_id } } });
    }
    if (url.startsWith('https://api.telegram.org/')) return Response.json({ ok: true, result: true });
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; text?: { body: string } };
      if (body.type === 'text') wire.whatsappSent.push(body.text!.body);
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.out.${wire.whatsappSent.length}` }] });
    }
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
type Ctx = { now: number; name: string; appSubject: number };
type Binding = Readonly<{ app?: boolean; byChoice?: boolean; whatsapp?: boolean }>;

// An owner bound to Telegram (subject 7) who has also used the app, with Google connected, the clock pinned, and no time
// zone confirmed in the app. The jobs each runtime arms on its first build are cleared, so each test schedules exactly the
// work it means to run.
const withOwner = async (name: string, run: (owner: Owner, state: DurableObjectState, ctx: Ctx) => Promise<void>, binding: Binding = { app: true }) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const originalNow = Date.now, ctx: Ctx = { now: AT, name, appSubject: appSubjectFor(name) };
    Date.now = () => ctx.now;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('telegram_subject', '7');
      if (binding.app) state.storage.kv.put('app_subject', String(ctx.appSubject));
      // Written to the app and to WhatsApp, the owner's choice; they wrote on WhatsApp an hour ago, so its window is open.
      if (binding.whatsapp) { state.storage.kv.put('whatsapp_subject', WHATSAPP); state.storage.kv.put('proactive_surface_v1', 'both'); state.storage.kv.put('wa_last_inbound_ms', AT - 3_600_000); }
      state.storage.kv.put('timezone', 'UTC');
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only',
        scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.readonly'] }]);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', MAIL_SOURCE_FOLLOWUPS: '1', CALENDAR_GROUNDED_PREP: '1',
        ...(binding.byChoice ? { PROACTIVE_BY_CHOICE: '1', OWNER_SURFACE_DEFAULT: '1' } : {}),
        ...(binding.whatsapp ? { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' } : {}) }) as unknown as Owner;
      await owner.setup('telegram').ready;
      await owner.setup('app').ready;
      state.storage.sql.exec('DELETE FROM schedule');
      wire.telegramSent = []; wire.previews = [];
      await run(owner, state, ctx);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};

const due = (state: DurableObjectState, id: string, kind: string, payloadRefs: Record<string, string> = { id }) => new Scheduler(state.storage.sql, state.storage, productionDeps())
  .schedule({ id, kind: kind as never, payloadRefs, occurrenceAt: Date.now() - 1000, dueAt: Date.now() - 1000, recurrence: null });
const dueSweep = (state: DurableObjectState) => new Scheduler(state.storage.sql, state.storage, productionDeps()).schedule({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot',
  payloadRefs: { id: BRIEF_SWEEP_ID }, occurrenceAt: Date.now() - 1000, dueAt: Date.now() - 1000, recurrence: { type: 'interval', every_ms: 10 * 60_000, phase_ms: 0 } });
// One alarm pass over the scheduled work, then one over the delivery outbox.
const schedulePass = async (owner: Owner, state: DurableObjectState) => { state.storage.kv.put('owner_alarm_last_v1', 1); await owner.alarm(); };
const outboxPass = async (owner: Owner, state: DurableObjectState, ctx: Ctx) => { ctx.now += 1000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); };
const appChat = async (owner: Owner, ctx: Ctx) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': ctx.name, 'x-waldo-app-session-hash': 'a'.repeat(64) } }));
  expect(response.status).toBe(200);
  // The channel is what the app counts as new: Waldo's rows on the app, never the alarm's channel.
  return (await response.json() as { messages: { role: string; text: string; channel: string }[] }).messages.map(({ role, text, channel }) => ({ role, text, channel }));
};
const outbox = (state: DurableObjectState) => state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? [];
const copyLog = (state: DurableObjectState) => state.storage.sql.exec<{ ok: number; note: string }>("SELECT ok, note FROM trace_log WHERE hop = 'telegram_copy'").toArray();
// A record already frozen in the outbox: a reply to an earlier Telegram turn, or a nudge addressed to the app.
const queue = (state: DurableObjectState, ctx: Ctx, record: 'telegram' | 'app', changed: Partial<FinalRecord> = {}) => new TelegramFinalOutbox(state.storage.kv, () => Date.now() - 60_000, (rows, at) => persistTransportWake(state.storage, rows, at))
  .enqueue({ ...(record === 'telegram'
    ? { id: 'turn:telegram-1', trace: 'tg-1', payload: { chat_id: 7, text: REPLY_TEXT }, ownerSubject: '7', doName: ctx.name, bot: '7' }
    : { id: 'nudge:app-1', trace: 'app-1', payload: { chat_id: ctx.appSubject, text: NUDGE_TEXT }, ownerSubject: String(ctx.appSubject), doName: ctx.name }), ...changed });

describe('proactive work for an owner on Telegram who also uses the app', () => {
  it('a day card reaches the app chat, and Telegram gets one plain copy with no buttons, with no time zone confirmed in the app', async () => {
    await withOwner('routing-day-card', async (owner, state, ctx) => {
      expect(state.storage.kv.get('timezone_confirmed')).toBeUndefined();
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await due(state, 'card:brief', 'brief');
      await schedulePass(owner, state);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: CARD_TEXT, channel: 'app' }]);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: CARD_TEXT }]);
    });
  });

  it('a day card written for the app still reads today\'s Telegram conversation, and its text joins the episodes nightly and search read', async () => {
    await withOwner('routing-day-card-context', async (owner, state) => {
      const episodes = episodeIndex(state.storage.sql);
      episodes.add('telegram-turn-1', 'owner', 'Lunch with Pat moved to 13:00.', AT - 3_600_000);
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await due(state, 'card:brief', 'brief');
      await schedulePass(owner, state);
      expect(fixture.requests.filter(content => content.includes('[Scheduled card'))).toEqual([expect.stringContaining('Lunch with Pat moved to 13:00.')]);
      expect(episodes.since(AT - 86_400_000, 30_000).map(episode => episode.text)).toContain(CARD_TEXT);
    });
  });

  it('an update card reaches the app chat, and Telegram gets one plain copy', async () => {
    await withOwner('routing-update-card', async (owner, state, ctx) => {
      dayPlanBook(state.storage.sql).sent(DAY, 'card:brief');
      updateBook(state.storage.sql).mark('calendar_since', AT - 3_600_000);
      fixture.changes = [{ id: 'event-1', title: 'Changed event', status: 'confirmed', start: `${DAY}T11:00:00Z`, end: `${DAY}T11:30:00Z`, all_day: false, description: '', etag: 'r2',
        created: new Date(AT - 86_400_000).toISOString() } as CalendarChange];
      await dueSweep(state);
      await schedulePass(owner, state);
      // The sweep wrote a reader job; its worker reports (stood in for here) and the next pass queues the card for the app.
      expect(reportMachineJobs(state.storage.sql)).toHaveLength(1);
      await schedulePass(owner, state);
      expect(outbox(state).filter(record => record.update).map(record => record.payload.chat_id)).toEqual([ctx.appSubject]);
      await outboxPass(owner, state, ctx);
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: UPDATE_TEXT, channel: 'app' }]);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: UPDATE_TEXT }]);
      // The card keeps the Main chat row it became and when it was delivered, for the day's history.
      const rows = (await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': ctx.name, 'x-waldo-app-session-hash': 'a'.repeat(64) } }))).json() as { messages: { id: string }[] }).messages;
      expect(updateBook(state.storage.sql).delivered(DAY)).toEqual([{ app_row: rows[0]!.id, delivered_at: AT + 1000 }]);
    });
  });

  it('a mail follow-up is queued for the app, reaches the app chat and is settled as delivered, and Telegram gets one plain copy', async () => {
    await withOwner('routing-mail-followup', async (owner, state, ctx) => {
      const updates = updateBook(state.storage.sql);
      updates.observeMail('mail:thread-1', 'thread-1', AT - 600_000, 'message-1');
      updates.record(DAY, AT - 600_000, [{ source: 'mail', kind: 'new', detail: '{"from":"Pat","subject":"Review the deck by 10"}', source_ref: 'mail:thread-1', source_message_id: 'message-1' }], null);
      state.storage.sql.exec('UPDATE observed_mail SET judged = 1');
      loopBook(state.storage.sql, { newId: () => 'deck', now: () => AT }).open({ title: 'Check the deck review', due: `${DAY}T09:30`, source_ref: 'mail:thread-1' });
      await dueSweep(state);
      await schedulePass(owner, state);
      expect(outbox(state).filter(record => record.mailFollowup).map(record => ({ chat: record.payload.chat_id, status: record.status }))).toEqual([{ chat: ctx.appSubject, status: 'pending' }]);
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: FOLLOWUP_TEXT, channel: 'app' }]);
      expect(state.storage.sql.exec('SELECT delivery_state FROM loop_mail_sources').toArray()).toEqual([{ delivery_state: 'delivered' }]);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: FOLLOWUP_TEXT }]);
    });
  });

  it('meeting prep is queued for the app, reaches the app chat before the meeting, and Telegram gets one plain copy', async () => {
    await withOwner('routing-prep', async (owner, state, ctx) => {
      fixture.event = { id: 'event-1', title: 'Design review', status: 'confirmed', start: `${DAY}T09:30:00Z`, end: `${DAY}T10:00:00Z`, all_day: false,
        description: 'Bring the onboarding mocks.', attendee_names: ['Pat'], attendees: 3, etag: 'r1' } as CalendarItem;
      await dueSweep(state);
      await schedulePass(owner, state);
      expect(outbox(state).filter(record => record.calendarPrep).map(record => ({ chat: record.payload.chat_id, status: record.status }))).toEqual([{ chat: ctx.appSubject, status: 'pending' }]);
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: PREP_TEXT, channel: 'app' }]);
      expect(outbox(state).find(record => record.calendarPrep)?.status).toBe('delivered');
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: PREP_TEXT }]);
    });
  });

  it('the check-back of a due loop is queued for the app, reaches the app chat, and Telegram gets one plain copy', async () => {
    await withOwner('routing-heartbeat', async (owner, state, ctx) => {
      loopBook(state.storage.sql, { newId: () => 'loop-1', now: () => AT }).open({ title: 'Send the invoice', due: `${DAY}T08:00` });
      await armHeartbeat(new Scheduler(state.storage.sql, state.storage, productionDeps()), Date.now() - 60 * 60_000);
      await schedulePass(owner, state);
      // The tick wrote a check-back job; its worker reports, and the next pass applies it on the app.
      reportMachineJobs(state.storage.sql);
      await schedulePass(owner, state);
      expect(outbox(state).filter(record => record.heartbeat).map(record => record.payload.chat_id)).toEqual([ctx.appSubject]);
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: CHECK_BACK_TEXT, channel: 'app' }]);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: CHECK_BACK_TEXT }]);
    });
  });

  it('a standing order\'s report reaches the app chat, and Telegram gets one plain copy', async () => {
    await withOwner('routing-standing-order', async (owner, state, ctx) => {
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const order = await standingOrderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date(Date.now()) }, () => 'order1')
        .set({ scope: 'Triage my inbox', trigger: 'daily', at: '08:00', gate: 'act_and_report', escalation: 'message_owner' });
      await due(state, order.id, 'standing_order', { order_id: order.id });
      await schedulePass(owner, state);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: ORDER_TEXT, channel: 'app' }]);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: ORDER_TEXT }]);
    });
  });

  // The card goes through the final outbox, whose payload carries no feedback buttons.
  it('keeps an update card on Telegram, with no copy, while the owner has no app binding', async () => {
    await withOwner('routing-no-app', async (owner, state, ctx) => {
      dayPlanBook(state.storage.sql).sent(DAY, 'card:brief');
      updateBook(state.storage.sql).mark('calendar_since', AT - 3_600_000);
      fixture.changes = [{ id: 'event-1', title: 'Changed event', status: 'confirmed', start: `${DAY}T11:00:00Z`, end: `${DAY}T11:30:00Z`, all_day: false, description: '', etag: 'r2',
        created: new Date(AT - 86_400_000).toISOString() } as CalendarChange];
      await dueSweep(state);
      await schedulePass(owner, state);
      expect(reportMachineJobs(state.storage.sql)).toHaveLength(1);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      await outboxPass(owner, state, ctx);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: UPDATE_TEXT }]);
      expect(await appChat(owner, ctx)).toEqual([]);
    }, { app: false });
  });
});

describe('the delivery outbox for an owner on both surfaces', () => {
  it('delivers a reply to a Telegram turn on Telegram with no copy, and a record queued for the app to the app with one copy', async () => {
    await withOwner('routing-mixed-outbox', async (owner, state, ctx) => {
      await queue(state, ctx, 'telegram');
      await queue(state, ctx, 'app');
      await outboxPass(owner, state, ctx);
      await outboxPass(owner, state, ctx);
      expect(outbox(state).map(record => [record.id, record.status])).toEqual([['turn:telegram-1', 'delivered'], ['nudge:app-1', 'delivered']]);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: NUDGE_TEXT, channel: 'app' }]);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: REPLY_TEXT }, { chat_id: 7, text: NUDGE_TEXT }]);
    });
  });

  it.each([['outage', 'unreachable'], ['error', 'answering 503']] as const)('keeps a record for the app pending while the directory is %s (%s), while a Telegram reply still goes out', async (authority, _how) => {
    await withOwner(`routing-outbox-${authority}`, async (owner, state, ctx) => {
      await queue(state, ctx, 'app');
      await queue(state, ctx, 'telegram');
      wire.authority = authority;
      await outboxPass(owner, state, ctx);
      await outboxPass(owner, state, ctx);
      expect(outbox(state).map(record => [record.id, record.status])).toEqual([['nudge:app-1', 'pending'], ['turn:telegram-1', 'delivered']]);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: REPLY_TEXT }]);
      // The record owns its one retry: it is due again once, a minute after the outage was met.
      const held = outbox(state).find(record => record.id === 'nudge:app-1')!;
      expect(held.dueAt - ctx.now).toBeGreaterThan(55_000);
      expect(held.dueAt - ctx.now).toBeLessThanOrEqual(60_000);
      wire.authority = 'current';
      ctx.now += 120_000;
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: NUDGE_TEXT, channel: 'app' }]);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: REPLY_TEXT }, { chat_id: 7, text: NUDGE_TEXT }]);
    });
  });

  it('blocks a record for the app when the directory no longer admits the owner: nothing reaches the app or Telegram', async () => {
    await withOwner('routing-outbox-revoked', async (owner, state, ctx) => {
      await queue(state, ctx, 'app');
      wire.authority = 'revoked';
      await outboxPass(owner, state, ctx);
      // Blocked is terminal and settled: nothing is left due, so the record asks the directory no more.
      expect(outbox(state).map(record => [record.status, record.reason, record.settled])).toEqual([['blocked', 'owner_binding', true]]);
      expect(await appChat(owner, ctx)).toEqual([]);
      expect(wire.telegramSent).toEqual([]);
    });
  });

  it.each([['Telegram', 'telegram', { ownerSubject: '8' }], ['app', 'app', { ownerSubject: '8' }], ['app', 'app', { doName: 'another-owner' }]] as const)('blocks a record for the %s whose owner is not this one (%o), and sends it nowhere', async (_surface, record, changed) => {
    await withOwner(`routing-foreign-${record}-${Object.keys(changed)[0]}`, async (owner, state, ctx) => {
      await queue(state, ctx, record, changed);
      await outboxPass(owner, state, ctx);
      expect(outbox(state).map(row => [row.status, row.reason])).toEqual([['blocked', 'owner_binding']]);
      expect(await appChat(owner, ctx)).toEqual([]);
      expect(wire.telegramSent).toEqual([]);
    });
  });

  it('sends one copy for a delivered record, and none when the same record is queued and drained again', async () => {
    await withOwner('routing-redelivery', async (owner, state, ctx) => {
      await queue(state, ctx, 'app');
      await outboxPass(owner, state, ctx);
      await queue(state, ctx, 'app');
      await outboxPass(owner, state, ctx);
      await outboxPass(owner, state, ctx);
      expect(outbox(state).map(record => record.status)).toEqual(['delivered']);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: NUDGE_TEXT, channel: 'app' }]);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: NUDGE_TEXT }]);
    });
  });

  it('sends no copy for a message the app did not take', async () => {
    await withOwner('routing-app-refused', async (owner, state, ctx) => {
      await queue(state, ctx, 'app');
      // The drain admits the owner; the delivery's own check, just before the write, finds the account revoked.
      wire.authority = 'revoked'; wire.authorityAfter = wire.asked + 1;
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, ctx)).toEqual([]);
      expect(wire.telegramSent).toEqual([]);
      expect(outbox(state).map(record => record.status)).not.toContain('delivered');
    });
  });

  it.each([['fails', 'copy_failed'], ['blocked', 'copy_blocked']] as const)('writes the app message once and settles it when the Telegram copy %s, with one fixed-code log line and no retry', async (failure, code) => {
    await withOwner(`routing-copy-${failure}`, async (owner, state, ctx) => {
      await queue(state, ctx, 'app');
      if (failure === 'fails') wire.telegram = 'fails';
      else wire.presence = false;
      await outboxPass(owner, state, ctx);
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: NUDGE_TEXT, channel: 'app' }]);
      expect(outbox(state).map(record => record.status)).toEqual(['delivered']);
      expect(wire.telegramSent).toEqual(failure === 'fails' ? [{ chat_id: 7, text: NUDGE_TEXT }] : []);
      expect(copyLog(state)).toEqual([{ ok: 0, note: code }]);
    });
  });
});

// Telegram fetches a link in a message to draw its preview, with no tap from the owner. Text that carries mail or calendar
// content can carry a link someone else wrote, so no send from the owner object asks for a preview.
describe('link previews on Telegram', () => {
  const noPreview = { is_disabled: true };

  it('meeting prep goes to a Telegram-only owner with link previews off', async () => {
    await withOwner('previews-prep', async (owner, state, ctx) => {
      fixture.event = { id: 'event-1', title: 'Design review', status: 'confirmed', start: `${DAY}T09:30:00Z`, end: `${DAY}T10:00:00Z`, all_day: false,
        description: 'Bring the onboarding mocks.', attendee_names: ['Pat'], attendees: 3, etag: 'r1' } as CalendarItem;
      await dueSweep(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: PREP_TEXT }]);
      expect(wire.previews).toEqual([noPreview]);
    }, { app: false });
  });

  it('an update card goes out with link previews off', async () => {
    await withOwner('previews-update', async (owner, state, ctx) => {
      dayPlanBook(state.storage.sql).sent(DAY, 'card:brief');
      updateBook(state.storage.sql).mark('calendar_since', AT - 3_600_000);
      fixture.changes = [{ id: 'event-1', title: 'Changed event', status: 'confirmed', start: `${DAY}T11:00:00Z`, end: `${DAY}T11:30:00Z`, all_day: false, description: '', etag: 'r2',
        created: new Date(AT - 86_400_000).toISOString() } as CalendarChange];
      await dueSweep(state);
      await schedulePass(owner, state);
      expect(reportMachineJobs(state.storage.sql)).toHaveLength(1);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      await outboxPass(owner, state, ctx);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: UPDATE_TEXT }]);
      expect(wire.previews).toEqual([noPreview]);
    }, { app: false });
  });

  it('a reply to a Telegram turn and the plain copy of an app message both go out with link previews off', async () => {
    await withOwner('previews-reply-and-copy', async (owner, state, ctx) => {
      await queue(state, ctx, 'telegram');
      await queue(state, ctx, 'app');
      await outboxPass(owner, state, ctx);
      await outboxPass(owner, state, ctx);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: REPLY_TEXT }, { chat_id: 7, text: NUDGE_TEXT }]);
      expect(wire.previews).toEqual([noPreview, noPreview]);
    });
  });
});

// PROACTIVE_BY_CHOICE: the owner's choice decides where Waldo writes first, whether or not they are still linked on Telegram.
// Telegram takes none of it while another surface reaches them, and keeps only what answers what they wrote there.
describe('with the owner\'s choice deciding, for an owner still linked on Telegram', () => {
  const ON = { app: true, byChoice: true } as const;

  it('a day card reaches the app chat and nothing goes to Telegram, on the zone the owner had on Telegram with none confirmed in the app', async () => {
    await withOwner('choice-day-card', async (owner, state, ctx) => {
      expect(state.storage.kv.get('timezone_confirmed')).toBeUndefined();
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await due(state, 'card:brief', 'brief');
      await schedulePass(owner, state);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: CARD_TEXT, channel: 'app' }]);
      expect(wire.telegramSent).toEqual([]);
    }, ON);
  });

  it('an update card reaches the app chat and nothing goes to Telegram', async () => {
    await withOwner('choice-update-card', async (owner, state, ctx) => {
      dayPlanBook(state.storage.sql).sent(DAY, 'card:brief');
      updateBook(state.storage.sql).mark('calendar_since', AT - 3_600_000);
      fixture.changes = [{ id: 'event-1', title: 'Changed event', status: 'confirmed', start: `${DAY}T11:00:00Z`, end: `${DAY}T11:30:00Z`, all_day: false, description: '', etag: 'r2',
        created: new Date(AT - 86_400_000).toISOString() } as CalendarChange];
      await dueSweep(state);
      await schedulePass(owner, state);
      expect(reportMachineJobs(state.storage.sql)).toHaveLength(1);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: UPDATE_TEXT, channel: 'app' }]);
      expect(wire.telegramSent).toEqual([]);
    }, ON);
  });

  it('a mail follow-up reaches the app chat, settles as delivered, and nothing goes to Telegram', async () => {
    await withOwner('choice-mail-followup', async (owner, state, ctx) => {
      const updates = updateBook(state.storage.sql);
      updates.observeMail('mail:thread-1', 'thread-1', AT - 600_000, 'message-1');
      updates.record(DAY, AT - 600_000, [{ source: 'mail', kind: 'new', detail: '{"from":"Pat","subject":"Review the deck by 10"}', source_ref: 'mail:thread-1', source_message_id: 'message-1' }], null);
      state.storage.sql.exec('UPDATE observed_mail SET judged = 1');
      loopBook(state.storage.sql, { newId: () => 'deck', now: () => AT }).open({ title: 'Check the deck review', due: `${DAY}T09:30`, source_ref: 'mail:thread-1' });
      await dueSweep(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: FOLLOWUP_TEXT, channel: 'app' }]);
      expect(state.storage.sql.exec('SELECT delivery_state FROM loop_mail_sources').toArray()).toEqual([{ delivery_state: 'delivered' }]);
      expect(wire.telegramSent).toEqual([]);
    }, ON);
  });

  it('meeting prep reaches the app chat and nothing goes to Telegram', async () => {
    await withOwner('choice-prep', async (owner, state, ctx) => {
      fixture.event = { id: 'event-1', title: 'Design review', status: 'confirmed', start: `${DAY}T09:30:00Z`, end: `${DAY}T10:00:00Z`, all_day: false,
        description: 'Bring the onboarding mocks.', attendee_names: ['Pat'], attendees: 3, etag: 'r1' } as CalendarItem;
      await dueSweep(state);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: PREP_TEXT, channel: 'app' }]);
      expect(wire.telegramSent).toEqual([]);
    }, ON);
  });

  it('the check-back of a due loop reaches the app chat and nothing goes to Telegram', async () => {
    await withOwner('choice-heartbeat', async (owner, state, ctx) => {
      loopBook(state.storage.sql, { newId: () => 'loop-1', now: () => AT }).open({ title: 'Send the invoice', due: `${DAY}T08:00` });
      await armHeartbeat(new Scheduler(state.storage.sql, state.storage, productionDeps()), Date.now() - 60 * 60_000);
      await schedulePass(owner, state);
      reportMachineJobs(state.storage.sql);
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: CHECK_BACK_TEXT, channel: 'app' }]);
      expect(wire.telegramSent).toEqual([]);
    }, ON);
  });

  it('a standing order\'s report reaches the app chat and nothing goes to Telegram', async () => {
    await withOwner('choice-standing-order', async (owner, state, ctx) => {
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const order = await standingOrderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date(Date.now()) }, () => 'order1')
        .set({ scope: 'Triage my inbox', trigger: 'daily', at: '08:00', gate: 'act_and_report', escalation: 'message_owner' });
      await due(state, order.id, 'standing_order', { order_id: order.id });
      await schedulePass(owner, state);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: ORDER_TEXT, channel: 'app' }]);
      expect(wire.telegramSent).toEqual([]);
    }, ON);
  });

  it('an owner who chose the app and WhatsApp gets a day card in both, and nothing on Telegram', async () => {
    await withOwner('choice-both', async (owner, state, ctx) => {
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await due(state, 'card:brief', 'brief');
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: CARD_TEXT, channel: 'app' }]);
      expect(wire.whatsappSent).toEqual([CARD_TEXT]);
      expect(wire.telegramSent).toEqual([]);
    }, { ...ON, whatsapp: true });
  });

  it('a full day for an owner still linked on Telegram who chose the app and WhatsApp: the Brief, a reminder, a check-back and a standing order\'s report reach both, and nothing reaches Telegram', async () => {
    await withOwner('choice-full-day', async (owner, state, ctx) => {
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const step = async () => { await schedulePass(owner, state); await outboxPass(owner, state, ctx); await outboxPass(owner, state, ctx); };
      // 09:00, the Brief.
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await due(state, 'card:brief', 'brief');
      await step();
      // 11:00, a reminder the owner set on Telegram yesterday.
      ctx.now = AT + 2 * 3_600_000;
      await reminderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date(Date.now() - 3_600_000) }, () => 'rem-1')
        .set({ note: 'call Sam', at: new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 16), repeat: 'none' });
      await step();
      // 13:00, the check-back of a loop that came due.
      ctx.now = AT + 4 * 3_600_000;
      loopBook(state.storage.sql, { newId: () => 'loop-1', now: () => ctx.now }).open({ title: 'Send the invoice', due: `${DAY}T12:00` });
      await armHeartbeat(scheduler, Date.now() - 60 * 60_000);
      await schedulePass(owner, state);
      reportMachineJobs(state.storage.sql);
      await step();
      // 17:00, a standing order's report.
      ctx.now = AT + 8 * 3_600_000;
      const order = await standingOrderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date(Date.now()) }, () => 'order1')
        .set({ scope: 'Triage my inbox', trigger: 'daily', at: '08:00', gate: 'act_and_report', escalation: 'message_owner' });
      await due(state, order.id, 'standing_order', { order_id: order.id });
      await step();
      const day = [CARD_TEXT, REMINDER_TEXT, CHECK_BACK_TEXT, ORDER_TEXT];
      // The app lists its newest row first.
      expect({ app: (await appChat(owner, ctx)).map(row => row.text).reverse(), whatsapp: wire.whatsappSent }).toEqual({ app: day, whatsapp: day });
      expect(wire.telegramSent).toEqual([]);
    }, { ...ON, whatsapp: true });
  });

  it('a reply to a Telegram turn still goes to Telegram, and a scheduled message left queued for Telegram goes to the app instead', async () => {
    await withOwner('choice-outbox', async (owner, state, ctx) => {
      await queue(state, ctx, 'telegram');
      await queue(state, ctx, 'telegram', { id: 'card:telegram-1', trace: 'card-1', payload: { chat_id: 7, text: CARD_TEXT }, dayCard: { day: DAY, card: 'card:brief' } } as Partial<FinalRecord>);
      await outboxPass(owner, state, ctx);
      await outboxPass(owner, state, ctx);
      expect(outbox(state).map(record => [record.id, record.status])).toEqual([['turn:telegram-1', 'delivered'], ['card:telegram-1', 'delivered']]);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: REPLY_TEXT }]);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: CARD_TEXT, channel: 'app' }]);
    }, ON);
  });

  it('while the directory cannot say, holds the pass: nothing goes to Telegram, and once it answers the reply and the app\'s message go out', async () => {
    await withOwner('choice-outage', async (owner, state, ctx) => {
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await due(state, 'card:brief', 'brief');
      await queue(state, ctx, 'app');
      await queue(state, ctx, 'telegram');
      wire.authority = 'outage';
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      // The reply to the owner's Telegram message waits with the rest, a minute at most, rather than the pass falling back to Telegram.
      expect(wire.telegramSent).toEqual([]);
      expect(outbox(state).map(record => [record.id, record.status])).toEqual([['nudge:app-1', 'pending'], ['turn:telegram-1', 'pending']]);
      wire.authority = 'current';
      ctx.now += 120_000;
      await outboxPass(owner, state, ctx);
      await outboxPass(owner, state, ctx);
      expect(outbox(state).map(record => [record.id, record.status])).toEqual([['nudge:app-1', 'delivered'], ['turn:telegram-1', 'delivered']]);
      expect(wire.telegramSent).toEqual([{ chat_id: 7, text: REPLY_TEXT }]);
      expect((await appChat(owner, ctx)).map(row => row.text)).toContain(NUDGE_TEXT);
    }, ON);
  });

  it('holds the pass while only the WhatsApp presence cannot be checked, rather than sending a Telegram copy, and delivers once it can', async () => {
    await withOwner('choice-presence-down', async (owner, state, ctx) => {
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await due(state, 'card:brief', 'brief');
      wire.presenceDown = true;
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect({ telegram: wire.telegramSent, whatsapp: wire.whatsappSent }).toEqual({ telegram: [], whatsapp: [] });
      wire.presenceDown = false;
      ctx.now += 120_000;
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, ctx)).toEqual([{ role: 'assistant', text: CARD_TEXT, channel: 'app' }]);
      expect({ telegram: wire.telegramSent, whatsapp: wire.whatsappSent }).toEqual({ telegram: [], whatsapp: [CARD_TEXT] });
    }, { ...ON, whatsapp: true });
  });

  it('sends nothing on Telegram for an owner the directory no longer admits: the choice opens no way around a revoked account', async () => {
    await withOwner('choice-app-revoked', async (owner, state, ctx) => {
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await due(state, 'card:brief', 'brief');
      wire.authority = 'revoked';
      await schedulePass(owner, state);
      expect(wire.telegramSent).toEqual([]);
      wire.authority = 'current';
      expect(await appChat(owner, ctx)).toEqual([]);
    }, ON);
  });

  it('an owner with WhatsApp and no app gets a day card on WhatsApp, and nothing on Telegram', async () => {
    await withOwner('choice-whatsapp-no-app', async (owner, state, ctx) => {
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await due(state, 'card:brief', 'brief');
      await schedulePass(owner, state);
      await outboxPass(owner, state, ctx);
      expect(wire.whatsappSent).toEqual([CARD_TEXT]);
      expect(wire.telegramSent).toEqual([]);
      // The card's job was admitted through WhatsApp, the surface that delivered it, not through the Telegram link.
      expect(new Set(wire.admittedBy)).toEqual(new Set(['whatsapp']));
    }, { app: false, byChoice: true, whatsapp: true });
  });

  it('keeps an owner with no other surface on Telegram', async () => {
    await withOwner('choice-telegram-only', async (owner, state) => {
      dayPlanBook(state.storage.sql).save(DAY, { card: 'card:brief', time: '00:00', reason: 'planned' });
      await due(state, 'card:brief', 'brief');
      await schedulePass(owner, state);
      expect(wire.telegramSent.map(sent => sent.text)).toEqual([CARD_TEXT]);
    }, { app: false, byChoice: true });
  });
});
