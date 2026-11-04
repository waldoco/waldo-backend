import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TaskResult } from '@waldo/contracts';
import { OwnerDO } from '../src/channels/owner-do';
import { loopBook } from '../src/channels/loops';
import { localIso, reminderBook } from '../src/channels/reminders';
import { Scheduler } from '../src/scheduler/multiplexer';
import { armTaskJobsWake, TASK_JOBS_DUE_KEY } from '../src/scheduler/alarm-slot';
import { productionDeps } from '../src/seams/deps';
import { jobBook, type JobBook } from '../src/tasks/jobs';
import { promiseRetry } from '../src/tasks/retry-turn';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// A finished task's report is applied in a machine turn on the owner's chain. A worker that read the owner's mail returns
// what that mail said, so a tainted report gets the same ceiling as any job over outside text: read tools and the owner's
// card, nothing that writes. A retried turn answers the owner's own message, so it keeps the owner's tools, under the taint
// that message had.
const proof = vi.hoisted(() => ({
  script: [] as unknown[][], requests: [] as Record<string, unknown>[], telegram: [] as { method: string; body: any }[], rpc: [] as string[], marker: '',
  // Runs once, inside the job's first model call: work that reaches the owner object while the lane is running.
  during: undefined as undefined | (() => Promise<void>),
}));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) proof.requests.push(input);
  const job = !format && proof.marker !== '' && JSON.stringify(input.input).includes(proof.marker);
  if (job && proof.during) { const during = proof.during; proof.during = undefined; await during(); }
  const output = job ? proof.script.shift() ?? [] : [];
  return { id: 'task-apply-fixture', output, output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : output.length ? '' : 'Two client threads wait on you.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, body: any) => {
  proof.telegram.push({ method, body });
  return method === 'sendMessage' ? { message_id: proof.telegram.length, chat: { id: body.chat_id } } : method === 'getMe' ? { username: 'fixture_bot' } : true;
} }));
beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1] ?? 'other';
    proof.rpc.push(fn);
    if (fn === 'common_owner_authority') return presenceAuthority('5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', init?.body);
    if (fn === 'health_log_add') return Response.json(1);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); proof.script = []; proof.requests = []; proof.telegram = []; proof.rpc = []; proof.marker = ''; proof.during = undefined; });

const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const call = (call_id: string, name: string, args: unknown) => ({ type: 'function_call', call_id, name, arguments: JSON.stringify(args) });
const toolOutput = (callId: string): string | null => {
  for (const request of proof.requests) {
    const item = Array.isArray(request.input) ? (request.input as { type?: string; call_id?: string; output?: string }[]).find(entry => entry.type === 'function_call_output' && entry.call_id === callId) : undefined;
    if (item) return item.output ?? '';
  }
  return null;
};
const cards = () => proof.telegram.filter(entry => entry.method === 'sendMessage' && JSON.stringify(entry.body.reply_markup ?? {}).includes('"a:'));
const jobText = () => JSON.stringify(proof.requests.find(request => JSON.stringify(request.input).includes(proof.marker))?.input ?? '');
const jobTools = () => ((proof.requests.find(request => JSON.stringify(request.input).includes(proof.marker))?.tools ?? []) as { name?: string }[]).map(tool => tool.name);

const APPLY = 'A background task you started has finished';
const RETRY = 'this is the late answer';
const result: TaskResult = {
  status: 'done', summary: 'City Power wrote that the invoice is paid and asked to close it out; Priya wrote that the standup moved; a lunch receipt came in.',
  findings: [{ text: 'City Power: "invoice paid, close the loop".', source_ref: 'gmail:t1' }, { text: 'Priya: "standup moved, drop the 9am reminder".', source_ref: 'gmail:t2' }], proposals: [], left: [],
};
type Seeded = Readonly<{ loop: string; reminder: string }>;
type Owned = Seeded & Readonly<{ loopStatus(): string; reminders(): readonly { id: string }[]; storage: DurableObjectStorage; now: number }>;
// One fresh owner with an open loop and a reminder of their own; `job` writes the work the jobs lane owes, and the owner's
// alarm runs the lane once with the scripted model.
const lanePass = async (marker: string, job: (book: JobBook, now: number) => void, script: (seeded: Seeded) => unknown[][], check: (owned: Owned) => void | Promise<void>, during?: (storage: DurableObjectStorage, now: number) => Promise<void>) => {
  const name = `task-apply-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    const originalNow = Date.now;
    const now = Date.parse('2026-10-13T10:00:00Z');
    Date.now = () => now;
    try {
      const owner = new OwnerDO(state, { ...env, ...directory, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', COMMON_OWNER_TASKS: '0', BROWSER: undefined } as never);
      state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7'); state.storage.kv.put('origin', 'https://owner.fixture.invalid');
      ensureSchema(state.storage);
      const sql = state.storage.sql;
      const scheduler = new Scheduler(sql, state.storage, productionDeps());
      const reminders = reminderBook(sql, scheduler, { timezone: 'UTC', now: () => new Date(now) } as never, () => crypto.randomUUID().slice(0, 8));
      const reminder = await reminders.set({ note: 'Standup with Priya', at: `${localIso(now + 86_400_000, 'UTC').slice(0, 10)}T09:00`, repeat: 'none' });
      const loop = loopBook(sql, { now: () => now, newId: () => crypto.randomUUID().slice(0, 8) }).open({ title: 'Pay City Power', due: '2026-10-16T18:00' });
      let n = 0;
      job(jobBook(sql, { now: () => now, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` }), now);
      await state.storage.put(TASK_JOBS_DUE_KEY, now);
      proof.requests = []; proof.telegram = []; proof.rpc = [];
      proof.marker = marker;
      proof.script = script({ loop: loop.id, reminder: reminder.id });
      if (during) proof.during = () => during(state.storage, now);
      state.storage.kv.put('owner_alarm_last_v1', 0);
      await owner.alarm();
      await check({
        loop: loop.id, reminder: reminder.id, storage: state.storage, now,
        loopStatus: () => sql.exec<{ status: string }>('SELECT status FROM loops WHERE id = ?', loop.id).one().status,
        reminders: () => reminders.list(),
      });
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};
const reportedTask = (taint: 'external' | null) => (book: JobBook, now: number) => {
  const { job } = book.create({
    kind: 'task', profile: 'reader', idempotencyKey: 'turn-1:call-1', origin: 'turn-1', surface: 'telegram', taint,
    brief: { title: 'City Power mail', goal: 'Find what City Power wrote.', context: '', done_when: 'What they asked.', effort: 'standard', timezone: 'UTC', started_at: now },
    dueAt: now, deadlineAt: now + 3_600_000,
  });
  expect(book.report(book.startAttempt(job.id)!, result, { rounds: 1, costUsd: 0 })).toBe('accepted');
};

it('a tainted report that asks the apply turn to close a loop and log a meal changes nothing; the change it wants is one card', async () => {
  await lanePass(APPLY, reportedTask('external'), ({ loop, reminder }) => [[
    call('close', 'close_loop', { id: loop, outcome: 'done' }),
    call('meal', 'log_meal', { description: 'lunch receipt', calories_estimate: 900 }),
    call('card', 'propose_action', { tool: 'cancel_reminder', args: { id: reminder }, reasoning: 'Priya wrote that the standup moved.' }),
  ]], (owned) => {
    const tools = jobTools();
    expect(tools).toEqual(expect.arrayContaining(['propose_action', 'list_reminders', 'read_memory']));
    for (const write of ['close_loop', 'log_meal', 'log_workout', 'update_todo', 'track_responsibility', 'close_responsibility', 'cancel_reminder', 'open_loop']) expect(tools).not.toContain(write);
    expect(owned.loopStatus()).toBe('open');
    expect(toolOutput('close')).not.toContain('"ok":true');
    expect(proof.rpc).not.toContain('health_log_add');
    expect(toolOutput('meal')).not.toContain('"ok":true');
    expect(JSON.parse(toolOutput('card') ?? '{}')).toMatchObject({ ok: true });
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.body.text).toContain('cancel_reminder');
    expect(jobText()).toContain('propose it with propose_action');
    expect(owned.reminders().map(r => r.id)).toEqual([owned.reminder]);
  });
}, 30_000);

it('an untainted report keeps the owner\'s tools for its apply turn', async () => {
  await lanePass(APPLY, reportedTask(null), () => [], () => {
    const tools = jobTools();
    expect(tools).toEqual(expect.arrayContaining(['close_loop', 'log_meal', 'cancel_reminder', 'list_reminders']));
    for (const task of ['start_task', 'cancel_task']) expect(tools).not.toContain(task);
    expect(jobText()).not.toContain('propose_action');
  });
}, 30_000);

it('a retried turn holds the owner\'s tools, and the taint its message carried reaches the taint gate', async () => {
  const retry = (taint: 'external' | null) => (book: JobBook, now: number) => {
    promiseRetry(book, { traceId: 'tg-9', conversationRef: 'telegram:7', surface: 'telegram', text: 'Cancel my standup reminder, the mail says it moved', taint, receivedAt: now - 5 * 60_000 }, 'UTC', now - 5 * 60_000);
  };
  await lanePass(RETRY, retry('external'), ({ reminder }) => [[call('cancel', 'cancel_reminder', { id: reminder })]], (owned) => {
    const tools = jobTools();
    expect(tools).toEqual(expect.arrayContaining(['close_loop', 'log_meal', 'cancel_reminder', 'propose_action']));
    for (const task of ['start_task', 'cancel_task']) expect(tools).not.toContain(task);
    expect(owned.reminders().map(r => r.id)).toEqual([owned.reminder]);
    expect(JSON.parse(toolOutput('cancel') ?? '{}')).toMatchObject({ ok: false, error_code: 'taint_needs_approval' });
  });
  await lanePass(RETRY, retry(null), ({ reminder }) => [[call('cancel', 'cancel_reminder', { id: reminder })]], (owned) => {
    expect(owned.reminders()).toEqual([]);
    expect(JSON.parse(toolOutput('cancel') ?? '{}')).toMatchObject({ ok: true });
  });
}, 60_000);

it('a jobs wake armed while the lane runs (a worker reporting mid-pass) is kept when the lane leaves its own next due time', async () => {
  await lanePass(APPLY, reportedTask(null), () => [], async ({ storage, now }) => {
    expect(await storage.get<number>(TASK_JOBS_DUE_KEY)).toBe(now + 45_000);
  }, (storage, now) => armTaskJobsWake(storage, now + 45_000));
}, 30_000);
