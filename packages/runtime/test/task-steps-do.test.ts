import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ownerTasks } from '../src/channels/tasks/step-runner';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// Durable task steps on the real owner object: every pass is a workerd alarm, the model is scripted per step, and the
// directory admits the Telegram owner unless a test revokes it.
type Call = Readonly<{ name: string; args: object }>;
type Reply = Readonly<{ calls: readonly Call[] } | { text: string }>;
const proof = vi.hoisted(() => ({
  respond: (_said: string, _round: number, _tools: readonly string[], _outputs: readonly string[]): Reply | Promise<Reply> => ({ text: 'ok' }),
  said: [] as { said: string; round: number; tools: string[] }[],
  revoked: false,
  rpcs: [] as string[],
  hung: false,
}));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: any) => {
  const format = body.text?.format?.name;
  if (format) return { id: 'structured', output: [], usage: { input_tokens: 1, output_tokens: 1 }, output_text:
    format === 'task_source_scope' ? '{"decision":"retain","sources":[]}'
      : format === 'claim_ops' ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}'
        : format === 'reaction' ? '{"reaction":"👌"}' : '{}' };
  const input: any[] = Array.isArray(body.input) ? body.input : [{ role: 'user', content: String(body.input) }];
  const last = input.map((entry) => entry?.role).lastIndexOf('user');
  const said = JSON.stringify(input[last]?.content ?? '');
  const outputs = input.slice(last + 1).filter((entry) => entry?.type === 'function_call_output').map((entry) => String(entry.output));
  const round = outputs.length;
  const tools = (body.tools ?? []).map((tool: { name?: string }) => tool.name ?? '');
  proof.said.push({ said, round, tools });
  const reply = await proof.respond(said, round, tools, outputs);
  return 'calls' in reply
    ? { id: `calls-${proof.said.length}`, output: reply.calls.map((call, index) => ({ type: 'function_call', call_id: `c${proof.said.length}-${index}`, name: call.name, arguments: JSON.stringify(call.args) })), output_text: '', usage: { input_tokens: 1, output_tokens: 1 } }
    : { id: `text-${proof.said.length}`, output: [], output_text: reply.text, usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async (load) => ({ ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string, payload: { chat_id: number }) => method === 'sendMessage' ? { message_id: 1, chat: { id: payload.chat_id } } : method === 'getMe' ? { username: 'fixture_bot' } : true }));

const OWNER = '6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e';
beforeEach(() => {
  proof.said = []; proof.revoked = false; proof.rpcs = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    proof.rpcs.push(url.split('/').at(-1)!);
    if (url.endsWith('/rpc/common_owner_authority')) return proof.revoked ? Response.json(null) : presenceAuthority(OWNER, init?.body);
    return Response.json(null);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

type World = Readonly<{ name: string; stub: DurableObjectStub; inObject<T>(work: (state: DurableObjectState) => T | Promise<T>): Promise<T> }>;
const attach = (name: string): World => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  return { name, stub, inObject: (work) => runInDurableObject(stub, async (_instance, state) => work(state)) };
};
const world = async (name: string): Promise<World> => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2030-11-01T14:00:00Z') });
  const w = attach(name);
  await w.inObject((state) => {
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '9201'); state.storage.kv.put('timezone', 'UTC');
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS schedule_preferences (kind TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
    for (const kind of ['daily_brief', 'event_briefs', 'nightly', 'heartbeat']) state.storage.sql.exec('INSERT OR REPLACE INTO schedule_preferences (kind, enabled) VALUES (?, 0)', kind);
  });
  return w;
};
const tasksIn = (state: DurableObjectState) => ownerTasks(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { newId: () => crypto.randomUUID(), now: Date.now });
// A responsibility of three steps: the first delegated as background research, the other two Waldo's own, in order.
const errand = (w: World) => w.inObject(async (state) => {
  const tasks = tasksIn(state);
  const { responsibility, items } = tasks.book.track({ title: 'Team offsite', intent: 'Find and hold a venue for the offsite', next_check_at: null, items: [
    { title: 'Venue research', owner: 'waldo', depends_on: [] },
    { title: 'Shortlist two', owner: 'waldo', depends_on: [0] },
    { title: 'Note the pick', owner: 'waldo', depends_on: [1] },
  ] }, 'test');
  const started = tasks.book.start(items[0]!.id, 'worker:test')!;
  expect(await tasks.delegation.startBackground!({ task: 'RESEARCH-VENUES: list three venues', itemId: items[0]!.id, revision: started.revision })).toBe(true);
  return { responsibility: responsibility.id, items: items.map((item) => item.id) };
});
const pass = async (w: World) => {
  const due = await w.inObject((state) => state.storage.getAlarm());
  expect(due, 'an armed wake').not.toBeNull();
  if (due! > Date.now()) vi.setSystemTime(due!);
  expect(await runDurableObjectAlarm(w.stub)).toBe(true);
};
const read = (w: World, itemIds: readonly string[]) => w.inObject((state) => {
  const tasks = tasksIn(state);
  return itemIds.map((id) => {
    const item = tasks.book.item(id)!;
    const step = tasks.journal.step(id);
    return { status: item.status, result: item.result_ref, superseded: item.superseded_result, attempts: step ? tasks.journal.attempts(id, step.revision).map((a) => ({ status: a.status, effects: a.effects_dispatched })) : [] };
  });
});
const stepIs = (marker: string, said: string) => said.includes(marker);

const lines: string[] = [];
beforeEach(() => {
  lines.length = 0;
  for (const method of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
});
const hops = () => lines.filter((line) => line.includes('"hop":"task_step"')).map((line) => JSON.parse(line) as Record<string, unknown>);
const modelSteps = () => proof.said.filter((call) => call.round === 0).length;
// A crash mid-attempt: the model never answers and the object is reset while the step waits on it, as an eviction or a
// deploy cuts off a running alarm. Nothing after that point runs, so the attempt is left as it was.
const hang = (): Promise<Reply> => { proof.hung = true; return new Promise(() => undefined); };
const crashedPass = async (w: World): Promise<World> => {
  const due = await w.inObject((state) => state.storage.getAlarm());
  if (due! > Date.now()) vi.setSystemTime(due!);
  proof.hung = false;
  const running = runDurableObjectAlarm(w.stub).catch(() => undefined);
  await vi.waitFor(() => expect(proof.hung).toBe(true), { timeout: 10_000, interval: 10 });
  await w.inObject((state) => state.abort('crash mid-step')).catch(() => undefined);
  await running;
  // The reset object's old stub is broken; a later wake reaches the object afresh. workerd's local alarm does not retry the
  // handler the reset cut off, as the platform does, so the wake that retry would deliver is armed here.
  const fresh = attach(w.name);
  await fresh.inObject((state) => new Scheduler(state.storage.sql, state.storage, productionDeps()).rearm());
  return fresh;
};
const scheduled = (w: World) => w.inObject((state) => state.storage.sql.exec<{ id: string; status: string }>("SELECT id, status FROM schedule WHERE kind = 'task_step'").toArray());
const responsibilityStatus = (w: World, id: string) => w.inObject((state) => tasksIn(state).book.get(id)!.status);
const MARKERS = ['RESEARCH-VENUES', 'Hall A', 'Team offsite', 'Shortlist two', 'Note the pick', 'hold a venue'];

it('a three-step errand runs one step per wake, in dependency order, with one journal row and one trace hop per attempt', async () => {
  const w = await world('tasks-three-steps');
  proof.respond = (said) => ({ text: stepIs('RESEARCH-VENUES', said) ? 'Three venues: Hall A, Hall B, Hall C.' : stepIs('This step: Shortlist two', said) ? 'Shortlisted Hall A and Hall B.' : 'Picked Hall A.' });
  const { responsibility, items } = await errand(w);

  await pass(w);
  expect((await read(w, items)).map((item) => item.status)).toEqual(['done', 'running', 'pending']);
  // The delegated research step is offered its read tools only.
  expect(proof.said[0]!.tools.sort()).toEqual(['get_context', 'read_memory', 'search_episodes', 'web_search']);
  await pass(w);
  expect((await read(w, items)).map((item) => item.status)).toEqual(['done', 'done', 'running']);
  await pass(w);
  const final = await read(w, items);
  expect(final).toEqual([
    { status: 'done', result: 'Three venues: Hall A, Hall B, Hall C.', superseded: null, attempts: [{ status: 'done', effects: 0 }] },
    { status: 'done', result: 'Shortlisted Hall A and Hall B.', superseded: null, attempts: [{ status: 'done', effects: 0 }] },
    { status: 'done', result: 'Picked Hall A.', superseded: null, attempts: [{ status: 'done', effects: 0 }] },
  ]);
  expect(modelSteps()).toBe(3);
  // Each step reads what the steps it waited on found; the last step is not offered only read tools.
  const [, second, third] = proof.said.filter((call) => call.round === 0);
  expect(second!.said).toContain('Three venues: Hall A, Hall B, Hall C.');
  expect(third!.said).toContain('Shortlisted Hall A and Hall B.');
  expect(third!.tools).toContain('track_responsibility');
  // Finishing every step does not close the responsibility: closing needs evidence, which is the model's call.
  expect(await responsibilityStatus(w, responsibility)).toBe('open');
  expect(await scheduled(w)).toEqual([]);
  // One hop per attempt with ids, attempt number, outcome, effects and time, and no task text anywhere in the logs.
  expect(hops().map((hop) => ({ ok: hop.ok, code: hop.code, detail: hop.detail, responsibility_id: hop.responsibility_id, ms: typeof hop.ms })))
    .toEqual(items.map((item) => ({ ok: true, code: 'done', detail: `item=${item} attempt=1 effects_dispatched=0`, responsibility_id: responsibility, ms: 'number' })));
  expect(new Set(hops().map((hop) => hop.trace)).size).toBe(3);
  for (const marker of MARKERS) expect(lines.filter((line) => line.includes(marker))).toEqual([]);
}, 60_000);

it('a reads-only step cut off mid-way runs again on the next wake and finishes', async () => {
  let w = await world('tasks-read-resume');
  let crashes = 1;
  proof.respond = (said) => stepIs('RESEARCH-VENUES', said) && crashes-- > 0 ? hang() : { text: 'Three venues found.' };
  const { items } = await errand(w);
  w = await crashedPass(w);
  expect((await read(w, items))[0]).toMatchObject({ status: 'running', attempts: [{ status: 'running', effects: 0 }] });
  await pass(w);
  expect((await read(w, items))[0]).toEqual({ status: 'done', result: 'Three venues found.', superseded: null, attempts: [{ status: 'interrupted', effects: 0 }, { status: 'done', effects: 0 }] });
  expect(hops().map((hop) => [hop.code, hop.detail])).toEqual([
    ['interrupted', `item=${items[0]} attempt=1 effects_dispatched=0`],
    ['done', `item=${items[0]} attempt=2 effects_dispatched=0`],
  ]);
}, 60_000);

it('a step cut off after it dispatched an effect is not run again: the step fails and the responsibility is uncertain', async () => {
  let w = await world('tasks-effect-uncertain');
  proof.respond = (said, round) => {
    if (stepIs('RESEARCH-VENUES', said)) return { text: 'Three venues found.' };
    if (round === 0) return { calls: [{ name: 'track_responsibility', args: { title: 'Hold Hall A', intent: 'Keep the hold on Hall A' } }] };
    return hang();
  };
  const { responsibility, items } = await errand(w);
  await pass(w);
  w = await crashedPass(w);
  expect((await read(w, items))[1]!.attempts).toEqual([{ status: 'running', effects: 1 }]);
  const calls = modelSteps();
  await pass(w);
  expect(await read(w, items)).toMatchObject([
    { status: 'done' },
    { status: 'failed', result: 'Outcome uncertain: a step with effects was interrupted before it finished.', attempts: [{ status: 'interrupted', effects: 1 }] },
    { status: 'pending', attempts: [] },
  ]);
  expect(await responsibilityStatus(w, responsibility)).toBe('uncertain');
  expect(modelSteps()).toBe(calls);
  expect(await scheduled(w)).toEqual([]);
  expect(hops().at(-1)).toMatchObject({ ok: false, code: 'interrupted', detail: `item=${items[1]} attempt=1 effects_dispatched=1` });
}, 60_000);

it('a step that fails three times is failed, the runner retrying it, and the scheduler never pauses it', async () => {
  const w = await world('tasks-three-failures');
  proof.respond = () => { throw new Error('model unavailable'); };
  const { responsibility, items } = await errand(w);
  for (let attempt = 1; attempt <= 3; attempt++) await pass(w);
  expect((await read(w, items))[0]).toEqual({ status: 'failed', result: 'Could not finish after 3 attempts.', superseded: null,
    attempts: [{ status: 'failed', effects: 0 }, { status: 'failed', effects: 0 }, { status: 'failed', effects: 0 }] });
  expect(await responsibilityStatus(w, responsibility)).toBe('open');
  expect(await scheduled(w)).toEqual([]);
  expect(await w.inObject((state) => state.storage.sql.exec("SELECT outcome FROM schedule_runs WHERE kind = 'task_step' ORDER BY fired_at").toArray().map((row) => row.outcome))).toEqual(['ok', 'ok', 'ok']);
  expect(hops().map((hop) => hop.code)).toEqual(['failed', 'failed', 'failed']);
}, 60_000);

it('dropping the responsibility mid-step fences the running attempt, keeps its result aside and takes the rest off the schedule', async () => {
  const w = await world('tasks-cancel-fence');
  const { responsibility, items } = await errand(w);
  let owner: DurableObjectState | undefined;
  await w.inObject((state) => { owner = state; });
  proof.respond = async (said) => {
    if (stepIs('RESEARCH-VENUES', said)) return { text: 'Three venues found.' };
    // The owner drops the errand while the shortlist step is with the model.
    const [, , , close] = tasksIn(owner!).handlers;
    await close.handle({ id: responsibility, outcome: 'dropped', evidence_ref: 'owner: forget the offsite' });
    return { text: 'Shortlisted Hall A and Hall B.' };
  };
  await pass(w);
  await pass(w);
  expect(await read(w, items)).toEqual([
    { status: 'done', result: 'Three venues found.', superseded: null, attempts: [{ status: 'done', effects: 0 }] },
    { status: 'cancelled', result: null, superseded: 'Stopped: the step was changed or cancelled while it ran.', attempts: [{ status: 'failed', effects: 0 }] },
    { status: 'cancelled', result: null, superseded: null, attempts: [] },
  ]);
  expect(await responsibilityStatus(w, responsibility)).toBe('dropped');
  expect(await scheduled(w)).toEqual([]);
  expect(hops().at(-1)).toMatchObject({ ok: false, code: 'fenced' });
}, 60_000);

it('six steps run to the end with a fresh object stub before every wake', async () => {
  const name = 'tasks-six-fresh-stubs';
  let w = await world(name);
  proof.respond = (said) => ({ text: `Finished ${said.match(/This step: (S\d)/)?.[1] ?? 'S1'}.` });
  const ids = await w.inObject(async (state) => {
    const tasks = tasksIn(state);
    const { items } = tasks.book.track({ title: 'Six steps', intent: 'Run six steps in order', next_check_at: null,
      items: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((title, index) => ({ title, owner: 'waldo' as const, depends_on: index === 0 ? [] : [index - 1] })) }, 'test');
    const started = tasks.book.start(items[0]!.id, 'worker:test')!;
    await tasks.delegation.startBackground!({ task: 'This step: S1', itemId: items[0]!.id, revision: started.revision });
    return items.map((item) => item.id);
  });
  for (let step = 0; step < 6; step++) {
    w = attach(name);
    await pass(w);
  }
  expect((await read(w, ids)).map((item) => [item.status, item.result, item.attempts.length])).toEqual(
    ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((title) => ['done', `Finished ${title}.`, 1]));
}, 90_000);

it('the run table keeps its 500-row cap when steps record their runs', async () => {
  const w = await world('tasks-run-cap');
  proof.respond = () => ({ text: 'Three venues found.' });
  await w.inObject((state) => {
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS background_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT, parent_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER)');
    for (let n = 0; n < 500; n++) state.storage.sql.exec("INSERT INTO background_runs (id, kind, status, started_at) VALUES (?, 'reminder', 'completed', ?)", `bg:old${n}`, n);
  });
  const { responsibility } = await errand(w);
  await pass(w);
  const runs = await w.inObject((state) => ({
    count: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM background_runs').one().n,
    step: state.storage.sql.exec("SELECT kind, status, parent_id FROM background_runs WHERE kind = 'task_step'").toArray(),
  }));
  expect(runs).toEqual({ count: 500, step: [{ kind: 'task_step', status: 'completed', parent_id: responsibility }] });
}, 60_000);

it('steps run only as the owner the directory admits: a revoked owner runs no step until the directory admits them again', async () => {
  const w = await world('tasks-revoked');
  proof.respond = (said) => ({ text: stepIs('RESEARCH-VENUES', said) ? 'Three venues found.' : 'Shortlisted.' });
  const { items } = await errand(w);
  await pass(w);
  proof.revoked = true;
  const calls = modelSteps();
  await pass(w);
  expect(modelSteps()).toBe(calls);
  expect((await read(w, items))[1]).toMatchObject({ status: 'running', attempts: [] });
  // A pass the directory refuses arms no wake: a revoked owner's work waits, armed, for the next admitted pass.
  expect(await w.inObject((state) => state.storage.getAlarm())).toBeNull();
  expect(await scheduled(w)).toHaveLength(1);
  proof.revoked = false;
  await w.inObject((state) => new Scheduler(state.storage.sql, state.storage, productionDeps()).rearm());
  await pass(w);
  expect((await read(w, items))[1]).toMatchObject({ status: 'done', result: 'Shortlisted.' });
}, 60_000);

it('a revoke while a step is with the model stops the step before its reply, and it does not run while the owner stays revoked', async () => {
  const w = await world('tasks-revoked-mid-step');
  proof.respond = () => { proof.revoked = true; return { text: 'Three venues found.' }; };
  const { items } = await errand(w);
  await pass(w);
  expect((await read(w, items))[0]).toMatchObject({ status: 'running', result: null, attempts: [{ status: 'failed', effects: 0 }] });
  const calls = modelSteps();
  await pass(w);
  expect(modelSteps()).toBe(calls);
  expect((await read(w, items))[0]!.attempts).toHaveLength(1);
}, 60_000);

it('an owner turn tracks a three-step errand and delegates its first step to the background, and the steps then run on their own wakes', async () => {
  const w = await world('tasks-owner-turn');
  proof.respond = (said, round, _tools, outputs) => {
    if (said.includes('Plan the team offsite')) {
      if (round === 0) return { calls: [{ name: 'track_responsibility', args: { title: 'Team offsite', intent: 'Find and hold a venue for the offsite', items: [
        { title: 'Venue research' }, { title: 'Shortlist two', depends_on: [0] }, { title: 'Note the pick', depends_on: [1] }] } }] };
      if (round === 1) {
        const first = outputs[0]!.match(/"id":"(i[0-9a-f-]+)"/)![1]!;
        return { calls: [{ name: 'delegate_task', args: { task: 'RESEARCH-VENUES: list three venues', item_id: first, background: true } }] };
      }
      return { text: 'On it: I am researching venues now and will work through the rest.' };
    }
    return { text: stepIs('RESEARCH-VENUES', said) ? 'Three venues: Hall A, Hall B, Hall C.' : stepIs('This step: Shortlist two', said) ? 'Shortlisted Hall A and Hall B.' : 'Picked Hall A.' };
  };
  const response = await w.stub.fetch(new Request('https://local.invalid/enqueue', { method: 'POST',
    headers: { 'x-waldo-inbox-secret': 'hermetic-test-webhook-secret', 'x-waldo-telegram-subject': '9201', 'x-waldo-do-name': w.name },
    body: JSON.stringify({ update_id: 4401, message: { message_id: 4401, from: { id: 9201, is_bot: false }, chat: { id: 9201, type: 'private' }, text: 'Plan the team offsite for me' } }) }));
  expect(response.status).toBe(200);
  for (let wake = 0; wake < 8 && (await w.inObject((state) => state.storage.getAlarm())) !== null; wake++) await pass(w);
  const outcome = await w.inObject((state) => {
    const tasks = tasksIn(state);
    const [tracked] = tasks.book.list('open');
    return tracked ? tasks.book.items(tracked.id).map((item) => [item.title, item.status, item.result_ref]) : [];
  });
  expect(outcome).toEqual([
    ['Venue research', 'done', 'Three venues: Hall A, Hall B, Hall C.'],
    ['Shortlist two', 'done', 'Shortlisted Hall A and Hall B.'],
    ['Note the pick', 'done', 'Picked Hall A.'],
  ]);
  const delegated = proof.said.find((call) => call.said.includes('Plan the team offsite') && call.round === 1);
  expect(delegated?.tools).toEqual(expect.arrayContaining(['track_responsibility', 'delegate_task']));
}, 90_000);
