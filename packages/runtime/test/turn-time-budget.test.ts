import { ownerTyped } from './helpers/owner-typed';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionState, OPENAI_GPT_6_LUNA_MODEL, OPENAI_PROVIDER, routingPolicySchema } from '@waldo/contracts';
import { OpenAIResponsesAdapter } from '../src/llm/openai';
import { RuntimeLLMProvider, type LLMGatewayRequest, type LLMGatewayResult, type RuntimeLLMRequest } from '../src/llm/provider';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { CALENDAR_PREP_FORMAT } from '../src/channels/event-briefs';
import { runToolLoop, unfinishedReply, type LoopExit, type ToolLoopEvent, type ToolLoopStep } from '../src/conversation/tool-loop';
import { ClosedRunError, type RunEffectScope } from '../src/channels/run-effect-scope';
import { TURN_TIMEOUT_MS } from '../src/channels/telegram-listener';
import { googleHandlers } from '../src/tools/live/google';
import { sanitise } from '../src/scribe/sanitiser';
import { FINAL_ANSWER_RESERVE_MS, MODEL_CALL_TIMEOUT_MS, RATE_LIMIT_BACKOFF_MS, RUN_CLOSE_MARGIN_MS, TOOL_ROUNDS_CEILING, toolRoundsFor, TURN_TIME_BUDGET_MS, turnDeadlineFor, withCallDeadline } from '../src/llm/time-budget';
import type { HookRuntimeContext } from '../src/hooks/registry';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

// The real OpenAI SDK, adapter, provider and tool loop run on a fake clock; only the network is fake.

const MODEL = OPENAI_GPT_6_LUNA_MODEL;
const SYNTHETIC_KEY = 'synthetic-key-0123456789';
const canaryTokens = ['1111111111111111', '2222222222222222', '3333333333333333'];

const usage = (input: number, output: number) => ({
  input_tokens: input, output_tokens: output, total_tokens: input + output,
  input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
});
const said = (text: string) => ({
  id: 'resp_text', object: 'response', status: 'completed',
  output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
  usage: usage(4, 2),
});
const asksForCalendar = (n: number, tool = 'query_calendar') => ({
  id: `resp_tool_${n}`, object: 'response', status: 'completed',
  output: [{ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: tool, arguments: '{}', status: 'completed' }],
  usage: usage(4, 2),
});
const reasoningOnly = { id: 'resp_reasoning', object: 'response', status: 'completed', output: [{ type: 'reasoning', id: 'rs_1', summary: [] }], usage: usage(4, 3) };
const providerError = { error: { message: 'synthetic provider failure', type: 'server_error', param: null, code: null } };

type Reply = 'hang' | Readonly<{ after: number; status?: number; body: unknown; headers?: Record<string, string> }>;

// The OpenAI API behind the real SDK: each request gets the script's reply after its delay, or hangs until aborted.
function fakeOpenAI(script: (n: number) => Reply) {
  const t0 = Date.now();
  const requests: Array<Readonly<{ at: number; body: Record<string, unknown> }>> = [];
  const ended: number[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const n = requests.length;
    requests.push({ at: Date.now() - t0, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const reply = script(n);
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      const abort = () => { ended[n] = Date.now() - t0; reject(new DOMException('The operation was aborted.', 'AbortError')); };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (reply === 'hang') return;
      setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        ended[n] = Date.now() - t0;
        resolve(new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json', ...reply.headers } }));
      }, reply.after);
    });
  });
  return { requests, ended };
}

// Runs the work on the fake clock until it settles, and reports how much fake time it took.
async function settle<T>(work: Promise<T>): Promise<Readonly<{ ms: number; value?: T; error?: unknown }>> {
  const started = Date.now();
  let outcome: { value: T } | { error: unknown } | undefined;
  work.then((value) => { outcome = { value }; }, (error: unknown) => { outcome = { error }; });
  for (let step = 0; step < 5_000; step += 1) {
    await vi.advanceTimersByTimeAsync(0);
    if (outcome !== undefined) return { ms: Date.now() - started, ...outcome };
    await vi.advanceTimersToNextTimerAsync();
  }
  throw new Error('the work never settled on the fake clock');
}

const hookCtx = (): HookRuntimeContext => ({
  authenticatedUserId: 'synthetic-owner', trigger: 'user_message', canaryTokens,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: canaryTokens, started_at: 1 }),
  sourceTaint: null, toolArgSourceTaint: null, sanitise,
});
const loopCtx = (runScope?: RunEffectScope): ToolDispatcherContext => ({
  authenticatedUserId: 'synthetic-owner', trigger: 'user_message', canaryTokens,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: canaryTokens, started_at: 1 }),
  sourceTaint: null, toolArgSourceTaint: null, sanitise, hasApproval: () => true,
  ...(runScope ? { runScope } : {}),
});

// A Telegram run is closed 150 s after it is claimed; an app run 15 minutes after. /stop can close either at any time.
const APP_RUN_MS = 15 * 60_000;
const TELEGRAM_TURN_MS = TURN_TIMEOUT_MS - RUN_CLOSE_MARGIN_MS;
const OUT_OF_TIME = unfinishedReply('time_exhausted', []);
const OUT_OF_TIME_AFTER_READ = unfinishedReply('time_exhausted', ['query_calendar']);
function runScope(lifetimeMs = TURN_TIMEOUT_MS) {
  const controller = new AbortController();
  const deadline = Date.now() + lifetimeMs;
  const scope: RunEffectScope = {
    runId: 'synthetic-run', attempt: 'synthetic-attempt', deadline, signal: controller.signal,
    admit() { if (controller.signal.aborted || Date.now() >= deadline) throw new ClosedRunError(); },
    commit(work) { this.admit(); return work(); },
  };
  return { scope, stop: () => controller.abort() };
}

function gatewayRequest(runScope?: RunEffectScope): LLMGatewayRequest {
  return {
    ...(runScope ? { runScope } : {}),
    request: { model: MODEL, system: 'Be brief.', messages: [{ role: 'user', content: 'Say hello.' }], max_tokens: 64, temperature: 0 },
    route: { trigger: 'user_message', primary: { provider: OPENAI_PROVIDER, model: MODEL, cache: 'none' }, fallback: [], floor: 'template' },
    step: { provider: OPENAI_PROVIDER, model: MODEL, cache: 'none' },
    context: 'full_context',
    fallback_step: 'configured_model',
    headers: { 'cf-aig-collect-log-payload': 'false' },
  };
}

// The owner turn's route: one model, no fallback rung.
const ownerPolicy = routingPolicySchema.parse({
  routes: [{ trigger: 'user_message', primary: { provider: OPENAI_PROVIDER, model: MODEL, cache: 'none', max_tokens: 4096 }, fallback: [], floor: 'template' }],
  escalation: [], template_fallback: false,
});
const ownerRequest = (runScope?: RunEffectScope, tools?: Parameters<ToolLoopStep>[0], turns: Parameters<ToolLoopStep>[1] = []): RuntimeLLMRequest => ({
  ...(runScope ? { runScope } : {}),
  trigger: 'user_message', policy: ownerPolicy,
  renderRequest: () => ({
    system: 'Be brief.', messages: [{ role: 'user', content: 'What is on my calendar?' }], max_tokens: 4096, temperature: 0.2,
    ...(tools ? { tools: [...tools] } : {}), ...(turns.length ? { tool_turns: [...turns] } : {}),
  }),
});

// The owner turn's model step: one provider call per round, and a failed call throws.
const ownerStep = (runtime: RuntimeLLMProvider, runScope?: RunEffectScope): ToolLoopStep => async (tools, turns) => {
  const result = await runtime.complete(ownerRequest(runScope, tools, turns), hookCtx());
  runScope?.admit();
  if (!result.ok) throw new Error(`live model failed: ${result.code}`);
  return result.response;
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clock = { timezone: 'UTC', now: () => new Date('2026-10-13T12:00:00Z') };
const calendar = (takesMs = 0) => googleHandlers(
  { client: async () => ({ events: async () => { if (takesMs > 0) await delay(takesMs); return []; } } as never) },
  { propose: async () => 'synthetic', proposeSendEmail: async () => 'synthetic', record: () => undefined },
  clock,
).find((handler) => handler.name === 'query_calendar')!;

function turn(step: ToolLoopStep, scope: RunEffectScope | undefined, handlers = [calendar()], budget: { remaining: number; deadline?: number } = { remaining: 25 }) {
  const events: ToolLoopEvent[] = [];
  let exit: LoopExit | undefined;
  const done = runToolLoop({ handlers, ctx: loopCtx(scope), maxSteps: 25, budget, step, onTool: (event) => events.push(event), onSettle: (value) => { exit = value; } });
  return { done, events, exit: () => exit };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('one model request: the real SDK behind the adapter', () => {
  it('aborts a hung request at the adapter timeout, after one request', async () => {
    const api = fakeOpenAI(() => 'hang');
    const run = await settle(new OpenAIResponsesAdapter({ apiKey: SYNTHETIC_KEY }).complete(gatewayRequest()));
    expect(run).toMatchObject({ ms: MODEL_CALL_TIMEOUT_MS, value: { ok: false, code: 'transient' } });
    expect(api.requests).toHaveLength(1);
  });

  it('returns a rate-limit reply when it arrives, with the wait the provider asked for, instead of sleeping it out', async () => {
    const api = fakeOpenAI(() => ({ after: 29_900, status: 429, body: providerError, headers: { 'retry-after-ms': '59000' } }));
    const run = await settle(new OpenAIResponsesAdapter({ apiKey: SYNTHETIC_KEY }).complete(gatewayRequest()));
    expect(run).toMatchObject({ ms: 29_900, value: { ok: false, code: 'rate_limited', retry: { afterMs: 59_000 } } });
    expect(api.requests).toHaveLength(1);
  });

  it('passes a retry-after in seconds and a refusal to retry up to the provider', async () => {
    fakeOpenAI(() => ({ after: 50, status: 503, body: providerError, headers: { 'retry-after': '3', 'x-should-retry': 'false' } }));
    const run = await settle(new OpenAIResponsesAdapter({ apiKey: SYNTHETIC_KEY }).complete(gatewayRequest()));
    expect(run.value).toMatchObject({ ok: false, code: 'transient', retry: { afterMs: 3_000, allowed: false } });
  });

  it('a run-scope stop aborts a request in flight at once', async () => {
    const api = fakeOpenAI(() => 'hang');
    const { scope, stop } = runScope();
    setTimeout(stop, 2_000);
    const run = await settle(new OpenAIResponsesAdapter({ apiKey: SYNTHETIC_KEY }).complete(gatewayRequest(scope)));
    expect(run).toMatchObject({ ms: 2_000, value: { ok: false, code: 'transient' } });
    expect(api.requests).toHaveLength(1);
  });

  it('a run-scope stop is never held up by a provider asking to retry later', async () => {
    const api = fakeOpenAI(() => ({ after: 100, status: 429, body: providerError, headers: { 'retry-after-ms': '59000' } }));
    const { scope, stop } = runScope();
    setTimeout(stop, 200);
    const run = await settle(new OpenAIResponsesAdapter({ apiKey: SYNTHETIC_KEY }).complete(gatewayRequest(scope)));
    expect(run.ms).toBeLessThanOrEqual(200);
    expect(api.requests).toHaveLength(1);
  });
});

describe('one model step: the provider is the only retry owner', () => {
  const step = () => new RuntimeLLMProvider({ gateway: new OpenAIResponsesAdapter({ apiKey: SYNTHETIC_KEY }) });

  it('asks a failing provider at most twice', async () => {
    const api = fakeOpenAI(() => ({ after: 50, status: 500, body: providerError }));
    const run = await settle(step().complete(ownerRequest(), hookCtx()));
    expect(run.value).toMatchObject({ ok: false, attempts: [{ outcome: 'failure', code: 'transient' }, { outcome: 'failure', code: 'transient' }] });
    expect(api.requests).toHaveLength(2);
  });

  it('sends at most two requests with every retry layer at its worst', async () => {
    // Server errors, with a reasoning-only reply third and ninth: what the SDK, the adapter and the provider each retried.
    const api = fakeOpenAI((n) => (n === 2 || n === 8 ? { after: 50, body: reasoningOnly } : { after: 50, status: 500, body: providerError }));
    const run = await settle(step().complete(ownerRequest(), hookCtx()));
    expect(run.value).toMatchObject({ ok: false });
    expect(api.requests).toHaveLength(2);
  });

  it.each([[401, 'auth_failed'], [404, 'not_found']] as const)('does not send a %i again', async (status, code) => {
    const api = fakeOpenAI(() => ({ after: 50, status, body: providerError }));
    const run = await settle(step().complete(ownerRequest(), hookCtx()));
    expect(api.requests).toHaveLength(1);
    expect(run.value).toMatchObject({ ok: false, attempts: [{ outcome: 'failure', code }] });
  });

  it('resends a rate-limited step once, after the wait the provider asked for', async () => {
    const api = fakeOpenAI((n) => (n === 0
      ? { after: 50, status: 429, body: providerError, headers: { 'retry-after-ms': '2000' } }
      : { after: 50, body: said('Here is your plan.') }));
    const run = await settle(step().complete(ownerRequest(), hookCtx()));
    expect(api.requests.map((request) => request.at)).toEqual([0, 2_050]);
    expect(run).toMatchObject({
      ms: 2_100,
      value: { ok: true, response: { text: 'Here is your plan.' }, attempts: [{ outcome: 'failure', code: 'rate_limited' }, { outcome: 'success' }] },
    });
  });

  it('backs off briefly before resending a rate limit that names no wait', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const api = fakeOpenAI((n) => (n === 0 ? { after: 50, status: 429, body: providerError } : { after: 50, body: said('Done.') }));
    const run = await settle(step().complete(ownerRequest(), hookCtx()));
    expect(api.requests.map((request) => request.at)).toEqual([0, 50 + RATE_LIMIT_BACKOFF_MS]);
    expect(run.value).toMatchObject({ ok: true });
  });

  it.each([
    ['is longer than a step may wait', 120_000, undefined],
    ['would leave no full call inside the turn', 15_000, 40_000],
  ] as const)('fails at once when the wait a rate limit asks for %s', async (_case, waitMs, turnLeftMs) => {
    const api = fakeOpenAI(() => ({ after: 50, status: 429, body: providerError, headers: { 'retry-after-ms': String(waitMs) } }));
    const { scope } = runScope();
    const call = () => step().complete(ownerRequest(scope), hookCtx());
    const run = await settle(turnLeftMs === undefined ? call() : withCallDeadline(scope, Date.now() + turnLeftMs, call));
    expect(api.requests).toHaveLength(1);
    expect(run).toMatchObject({ ms: 50, value: { ok: false, attempts: [{ outcome: 'failure', code: 'rate_limited' }] } });
  });

  it('a stop during the wait ends the step at once', async () => {
    const api = fakeOpenAI(() => ({ after: 50, status: 429, body: providerError, headers: { 'retry-after-ms': '5000' } }));
    const { scope, stop } = runScope();
    setTimeout(stop, 1_000);
    const run = await settle(step().complete(ownerRequest(scope), hookCtx()));
    expect(run.error).toBeInstanceOf(ClosedRunError);
    expect(run.ms).toBeLessThanOrEqual(1_200);
    expect(api.requests).toHaveLength(1);
  });

  it('does not resend when the provider says not to retry', async () => {
    const api = fakeOpenAI(() => ({ after: 50, status: 500, body: providerError, headers: { 'x-should-retry': 'false' } }));
    const run = await settle(step().complete(ownerRequest(), hookCtx()));
    expect(api.requests).toHaveLength(1);
    expect(run.value).toMatchObject({ ok: false, attempts: [{ outcome: 'failure', code: 'transient' }] });
  });

  it('retries a reasoning-only reply once, visibly, and still counts its tokens', async () => {
    const api = fakeOpenAI((n) => ({ after: 50, body: n === 0 ? reasoningOnly : said('Here is your plan.') }));
    const run = await settle(step().complete(ownerRequest(), hookCtx()));
    expect(run.value).toMatchObject({
      ok: true, response: { text: 'Here is your plan.' }, usage: { input_tokens: 8, output_tokens: 5 },
      attempts: [{ outcome: 'failure', code: 'transient' }, { outcome: 'success' }],
    });
    expect(api.requests).toHaveLength(2);
  });
});

describe('one turn: the tool loop spends one time budget', () => {
  const runtime = () => new RuntimeLLMProvider({ gateway: new OpenAIResponsesAdapter({ apiKey: SYNTHETIC_KEY }) });

  // The work before the loop, and a last tool round that runs past the deadline, both spend this margin.
  it('leaves a Telegram run at least one model call of time after the turn budget', () => {
    const { scope } = runScope();
    expect(scope.deadline - turnDeadlineFor(scope)).toBeGreaterThanOrEqual(MODEL_CALL_TIMEOUT_MS);
    expect(turnDeadlineFor(scope) - Date.now()).toBe(TELEGRAM_TURN_MS);
  });

  it('a slow model no longer stretches a turn over every tool round', async () => {
    const api = fakeOpenAI((n) => ({ after: 25_000, body: asksForCalendar(n) }));
    const { scope } = runScope();
    const loop = turn(ownerStep(runtime(), scope), scope);
    const run = await settle(loop.done);
    // Rounds start at 0, 25, 50 and 75 s; at 100 s less than one full call is left, so the answer call gets the last 20 s.
    expect(api.requests.map((request) => request.at)).toEqual([0, 25_000, 50_000, 75_000, 100_000]);
    expect(run).toMatchObject({ ms: TELEGRAM_TURN_MS, value: OUT_OF_TIME_AFTER_READ });
    expect(loop.exit()).toBe('time_exhausted');
  });

  it('shortens a later model call to what is left of the turn', async () => {
    const slowRead = TELEGRAM_TURN_MS - FINAL_ANSWER_RESERVE_MS + 5_000;
    const api = fakeOpenAI((n) => (n === 0 ? { after: 0, body: asksForCalendar(0) } : 'hang'));
    const { scope } = runScope();
    const loop = turn(ownerStep(runtime(), scope), scope, [calendar(slowRead)]);
    const run = await settle(loop.done);
    expect(run).toMatchObject({ ms: TELEGRAM_TURN_MS, value: OUT_OF_TIME_AFTER_READ });
    // The answer call starts with 25 s left and is cut there, not at its own 30 s; no retry is sent once the time is gone.
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]).toMatchObject({ at: slowRead });
    expect(api.requests[1]!.body.tools).toBeUndefined();
    expect(api.ended[1]).toBe(TELEGRAM_TURN_MS);
  });

  it('ends an exhausted budget through the final no-tools step', async () => {
    const api = fakeOpenAI((n) => (n < 5 ? { after: 20_000, body: asksForCalendar(n) } : { after: 5_000, body: said('Here is what I found so far.') }));
    const { scope } = runScope();
    const loop = turn(ownerStep(runtime(), scope), scope);
    const run = await settle(loop.done);
    // Rounds start at 0, 20, 40, 60 and 80 s; at 100 s less than one full call is left, so the sixth call offers no tools.
    expect(run).toMatchObject({ ms: 105_000, value: 'Here is what I found so far.' });
    expect(api.requests.map((request) => request.body.tools === undefined)).toEqual([false, false, false, false, false, true]);
    expect(loop.events.at(-1)?.output).toContain('turn time is up');
    expect(loop.exit()).toBe('time_exhausted');
  });

  it('says plainly that it could not finish when no time is left for an answer', async () => {
    const api = fakeOpenAI(() => ({ after: 1_000, body: asksForCalendar(0) }));
    const { scope } = runScope();
    const loop = turn(ownerStep(runtime(), scope), scope, [calendar(TELEGRAM_TURN_MS)]);
    const run = await settle(loop.done);
    expect(run).toMatchObject({ ms: 1_000 + TELEGRAM_TURN_MS, value: OUT_OF_TIME_AFTER_READ });
    // The read that started ran to its end; only the model call that could not finish was skipped.
    expect(loop.events.map((event) => [event.call.name, event.ok])).toEqual([['query_calendar', true]]);
    expect(api.requests).toHaveLength(1);
    expect(loop.exit()).toBe('time_exhausted');
  });

  it('keeps a model answer that lands just inside the budget', async () => {
    const slowRead = TELEGRAM_TURN_MS - FINAL_ANSWER_RESERVE_MS + 5_000;
    fakeOpenAI((n) => (n === 0 ? { after: 0, body: asksForCalendar(0) } : { after: TELEGRAM_TURN_MS - slowRead - 1, body: said('Your afternoon is clear.') }));
    const { scope } = runScope();
    const run = await settle(turn(ownerStep(runtime(), scope), scope, [calendar(slowRead)]).done);
    expect(run).toMatchObject({ ms: TELEGRAM_TURN_MS - 1, value: 'Your afternoon is clear.' });
  });

  it('a run-scope stop still ends the turn at once, never as running out of time', async () => {
    const api = fakeOpenAI(() => 'hang');
    const { scope, stop } = runScope();
    setTimeout(stop, 10_000);
    const run = await settle(turn(ownerStep(runtime(), scope), scope).done);
    expect(run.ms).toBe(10_000);
    expect(run.error).toBeInstanceOf(ClosedRunError);
    expect(api.requests).toHaveLength(1);
  });

  it('a closed run after the deadline still throws instead of the plain reply', async () => {
    const { scope } = runScope();
    const run = await settle(turn(async () => { await delay(TELEGRAM_TURN_MS + 1_000); throw new ClosedRunError(); }, scope).done);
    expect(run.error).toBeInstanceOf(ClosedRunError);
  });

  it('a child loop spends the same deadline as its parent', async () => {
    const budget: { remaining: number; deadline?: number } = { remaining: 25 };
    await settle(turn(async () => ({ text: 'parent closing' }), undefined, [calendar()], budget).done);
    await vi.advanceTimersByTimeAsync(TURN_TIME_BUDGET_MS - FINAL_ANSWER_RESERVE_MS + 1);
    const offered: boolean[] = [];
    const child = turn(async (tools) => { offered.push(tools !== undefined); return { text: 'child report' }; }, undefined, [calendar()], budget);
    expect(await child.done).toBe('child report');
    expect(offered).toEqual([false]);
    expect(child.exit()).toBe('time_exhausted');
  });
});

const sameTime = <T>(_hop: string, work: () => Promise<T>) => work();

describe('one owner turn through the responder', () => {
  it('cuts the answer call to what is left of the turn', async () => {
    const slowRead = TELEGRAM_TURN_MS - FINAL_ANSWER_RESERVE_MS + 5_000;
    const api = fakeOpenAI((n) => (n === 0 ? { after: 0, body: asksForCalendar(0) } : 'hang'));
    const { scope } = runScope();
    // The calendar read is offered without its connection check, and takes 65 s.
    const { eligible: _connected, ...slowCalendar } = calendar(slowRead);
    const responder = createOwnerResponder(SYNTHETIC_KEY, undefined, undefined, undefined, clock, [slowCalendar]);
    const run = await settle(responder.respond(ownerTyped({ traceId: 'slow-turn', conversationRef: 'owner', surface: 'telegram', text: 'What is on my calendar?', memoryWrites: false, runScope: scope }), sameTime));
    expect(api.requests).toHaveLength(2);
    // The answer call starts with 25 s of the turn left and is cut there, not at its own 30 s limit.
    expect(api.ended[1]! - api.requests[1]!.at).toBe(TELEGRAM_TURN_MS - slowRead);
    expect(run.value).toBe(OUT_OF_TIME_AFTER_READ);
  });
});

describe('the turn budget follows the run it serves', () => {
  const runtime = () => new RuntimeLLMProvider({ gateway: new OpenAIResponsesAdapter({ apiKey: SYNTHETIC_KEY }) });

  it('an app turn keeps working past two minutes, up to its own run less the close margin', async () => {
    const api = fakeOpenAI((n) => ({ after: 25_000, body: asksForCalendar(n) }));
    const { scope } = runScope(APP_RUN_MS);
    const loop = turn(ownerStep(runtime(), scope), scope, [calendar()], { remaining: 200 });
    const run = await settle(loop.done);
    // 25 rounds of 25 s: the round cap ends it at 625 s, long before the app run's 14.5 minutes.
    expect(api.requests.filter((request) => request.body.tools !== undefined && request.at > TURN_TIME_BUDGET_MS).length).toBeGreaterThan(0);
    expect(run.ms).toBe(26 * 25_000);
    expect(loop.exit()).toBe('budget_exhausted');
  });

  it('an app turn that runs to its deadline stops tools one answer call before it', async () => {
    const api = fakeOpenAI((n) => ({ after: 25_000, body: asksForCalendar(n) }));
    const { scope } = runScope(APP_RUN_MS);
    let exit: LoopExit | undefined;
    const run = await settle(runToolLoop({ handlers: [calendar()], ctx: loopCtx(scope), maxSteps: 200, budget: { remaining: 200 }, step: ownerStep(runtime(), scope), onSettle: (value) => { exit = value; } }));
    const end = APP_RUN_MS - RUN_CLOSE_MARGIN_MS;
    expect(Math.max(...api.requests.filter((request) => request.body.tools !== undefined).map((request) => request.at))).toBeLessThanOrEqual(end - FINAL_ANSWER_RESERVE_MS);
    expect(run.ms).toBe(end);
    expect(exit).toBe('time_exhausted');
  });

  it('gives tool rounds in proportion to the time, from 25 for two minutes up to a runaway ceiling', () => {
    expect(toolRoundsFor(TELEGRAM_TURN_MS)).toBe(25);
    expect(toolRoundsFor(30_000)).toBe(25);
    expect(toolRoundsFor(4 * 60_000)).toBe(50);
    expect(toolRoundsFor(APP_RUN_MS - RUN_CLOSE_MARGIN_MS)).toBe(TOOL_ROUNDS_CEILING);
    expect(TOOL_ROUNDS_CEILING).toBeLessThan(200);
  });

  const roundsThroughResponder = async (lifetimeMs: number) => {
    const api = fakeOpenAI((n) => ({ after: 0, body: asksForCalendar(n) }));
    const { scope } = runScope(lifetimeMs);
    const responder = createOwnerResponder(SYNTHETIC_KEY, undefined, undefined, undefined, clock, [calendar()]);
    await settle(responder.respond(ownerTyped({ traceId: 'long-turn', conversationRef: 'owner', surface: 'app', text: 'Work through my week.', memoryWrites: false, runScope: scope }), sameTime));
    return api.requests.filter((request) => request.body.tools !== undefined).length;
  };

  it('a Telegram owner turn still gets 25 tool rounds', async () => {
    expect(await roundsThroughResponder(TURN_TIMEOUT_MS)).toBe(25);
  });

  it('a longer run gives the owner turn rounds for its time', async () => {
    const lifetime = 3 * 60_000;
    expect(await roundsThroughResponder(lifetime)).toBe(toolRoundsFor(lifetime - RUN_CLOSE_MARGIN_MS));
    expect(toolRoundsFor(lifetime - RUN_CLOSE_MARGIN_MS)).toBe(31);
  });
});

describe('an owner reply has room to write', () => {
  const replyRequest = async (respond: (responder: ReturnType<typeof createOwnerResponder>, scope: RunEffectScope) => Promise<unknown>) => {
    const api = fakeOpenAI(() => ({ after: 0, body: said('Done.') }));
    const { scope } = runScope();
    await settle(respond(createOwnerResponder(SYNTHETIC_KEY, undefined, undefined, undefined, clock, []), scope));
    return api.requests[0]!.body as { max_output_tokens?: number };
  };

  it('asks for output room for reasoning plus a long answer on an owner turn', async () => {
    expect(await replyRequest((responder, scope) => responder.respond(ownerTyped({ traceId: 'reply', conversationRef: 'owner', surface: 'app', text: 'Plan my day.', memoryWrites: false, runScope: scope }), sameTime))).toMatchObject({ max_output_tokens: 16_384 });
  });

  it('keeps machine turns at the smaller output', async () => {
    expect(await replyRequest((responder) => responder.remind('remind', 'owner', 'Stretch.', sameTime))).toMatchObject({ max_output_tokens: 4096 });
  });
});

describe('background decisions: one resend, and the breaker counts only what was sent', () => {
  const answer = (request: LLMGatewayRequest): LLMGatewayResult => ({
    ok: true, data: { model: request.request.model, text: '{"kind":"no_op","text":""}', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 },
  });
  const miss = (): LLMGatewayResult => ({ ok: false, code: 'transient', error: 'synthetic miss' });
  // The owner DO's base responder, with a scripted model, running calendar-prep decisions.
  const decisions = (script: Array<(request: LLMGatewayRequest) => LLMGatewayResult>) => {
    const sent: Array<Readonly<{ decision: string; request: LLMGatewayRequest }>> = [];
    let decision = '';
    const args: Parameters<typeof createOwnerResponder> = ['fixture'];
    args[10] = { complete: async (request) => { sent.push({ decision, request }); return script.shift()!(request); } };
    const responder = createOwnerResponder(...args);
    const decide = (id: string) => {
      decision = id;
      return settle(responder.prompt(id, 'owner', '[Meeting prep decision] Calendar facts only', sameTime, 'telegram', [], async () => undefined, CALENDAR_PREP_FORMAT));
    };
    return { sent, decide };
  };

  it('resends a missed decision once, unchanged', async () => {
    const { sent, decide } = decisions([miss, answer]);
    expect((await decide('prep')).value).toBe('{"kind":"no_op","text":""}');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.request.request).toEqual(sent[0]!.request.request);
  });

  it('opens the shared breaker on the third failed request in a row, after a success cleared the count', async () => {
    const { sent, decide } = decisions([miss, answer, miss, miss, miss, answer]);
    expect((await decide('a')).value).toBe('{"kind":"no_op","text":""}');
    expect((await decide('b')).error).toBeInstanceOf(Error);
    expect((await decide('c')).error).toBeInstanceOf(Error);
    // a's answer clears its miss; b's two misses and c's first make three, so c's resend is never sent.
    expect(sent.map((entry) => entry.decision)).toEqual(['a', 'a', 'b', 'b', 'c']);
  });
});
