import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { TelegramOwnerInbox } from '../src/channels/telegram-owner-inbox';
import { FINAL_OUTBOX_KEY } from '../src/channels/telegram-final-outbox';
import type { TelegramWebhookEnv } from '../src/channels/telegram-webhook';
import { persistInboxWake, TASK_JOBS_DUE_KEY } from '../src/scheduler/alarm-slot';
import { jobBook, type JobRow } from '../src/tasks/jobs';
import { TASK_ALARM_SLICE_MS, taskWorkerName } from '../src/tasks/worker-do';

// The worker layer end to end in workerd: an owner turn starts a task, the owner's alarm starts a real TaskWorkerDO, the
// worker's alarm runs the attempt and reports over RPC, and the owner's next alarm tells the owner once. The model and
// Telegram are the only fakes.
const seen = vi.hoisted(() => ({ bodies: [] as string[], outputs: [] as unknown[][], sent: [] as string[], down: 0, skew: 0 }));
vi.mock('../src/channels/telegram-api', async load => ({
  ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string, params?: unknown) => {
    if (method === 'sendMessage') seen.sent.push(JSON.stringify(params));
    return method === 'getMe' ? { username: 'fixture_bot' } : method === 'sendMessage' ? { message_id: seen.sent.length } : true;
  },
}));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  seen.bodies.push(JSON.stringify(body));
  // A worker's model call that takes this long: the clock moves past the attempt's alarm slice.
  if (seen.skew > 0 && JSON.stringify(body).includes('"finish_task"')) { vi.setSystemTime(Date.now() + seen.skew); seen.skew = 0; }
  if (seen.down > 0) { seen.down -= 1; throw Object.assign(new Error('provider down'), { status: 503 }); }
  const name = (body as { text?: { format?: { name?: string } } }).text?.format?.name;
  return { id: 'fixture', output_text: name === 'reaction' ? '{"reaction":null}' : name === 'day_plan' ? '{"cards":[]}' : 'Done', output: name ? [] : seen.outputs.shift() ?? [] };
} }; } }));
beforeEach(() => { seen.bodies.length = 0; seen.outputs.length = 0; seen.sent.length = 0; seen.down = 0; seen.skew = 0; });
afterEach(() => { vi.useRealTimers(); });

const NAME = 'task-worker-e2e';
const owner = () => env.OWNER_DO!.get(env.OWNER_DO!.idFromName(NAME));
const fn = (name: string, args: unknown) => [{ type: 'function_call', call_id: `call-${name}`, name, arguments: JSON.stringify(args) }];
const BRIEF = { profile: 'reader', title: 'Inbox since Monday', goal: 'Find client mail that still needs a reply.', context: 'Clients write from company domains.', done_when: 'A list of threads with who is waiting.' };
const RESULT = { status: 'done', summary: 'Two client threads wait on you.', findings: [{ text: 'Asha asked for the quote on Tuesday.' }], proposals: [], left: [] };
// Polls up to about 5 s, so each case sets its own timeout above the config's 5 s default.
const until = async <T,>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
  for (let tries = 0; tries < 100; tries += 1) { const value = await read(); if (done(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  return read();
};
const jobs = (sql: SqlStorage) => sql.exec<JobRow>('SELECT * FROM task_jobs').toArray();

it('an owner turn starts a task; the worker runs with no authority and the result reaches the owner exactly once', async () => {
  seen.outputs.push(fn('start_task', BRIEF), []);
  await runInDurableObject(owner(), async (instance, state) => {
    await state.storage.put({ telegram_subject: '42', do_name: NAME, origin: 'https://fixture.invalid' });
    const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
    await inbox.admit({ bot: env.TELEGRAM_BOT_TOKEN!.split(':')[0]!, subject: '42', doName: NAME }, 1,
      JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, date: 1, text: 'Go through my inbox since Monday and tell me who is waiting on me' } }));
    await (instance as unknown as { drainInbox(): Promise<void> }).drainInbox();
    const [job] = jobs(state.storage.sql);
    expect(job).toMatchObject({ kind: 'task', profile: 'reader', status: 'queued', surface: 'telegram' });
    expect(JSON.parse(job!.brief_json)).toMatchObject({ goal: BRIEF.goal, timezone: expect.any(String) });
    expect(await state.storage.get<number>(TASK_JOBS_DUE_KEY)).toBeLessThanOrEqual(Date.now());
  });
  // The owner turn's tool list offered start_task, chosen by the model, not routed by any rule.
  expect(seen.bodies.some(body => body.includes('"start_task"'))).toBe(true);

  // The owner's alarm starts attempt 1 on a worker of its own; the worker's alarm, and the owner's wake after the report,
  // fire on their own in workerd. The worker's model finishes at once; the apply turn answers plain text.
  seen.outputs.push(fn('finish_task', RESULT), []);
  const before = seen.bodies.length;
  await runDurableObjectAlarm(owner());
  const settled = await until(() => runInDurableObject(owner(), (_instance, state) => jobs(state.storage.sql)[0]!), job => job.status === 'applied');
  expect(settled).toMatchObject({ status: 'applied', attempt: 1, outcome: 'done', checkpoint_json: null });
  const jobId = settled.id;
  const workerBody = seen.bodies.slice(before).find(body => body.includes(BRIEF.goal) && body.includes('finish_task'))!;
  // The worker's model sees the brief and the profile's tools, never the conversation or a send, approve or memory tool.
  expect(workerBody).toBeDefined();
  expect(workerBody).not.toContain('tell me who is waiting on me');
  for (const tool of ['send_message', 'send_email', 'remember', 'forget_memory', 'raise_approval', 'start_task', 'delegate_task']) expect(workerBody).not.toContain(`"name":"${tool}"`);

  // One record under the job's key, however many alarms run.
  await runDurableObjectAlarm(owner());
  await runInDurableObject(owner(), async (_instance, state) => {
    const outbox = state.storage.kv.get<{ id: string }[]>(FINAL_OUTBOX_KEY) ?? [];
    expect(outbox.filter(record => record.id === `task:${jobId}`)).toHaveLength(1);
    expect(jobs(state.storage.sql)[0]!.status).toBe('applied');
  });
  const workers = (env as unknown as TelegramWebhookEnv).TASK_WORKER_DO!;
  const ticket = { jobId, attempt: 1, token: 'any' };
  // The worker cleared its own storage when its attempt ended.
  await runInDurableObject(workers.get(workers.idFromName(taskWorkerName(owner().id.toString(), ticket))), async (_instance, state) => {
    expect([...(await state.storage.list()).keys()]).toEqual([]);
  });
  const applyBody = seen.bodies.find(body => body.includes('A background task you started has finished'));
  expect(applyBody).toContain('Asha asked for the quote on Tuesday.');
  // A late second report from the same attempt is a duplicate: it changes nothing.
  await runInDurableObject(owner(), async (instance, state) => {
    const rpc = instance as unknown as { taskReport(...args: unknown[]): Promise<string> };
    expect(await rpc.taskReport(ticket, { kind: 'result', result: { ...RESULT, summary: 'forged' } }, [], { rounds: 0, costUsd: 0 })).toBe('duplicate');
    // Applied rows keep no result (only the apply turn reads it), and the duplicate wrote none back.
    expect(jobs(state.storage.sql)[0]).toMatchObject({ status: 'applied', result_json: null });
  });
}, 30_000);

it('cancel_task in an owner turn ends the task and withdraws the card its errand raised', async () => {
  const name = 'task-cancel-card-e2e';
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const say = async (instance: unknown, state: DurableObjectState, update: number, text: string) => {
    const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
    await inbox.admit({ bot: env.TELEGRAM_BOT_TOKEN!.split(':')[0]!, subject: '42', doName: name }, update,
      JSON.stringify({ update_id: update, message: { message_id: update, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, date: update, text } }));
    await (instance as { drainInbox(): Promise<void> }).drainInbox();
    // The queued task is due at once; no alarm may start its worker while this test drives the owner by hand.
    await state.storage.deleteAlarm();
  };
  seen.outputs.push(fn('start_task', { ...BRIEF, profile: 'errand' }), []);
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.put({ telegram_subject: '42', do_name: name, origin: 'https://fixture.invalid' });
    await say(instance, state, 1, 'Book me a table for two tonight');
    const [job] = jobs(state.storage.sql);
    expect(job).toMatchObject({ status: 'queued' });
    // The card the errand raised while it ran, still waiting for the owner.
    const card = await approvalDesk(state.storage.sql, { owner: 42, call: async () => ({}), google: async () => null, newId: () => 'task-card-1', now: Date.now, timezone: 'UTC', log: () => {},
      currentRunRef: () => `task:${job!.id}`, browserSubmit: async () => { throw new Error('a withdrawn card never submits'); } })
      .proposeBrowserSubmit({ url: 'https://fixture.invalid', action: { selector: '#submit', description: 'Submit' }, binding: { value: 'synthetic' }, steps: [] });
    seen.outputs.push(fn('cancel_task', { job_id: job!.id }), []);
    await say(instance, state, 2, 'Actually, cancel that');
    expect(jobs(state.storage.sql)[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'owner' });
    expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', card).one().status).toBe('skipped');
  });
}, 30_000);

it('three model failures in one job open the breaker for that job\'s next attempt and for the owner\'s next turn', async () => {
  const name = 'task-breaker-e2e';
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  type Rpc = { drainInbox(): Promise<void>; taskClaim(...args: unknown[]): Promise<{ providerHealth?: unknown } | 'fenced'>; taskReport(...args: unknown[]): Promise<string> };
  const say = async (instance: unknown, state: DurableObjectState, update: number, text: string) => {
    const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
    await inbox.admit({ bot: env.TELEGRAM_BOT_TOKEN!.split(':')[0]!, subject: '42', doName: name }, update,
      JSON.stringify({ update_id: update, message: { message_id: update, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, date: update, text } }));
    await (instance as Rpc).drainInbox();
  };
  // The deferred job's next try is made due now, and the owner's alarm starts it on a worker that runs on its own alarm.
  const nextTry = async (deferrals: number) => {
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE task_jobs SET due_at = ? WHERE status = 'queued'", Date.now());
      await state.storage.put(TASK_JOBS_DUE_KEY, Date.now());
    });
    await runDurableObjectAlarm(stub);
    return until(() => runInDurableObject(stub, (_instance, state) => jobs(state.storage.sql)[0]!), job => job.status === 'queued' && job.deferrals === deferrals);
  };
  const openaiHealth = () => runInDurableObject(stub, (instance) =>
    (instance as unknown as { providerHealth: { snapshot(): { provider: string; failures: number; opened_at: number | null }[] } }).providerHealth.snapshot().find(entry => entry.provider === 'openai'));

  seen.outputs.push(fn('start_task', BRIEF), []);
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.put({ telegram_subject: '42', do_name: name, origin: 'https://fixture.invalid' });
    await say(instance, state, 1, 'Go through my inbox since Monday and tell me who is waiting on me');
  });

  // Exactly three model failures. Attempt 1 misses twice (the full request, then the reduced one) and defers; the owner's
  // breaker hears both. Attempt 2 starts from those two: its third miss opens the breaker, so it skips its reduced retry.
  seen.down = 3;
  expect(await nextTry(1)).toMatchObject({ status: 'queued', deferrals: 1 });
  expect(await openaiHealth()).toMatchObject({ failures: 2, opened_at: null });
  expect(await nextTry(2)).toMatchObject({ status: 'queued', deferrals: 2 });
  expect(seen.down).toBe(0);
  expect(await openaiHealth()).toMatchObject({ failures: 3, opened_at: expect.any(Number) });

  // The job's next attempt claims a seed that shows the provider open.
  await runInDurableObject(stub, async (instance, state) => {
    const ticket = jobBook(state.storage.sql, { now: Date.now, newId: () => 'unused', newToken: () => crypto.randomUUID() }).startAttempt(jobs(state.storage.sql)[0]!.id)!;
    const claim = await (instance as unknown as Rpc).taskClaim(ticket);
    expect(claim === 'fenced' ? null : claim.providerHealth).toEqual([{ provider: 'openai', failures: 3, opened_at: expect.any(Number) }]);
    expect(await (instance as unknown as Rpc).taskReport(ticket, { kind: 'unavailable' }, [], { rounds: 0, costUsd: 0 }, [])).toBe('deferred');
  });
  // A real worker on that seed defers without calling the model at all.
  const before = seen.bodies.length;
  expect(await nextTry(4)).toMatchObject({ status: 'queued', deferrals: 4 });
  expect(seen.bodies.length).toBe(before);

  // The owner's next turn sees the same open breaker: it reaches the floor without asking the provider.
  await runInDurableObject(stub, async (instance, state) => {
    await say(instance, state, 2, 'What should I pack for Goa?');
    expect(seen.bodies.length).toBe(before);
    const queued = (state.storage.kv.get<{ payload: { text: string } }[]>(FINAL_OUTBOX_KEY) ?? []).map(record => record.payload.text.replaceAll('&#39;', "'"));
    expect(queued.some(text => text.startsWith("I can't answer properly right now."))).toBe(true);
    await state.storage.deleteAlarm();
  });
}, 30_000);

it('R-4: when no model answers the owner, the floor reply promises a time and the retry keeps it, once', async () => {
  const name = 'retry-turn-e2e';
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  seen.down = 1_000;
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.put({ telegram_subject: '42', do_name: name, origin: 'https://fixture.invalid' });
    const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
    await inbox.admit({ bot: env.TELEGRAM_BOT_TOKEN!.split(':')[0]!, subject: '42', doName: name }, 1,
      JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, date: 1, text: 'What should I pack for Goa?' } }));
    await (instance as unknown as { drainInbox(): Promise<void> }).drainInbox();
    seen.down = 0;
    const [job] = jobs(state.storage.sql);
    expect(job).toMatchObject({ kind: 'retry_turn', status: 'queued', surface: 'telegram' });
    expect(JSON.parse(job!.brief_json)).toMatchObject({ text: 'What should I pack for Goa?' });
    expect(job!.due_at).toBeGreaterThan(Date.now());
    // The floor reply the owner gets names the promised time; the job holding that promise was written first.
    const queued = (state.storage.kv.get<{ id: string; payload: { text: string } }[]>(FINAL_OUTBOX_KEY) ?? []).map(record => record.payload.text.replaceAll('&#39;', "'"));
    expect(queued.some(text => /^I can't answer properly right now\. I'll come back to you by \d\d:\d\d\.$/.test(text))).toBe(true);
    // The first try is due; the owner's alarm runs it.
    state.storage.sql.exec('UPDATE task_jobs SET due_at = ? WHERE id = ?', Date.now(), job!.id);
    await state.storage.put(TASK_JOBS_DUE_KEY, Date.now());
  });
  // Providers come back later. The object is evicted meanwhile (its provider breaker, still open from the outage, goes
  // with it); the promise lives in the job row and survives.
  await evictDurableObject(stub);
  seen.outputs.push([]);
  await runDurableObjectAlarm(stub);
  const settled = await until(() => runInDurableObject(stub, (_instance, state) => jobs(state.storage.sql)[0]!), row => row.status === 'applied');
  expect(settled.status).toBe('applied');
  const retried = seen.bodies.find(body => body.includes('this is the late answer'));
  expect(retried).toContain('What should I pack for Goa?');
  await runDurableObjectAlarm(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const outbox = state.storage.kv.get<{ id: string }[]>(FINAL_OUTBOX_KEY) ?? [];
    expect(outbox.filter(record => record.id === `retry:${settled.id}`)).toHaveLength(1);
  });
}, 30_000);

it('one owner\'s provider failures open only that owner\'s breaker: another owner\'s workers and turns still ask the provider', async () => {
  type Rpc = { drainInbox(): Promise<void>; taskClaim(...args: unknown[]): Promise<{ providerHealth?: unknown } | 'fenced'>; taskReport(...args: unknown[]): Promise<string> };
  const health = (instance: unknown) => (instance as { providerHealth: { snapshot(): { provider: string; failures: number; opened_at: number | null }[] } }).providerHealth.snapshot();
  // A job's attempt claims, then reports that no provider answered, with the misses its worker saw.
  const attempt = (name: string, misses: number) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (instance, state) => {
    await state.storage.put({ telegram_subject: '42', do_name: name, origin: 'https://fixture.invalid' });
    const book = jobBook(state.storage.sql, { now: Date.now, newId: () => crypto.randomUUID().slice(0, 12), newToken: () => crypto.randomUUID() });
    const { job } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: crypto.randomUUID(), origin: 'tg-1', surface: 'telegram', brief: { ...BRIEF, effort: 'standard', timezone: 'UTC', started_at: Date.now() }, dueAt: Date.now(), deadlineAt: Date.now() + 3_600_000 });
    const ticket = book.startAttempt(job.id)!;
    const claim = await (instance as unknown as Rpc).taskClaim(ticket);
    expect(await (instance as unknown as Rpc).taskReport(ticket, { kind: 'unavailable' }, [], { rounds: 0, costUsd: 0 }, Array.from({ length: misses }, () => ({ provider: 'openai', ok: false })))).toBe('deferred');
    await state.storage.deleteAlarm();
    return { seed: claim === 'fenced' ? null : claim.providerHealth, after: health(instance).find(entry => entry.provider === 'openai') };
  });
  const a = await attempt('breaker-owner-a', 3);
  expect(a.after).toMatchObject({ failures: 3, opened_at: expect.any(Number) });
  const b = await attempt('breaker-owner-b', 0);
  expect(b.seed).toEqual([]);
  expect(b.after).toBeUndefined();
  // Owner B's own turn asks the provider and gets an answer, not the floor reply.
  const before = seen.bodies.length;
  seen.outputs.push([]);
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('breaker-owner-b')), async (instance, state) => {
    const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
    await inbox.admit({ bot: env.TELEGRAM_BOT_TOKEN!.split(':')[0]!, subject: '42', doName: 'breaker-owner-b' }, 1,
      JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, date: 1, text: 'What should I pack for Goa?' } }));
    await (instance as unknown as Rpc).drainInbox();
    await state.storage.deleteAlarm();
    const queued = (state.storage.kv.get<{ payload: { text: string } }[]>(FINAL_OUTBOX_KEY) ?? []).map(record => record.payload.text.replaceAll('&#39;', "'"));
    expect(queued.some(text => text.startsWith("I can't answer properly right now."))).toBe(false);
  });
  expect(seen.bodies.length).toBeGreaterThan(before);
}, 30_000);

it('an attempt that outlasts its alarm slice hands over to a fresh alarm of the same worker and finishes there', async () => {
  const name = 'task-slice-e2e';
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const workers = (env as unknown as TelegramWebhookEnv).TASK_WORKER_DO!;
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
  const ticket = await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put({ telegram_subject: '42', do_name: name, origin: 'https://fixture.invalid' });
    const book = jobBook(state.storage.sql, { now: Date.now, newId: () => crypto.randomUUID().slice(0, 12), newToken: () => crypto.randomUUID() });
    const { job } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: 'slice-1', origin: 'tg-1', surface: 'telegram', brief: { ...BRIEF, effort: 'standard', timezone: 'UTC', started_at: Date.now() }, dueAt: Date.now(), deadlineAt: Date.now() + 3_600_000 });
    return book.startAttempt(job.id)!;
  });
  const worker = workers.get(workers.idFromName(taskWorkerName(stub.id.toString(), ticket)));
  // The first round's model call runs past the slice; its step is checkpointed and the attempt continues on a new alarm.
  seen.skew = TASK_ALARM_SLICE_MS + 60_000;
  seen.outputs.push(fn('get_tasks', {}), fn('finish_task', RESULT), []);
  await worker.start({ owner: stub.id.toString(), ticket });
  const handed = await until(() => runInDurableObject(stub, (_instance, state) => jobs(state.storage.sql)[0]!), job => job.checkpoint_seq === 1);
  expect(handed).toMatchObject({ status: 'running', attempt: 1, crashes: 0, checkpoint_seq: 1 });
  await runInDurableObject(worker, async (_instance, state) => {
    expect([...state.storage.kv.list()].map(([key]) => key)).toEqual(['task_worker_ticket_v1']);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
  // The next alarm of the same worker resumes the attempt from that checkpoint and reports.
  expect(await runDurableObjectAlarm(worker)).toBe(true);
  const reported = await until(() => runInDurableObject(stub, (_instance, state) => jobs(state.storage.sql)[0]!), job => job.status !== 'running');
  expect(reported).toMatchObject({ attempt: 1, crashes: 0, outcome: 'done' });
  const resumed = seen.bodies.filter(body => body.includes('"finish_task"'));
  expect(resumed).toHaveLength(2);
  expect(resumed[1]).toContain('get_tasks');
  await runInDurableObject(worker, async (_instance, state) => { expect([...(await state.storage.list()).keys()]).toEqual([]); });
  await runInDurableObject(stub, async (_instance, state) => { await state.storage.deleteAlarm(); });
}, 30_000);
