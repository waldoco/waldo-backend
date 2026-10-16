import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarChange, CalendarItem } from '../src/connectors/google';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { traceBook } from '../src/channels/harness';
import { loopBook } from '../src/channels/loops';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';
import { updateBook } from '../src/channels/update-cards';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

const UPDATE_TEXT = 'Your 10:30 moved to 11:00.';
const FOLLOWUP_TEXT = 'Have you handled the deck review? Pat asked for it by 10.';
const PREP_TEXT = 'Design review at 09:30. Bring the onboarding mocks; Pat is listed.';
const fixture = vi.hoisted(() => ({ event: null as CalendarItem | null, changes: [] as CalendarChange[], requests: [] as string[], duringPrep: null as (() => void) | null }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => fixture.event ? [fixture.event] : [], newMail: async () => [], changedEvents: async () => fixture.changes, event: async () => fixture.event,
    calendarPage: async () => ({ events: fixture.event ? [fixture.event] : [], next_page_token: null, fetched_count: 1, account, observed_at: new Date().toISOString() }),
  }) };
});
vi.mock('../src/channels/owner-turn', async load => {
  const original = await load<typeof import('../src/channels/owner-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const sent = JSON.stringify(request.request);
    fixture.requests.push(sent);
    const content = request.request.messages.at(-1)?.content ?? '';
    const format = request.request.response_format?.name;
    const text = format === 'task_source_scope' ? '{"decision":"retain","sources":[]}'
      : format === 'claim_ops' ? JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null })
      : content.includes('[Meeting prep decision') ? (fixture.duringPrep?.(), JSON.stringify({ kind: 'notify', text: PREP_TEXT }))
      : content.includes('[Mail follow-up check') ? FOLLOWUP_TEXT
      : content.includes('[Update check') ? UPDATE_TEXT : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createOwnerResponder: (...args: Parameters<typeof original.createOwnerResponder>) => { args[10] = gateway; return original.createOwnerResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d';
const AT = Date.parse('2026-10-03T09:00:00Z');
const DAY = '2026-10-03';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { revoked: false, telegramSent: 0 };

beforeEach(() => {
  fixture.event = null; fixture.changes = []; fixture.requests = []; fixture.duringPrep = null;
  wire.revoked = false; wire.telegramSent = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json(wire.revoked ? null : { owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_log_recent') return Response.json([
      { id: 1, kind: 'meal', logged_at: new Date(Date.now() - 3_600_000).toISOString(), payload: { description: 'oat bowl', calories_estimate: 8263.75 } },
      { id: 2, kind: 'workout', logged_at: new Date(Date.now() - 3_600_000).toISOString(), payload: { type: 'run', duration_minutes: 91.625 } },
    ]);
    if (fn === 'health_context_read') return Response.json(null);
    // An owner who only uses the app has no Telegram or WhatsApp presence.
    if (fn === 'assert_channel_presence') return Response.json(false);
    if (url.startsWith('https://api.telegram.org/')) { wire.telegramSent += 1; return Response.json({ ok: true, result: { message_id: 1, chat: { id: 7 } } }); }
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Runtime = Readonly<{ ready: Promise<unknown>; act(action: { action: string; value?: string }): Promise<boolean | string> }>;
type Owner = Readonly<{ setup(channel: string): Runtime; fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
type Ctx = { now: number; built: Record<string, string> };

// An owner who only uses the app, with Google connected and the clock pinned. The jobs the runtime arms on its first
// build are noted, then cleared, so each test schedules exactly the work it means to run.
const withAppOwner = async (name: string, confirmed: boolean, run: (owner: Owner, state: DurableObjectState, ctx: Ctx) => Promise<void>, flags: Record<string, string> = {}) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const originalNow = Date.now, ctx: Ctx = { now: AT, built: {} };
    Date.now = () => ctx.now;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      if (confirmed) state.storage.kv.put('timezone_confirmed', true);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only',
        scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.readonly'] }]);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', MAIL_SOURCE_FOLLOWUPS: '1', CALENDAR_GROUNDED_PREP: undefined, ...flags }) as unknown as Owner;
      await owner.setup('app').ready;
      ctx.built = schedule(state);
      state.storage.sql.exec('DELETE FROM schedule');
      await run(owner, state, ctx);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};

const dueSweep = (state: DurableObjectState) => new Scheduler(state.storage.sql, state.storage, productionDeps()).schedule({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot',
  payloadRefs: { id: BRIEF_SWEEP_ID }, occurrenceAt: Date.now() - 1000, dueAt: Date.now() - 1000, recurrence: { type: 'interval', every_ms: 10 * 60_000, phase_ms: 0 } });
// One alarm pass over the scheduled work, then one over the delivery outbox.
const sweepPass = async (owner: Owner, state: DurableObjectState) => { state.storage.kv.put('owner_alarm_last_v1', 1); await owner.alarm(); };
const outboxPass = async (owner: Owner, state: DurableObjectState, ctx: Ctx) => { ctx.now += 1000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); };
const appChat = async (owner: Owner, name: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64) } }));
  expect(response.status).toBe(200);
  return (await response.json() as { messages: { role: string; text: string }[] }).messages.map(({ role, text }) => ({ role, text }));
};
const schedule = (state: DurableObjectState) => Object.fromEntries(state.storage.sql
  .exec<{ id: string; status: string }>('SELECT id, status FROM schedule').toArray().map(row => [row.id, row.status]));
// Every stored copy in the owner DO: KV values (the app transcript among them) and the rows of every table it can read.
const storedText = (state: DurableObjectState) => {
  const kv = [...state.storage.kv.list()].map(([key, value]) => `${key} ${JSON.stringify(value)}`);
  const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(row => row.name);
  return [...kv, ...tables.flatMap(table => state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray().map(row => JSON.stringify(row)))].join('\n');
};
// The health values are decimal sentinels: a '.' never occurs in the hex ids or epoch times a store holds, so their absence
// from storedText means no stored copy carries them in any rendering.
const HEALTH_VALUES = ['8263.75', '91.625'];
const expectHealthOnlyInTheRequest = (state: DurableObjectState, marker: string) => {
  const request = fixture.requests.find(sent => sent.includes(marker));
  expect(request).toContain('~8263.75 kcal, estimate');
  expect(request).toContain('run, 91.625 min');
  const stored = storedText(state);
  for (const value of HEALTH_VALUES) expect(stored).not.toContain(value);
};
const outbox = (state: DurableObjectState) => state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? [];

describe('event-brief work for an owner who only uses the app', () => {
  it('an update card reaches the app chat without feedback buttons, written with the owner\'s health logs but never storing them', async () => {
    await withAppOwner('app-briefs-update-card', true, async (owner, state) => {
      dayPlanBook(state.storage.sql).sent(DAY, 'card:brief');
      const updates = updateBook(state.storage.sql);
      updates.mark('calendar_since', AT - 3_600_000);
      fixture.changes = [{ id: 'event-1', title: 'Changed event', status: 'confirmed', start: `${DAY}T11:00:00Z`, end: `${DAY}T11:30:00Z`, all_day: false, description: '', etag: 'r2',
        created: new Date(AT - 86_400_000).toISOString() } as CalendarChange];
      await dueSweep(state);
      await sweepPass(owner, state);
      expect(await appChat(owner, 'app-briefs-update-card')).toEqual([{ role: 'assistant', text: UPDATE_TEXT }]);
      expect(state.storage.sql.exec('SELECT pushed, text FROM update_cards').toArray()).toEqual([{ pushed: 1, text: UPDATE_TEXT }]);
      expectHealthOnlyInTheRequest(state, 'Changed event');
    });
    expect(wire.telegramSent).toBe(0);
  });

  it('a mail follow-up is queued, then reaches the app chat and is settled as delivered, written with the owner\'s health logs but never storing them', async () => {
    await withAppOwner('app-briefs-mail-followup', true, async (owner, state, ctx) => {
      const updates = updateBook(state.storage.sql);
      updates.observeMail('mail:thread-1', 'thread-1', AT - 600_000, 'message-1');
      updates.record(DAY, AT - 600_000, [{ source: 'mail', kind: 'new', detail: '{"from":"Pat","subject":"Review the deck by 10"}', source_ref: 'mail:thread-1', source_message_id: 'message-1' }], null);
      state.storage.sql.exec('UPDATE observed_mail SET judged = 1');
      loopBook(state.storage.sql, { newId: () => 'deck', now: () => AT }).open({ title: 'Check the deck review', due: `${DAY}T09:30`, source_ref: 'mail:thread-1' });
      await dueSweep(state);
      await sweepPass(owner, state);
      expect(outbox(state).filter(record => record.mailFollowup).map(record => ({ status: record.status, bot: record.bot }))).toEqual([{ status: 'pending', bot: undefined }]);
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, 'app-briefs-mail-followup')).toEqual([{ role: 'assistant', text: FOLLOWUP_TEXT }]);
      expect(state.storage.sql.exec('SELECT delivery_state FROM loop_mail_sources').toArray()).toEqual([{ delivery_state: 'delivered' }]);
      expectHealthOnlyInTheRequest(state, 'Mail follow-up check');
    });
    expect(wire.telegramSent).toBe(0);
  });

  it('meeting prep is decided once, queued, then reaches the app chat before the meeting', async () => {
    await withAppOwner('app-briefs-prep', true, async (owner, state, ctx) => {
      fixture.event = { id: 'event-1', title: 'Design review', status: 'confirmed', start: `${DAY}T09:30:00Z`, end: `${DAY}T10:00:00Z`, all_day: false,
        description: 'Bring the onboarding mocks.', attendee_names: ['Pat'], attendees: 3, etag: 'r1' } as CalendarItem;
      await dueSweep(state);
      await sweepPass(owner, state);
      expect(outbox(state).filter(record => record.calendarPrep).map(record => ({ status: record.status, bot: record.bot }))).toEqual([{ status: 'pending', bot: undefined }]);
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM event_briefs').one().n).toBe(1);
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, 'app-briefs-prep')).toEqual([{ role: 'assistant', text: PREP_TEXT }]);
      expect(outbox(state).find(record => record.calendarPrep)?.status).toBe('delivered');
      const prep = fixture.requests.filter(sent => sent.includes('[Meeting prep decision'));
      expect(prep).toHaveLength(1);
      for (const value of [...HEALTH_VALUES, 'oat bowl']) expect(prep[0]).not.toContain(value);
      for (const value of HEALTH_VALUES) expect(storedText(state)).not.toContain(value);
    });
    expect(wire.telegramSent).toBe(0);
  });

  // Production runs with grounded prep off. The legacy sweep sends straight to the chat with no outbox, so it never runs on
  // the app; the update check after it still does.
  it('with grounded prep off, no event brief is sent on the app, and the update card still reaches the app chat', async () => {
    await withAppOwner('app-briefs-legacy-off', true, async (owner, state) => {
      fixture.event = { id: 'event-1', title: 'Design review', status: 'confirmed', start: `${DAY}T09:30:00Z`, end: `${DAY}T10:00:00Z`, all_day: false,
        description: 'Bring the onboarding mocks.', attendee_names: ['Pat'], attendees: 3, etag: 'r1' } as CalendarItem;
      dayPlanBook(state.storage.sql).sent(DAY, 'card:brief');
      updateBook(state.storage.sql).mark('calendar_since', AT - 3_600_000);
      fixture.changes = [{ id: 'event-2', title: 'Changed event', status: 'confirmed', start: `${DAY}T11:00:00Z`, end: `${DAY}T11:30:00Z`, all_day: false, description: '', etag: 'r2',
        created: new Date(AT - 86_400_000).toISOString() } as CalendarChange];
      await dueSweep(state);
      await sweepPass(owner, state);
      expect(await appChat(owner, 'app-briefs-legacy-off')).toEqual([{ role: 'assistant', text: UPDATE_TEXT }]);
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM event_briefs').one().n).toBe(0);
      expect(fixture.requests.filter(sent => sent.includes('Design review'))).toEqual([]);
    }, { CALENDAR_GROUNDED_PREP: '0' });
    expect(wire.telegramSent).toBe(0);
  });

  it.each([['unlinks the app', 'app_unlinked', true], ['binds another app account', 'app_subject', '1']] as const)('queues no prep when the owner %s while it is being decided', async (_case, key, value) => {
    await withAppOwner(`app-briefs-prep-${key}`, true, async (owner, state, ctx) => {
      fixture.event = { id: 'event-1', title: 'Design review', status: 'confirmed', start: `${DAY}T09:30:00Z`, end: `${DAY}T10:00:00Z`, all_day: false,
        description: 'Bring the onboarding mocks.', attendee_names: ['Pat'], attendees: 3, etag: 'r1' } as CalendarItem;
      fixture.duringPrep = () => state.storage.kv.put(key, value);
      await dueSweep(state);
      await sweepPass(owner, state);
      expect(fixture.requests.filter(sent => sent.includes('[Meeting prep decision'))).toHaveLength(1);
      expect(outbox(state).filter(record => record.calendarPrep)).toEqual([]);
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM event_briefs').one().n).toBe(0);
      state.storage.kv.delete(key);
      if (key === 'app_subject') state.storage.kv.put('app_subject', String(appSubjectFor(`app-briefs-prep-${key}`)));
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, `app-briefs-prep-${key}`)).toEqual([]);
    });
    expect(wire.telegramSent).toBe(0);
  });

  it('runs nothing while the directory no longer admits the owner, and keeps a queued follow-up until it does', async () => {
    await withAppOwner('app-briefs-revoked', true, async (owner, state, ctx) => {
      const updates = updateBook(state.storage.sql);
      updates.observeMail('mail:thread-1', 'thread-1', AT - 600_000, 'message-1');
      updates.record(DAY, AT - 600_000, [{ source: 'mail', kind: 'new', detail: '{"from":"Pat","subject":"Review the deck by 10"}', source_ref: 'mail:thread-1', source_message_id: 'message-1' }], null);
      state.storage.sql.exec('UPDATE observed_mail SET judged = 1');
      loopBook(state.storage.sql, { newId: () => 'deck', now: () => AT }).open({ title: 'Check the deck review', due: `${DAY}T09:30`, source_ref: 'mail:thread-1' });
      await dueSweep(state);
      wire.revoked = true;
      await sweepPass(owner, state);
      expect(fixture.requests).toEqual([]);
      wire.revoked = false;
      await sweepPass(owner, state);
      wire.revoked = true;
      await outboxPass(owner, state, ctx);
      expect(outbox(state).find(record => record.mailFollowup)?.status).toBe('pending');
      expect(await appChat(owner, 'app-briefs-revoked')).toEqual([]);
      wire.revoked = false;
      await outboxPass(owner, state, ctx);
      expect(await appChat(owner, 'app-briefs-revoked')).toEqual([{ role: 'assistant', text: FOLLOWUP_TEXT }]);
    });
    expect(wire.telegramSent).toBe(0);
  });

  it('arms the sweep on the runtime build in a confirmed zone, and the zone choice arms one that was cancelled while unconfirmed', async () => {
    // A confirmed owner whose sweep an earlier build cancelled has no row; the next build arms it again.
    await withAppOwner('app-briefs-arm-confirmed', true, async (_owner, _state, ctx) => {
      expect(ctx.built[BRIEF_SWEEP_ID]).toBe('armed');
    });
    await withAppOwner('app-briefs-arm-first-choice', false, async (owner, state, ctx) => {
      expect(ctx.built[BRIEF_SWEEP_ID]).toBeUndefined();
      await dueSweep(state);
      await sweepPass(owner, state);
      expect(schedule(state)[BRIEF_SWEEP_ID]).toBeUndefined();
      expect(await owner.setup('app').act({ action: 'timezone.set', value: 'Europe/London' })).toBe(true);
      expect(schedule(state)[BRIEF_SWEEP_ID]).toBe('armed');
    });
    expect(fixture.requests).toEqual([]);
    expect(wire.telegramSent).toBe(0);
  });
});
