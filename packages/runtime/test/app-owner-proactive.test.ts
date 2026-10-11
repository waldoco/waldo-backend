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
const model = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    model.calls += 1;
    return { ok: true as const, data: { model: request.request.model, text: CARD_TEXT, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

const OWNER_ID = '4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
// A fallback zone that differs from the directory's 'UTC' default, so saving the fallback is observable.
const FALLBACK = 'Asia/Tokyo';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { saved: [] as string[], telegramSent: 0, other: [] as string[] };

beforeEach(() => {
  model.calls = 0; wire.saved = []; wire.telegramSent = 0; wire.other = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'set_owner_settings') { wire.saved.push(asked.p_timezone!); return Response.json(true); }
    if (fn === 'health_context_read' || fn === 'assert_channel_presence') return Response.json(fn === 'assert_channel_presence' ? true : null);
    if (url.startsWith('https://api.telegram.org/')) { wire.telegramSent += 1; return Response.json({ ok: true, result: { message_id: 1, chat: { id: 7 } } }); }
    wire.other.push(url);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Runtime = Readonly<{ ready: Promise<unknown>; timezone: string; act(action: { action: string; id?: string; value?: string }): Promise<boolean | string> }>;
type Owner = Readonly<{ setup(channel: string): Runtime; fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
type Stored = Readonly<{ zone?: string; confirmed?: boolean; pins?: Record<string, string> }>;

const withAppOwner = async <T>(name: string, stored: Stored, run: (owner: Owner, state: DurableObjectState) => Promise<T>): Promise<T> => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  return runInDurableObject(stub, async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    if (stored.zone) state.storage.kv.put('timezone', stored.zone);
    if (stored.confirmed) state.storage.kv.put('timezone_confirmed', true);
    for (const [card, time] of Object.entries(stored.pins ?? {})) dayPlanBook(state.storage.sql).pin(card as never, time);
    const owner = new TelegramOwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: FALLBACK, WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
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

  it('arms nightly, heartbeat and today\'s day cards in a confirmed zone on first app use, and never the event-brief sweep', async () => {
    await withAppOwner('proactive-confirmed-boot', { zone: 'Europe/London', confirmed: true }, async (owner, state) => {
      await owner.setup('app').ready;
      const rows = schedule(state);
      expect(JSON.parse(rows[NIGHTLY_ID]!.recurrence!)).toMatchObject({ type: 'daily_local', timezone: 'Europe/London' });
      expect(rows[HEARTBEAT_ID]?.status).toBe('armed');
      expect(rows[BRIEF_SWEEP_ID]).toBeUndefined();
      for (const [card, at] of Object.entries(cardsAhead('Europe/London'))) expect(rows[card]?.due_at).toBe(at);
    });
    expect(model.calls).toBe(0);
  });

  it('the owner\'s first time-zone choice confirms it and arms the jobs in that zone, and the runtime uses the new zone', async () => {
    await withAppOwner('proactive-first-choice', {}, async (owner, state) => {
      await owner.setup('app').ready;
      expect(await owner.setup('app').act({ action: 'timezone.set', value: 'Asia/Kolkata' })).toBe(true);
      expect(wire.saved).toEqual(['Asia/Kolkata']);
      expect(state.storage.kv.get('timezone_confirmed')).toBe(true);
      const rows = schedule(state);
      expect(JSON.parse(rows[NIGHTLY_ID]!.recurrence!)).toMatchObject({ timezone: 'Asia/Kolkata' });
      expect(rows[HEARTBEAT_ID]?.status).toBe('armed');
      expect(rows[BRIEF_SWEEP_ID]).toBeUndefined();
      for (const [card, at] of Object.entries(cardsAhead('Asia/Kolkata'))) expect(rows[card]?.due_at).toBe(at);
      expect(owner.setup('app').timezone).toBe('Asia/Kolkata');
    });
  });

  it('a later zone change moves today\'s unsent day cards to the new zone and keeps the owner\'s pins and today\'s planned times', async () => {
    const pins = { 'card:close': '23:45' }, planned = { 'card:midday': '23:30' };
    await withAppOwner('proactive-zone-change', { zone: 'Europe/London', confirmed: true, pins }, async (owner, state) => {
      await owner.setup('app').ready;
      // A time already planned for the new zone's today, as nightly planning or the owner sets it.
      dayPlanBook(state.storage.sql).save(localIso(Date.now(), 'America/New_York').slice(0, 10), { card: 'card:midday', time: planned['card:midday'], reason: 'planned' });
      expect(await owner.setup('app').act({ action: 'timezone.set', value: 'America/New_York' })).toBe(true);
      const rows = schedule(state), ahead = cardsAhead('America/New_York', { ...pins, ...planned });
      for (const [card, at] of Object.entries(ahead)) expect(rows[card]?.due_at).toBe(at);
      for (const card of DAY_CARDS.map(c => c.id).filter(id => !(id in ahead))) expect(rows[card]).toBeUndefined();
      expect(owner.setup('app').timezone).toBe('America/New_York');
    });
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

  it('while no zone is confirmed, a due heartbeat or day card delivers nothing and the heartbeat stays scheduled', async () => {
    await withAppOwner('proactive-held-fire', {}, async (owner, state) => {
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      await armHeartbeat(scheduler, Date.now() - 60 * 60_000);
      await scheduler.schedule({ id: 'card:brief', kind: 'brief', payloadRefs: { id: 'card:brief' }, occurrenceAt: Date.now() - 60_000, dueAt: Date.now() - 60_000, recurrence: null });
      await owner.alarm(); await owner.alarm();
      expect(model.calls).toBe(0);
      expect(await appChat(owner, 'proactive-held-fire')).toEqual([]);
      expect(schedule(state)[HEARTBEAT_ID]?.status).toBe('armed');
    });
    expect(wire.telegramSent).toBe(0);
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
});
