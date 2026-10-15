import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { loopBook } from '../src/channels/loops';
import { TelegramFinalOutbox } from '../src/channels/telegram-final-outbox';
import { dueFailureNotices, markFailureNoticed } from '../src/scheduler/failure-notice';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// A job whose own runs fail three times in a row is paused for a day, and the owner hears so once. Every pass runs on
// workerd's alarm scheduler with a far-future clock, so nothing fires on its own: the test moves the clock to the wake the
// runtime armed and runs that alarm. Model calls are refused, which fails every reminder run; Telegram sends are recorded.
const sent = vi.hoisted(() => [] as { chat_id: number; text: string }[]);
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string, payload: { chat_id: number; text: string }) => {
    if (method === 'sendMessage') sent.push(payload);
    return { message_id: sent.length, chat: { id: payload.chat_id } };
  } }));
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('model unavailable'); } }; } }));

const NOTE = 'call Sam about the contract renewal';
const ZONE = 'America/New_York';
const DAY_MS = 24 * 60 * 60_000;
type World = Readonly<{ stub: DurableObjectStub; subject: string; inObject<T>(work: (state: DurableObjectState) => T | Promise<T>): Promise<T> }>;
type Queued = { id: string; status: string; expiresAt?: number; payload: { text: string } };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// A Telegram owner in New York with the built-in jobs off through their own preferences, so only the test's reminders run.
const world = async (name: string, subject: string, now: number): Promise<World> => {
  vi.useFakeTimers({ toFake: ['Date'], now });
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const inObject = <T>(work: (state: DurableObjectState) => T | Promise<T>) => runInDurableObject(stub, async (_instance, state) => work(state));
  await inObject(state => {
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', subject); state.storage.kv.put('timezone', ZONE);
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS schedule_preferences (kind TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
    for (const kind of ['daily_brief', 'event_briefs', 'nightly', 'heartbeat']) state.storage.sql.exec('INSERT OR REPLACE INTO schedule_preferences (kind, enabled) VALUES (?, 0)', kind);
  });
  return { stub, subject, inObject };
};
const quietHours = (w: World, start: string, end: string) => w.inObject(state => {
  loopBook(state.storage.sql, { newId: () => crypto.randomUUID(), now: Date.now }).setProactivity({ quiet_start: start, quiet_end: end, volume: 'normal' });
});
// Sets a reminder due at `due`, or re-arms it, as an owner's edit does.
const remind = (w: World, id: string, due: number) => w.inObject(async state => {
  state.storage.sql.exec('CREATE TABLE IF NOT EXISTS reminder_notes (id TEXT PRIMARY KEY, note TEXT NOT NULL, created_at INTEGER NOT NULL)');
  state.storage.sql.exec('INSERT OR REPLACE INTO reminder_notes (id, note, created_at) VALUES (?, ?, ?)', id, NOTE, due);
  await new Scheduler(state.storage.sql, state.storage, productionDeps())
    .schedule({ id, kind: 'reminder', payloadRefs: { reminder_id: id }, occurrenceAt: due, dueAt: due, recurrence: null });
});
const armed = (w: World) => w.inObject(state => state.storage.getAlarm());
// Moves the clock to the wake the runtime armed (never backwards) and runs that alarm.
const pass = async (w: World): Promise<number> => {
  const due = await armed(w);
  expect(due, 'an armed wake').not.toBeNull();
  if (due! > Date.now()) vi.setSystemTime(due!);
  expect(await runDurableObjectAlarm(w.stub)).toBe(true);
  return due!;
};
// Runs the armed alarm late, at `at`: each pass it stands for in between would have found the same state.
const passAt = async (w: World, at: number) => {
  expect(await armed(w)).toBeLessThanOrEqual(at);
  vi.setSystemTime(at);
  expect(await runDurableObjectAlarm(w.stub)).toBe(true);
};
const job = (w: World, id: string) => w.inObject(state => state.storage.sql
  .exec<{ status: string; attempts: number; until: number | null }>('SELECT status, attempts, quarantined_until AS until FROM schedule WHERE id = ?', id).toArray()[0]);
// Three passes, each the reminder's next attempt; the scheduler pauses it for a day from the third.
const failThrice = async (w: World, id: string): Promise<number> => {
  let third = 0;
  for (let attempt = 1; attempt <= 3; attempt++) third = await pass(w);
  const row = await job(w, id);
  expect(row?.status).toBe('quarantined');
  expect(row?.until).toBe(third + DAY_MS);
  return row!.until!;
};
const sentTo = (w: World) => sent.filter(message => message.chat_id === Number(w.subject)).map(message => message.text);
const queued = (w: World) => w.inObject(state => (state.storage.kv.get<Queued[]>('telegram_final_outbox_v1') ?? []).filter(record => record.id.startsWith('schedule-failed:')));
const line = (when: string) => `One of your reminders failed 3 times in a row, so I've paused it. I'll try again around ${when}.`;

it('a reminder whose runs fail three times in a row says so once, with no content, naming when it tries again', async () => {
  const w = await world('notice-once', '9101', Date.parse('2030-11-01T14:00:00Z')); // Fri 10:00 in New York
  await remind(w, 'reminder:once', Date.now());
  const until = await failThrice(w, 'reminder:once');
  expect(sentTo(w)).toEqual([]);
  // A notice still undelivered when the pause ends lapses with it.
  expect((await queued(w)).map(record => record.expiresAt)).toEqual([until]);
  // The pass that paused the job queued the notice and armed its delivery; the runtime's own next wake sends it.
  expect(await armed(w)).toBeLessThanOrEqual(Date.now() + 1_000);
  await pass(w);
  expect(sentTo(w)).toEqual([line('Sat 2 Nov, 10:01')]);
  expect(sentTo(w).join()).not.toContain('Sam');
  // A later scheduled pass, here another reminder's first failure, doesn't repeat it.
  await remind(w, 'reminder:other', Date.now() + 60_000);
  await pass(w);
  expect((await job(w, 'reminder:other'))?.attempts).toBe(1);
  expect(await queued(w)).toHaveLength(1);
  expect(sentTo(w)).toEqual([line('Sat 2 Nov, 10:01')]);
}, 30_000);

it('quiet hours hold the notice, and the line they let through names the real retry time', async () => {
  const w = await world('notice-quiet', '9102', Date.parse('2030-11-02T03:00:00Z')); // Fri 23:00 in New York
  await quietHours(w, '22:00', '07:00');
  await remind(w, 'reminder:quiet', Date.now());
  await failThrice(w, 'reminder:quiet');
  await pass(w);
  await pass(w);
  expect(sentTo(w)).toEqual([]);
  expect((await queued(w)).map(record => record.status)).toEqual(['pending']);
  await passAt(w, Date.parse('2030-11-02T11:00:30Z')); // Sat 07:00 in New York
  // Delivered eight hours after the pause began, the line names the pause's end, not "this time tomorrow".
  expect(sentTo(w)).toEqual([line('Sat 2 Nov, 23:01')]);
}, 30_000);

it('a pause across the end of daylight time names the local hour it ends at', async () => {
  const w = await world('notice-dst', '9103', Date.parse('2030-11-02T14:00:00Z')); // Sat 10:00 EDT
  await remind(w, 'reminder:dst', Date.now());
  await failThrice(w, 'reminder:dst');
  await pass(w);
  // 24 hours later the clocks have gone back an hour: 09:01 EST.
  expect(sentTo(w)).toEqual([line('Sun 3 Nov, 09:01')]);
}, 30_000);

it('a time-zone change does not repeat a notice, even across a midnight of the new zone', async () => {
  const w = await world('notice-zone', '9104', Date.parse('2030-11-01T14:00:00Z')); // Fri 10:00 in New York, Fri 23:00 in Tokyo
  await remind(w, 'reminder:zone', Date.now());
  await failThrice(w, 'reminder:zone');
  await pass(w);
  expect(sentTo(w)).toEqual([line('Sat 2 Nov, 10:01')]);
  // The owner moves to Tokyo, and the next scheduled pass falls after midnight there: a new local day.
  await w.inObject(state => state.storage.kv.put('timezone', 'Asia/Tokyo'));
  await remind(w, 'reminder:after-move', Date.parse('2030-11-01T15:10:00Z'));
  await pass(w);
  expect((await job(w, 'reminder:after-move'))?.attempts).toBe(1);
  expect(await queued(w)).toHaveLength(1);
  expect(sentTo(w)).toEqual([line('Sat 2 Nov, 10:01')]);
}, 30_000);

it('a job paused again the same day stays silent, and paused again on a later day says so', async () => {
  const w = await world('notice-day-cap', '9105', Date.parse('2030-11-01T14:00:00Z')); // Fri 10:00 in New York
  await remind(w, 'reminder:cap', Date.now());
  await failThrice(w, 'reminder:cap');
  await pass(w);
  expect(sentTo(w)).toEqual([line('Sat 2 Nov, 10:01')]);
  // The owner moves it to noon, which lifts the pause, and it fails three more times that day.
  vi.setSystemTime(Date.parse('2030-11-01T16:00:00Z'));
  await remind(w, 'reminder:cap', Date.now());
  await failThrice(w, 'reminder:cap');
  expect(await queued(w)).toHaveLength(1);
  expect(await armed(w)).toBeGreaterThan(Date.now() + 60 * 60_000);
  // Saturday morning the owner moves it again; three more failures make Saturday's one notice.
  vi.setSystemTime(Date.parse('2030-11-02T13:05:00Z')); // Sat 09:05 EDT
  await remind(w, 'reminder:cap', Date.now());
  await failThrice(w, 'reminder:cap');
  await pass(w);
  expect(sentTo(w)).toEqual([line('Sat 2 Nov, 10:01'), line('Sun 3 Nov, 08:06')]);
}, 30_000);

it('two reminders that pause in the same pass each say so', async () => {
  const w = await world('notice-two', '9106', Date.parse('2030-11-01T14:00:00Z'));
  await remind(w, 'reminder:first', Date.now());
  await remind(w, 'reminder:second', Date.now());
  await failThrice(w, 'reminder:first');
  expect((await job(w, 'reminder:second'))?.status).toBe('quarantined');
  await pass(w);
  await pass(w);
  expect(sentTo(w)).toEqual([line('Sat 2 Nov, 10:01'), line('Sat 2 Nov, 10:01')]);
}, 30_000);

it('a notice that cannot be queued never holds the jobs beside it, and the next scheduled pass queues it', async () => {
  const w = await world('notice-contained', '9107', Date.parse('2030-11-01T14:00:00Z'));
  const enqueue = TelegramFinalOutbox.prototype.enqueue;
  const refuse = vi.spyOn(TelegramFinalOutbox.prototype, 'enqueue').mockImplementation(async function (this: TelegramFinalOutbox, input) {
    if (input.id.startsWith('schedule-failed:')) throw new Error('final outbox capacity');
    return enqueue.call(this, input);
  });
  await remind(w, 'reminder:contained', Date.now());
  await failThrice(w, 'reminder:contained');
  expect(await w.inObject(state => [state.storage.kv.get('owner_alarm_failed_lane_v1'), state.storage.kv.get('owner_alarm_failures_v1')])).toEqual([undefined, undefined]);
  expect(await queued(w)).toEqual([]);
  refuse.mockRestore();
  await remind(w, 'reminder:next', Date.now() + 60_000);
  await pass(w);
  await pass(w);
  expect(sentTo(w)).toEqual([line('Sat 2 Nov, 10:01')]);
}, 30_000);

it('a notice queued by a pass that died before marking it is marked, never queued again under a new zone', async () => {
  const w = await world('notice-requeue', '9108', Date.parse('2030-11-01T14:00:00Z'));
  const enqueue = TelegramFinalOutbox.prototype.enqueue;
  // The first notice is queued, then its pass dies before the mark.
  let died = false;
  vi.spyOn(TelegramFinalOutbox.prototype, 'enqueue').mockImplementation(async function (this: TelegramFinalOutbox, input) {
    await enqueue.call(this, input);
    if (input.id.startsWith('schedule-failed:') && !died) { died = true; throw new Error('pass died'); }
  });
  await remind(w, 'reminder:requeue', Date.now());
  await failThrice(w, 'reminder:requeue');
  expect(died).toBe(true);
  // The owner moves to Tokyo, so the same notice would now read differently; the next scheduled pass marks the queued one.
  await w.inObject(state => state.storage.kv.put('timezone', 'Asia/Tokyo'));
  await remind(w, 'reminder:next', Date.now() + 60_000);
  await pass(w);
  await pass(w);
  expect((await queued(w)).map(record => record.payload.text)).toEqual([line('Sat 2 Nov, 10:01')]);
  expect(sentTo(w)).toEqual([line('Sat 2 Nov, 10:01')]);
  const failures = await w.inObject(state => state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM trace_log WHERE hop = 'schedule_notice' AND ok = 0").one().n);
  expect(failures).toBe(1);
}, 30_000);

it('a held notice is dropped once its pause is lifted, so it never reports a pause that has gone', async () => {
  const w = await world('notice-lifted', '9109', Date.parse('2030-11-02T03:00:00Z')); // Fri 23:00 in New York
  await quietHours(w, '22:00', '07:00');
  await remind(w, 'reminder:lifted', Date.now());
  await failThrice(w, 'reminder:lifted');
  await pass(w);
  // The owner deletes the reminder during the night.
  await w.inObject(state => new Scheduler(state.storage.sql, state.storage, productionDeps()).cancel('reminder:lifted'));
  await passAt(w, Date.parse('2030-11-02T11:00:30Z'));
  expect(sentTo(w)).toEqual([]);
  expect((await queued(w)).map(record => record.status)).toEqual(['blocked']);
}, 30_000);

it('names only a job\'s own failed runs, each pause once, and keeps a pause the daily cap silenced silent', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('notice-unit')), async (_instance, state) => {
    ensureSchema(state.storage);
    const { sql, kv } = state.storage;
    const friday = Date.parse('2030-11-01T14:00:00Z'), saturday = friday + DAY_MS;
    const pause = (id: string, kind: string, until: number, outcome: string, errorClass: string) => {
      sql.exec(`INSERT OR REPLACE INTO schedule (id, kind, occurrence_at, due_at, recurrence_json, payload_json, status, attempts, last_fired_at, quarantined_until, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, '{}', 'quarantined', 3, ?, ?, ?, ?)`, id, kind, until - DAY_MS, until - DAY_MS, until - DAY_MS, until, until - DAY_MS, until - DAY_MS);
      sql.exec('INSERT INTO schedule_runs (id, schedule_id, kind, fired_at, attempt, outcome, error_class, settled_at, duration_ms) VALUES (?, ?, ?, ?, 3, ?, ?, ?, 0)',
        `${id}:${until}:3`, id, kind, until - DAY_MS, outcome, errorClass, until - DAY_MS);
    };
    pause('reminder:own', 'reminder', saturday, 'quarantined', 'run');
    pause('reminder:handoff', 'reminder', saturday, 'failed', 'scheduler_handoff');
    pause('reminder:delivery', 'reminder', saturday, 'quarantined', 'delivery');
    pause('patrol:1', 'patrol', saturday, 'quarantined', 'run');
    pause('card:midday', 'brief', saturday, 'quarantined', 'run');
    pause('reminder:ended', 'reminder', friday - 1, 'quarantined', 'run');
    const due = dueFailureNotices(sql, kv, friday, ZONE);
    expect(due.map(notice => [notice.scheduleId, notice.text])).toEqual([
      ['card:midday', 'Your Check-in failed 3 times in a row, so I\'ve paused it. I\'ll try again around Sat 2 Nov, 10:00.'],
      ['reminder:own', line('Sat 2 Nov, 10:00')],
    ]);
    for (const notice of due) markFailureNoticed(kv, notice, friday);
    expect(dueFailureNotices(sql, kv, friday + 60_000, ZONE)).toEqual([]);
    // Re-armed and paused again the same day: handled, and silent.
    pause('reminder:own', 'reminder', saturday + 2 * 60 * 60_000, 'quarantined', 'run');
    const capped = dueFailureNotices(sql, kv, friday + 2 * 60 * 60_000, ZONE);
    expect(capped.map(notice => [notice.scheduleId, notice.text])).toEqual([['reminder:own', null]]);
    markFailureNoticed(kv, capped[0]!, friday + 2 * 60 * 60_000);
    // Still paused the next morning, it stays silent; a new pause that day is that day's notice.
    expect(dueFailureNotices(sql, kv, saturday - 60 * 60_000, ZONE)).toEqual([]);
    pause('reminder:own', 'reminder', saturday + 3 * 60 * 60_000 + DAY_MS, 'quarantined', 'run');
    expect(dueFailureNotices(sql, kv, saturday + 3 * 60 * 60_000, ZONE).map(notice => notice.text)).toEqual([line('Sun 3 Nov, 12:00')]);
  });
});
