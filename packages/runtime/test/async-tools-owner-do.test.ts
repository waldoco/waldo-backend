import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OPENAI_GPT_6_1_TERRA_MODEL, OPENAI_GPT_6_LUNA_MODEL } from '@waldo/contracts';
import { appHistoryResultV1Schema, appMessageReceiptV1Schema } from '../../contracts/src/app/core';
import { registerCommonBrowserSdk } from '../src/channels/common-staging-registration';
import { appSubjectFor } from '../src/channels/app-api';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { TASK_JOBS_DUE_KEY } from '../src/scheduler/alarm-slot';
import { jobBook, type JobRow, type TaskTicket } from '../src/tasks/jobs';
import { runTaskAttempt, taskModel, type TaskBrainPort } from '../src/tasks/worker-loop';
import { ensureSchema } from '../src/tracer/schema';

// The owner's app chat with WALDO_ASYNC_TOOLS on (docs/proposals/WALDO_ASYNC_TOOLS_DESIGN_2026-11-04.md): long work leaves the
// owner's turn as a task and the turn answers at once; a newer owner message is answered while the task's browser step is
// still open; the report reaches the owner when the task finishes. The model and the browser vendor are the only fakes. The
// owner object, its serial chain, tool loop, task host, the worker loop (run here as a TaskWorkerDO runs it) and the jobs lane
// are real.
const seen = vi.hoisted(() => {
  const state = { trace: [] as string[], ownerTools: [] as string[][], ownerSystem: [] as string[], models: [] as string[], applyAsked: '', release: () => {}, hold: Promise.resolve(), modelMs: 0, browseMs: 0 };
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    if (state.modelMs && !request.response_format) await new Promise(resolve => setTimeout(resolve, state.modelMs));
    const done = (fields: object) => ({ ok: true as const, data: { model: request.model, text: '', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...fields } });
    if (request.response_format) return done({ text: request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : request.response_format.name === 'day_plan' ? '{"cards":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[]}' });
    const tools = (request.tools ?? []).map(tool => tool.name), turns = request.tool_turns ?? [], said = String(request.messages.at(-1)?.content ?? '');
    const call = (name: string, args: unknown) => done({ tool_calls: [{ call_id: `call-${name}-${turns.length}`, name, arguments: JSON.stringify(args) }] });
    if (tools.includes('finish_task')) {
      state.trace.push(`worker_model:${request.model}`);
      return turns.length === 0 ? call('browse_page', { url: 'https://fixture.invalid/hotels', instruction: 'List the hotels and their nightly prices' })
        : call('finish_task', { status: 'done', summary: 'Three hotels near the venue.', findings: [{ text: 'Hotel Alpha is closest, from 4,200 a night.' }], proposals: [], left: [] });
    }
    if (said.includes('A background task you started has finished')) { state.applyAsked = said; state.trace.push('apply_model'); return done({ text: 'The hotels are in: Hotel Alpha is closest, from 4,200 a night.' }); }
    if (turns.length === 0) { state.ownerTools.push(tools); state.ownerSystem.push(request.system ?? ''); }
    state.models.push(request.model);
    // The latency eval's asks. A subagent's own call stands for one page read inside the owner's turn: it takes a page's time.
    if (request.system?.startsWith('You are a subagent of Waldo')) { state.trace.push('browse_open'); await new Promise(resolve => setTimeout(resolve, state.browseMs)); state.trace.push('browse_done'); return done({ text: 'The page lists three hotels.' }); }
    // An ask that needs a page: the owner's turn researches it inline, or hands it to a task, whichever it holds.
    if (said.includes('Check the page')) {
      if (turns.length > 0) return done({ text: tools.includes('delegate_task') ? 'The page says three hotels.' : 'I have started reading the page.' });
      return tools.includes('delegate_task') ? call('delegate_task', { task: 'Read the hotels page at https://fixture.invalid/hotels and list the hotels.' })
        : call('start_task', { profile: 'reader', title: 'Read the hotels page', goal: 'Read the page.', context: '', done_when: 'What it says.' });
    }
    if (said.includes('Find me three hotels') && turns.length === 0) return call('start_task', { profile: 'reader', title: 'Hotels near the venue', goal: 'Find three hotels near the venue with their nightly price.', context: 'The venue is fixture.invalid.', done_when: 'Three hotels with a price and a link each.' });
    if (said.includes('Find me three hotels')) { state.trace.push('reply:started'); return done({ text: 'I have started looking for hotels near the venue and will message you with three options.' }); }
    state.trace.push('reply:time');
    return done({ text: 'It is a quarter past ten.' });
  } };
  return { ...state, state, gateway };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  // The owner's browser host may hand the responder a gateway of its own (a browser registration is selected); it is kept, so
  // its run checks hold, and its model adapter is the scripted one below.
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] ??= seen.gateway; return original.createTelegramResponder(...args); } };
});
vi.mock('../src/llm/openai', async load => ({ ...await load<typeof import('../src/llm/openai')>(), OpenAIResponsesAdapter: class { complete(request: LLMGatewayRequest) { return seen.gateway.complete(request); } } }));
vi.mock('../src/identity/owner-runtime-authority', async load => ({ ...await load<typeof import('../src/identity/owner-runtime-authority')>(),
  ownerRuntimeAuthority: () => ({ resolve: async ({ doName }: { doName: string }) => ({ ownerId: OWNER, authenticatedUserId: OWNER, doName, stateVersion: 1, admissionRevision: '5' }) }) }));
vi.mock('../src/identity/common-owner-authority', () => ({ commonOwnerAuthority: () => ({ resolve: async () => ({ directoryOwnerId: OWNER, custodyDigest: 'd'.repeat(64) }) }) }));
const { OwnerDO } = await import('../src/channels/owner-do');
let alive = false;
registerCommonBrowserSdk(async () => ({ acquire: async () => { alive = true; return { sessionId: 'async-tools-session' }; },
  connect: async () => ({ newContext: async () => ({ serviceWorkers: () => [], addInitScript: async () => {}, routeWebSocket: async () => {}, route: async () => {},
    newPage: async () => ({ mainFrame: () => null, setDefaultTimeout() {}, on() {}, waitForLoadState: async () => {}, evaluate: async () => {},
      goto: async () => { seen.state.trace.push('browse_open'); await seen.state.hold; if (seen.state.browseMs) await new Promise(resolve => setTimeout(resolve, seen.state.browseMs)); seen.state.trace.push('browse_done'); return { status: () => 200 }; },
      url: () => 'https://fixture.invalid/hotels', title: async () => 'Hotels', locator: () => ({ innerText: async () => 'Three hotels near the venue, from 4,200 a night.' }) }), close: async () => {} }),
    newBrowserCDPSession: async () => ({ send: async () => { alive = false; } }), close: async () => {} }),
  sessions: async () => alive ? [{ sessionId: 'async-tools-session' }] : [], endpointURLString: () => '' } as never));

const OWNER = vi.hoisted(() => '10000000-0000-0000-0000-000000000004');
const HASH = 'c'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  const state = seen.state;
  state.trace.length = 0; state.ownerTools.length = 0; state.ownerSystem.length = 0; state.models.length = 0; state.applyAsked = ''; state.modelMs = 0; state.browseMs = 0; alive = false;
  state.hold = new Promise<void>(resolve => { state.release = resolve; });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER, auth_user_id: OWNER, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { seen.state.release(); vi.unstubAllGlobals(); });

type Owner = InstanceType<typeof OwnerDO>;
type Host = Owner & { alarm(): Promise<void>; taskClaim: TaskBrainPort['claim']; taskTool: TaskBrainPort['tool']; taskCheckpoint: TaskBrainPort['checkpoint']; taskReport: TaskBrainPort['report']; taskHeartbeat: TaskBrainPort['heartbeat'] };
const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, 'content-type': 'application/json' });
const withOwner = (switches: Readonly<Record<string, string>>, work: (owner: Host, state: DurableObjectState, name: string) => Promise<void>) => {
  const name = `async-tools-${crypto.randomUUID()}`;
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage);
    // This test drives the owner's alarm by hand, on its own instance. The object's own instance shares the storage, and its
    // alarm's inbox recovery would take this instance's running turn for a lost one.
    (instance as { alarm(): Promise<void> }).alarm = async () => {};
    await state.storage.put({ do_name: name, app_subject: String(appSubjectFor(name)), origin: 'https://fixture.invalid' });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, ...switches, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_MODEL_PROVIDER: 'openai',
      WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_ENVIRONMENT: 'staging', WALDO_EGRESS_ALLOWLIST: '*', BROWSER: {} as never, COMMON_OWNER_TASKS: '0' } as never) as Host;
    try { await work(owner, state, name); } finally { seen.state.release(); quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
};
const send = async (owner: Owner, name: string, client: string, text: string) => {
  const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: client, text }) }));
  expect(sent.status).toBe(202);
};
const receipt = async (owner: Owner, name: string, client: string) => appMessageReceiptV1Schema.parse(await (await owner.fetch(new Request(`https://telegram-owner/app/v1/chat/main/messages/${client}`, { headers: headers(name) }))).json());
const completed = (owner: Owner, name: string, client: string) => vi.waitFor(async () => expect((await receipt(owner, name, client)).state, client).toBe("completed"), { timeout: 15_000, interval: 20 });
const history = async (owner: Owner, name: string) => JSON.stringify(appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }))).json()));
const jobs = (sql: SqlStorage) => sql.exec<JobRow>('SELECT * FROM task_jobs').toArray();
// The worker's side, run against this owner object exactly as a TaskWorkerDO runs it over RPC.
const worker = (host: Host, ticket: TaskTicket, access: Parameters<typeof taskModel>[0] = { openaiApiKey: 'synthetic-fixture', primary: 'openai' }, strong = false) => runTaskAttempt(ticket, {
  brain: { claim: t => host.taskClaim(t), tool: (t, c, k) => host.taskTool(t, c, k), checkpoint: (...args) => host.taskCheckpoint(...args), report: (...args) => host.taskReport(...args), heartbeat: t => host.taskHeartbeat(t) },
  model: taskModel(access, seen.gateway, strong), sliceEnd: Date.now() + 120_000,
});
const attemptOf = (state: DurableObjectState, id: string) => jobBook(state.storage.sql, { now: Date.now, newId: () => 'unused', newToken: () => crypto.randomUUID() }).startAttempt(id)!;
const LONG_TOOLS = ['browse_page', 'browse_act', 'read_drive', 'delegate_task'];

it('with WALDO_ASYNC_TOOLS on, the owner turn starts long work as a task and answers at once; a newer message is answered while the task browses; the report follows', async () => {
  await withOwner({ WALDO_ASYNC_TOOLS: '1' }, async (owner, state, name) => {
    await send(owner, name, 'async-a-0001', 'Find me three hotels near the venue with prices');
    await completed(owner, name, 'async-a-0001');
    // The owner's turn offered start_task and none of the long tools; the model chose to start the work.
    expect(seen.state.ownerTools[0]).toContain('start_task');
    for (const tool of LONG_TOOLS) expect(seen.state.ownerTools[0]).not.toContain(tool);
    const [job] = jobs(state.storage.sql);
    expect(job).toMatchObject({ kind: 'task', profile: 'reader', status: 'queued', surface: 'app' });
    // The reply says what was started, by the task's title.
    expect(await history(owner, name)).toContain('task started Hotels near the venue');

    // The task's worker browses; the page load is held open.
    const attempt = worker(owner, attemptOf(state, job!.id));
    await vi.waitFor(() => expect(seen.state.trace).toContain('browse_open'), { timeout: 15_000, interval: 20 });

    // A newer owner message is answered while the worker's browser step is still open.
    await send(owner, name, 'async-b-0001', 'What time is it?');
    await completed(owner, name, 'async-b-0001');
    expect(seen.state.trace).not.toContain('browse_done');
    expect(await history(owner, name)).toContain('It is a quarter past ten.');

    // The page loads, the worker finishes, and the jobs lane's apply turn tells the owner.
    seen.state.release();
    expect(await attempt).toBe('reported');
    await state.storage.put(TASK_JOBS_DUE_KEY, Date.now());
    await owner.alarm();
    await vi.waitFor(() => expect(jobs(state.storage.sql)[0]).toMatchObject({ status: 'applied', outcome: 'done' }), { timeout: 15_000, interval: 20 });
    expect(seen.state.applyAsked).toContain('Hotel Alpha is closest');
    // The report leaves through the final outbox, which the next alarm pass drains into the main chat.
    await vi.waitFor(async () => { await owner.alarm(); expect(await history(owner, name)).toContain('The hotels are in'); }, { timeout: 15_000, interval: 50 });

    // The trace: the turn started the task and replied before any worker step; the newer message was answered while the page was open.
    expect(seen.state.trace).toEqual(['reply:started', expect.stringMatching(/^worker_model:/), 'browse_open', 'reply:time', 'browse_done', expect.stringMatching(/^worker_model:/), 'apply_model']);
  });
}, 60_000);

// Off, as before: the owner's turn holds the long tools and a worker's browser step takes the owner's chain. On, an errand's
// step does too: an errand can act on a page, and a card or effect it raises is filed under the run on the chain.
it.each([['0', 'reader'], ['1', 'errand']] as const)('with WALDO_ASYNC_TOOLS %s, a %s worker\'s browser step holds the next app message on the owner\'s chain', async (switched, profile) => {
  await withOwner({ WALDO_ASYNC_TOOLS: switched }, async (owner, state, name) => {
    await send(owner, name, 'base-a-0001', 'What time is it?');
    await completed(owner, name, 'base-a-0001');
    if (switched === '0') expect(seen.state.ownerTools[0]).toEqual(expect.arrayContaining(['start_task', 'delegate_task']));
    const book = jobBook(state.storage.sql, { now: Date.now, newId: () => 'heldjob00001', newToken: () => crypto.randomUUID() });
    const { job } = book.create({ kind: 'task', profile, idempotencyKey: 'turn-0:call-0', origin: 'turn-0', surface: 'app',
      brief: { title: 'Hotels near the venue', goal: 'Find three hotels.', context: '', done_when: 'Three hotels.', effort: 'standard', timezone: 'UTC', started_at: Date.now() }, dueAt: Date.now(), deadlineAt: Date.now() + 3_600_000 });
    const attempt = worker(owner, book.startAttempt(job.id)!);
    await vi.waitFor(() => expect(seen.state.trace).toContain('browse_open'), { timeout: 15_000, interval: 20 });
    await send(owner, name, 'base-b-0001', 'And what time is it now?');
    await new Promise(resolve => setTimeout(resolve, 500));
    expect((await receipt(owner, name, 'base-b-0001')).state).not.toBe('completed');
    seen.state.release();
    expect(await attempt).toBe('reported');
    await completed(owner, name, 'base-b-0001');
    expect(seen.state.trace.indexOf('browse_done')).toBeLessThan(seen.state.trace.lastIndexOf('reply:time'));
  });
}, 60_000);

it('with the harness tool loader, the owner turn\'s catalogue names no long tool, so use_tool cannot reach one; the prompt sends long work to a task', async () => {
  await withOwner({ WALDO_ASYNC_TOOLS: '1', WALDO_TOOL_LOADER: 'harness' }, async (owner, _state, name) => {
    await send(owner, name, 'loader-a-0001', 'What time is it?');
    await completed(owner, name, 'loader-a-0001');
    const system = seen.state.ownerSystem[0]!;
    // The catalogue lists each group's tool names, then the group's description, which may name a tool held elsewhere.
    const catalogue = system.slice(system.indexOf('Tool catalogue:')).split('\n').slice(1).filter(line => line.startsWith('- ')).map(line => line.split('. ')[0]!);
    expect(catalogue.join('\n')).toContain('start_task');
    for (const tool of LONG_TOOLS) { expect(seen.state.ownerTools[0]).not.toContain(tool); expect(catalogue.join('\n')).not.toContain(tool); }
    expect(system).toContain('Background work');
  });
}, 60_000);

it('with WALDO_LIGHT_CHAT on, the owner\'s reply runs on the auxiliary model and a standard task on the chat model', async () => {
  await withOwner({ WALDO_ASYNC_TOOLS: '1', WALDO_LIGHT_CHAT: '1' }, async (owner, state, name) => {
    await send(owner, name, 'light-a-0001', 'Find me three hotels near the venue with prices');
    await completed(owner, name, 'light-a-0001');
    expect(new Set(seen.state.models)).toEqual(new Set([OPENAI_GPT_6_LUNA_MODEL]));
    const [job] = jobs(state.storage.sql);
    expect(JSON.parse(job!.brief_json)).toMatchObject({ effort: 'standard' });
    seen.state.release();
    expect(await worker(owner, attemptOf(state, job!.id), { openaiApiKey: 'synthetic-fixture', primary: 'openai' }, true)).toBe('reported');
    expect(seen.state.trace.filter(step => step.startsWith('worker_model:'))).toEqual([`worker_model:${OPENAI_GPT_6_1_TERRA_MODEL}`, `worker_model:${OPENAI_GPT_6_1_TERRA_MODEL}`]);
  });
  // Off, the owner's reply runs on the chat model.
  await withOwner({ WALDO_ASYNC_TOOLS: '1' }, async (owner, _state, name) => {
    seen.state.models.length = 0;
    await send(owner, name, 'light-b-0001', 'What time is it?');
    await completed(owner, name, 'light-b-0001');
    expect(new Set(seen.state.models)).toEqual(new Set([OPENAI_GPT_6_1_TERRA_MODEL]));
  });
}, 60_000);

// Time to first reply: owner message admitted to its reply in the chat, on the real owner pipeline with scaled latencies (a
// model call 60 ms, a page 150 ms: 1:100 of the 10 Oct medians, 6 s and about 15 s). The asks: four that need a page, four
// that do not; then a second message sent while a page loads, once inside the owner's own turn (off: inline research with
// delegate_task, whose call takes a page's time) and once on a task's worker (on).
// Simulated, so the numbers are relative; staging p50 and p95 come from Langfuse once deployed.
const percentile = (values: readonly number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!; };
const timed = async (owner: Owner, name: string, client: string, text: string) => { const started = Date.now(); await send(owner, name, client, text); await completed(owner, name, client); return Date.now() - started; };
it('time to first reply, simulated: long work as a task answers sooner, and a newer message no longer waits for a page', async () => {
  const report: Record<string, Readonly<{ p50: number; p95: number; n: number }>> = {};
  for (const mode of ['0', '1'] as const) {
    await withOwner({ WALDO_ASYNC_TOOLS: mode }, async (owner, state, name) => {
      seen.state.release(); seen.state.modelMs = 60; seen.state.browseMs = 150;
      const asks: number[] = [];
      for (let i = 0; i < 8; i += 1) asks.push(await timed(owner, name, `eval-${mode}-${i}-0001`, i % 2 === 0 ? `Check the page for hotels (${i})` : `What time is it? (${i})`));
      report[`asks_async_${mode}`] = { p50: percentile(asks, 0.5), p95: percentile(asks, 0.95), n: asks.length };
      // A second message while a page loads: on the owner's turn itself (off), or on a task's worker (on).
      const second: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        seen.state.browseMs = 600;
        const first = mode === '0' ? send(owner, name, `slow-${mode}-${i}-0001`, `Check the page for hotels (slow ${i})`) : (async () => {
          const book = jobBook(state.storage.sql, { now: Date.now, newId: () => crypto.randomUUID().replaceAll('-', '').slice(0, 12), newToken: () => crypto.randomUUID() });
          const { job } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: `eval:${i}`, origin: `eval:${i}`, surface: 'app',
            brief: { title: 'Read the page', goal: 'Read the page.', context: '', done_when: 'What it says.', effort: 'standard', timezone: 'UTC', started_at: Date.now() }, dueAt: Date.now(), deadlineAt: Date.now() + 3_600_000 });
          await worker(owner, book.startAttempt(job.id)!);
        })();
        await vi.waitFor(() => expect(seen.state.trace.filter(step => step === 'browse_open').length).toBeGreaterThan(seen.state.trace.filter(step => step === 'browse_done').length), { timeout: 15_000, interval: 5 });
        second.push(await timed(owner, name, `next-${mode}-${i}-0001`, `What time is it? (next ${i})`));
        await first;
        if (mode === '0') await completed(owner, name, `slow-${mode}-${i}-0001`);
        seen.state.browseMs = 150;
      }
      report[`second_message_async_${mode}`] = { p50: percentile(second, 0.5), p95: percentile(second, 0.95), n: second.length };
    });
  }
  console.warn(JSON.stringify({ hop: 'ttfr_eval', scale: '1:100 (model 6 s -> 60 ms, page 15 s -> 150 ms; the held page 600 ms)', report }));
  expect(report.asks_async_1!.p95).toBeLessThan(report.asks_async_0!.p95);
  expect(report.second_message_async_1!.p50).toBeLessThan(report.second_message_async_0!.p50);
}, 120_000);

// With a browser registration selected, every model call of the owner's turns goes through the browser host's gateway, which
// checks the call's run against the one the host serves. A task's browser step on the browser lane is not the owner's run,
// so the gateway checks the owner's chain instead: the owner's turn answers while the step holds the browser.
it('while a task\'s browser step holds the browser lane, the owner\'s turn answers through the browser host\'s gateway', async () => {
  await withOwner({ WALDO_ASYNC_TOOLS: '1', COMMON_BROWSER_REGISTRATION: '{' }, async (owner, _state, name) => {
    const abort = new AbortController();
    const task = { runId: 'task:lane-hold', attempt: '1', deadline: Date.now() + 60_000, signal: abort.signal, admit: () => {}, commit: <T,>(work: () => T) => work() };
    const lane = (owner as unknown as { browserSerial(scope: typeof task, work: () => Promise<void>): Promise<void> }).browserSerial(task, () => seen.state.hold);
    await send(owner, name, 'lane-a-0001', 'What time is it?');
    await completed(owner, name, 'lane-a-0001');
    expect(await history(owner, name)).toContain('It is a quarter past ten.');
    seen.state.release();
    await lane;
  });
}, 60_000);
