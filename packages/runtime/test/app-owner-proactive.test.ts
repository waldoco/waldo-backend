import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { NIGHTLY_ID } from '../src/channels/episodes';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { traceBook } from '../src/channels/harness';
import { armHeartbeat, HEARTBEAT_ID } from '../src/channels/heartbeat';
import { localIso, localToEpoch } from '../src/channels/reminders';
import { DAY_CARDS } from '../src/prompt/day-cards';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

const CARD_TEXT = 'Your morning is clear until noon.';
const model = vi.hoisted(() => ({ calls: 0, requests: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    model.calls += 1;
    model.requests.push(JSON.stringify(request.request));
    return { ok: true as const, data: { model: request.request.model, text: CARD_TEXT, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
// A fallback zone that differs from the directory's 'UTC' default, so saving the fallback is observable.
const FALLBACK = 'Asia/Tokyo';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { saved: [] as string[], telegramSent: 0, other: [] as string[], healthLogs: [] as unknown[] };

beforeEach(() => {
  model.calls = 0; model.requests = []; wire.saved = []; wire.telegramSent = 0; wire.other = []; wire.healthLogs = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'set_owner_settings') { wire.saved.push(asked.p_timezone!); return Response.json(true); }
    if (fn === 'health_log_recent') return Response.json(wire.healthLogs);
    if (fn === 'health_context_read' || fn === 'assert_channel_presence') return Response.json(fn === 'assert_channel_presence' ? true : null);
    if (url.startsWith('https://api.telegram.org/')) { wire.telegramSent += 1; return Response.json({ ok: true, result: { message_id: 1, chat: { id: 7 } } }); }
    wire.other.push(url);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Runtime = Readonly<{ ready: Promise<unknown>; timezone: string; view(session: { token: string; csrf: string; expires: number }, notice: null): Promise<{ timezoneConfirmed: boolean }>; act(action: { action: string; id?: string; value?: string }): Promise<boolean | string> }>;
type Owner = Readonly<{ setup(channel: string): Runtime; fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
type Stored = Readonly<{ zone?: string; confirmed?: boolean; pins?: Record<string, string>; capture?: boolean }>;

const withAppOwner = async <T>(name: string, stored: Stored, run: (owner: Owner, state: DurableObjectState) => Promise<T>): Promise<T> => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  return runInDurableObject(stub, async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    if (stored.zone) state.storage.kv.put('timezone', stored.zone);
    if (stored.confirmed) state.storage.kv.put('timezone_confirmed', true);
    for (const [card, time] of Object.entries(stored.pins ?? {})) dayPlanBook(state.storage.sql).pin(card as never, time);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: FALLBACK, WALDO_OWNER_TELEGRAM_ID: undefined, ...(stored.capture ? { LANGFUSE_CAPTURE_TEXT: 'true', WALDO_ENVIRONMENT: 'staging' } : {}) }) as unknown as Owner;
    try { return await run(owner, state); } finally { await state.storage.deleteAlarm(); }
  });
};

type Row = Readonly<{ id: string; status: string; due_at: number; recurrence: string | null }>;
const schedule = (state: DurableObjectState) => Object.fromEntries(state.storage.sql
  .exec<Row>('SELECT id, status, due_at, recurrence_json AS recurrence FROM schedule').toArray().map(row => [row.id, row]));
const OWN_JOBS = [NIGHTLY_ID, HEARTBEAT_ID, BRIEF_SWEEP_ID, ...DAY_CARDS.map(card => card.id)];
const ownJobs = (state: DurableObjectState) => Object.keys(schedule(state)).filter(id => OWN_JOBS.includes(id)).sort();
// Today's cards in `zone` that are still ahead, at their pinned or default local time.
const cardsAhead = (zone: string, pins: Record<string, string> = {}) => {
  const now = Date.now(), day = localIso(now, zone).slice(0, 10);
  return Object.fromEntries(DAY_CARDS.map(card => [card.id, localToEpoch(`${day}T${pins[card.id] ?? card.defaultTime}`, zone)]).filter(([, at]) => (at as number) > now + 5_000));
};
const appChat = async (owner: Owner, name: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64) } }));
  expect(response.status).toBe(200);
  return (await response.json() as { messages: { role: string; text: string }[] }).messages.map(({ role, text }) => ({ role, text }));
};

describe('proactive work for an owner who only uses the app', () => {
  it('arms nothing on first app use while no zone is confirmed, even with a stored zone that only arrived through ingress', async () => {
    for (const [name, stored] of [['proactive-unconfirmed', {}], ['proactive-ingress-zone', { zone: 'UTC' }]] as const) {
      await withAppOwner(name, stored, async (owner, state) => {
        await owner.setup('app').ready;
        expect(ownJobs(state)).toEqual([]);
      });
    }
    expect(model.calls).toBe(0);
  });

  it('arms nightly, heartbeat, the event-brief sweep and today\'s day cards in a confirmed zone on first app use', async () => {
    await withAppOwner('proactive-confirmed-boot', { zone: 'Europe/London', confirmed: true }, async (owner, state) => {
      await owner.setup('app').ready;
      const rows = schedule(state);
      expect(JSON.parse(rows[NIGHTLY_ID]!.recurrence!)).toMatchObject({ type: 'daily_local', timezone: 'Europe/London' });
      expect(rows[HEARTBEAT_ID]?.status).toBe('armed');
      expect(rows[BRIEF_SWEEP_ID]?.status).toBe('armed');
      for (const [card, at] of Object.entries(cardsAhead('Europe/London'))) expect(rows[card]?.due_at).toBe(at);
    });
    expect(model.calls).toBe(0);
  });

  it('the owner\'s first time-zone choice confirms it and arms the jobs in that zone, and the runtime uses the new zone', async () => {
    await withAppOwner('proactive-first-choice', {}, async (owner, state) => {
      await owner.setup('app').ready;
      expect((await owner.setup('app').view({ token: 't', csrf: 't', expires: Date.now() + 60_000 }, null)).timezoneConfirmed).toBe(false);
      expect(await owner.setup('app').act({ action: 'timezone.set', value: 'Asia/Kolkata' })).toBe(true);
      expect(wire.saved).toEqual(['Asia/Kolkata']);
      expect(state.storage.kv.get('timezone_confirmed')).toBe(true);
      expect((await owner.setup('app').view({ token: 't', csrf: 't', expires: Date.now() + 60_000 }, null)).timezoneConfirmed).toBe(true);
      const rows = schedule(state);
      expect(JSON.parse(rows[NIGHTLY_ID]!.recurrence!)).toMatchObject({ timezone: 'Asia/Kolkata' });
      expect(rows[HEARTBEAT_ID]?.status).toBe('armed');
      expect(rows[BRIEF_SWEEP_ID]?.status).toBe('armed');
      for (const [card, at] of Object.entries(cardsAhead('Asia/Kolkata'))) expect(rows[card]?.due_at).toBe(at);
      expect(owner.setup('app').timezone).toBe('Asia/Kolkata');
    });
  });

  // The test clock is pinned: whether two zones share a date depends on the instant.
  it.each([
    ['on the same date in both zones', '2026-10-11T12:00:00Z', 'Europe/London', 'America/New_York', false],
    ['to a zone still on the previous date', '2026-10-11T23:30:00Z', 'Europe/London', 'America/New_York', false],
    ['to a zone already on the next date', '2026-10-11T23:30:00Z', 'America/New_York', 'Europe/London', false],
    ['after a card already went out today in the new zone', '2026-10-11T12:00:00Z', 'Europe/London', 'America/New_York', true],
  ] as const)('a zone change %s re-plans every day card for today in the new zone, keeps pins and planned times, and leaves no entry from the old zone', async (_case, instant, from, to, closeSent) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(instant));
    try {
      const pins = { 'card:close': '23:45' }, planned = { 'card:midday': '23:30' };
      await withAppOwner(`proactive-zone-change-${from}-${to}-${closeSent}-${instant}`, { zone: from, confirmed: true, pins }, async (owner, state) => {
        await owner.setup('app').ready;
        const book = dayPlanBook(state.storage.sql), today = localIso(Date.now(), to).slice(0, 10);
        // A time already planned for the new zone's today, as nightly planning or the owner sets it.
        book.save(today, { card: 'card:midday', time: planned['card:midday'], reason: 'planned' });
        if (closeSent) book.sent(today, 'card:close');
        expect(await owner.setup('app').act({ action: 'timezone.set', value: to })).toBe(true);
        const rows = schedule(state), ahead = cardsAhead(to, { ...pins, ...planned });
        if (closeSent) delete ahead['card:close'];
        expect(Object.keys(ahead).length).toBeGreaterThan(0);
        for (const [card, at] of Object.entries(ahead)) expect(rows[card]?.due_at).toBe(at);
        for (const card of DAY_CARDS.map(c => c.id).filter(id => !(id in ahead))) expect(rows[card]).toBeUndefined();
        expect(owner.setup('app').timezone).toBe(to);
      });
    } finally { vi.useRealTimers(); }
  });

  it('saving quiet hours never writes the time-zone fallback to the directory', async () => {
    await withAppOwner('proactive-quiet-unconfirmed', {}, async owner => {
      expect(await owner.setup('app').act({ action: 'proactivity.set', value: '22:00|07:00|normal' })).toBe(true);
    });
    await withAppOwner('proactive-quiet-confirmed', { zone: 'Europe/London', confirmed: true }, async owner => {
      expect(await owner.setup('app').act({ action: 'proactivity.set', value: '22:00|07:00|normal' })).toBe(true);
    });
    expect(wire.saved).toEqual(['UTC', 'Europe/London']);
  });

  it.each([false, true])('while no zone is confirmed, a due heartbeat or day card delivers nothing and the heartbeat stays scheduled (text capture %s)', async capture => {
    await withAppOwner(`proactive-held-fire-${capture}`, { capture }, async (owner, state) => {
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      await armHeartbeat(scheduler, Date.now() - 60 * 60_000);
      await scheduler.schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 60_000, dueAt: Date.now() - 60_000, recurrence: null });
      await owner.alarm(); await owner.alarm();
      expect(model.calls).toBe(0);
      expect(await appChat(owner, `proactive-held-fire-${capture}`)).toEqual([]);
      expect(schedule(state)[HEARTBEAT_ID]?.status).toBe('armed');
      // Each hold leaves one fixed code naming the kind and the reason, never an id or text.
      expect(state.storage.sql.exec<{ hop: string; note: string; ok: number }>("SELECT DISTINCT hop, note, ok FROM trace_log WHERE hop = 'scheduled_hold' ORDER BY note").toArray())
        .toEqual([{ hop: 'scheduled_hold', note: 'daily_brief_timezone_unconfirmed', ok: 1 }, { hop: 'scheduled_hold', note: 'heartbeat_timezone_unconfirmed', ok: 1 }]);
    });
    expect(wire.telegramSent).toBe(0);
  });

  it.each([false, true])('while no zone is confirmed, an event-brief sweep on the app is cancelled the first time the alarm meets it, with one trace row naming why (text capture %s)', async capture => {
    await withAppOwner(`proactive-brief-drop-${capture}`, { zone: 'UTC', capture }, async (owner, state) => {
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      await scheduler.schedule({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot', payloadRefs: { id: BRIEF_SWEEP_ID }, occurrenceAt: Date.now() - 60_000, dueAt: Date.now() - 60_000, recurrence: { type: 'interval', every_ms: 10 * 60_000, phase_ms: 0 } });
      await owner.alarm(); await owner.alarm();
      expect(model.calls).toBe(0);
      expect(schedule(state)[BRIEF_SWEEP_ID]?.status ?? 'none').not.toBe('armed');
      expect(state.storage.sql.exec<{ hop: string; note: string }>("SELECT hop, note FROM trace_log WHERE hop IN ('scheduled_drop', 'scheduled_hold')").toArray())
        .toEqual([{ hop: 'scheduled_drop', note: 'event_briefs_timezone_unconfirmed' }]);
    });
    expect(wire.telegramSent).toBe(0);
  });

  it('a day card is a machine turn: it is never offered raise_approval', async () => {
    await withAppOwner('proactive-no-raise', { zone: 'UTC', confirmed: true }, async (owner, state) => {
      dayPlanBook(state.storage.sql).save(localIso(Date.now(), 'UTC').slice(0, 10), { card: 'card:brief', time: '00:00', reason: 'planned' });
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      await scheduler.schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 60_000, dueAt: Date.now() - 60_000, recurrence: null });
      model.requests = [];
      await owner.alarm();
      const offered = model.requests.map(request => (JSON.parse(request) as { tools?: { name?: string }[] }).tools?.map(tool => tool.name) ?? []);
      expect(offered.some(names => names.length > 0)).toBe(true);
      expect(offered.flat()).not.toContain('raise_approval');
    });
  });

  it('with a confirmed zone, a due day card reaches the app chat and nothing goes to Telegram', async () => {
    await withAppOwner('proactive-confirmed-fire', { zone: 'UTC', confirmed: true }, async (owner, state) => {
      // Today's plan already exists, as it does once nightly or the first arming has planned the day.
      dayPlanBook(state.storage.sql).save(localIso(Date.now(), 'UTC').slice(0, 10), { card: 'card:brief', time: '00:00', reason: 'planned' });
      await new Scheduler(state.storage.sql, state.storage, productionDeps())
        .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 60_000, dueAt: Date.now() - 60_000, recurrence: null });
      await owner.alarm();
      expect(await appChat(owner, 'proactive-confirmed-fire')).toContainEqual({ role: 'assistant', text: CARD_TEXT });
    });
    expect(wire.telegramSent).toBe(0);
  });

  // Every stored copy in the owner DO: KV values and the rows of every table it can read.
  const storedText = (state: DurableObjectState) => {
    const kv = [...state.storage.kv.list()].map(([key, value]) => `${key} ${JSON.stringify(value)}`);
    const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(row => row.name);
    return [...kv, ...tables.flatMap(table => state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray().map(row => JSON.stringify(row)))].join('\n');
  };

  it('a day card is written with the owner\'s health logs, but no stored copy of its prompt carries their numbers', async () => {
    const name = 'proactive-health-strip';
    const at = new Date(Date.now() - 3_600_000).toISOString();
    wire.healthLogs = [
      { id: 1, kind: 'meal', logged_at: at, payload: { description: 'oat bowl', calories_estimate: 640 } },
      { id: 2, kind: 'workout', logged_at: at, payload: { type: 'run', duration_minutes: 37 } },
    ];
    await withAppOwner(name, { zone: 'UTC', confirmed: true }, async (owner, state) => {
      dayPlanBook(state.storage.sql).save(localIso(Date.now(), 'UTC').slice(0, 10), { card: 'card:brief', time: '00:00', reason: 'planned' });
      await new Scheduler(state.storage.sql, state.storage, productionDeps())
        .schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 60_000, dueAt: Date.now() - 60_000, recurrence: null });
      await owner.alarm();
      expect(await appChat(owner, name)).toContainEqual({ role: 'assistant', text: CARD_TEXT });
      const reply = model.requests.find(request => request.includes('oat bowl'));
      expect(reply).toContain('~640 kcal, estimate');
      expect(reply).toContain('run, 37 min');
      const stored = storedText(state);
      expect(stored).toContain(CARD_TEXT);
      expect(stored).not.toContain('640 kcal');
      expect(stored).not.toContain('37 min');
    });
  });
});
