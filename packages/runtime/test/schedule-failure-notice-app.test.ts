import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { loopBook } from '../src/channels/loops';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// An app owner gets proactive work on the app, with a plain copy on Telegram when that is bound too. A paused job's notice
// takes that route: held through quiet hours, then written to the owner's Main chat. This pool backs the deploy with a
// directory, answered here. Passes run on workerd's alarm scheduler with a far-future clock, so nothing fires on its own.
const sent = vi.hoisted(() => [] as { chat_id: number; text: string }[]);
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string, payload: { chat_id: number; text: string }) => {
    if (method === 'sendMessage') sent.push(payload);
    return { message_id: sent.length, chat: { id: payload.chat_id } };
  } }));
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('model unavailable'); } }; } }));

const OWNER_ID = '5c4d3e2f-1a0b-4c9d-8e7f-6a5b4c3d2e1f';
const PRINCIPAL = `prn_${OWNER_ID.replaceAll('-', '')}`;
const LINE = 'One of your reminders failed 3 times in a row, so I\'ve paused it. I\'ll try again around Sat 2 Nov, 23:01.';

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each([
  { binding: 'the app and Telegram', name: 'notice-app-dual', telegram: '9201' },
  { binding: 'the app only', name: 'notice-app-only', telegram: null },
])('an owner on $binding: the notice waits out quiet hours on the app route, then lands in Main chat', async ({ name, telegram }) => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2030-11-02T03:00:00Z') }); // Fri 23:00 in New York
  const id = 'reminder:app';
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const inObject = <T>(work: (state: DurableObjectState) => T | Promise<T>) => runInDurableObject(stub, async (_instance, state) => work(state));
  const pass = async (at?: number) => {
    const due = await inObject(state => state.storage.getAlarm());
    expect(due, 'an armed wake').not.toBeNull();
    const now = at ?? Math.max(due!, Date.now());
    expect(due!).toBeLessThanOrEqual(now);
    vi.setSystemTime(now);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  };
  // The owner's admitted history: Main chat is the principal's app chain.
  const mainChat = () => inObject(state => [...state.storage.kv.list<{ chatId: string; role: string; appPayload: string }>({ prefix: `canonical-owner-v1:${PRINCIPAL}:` })]
    .filter(([key]) => key.includes(':conv:')).map(([, row]) => row).filter(row => row.appPayload === LINE));
  await inObject(async state => {
    ensureSchema(state.storage);
    const kv = state.storage.kv;
    kv.put('do_name', name); kv.put('app_subject', String(appSubjectFor(name)));
    if (telegram) kv.put('telegram_subject', telegram);
    kv.put('timezone', 'America/New_York'); kv.put('timezone_confirmed', true);
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS schedule_preferences (kind TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
    for (const kind of ['daily_brief', 'event_briefs', 'nightly', 'heartbeat']) state.storage.sql.exec('INSERT OR REPLACE INTO schedule_preferences (kind, enabled) VALUES (?, 0)', kind);
    loopBook(state.storage.sql, { newId: () => crypto.randomUUID(), now: Date.now }).setProactivity({ quiet_start: '22:00', quiet_end: '07:00', volume: 'normal' });
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS reminder_notes (id TEXT PRIMARY KEY, note TEXT NOT NULL, created_at INTEGER NOT NULL)');
    state.storage.sql.exec('INSERT INTO reminder_notes (id, note, created_at) VALUES (?, ?, ?)', id, 'call Sam', Date.now());
    await new Scheduler(state.storage.sql, state.storage, productionDeps())
      .schedule({ id, kind: 'reminder', payloadRefs: { reminder_id: id }, occurrenceAt: Date.now(), dueAt: Date.now(), recurrence: null });
  });
  for (let attempt = 1; attempt <= 3; attempt++) await pass();
  expect(await inObject(state => state.storage.sql.exec<{ status: string }>('SELECT status FROM schedule WHERE id = ?', id).one().status)).toBe('quarantined');
  // The notice's first delivery pass falls in quiet hours, on the route the app takes: held.
  await pass();
  expect(await mainChat()).toEqual([]);
  expect(sent).toEqual([]);
  await pass(Date.parse('2030-11-02T11:00:30Z')); // Sat 07:00 in New York
  expect(await mainChat()).toEqual([expect.objectContaining({ chatId: `owner:${PRINCIPAL}`, role: 'assistant' })]);
  // Telegram, when bound, gets its plain copy.
  expect(sent.map(message => [message.chat_id, message.text])).toEqual(telegram ? [[Number(telegram), LINE]] : []);
  await inObject(state => state.storage.deleteAlarm());
}, 30_000);
