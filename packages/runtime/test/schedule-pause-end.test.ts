import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// The scheduler pauses a job for a day after three failed runs in a row, then wakes at the pause's end. Every pass runs on
// workerd's alarm scheduler with a far-future clock, so nothing fires on its own: the test moves the clock to the wake the
// runtime armed and runs that alarm. Model calls are refused, which fails every reminder run; Telegram sends are recorded.
const sent = vi.hoisted(() => [] as string[]);
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string, payload: { chat_id: number; text: string }) => {
    if (method === 'sendMessage') sent.push(payload.text);
    return { message_id: 1, chat: { id: payload.chat_id } };
  } }));
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('model unavailable'); } }; } }));

afterEach(() => { vi.useRealTimers(); });

it('a paused job runs again when its pause ends, and the alarm then waits for its retry', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2030-11-01T14:00:00Z') });
  const name = 'pause-end-wake', id = 'reminder:pause-end';
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const inObject = <T>(work: (state: DurableObjectState) => T | Promise<T>) => runInDurableObject(stub, async (_instance, state) => work(state));
  const row = () => inObject(state => state.storage.sql
    .exec<{ status: string; attempts: number; until: number | null }>('SELECT status, attempts, quarantined_until AS until FROM schedule WHERE id = ?', id).one());
  // Moves the clock to the wake the runtime armed and runs that alarm.
  const pass = async () => {
    const due = await inObject(state => state.storage.getAlarm());
    expect(due, 'an armed wake').not.toBeNull();
    if (due! > Date.now()) vi.setSystemTime(due!);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  };
  // A Telegram owner with the built-in jobs off through their own preferences, so the reminder is the only scheduled work.
  await inObject(async state => {
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '9301'); state.storage.kv.put('timezone', 'America/New_York');
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS schedule_preferences (kind TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
    for (const kind of ['daily_brief', 'event_briefs', 'nightly', 'heartbeat']) state.storage.sql.exec('INSERT INTO schedule_preferences (kind, enabled) VALUES (?, 0)', kind);
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS reminder_notes (id TEXT PRIMARY KEY, note TEXT NOT NULL, created_at INTEGER NOT NULL)');
    state.storage.sql.exec('INSERT INTO reminder_notes (id, note, created_at) VALUES (?, ?, ?)', id, 'call Sam', Date.now());
    await new Scheduler(state.storage.sql, state.storage, productionDeps())
      .schedule({ id, kind: 'reminder', payloadRefs: { reminder_id: id }, occurrenceAt: Date.now(), dueAt: Date.now(), recurrence: null });
  });
  for (let attempt = 1; attempt <= 3; attempt++) await pass();
  const paused = await row();
  expect(paused.status).toBe('quarantined');
  // The next pass sends the owner the pause's notice, and the wake after it is the pause's end.
  expect(sent).toEqual([]);
  await pass();
  expect(sent).toHaveLength(1);
  expect(await inObject(state => state.storage.getAlarm())).toBe(paused.until);
  await pass();
  expect(Date.now()).toBe(paused.until);
  // That pass re-armed the job and ran it; its failed run waits 30 s for the retry, with no wake before it.
  expect(await row()).toMatchObject({ status: 'armed', attempts: 1 });
  expect(await inObject(state => state.storage.getAlarm())).toBe(paused.until! + 30_000);
  await inObject(state => state.storage.deleteAlarm());
}, 30_000);
