import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TaskResult } from '@waldo/contracts';
import type { CalendarChange, CalendarItem, MailItem } from '../src/connectors/google';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { PUSHES } from '../src/channels/expo-push';
import { loopBook } from '../src/channels/loops';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { jobBook, type JobRow } from '../src/tasks/jobs';
import { ensureSchema } from '../src/tracer/schema';

// Golden, end to end in the owner object with the day state on: a meeting the sweep saw untouched at the start of the day is
// moved after the Brief reached the app. The change carries what it was; the apply turn revises the Brief and pushes; the
// revision lands in Main chat, the push names the change and opens the Brief, and the app's day view shows the revision to a
// build at controls=9 while an older build still reads the Brief as first delivered. A push line that quotes the mail or the
// health log the turn read goes out as the fixed line, whatever the model wrote.
const OWNER_ID = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
const HASH = 'c'.repeat(64);
const EXPO_TOKEN = 'ExponentPushToken[synthetic-day-state]';
const INSTALLATION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const BRIEF = 'Your sync with Krati at 10:00 is the main thing today.';
const REVISED = 'Brief, updated: the sync with Krati moved from 10:00 to 15:00, so your morning is open.';
const PUSH = 'Your 10:00 with Krati moved to 15:00';
const SYNC: CalendarItem = { id: 'e-sync', title: 'Sync with Krati', status: 'confirmed', start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z', all_day: false, attendees: 2 };
const FOUND: TaskResult = { status: 'done', summary: 'The Krati sync moved.', findings: [{ text: 'The sync with Krati moved from 10:00 to 15:00 today.', source_ref: 'event:e-sync' }], proposals: [], left: [] };
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };

const MAIL: MailItem = { id: 'm-1', thread_id: 't-1', from: 'Asha <asha@client.example>', subject: 'Quote', snippet: 'the lab results came back and your cholesterol is fine', at: '2026-10-20T07:05:00Z' };
const MEAL = { id: 1, kind: 'meal', logged_at: '2026-10-20T06:30:00Z', payload: { description: 'oatmeal with blueberries before the long run', calories_estimate: 420 } };
const fixture = vi.hoisted(() => ({ listed: [] as CalendarItem[], changed: [] as CalendarChange[], mail: [] as MailItem[], prompts: [] as string[], requests: [] as string[], push: '' }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => [...fixture.listed],
    calendarPage: async () => ({ events: [...fixture.listed], next_page_token: null, fetched_count: fixture.listed.length, account, observed_at: new Date().toISOString() }),
    event: async () => fixture.listed[0] ?? null, changedEvents: async () => [...fixture.changed], newMail: async () => [...fixture.mail],
  }) };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const content = String(request.request.messages.at(-1)?.content ?? '');
    const text = content.includes('[Scheduled card') ? BRIEF
      : content.includes('[Update check') ? (fixture.prompts.push(content), fixture.requests.push(JSON.stringify(request.request.messages)),
        JSON.stringify({ revise: { card: 'card:brief', text: REVISED }, push: fixture.push }))
      : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const wire = { pushes: [] as { body: string; data: unknown }[], sent: [] as string[], meals: [] as unknown[] };
let clock = 0;
beforeEach(() => {
  wire.pushes = []; wire.sent = []; wire.meals = []; fixture.listed = []; fixture.changed = []; fixture.mail = []; fixture.prompts = []; fixture.requests = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: clock + 3_600_000 });
    if (fn === 'console_session_inventory') return Response.json([{ session: HASH, created_at: new Date(clock - 60_000).toISOString(), last_seen_at: new Date(clock).toISOString(), expires_at: new Date(clock + 12 * 60 * 60_000).toISOString(), rotated_to: null, signed_in_at: new Date(clock - 60_000).toISOString() }]);
    if (fn === 'app_push_targets') return Response.json([{ installation_id: INSTALLATION, device_epoch: 4, token: EXPO_TOKEN }]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_log_recent') return Response.json(wire.meals);
    if (fn === 'assert_channel_presence') return Response.json(false);
    if (url === 'https://exp.host/--/api/v2/push/send') {
      wire.sent.push(String(init?.body));
      for (const message of JSON.parse(String(init?.body)) as { body: string; data: unknown }[]) wire.pushes.push({ body: message.body, data: message.data });
      return Response.json({ data: [{ status: 'ok', id: 'ticket-1' }] });
    }
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
type Card = Readonly<{ id: string; latest?: { excerpt: string } | null; revision?: number; revised_at?: number }>;

it.each([
  { case: 'names the change', push: PUSH, body: PUSH, mail: false, meal: false, never: [] as string[] },
  { case: 'quotes a mail it read', push: 'Asha says the lab results came back fine', body: PUSHES.update.body, mail: true, meal: false, never: ['lab results', 'Asha'] },
  { case: 'quotes a health log line', push: 'After oatmeal with blueberries before the run, the sync moved', body: PUSHES.update.body, mail: false, meal: true, never: ['oatmeal', 'blueberries'] },
])('golden: a meeting moved after the Brief revises the Brief and pushes; a push line that $case', async ({ case: line, push, body, mail, meal, never }) => {
  const name = `day-state-revision-${line.replace(/\W+/g, '-')}`;
  fixture.push = push;
  if (meal) wire.meals = [MEAL];
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    clock = Date.parse('2026-10-20T07:00:00Z');
    Date.now = () => clock;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
      const owner = new OwnerDO(state, { ...env, ...directory, WALDO_DAY_STATE: '1', UPDATE_PUSH_NAMES: '1', CALENDAR_GROUNDED_PREP: '0', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture',
        OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, EXPO_ACCESS_TOKEN: 'synthetic-expo-access',
        GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' }) as unknown as Owner;
      await owner.setup('app').ready;
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const due = async (id: string, kind: 'brief' | 'pre_activity_spot') => {
        state.storage.sql.exec('DELETE FROM schedule');
        await scheduler.schedule({ id, kind, payloadRefs: { id }, occurrenceAt: clock - 1000, dueAt: clock - 1000, recurrence: null });
      };
      const alarm = async () => { state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); };
      const plans = dayPlanBook(state.storage.sql);
      const updates = () => (state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []).filter(record => record.update);
      const appDay = async (contract: string) => {
        const read = await owner.fetch(new Request('https://telegram-owner/app/v1/controls?view=day', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, 'x-waldo-app-contract': contract } }));
        return ((await read.json()) as { data: { cards: Card[] } }).data.cards.find(card => card.id === 'card:brief')!;
      };

      // The first sweep of the day sees the meeting as it is, untouched; the Brief then reaches the app.
      fixture.listed = [SYNC];
      await due(BRIEF_SWEEP_ID, 'pre_activity_spot');
      await alarm();
      plans.save('2026-10-20', { card: 'card:brief', time: '07:00', reason: 'planned' });
      clock += 60_000;
      await due('card:brief', 'brief');
      await alarm();
      await alarm();
      expect(plans.reached('2026-10-20', 'card:brief')).toBe(true);
      await vi.waitFor(() => expect(wire.pushes.map(push => (push.data as { trigger: string }).trigger)).toEqual(['brief']));

      // The meeting moves to 15:00. The next sweep records the change with what it was, and writes a reader job.
      clock += 10 * 60_000;
      const moved = { ...SYNC, start: '2026-10-20T15:00:00Z', end: '2026-10-20T15:30:00Z' };
      fixture.listed = [moved];
      fixture.changed = [{ ...moved, status: 'confirmed', created: '2026-10-01T00:00:00Z' }];
      if (mail) fixture.mail = [MAIL];
      await due(BRIEF_SWEEP_ID, 'pre_activity_spot');
      await alarm();
      const jobs = jobBook(state.storage.sql, { now: () => clock, newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID() });
      const [job] = state.storage.sql.exec<JobRow>("SELECT * FROM task_jobs WHERE origin = 'machine:update_sweep'").toArray();
      expect(job).toBeDefined();
      expect(jobs.report(jobs.startAttempt(job!.id)!, FOUND, { rounds: 1, costUsd: 0 })).toBe('accepted');

      // The brain's apply turn sees the move from 10:00, revises the Brief, and the revision reaches the app with its push.
      clock += 60_000;
      await alarm();
      clock += 1000;
      await alarm();
      expect(fixture.prompts).toHaveLength(1);
      expect(fixture.prompts[0]).toContain('(before: {"start":"2026-10-20T10:00:00Z","end":"2026-10-20T10:30:00Z"');
      expect(fixture.prompts[0]).toContain('The Brief reached them in the app');
      // The turn sees the Brief it revises: the card's own turn is on the owner's chain.
      expect(fixture.requests[0]).toContain(BRIEF);
      if (mail) expect(fixture.prompts[0]).toContain('cholesterol');
      expect(updates()).toEqual([expect.objectContaining({ status: 'delivered', revision: { day: '2026-10-20', card: 'card:brief' } })]);
      await vi.waitFor(() => expect(wire.pushes).toHaveLength(2));
      expect(wire.pushes[1]).toEqual({ body, data: { trigger: 'update', card_ref: 'card:brief' } });
      for (const text of never) expect(wire.sent[1]).not.toContain(text);
      // Main chat shows the revised card, never the turn's JSON.
      const chat = await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH } }))).text();
      expect(chat).toContain(REVISED);
      for (const envelope of ['\\"revise\\"', '{\\"push\\"', '\\"card:brief\\"']) expect(chat).not.toContain(envelope);

      const v9 = await appDay('controls=9');
      expect(v9).toMatchObject({ revision: 1, revised_at: expect.any(Number), latest: { excerpt: REVISED } });
      const v8 = await appDay('controls=8');
      expect(v8).not.toHaveProperty('revision');
      expect(v8).not.toHaveProperty('revised_at');
      expect(v8.latest?.excerpt).toBe(BRIEF);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
});

// The gate in the owner object. Without the day state a sent Close still holds every update until tomorrow, as before. With
// it the Close holds nothing, so the model judges a change after it; quiet hours on the app still write the job (a revision
// may land) while on a surface that would have to send, they hold it.
it.each([
  { state: undefined, case: 'after the Close', job: false },
  { state: '1', case: 'after the Close', job: true },
  { state: '1', case: 'in quiet hours on the app', job: true },
])('day state $state, $case: a reader job written is $job', async ({ state: dayState, case: when, job }) => {
  const name = `day-state-gate-${dayState ?? 'off'}-${when.replace(/\W+/g, '-')}`;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    clock = Date.parse('2026-10-20T22:00:00Z');
    Date.now = () => clock;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
      const owner = new OwnerDO(state, { ...env, ...directory, WALDO_DAY_STATE: dayState, CALENDAR_GROUNDED_PREP: '0', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture',
        OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined,
        GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' }) as unknown as Owner;
      await owner.setup('app').ready;
      if (when === 'after the Close') dayPlanBook(state.storage.sql).sent('2026-10-20', 'card:close');
      else loopBook(state.storage.sql, { newId: () => crypto.randomUUID(), now: () => clock }).setProactivity({ quiet_start: '21:00', quiet_end: '07:00', volume: 'normal' });
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const sweep = async () => {
        state.storage.sql.exec('DELETE FROM schedule');
        await scheduler.schedule({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot', payloadRefs: { id: BRIEF_SWEEP_ID }, occurrenceAt: clock - 1000, dueAt: clock - 1000, recurrence: null });
        state.storage.kv.put('owner_alarm_last_v1', 0);
        await owner.alarm();
      };
      const tomorrow = { ...SYNC, start: '2026-10-21T08:00:00Z', end: '2026-10-21T08:30:00Z' };
      fixture.listed = [tomorrow];
      await sweep();
      clock += 10 * 60_000;
      fixture.changed = [{ ...tomorrow, status: 'cancelled', created: '2026-10-01T00:00:00Z' }];
      await sweep();
      expect(state.storage.sql.exec("SELECT id FROM task_jobs WHERE origin = 'machine:update_sweep'").toArray().length > 0).toBe(job);
      expect(state.storage.sql.exec('SELECT changes FROM update_cards').toArray()).toHaveLength(1);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
});
