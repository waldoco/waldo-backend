import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionState, getCrsArgsSchema, LLM_TOOL_TURNS_MAX, OPENAI_GPT_6_LUNA_MODEL, OPENAI_PROVIDER, sendMessageArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type LLMToolTurn, type ToolHandler } from '@waldo/contracts';
import { runToolLoop, unfinishedReply, type LoopExit } from '../src/conversation/tool-loop';
import { delegateTaskHandler, runChildLoop, SUBAGENT_ROUND_SHARE } from '../src/conversation/subagent';
import { dispatchTool, MAX_TOOL_ERROR_CHARS, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { inMemoryToolOutputStore } from '../src/conversation/tool-output-store';
import { OpenAIResponsesAdapter, type OpenAIResponsesClient } from '../src/llm/openai';
import { ownerTurnEffort, spendPosture } from '../src/llm/cost-ledger';
import { getContextHandler } from '../src/tools/live/get-context';
import { resolveRunLoopAdapters } from '../src/run-loop/adapters';
import type { LLMGatewayRequest } from '../src/llm/provider';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = (): ToolDispatcherContext => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message', canaryTokens: CANARIES,
  sourceTaint: null, toolArgSourceTaint: null, hasApproval: () => true,
  sanitise: adapters.safety.sanitise,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: Date.now() }),
});
const clock = { timezone: 'UTC', now: () => new Date('2026-10-13T12:00:00Z') };
const read = getContextHandler(clock);
let reads = 0;
const countedRead = { ...read, handle: async (...args: Parameters<typeof read.handle>) => { reads += 1; return read.handle(...args); } };
const contextCall = (id: string, args = '{}') => ({ call_id: id, name: 'get_context', arguments: args });
let sends = 0;
const send = {
  name: 'send_message' as const, description: 'Queue a message.', schema: sendMessageArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((t) => TOOL_PERMISSIONS[t].includes('send_message')),
  autonomy_gated: true,
  handle: async () => { sends += 1; return { ok: true as const, data: { queued: true }, source_taint: null }; },
};
const SEND_ARGS = `{"channel":"telegram","content":"hi","idempotency_key":"${'c'.repeat(64)}"}`;

beforeEach(() => { vi.useFakeTimers(); reads = 0; sends = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('a repeated read', () => {
  const loop = (script: (n: number) => readonly { call_id: string; name: string; arguments: string }[] | null, handlers: readonly unknown[] = [countedRead]) => {
    const outputs: string[] = [];
    let n = 0;
    const done = runToolLoop({
      handlers: handlers as never, ctx: ctx(), maxSteps: 25, onTool: (event) => outputs.push(event.output),
      step: async (tools) => {
        n += 1;
        const calls = tools ? script(n) : null;
        return calls ? { text: '', tool_calls: [...calls] } : { text: 'done.' };
      },
    });
    return { done, outputs };
  };

  it('is refused when nothing ran since the same read moments ago', async () => {
    const run = loop((n) => n <= 2 ? [contextCall(`c${n}`)] : null);
    expect(await run.done).toBe('done.');
    expect(reads).toBe(1);
    expect(run.outputs[1]).toContain('repeat_refusal');
  });

  it('runs again once another call ran in between', async () => {
    const run = loop((n) => n === 1 ? [contextCall('a')] : n === 2 ? [contextCall('b', '{"topic":"x"}')] : n === 3 ? [contextCall('c')] : null);
    await run.done;
    expect(run.outputs.map((output) => output.includes('repeat_refusal'))).toEqual([false, false, false]);
    expect(reads).toBe(3);
  });

  it('runs again back to back once time has passed', async () => {
    const run = loop((n) => {
      if (n === 2) vi.setSystemTime(Date.now() + 30_000);
      return n <= 2 ? [contextCall(`c${n}`)] : null;
    });
    await run.done;
    expect(reads).toBe(2);
    expect(run.outputs[1]).not.toContain('repeat_refusal');
  });

  it('never re-sends a landed mutation, whatever ran in between or however long ago', async () => {
    const run = loop((n) => {
      if (n === 3) vi.setSystemTime(Date.now() + 120_000);
      return n === 1 ? [{ call_id: 'm1', name: 'send_message', arguments: SEND_ARGS }]
        : n === 2 ? [contextCall('r1')]
          : n === 3 ? [{ call_id: 'm2', name: 'send_message', arguments: SEND_ARGS }] : null;
    }, [countedRead, send]);
    await run.done;
    expect(sends).toBe(1);
    expect(run.outputs[2]).toContain('Same call already made this turn');
  });
});

describe('the end of a turn', () => {
  it('stays quiet until the last rounds, then says what is left to do', async () => {
    const seen: string[] = [];
    let n = 0;
    await runToolLoop({
      handlers: [read], ctx: ctx(), maxSteps: 25,
      onTool: (event) => seen.push(event.output),
      step: async (tools) => { n += 1; return tools ? { text: '', tool_calls: [contextCall(`c${n}`, `{"topic":"t${n}"}`)] } : { text: 'answer' }; },
    });
    const noted = seen.map((output) => output.includes('[budget:'));
    expect(noted.slice(0, 22).some(Boolean)).toBe(false);
    expect(noted.slice(22)).toEqual([true, true, true]);
    expect(seen.at(-1)).toContain('what is left');
  });

  it('warns about time only when the tool time is nearly gone', async () => {
    const seen: string[] = [];
    let n = 0;
    await runToolLoop({
      handlers: [read], ctx: ctx(), maxSteps: 25, budget: { remaining: 25, deadline: Date.now() + 120_000 },
      onTool: (event) => seen.push(event.output),
      step: async (tools) => {
        n += 1;
        vi.setSystemTime(Date.now() + 15_000);
        return tools ? { text: '', tool_calls: [contextCall(`c${n}`, `{"topic":"t${n}"}`)] } : { text: 'answer' };
      },
    });
    // Results land every 15 s; the last tool round starts with 30 s left (one answer call's time) and lands at 105 s.
    // Only the results with under 15 s of tool time left carry a note.
    expect(seen.map((output) => output.includes('[budget:'))).toEqual([false, false, false, false, false, true, true]);
  });

  it('hands back progress and offers to continue when the rounds run out and the model says nothing', async () => {
    let n = 0;
    let exit: LoopExit | undefined;
    const text = await runToolLoop({
      handlers: [read], ctx: ctx(), maxSteps: 2, onSettle: (value) => { exit = value; },
      step: async (tools) => { n += 1; return tools ? { text: '', tool_calls: [contextCall(`c${n}`, `{"topic":"t${n}"}`)] } : { text: '' }; },
    });
    expect(exit).toBe('budget_exhausted');
    expect(text).toBe(unfinishedReply('budget_exhausted', ['get_context']));
    expect(text).toContain('get context');
    expect(text).toMatch(/continue/);
  });

  it('hands back progress when no time is left for an answer', async () => {
    const text = await runToolLoop({
      handlers: [read], ctx: ctx(), maxSteps: 25, budget: { remaining: 25, deadline: Date.now() + 120_000 },
      step: async (tools) => {
        if (!tools) throw new Error('no answer step expected');
        vi.setSystemTime(Date.now() + 120_001);
        return { text: '', tool_calls: [contextCall('c1')] };
      },
    });
    expect(text).toBe(unfinishedReply('time_exhausted', ['get_context']));
  });

  it('says nothing was finished when no step completed', () => {
    const text = unfinishedReply('time_exhausted', []);
    expect(text).toMatch(/ran out of time/);
    expect(text).toMatch(/continue/);
    expect(unfinishedReply('budget_exhausted', ['a', 'b', 'a'])).toContain('a, b.');
  });
});

describe('a long turn', () => {
  it('never sends the model more tool results than a request may carry, and says what was set aside', async () => {
    const sizes: number[] = [];
    let last: readonly LLMToolTurn[] = [];
    let n = 0;
    await runToolLoop({
      handlers: [read], ctx: ctx(), maxSteps: LLM_TOOL_TURNS_MAX + 6,
      step: async (tools, turns) => {
        sizes.push(turns.length);
        last = turns;
        n += 1;
        return tools ? { text: '', tool_calls: [contextCall(`c${n}`, `{"topic":"t${n}"}`)] } : { text: 'answer' };
      },
    });
    expect(Math.max(...sizes)).toBe(LLM_TOOL_TURNS_MAX);
    expect(last[0]!.output).toMatch(/earlier in this turn: \d+ older tool results/);
    expect(last.at(-1)!.call.call_id).toBe(`c${LLM_TOOL_TURNS_MAX + 6}`);
  });

  it('keeps a round whole when it trims, so its reasoning still precedes its calls', async () => {
    let last: readonly LLMToolTurn[] = [];
    let n = 0;
    await runToolLoop({
      handlers: [read], ctx: ctx(), maxSteps: 40,
      step: async (tools, turns) => {
        last = turns;
        n += 1;
        return tools ? { text: '', output_items: [{ type: 'reasoning', id: `rs_${n}` }], tool_calls: [contextCall(`a${n}`, `{"topic":"a${n}"}`), contextCall(`b${n}`, `{"topic":"b${n}"}`), contextCall(`c${n}`, `{"topic":"c${n}"}`)] } : { text: 'answer' };
      },
    });
    expect(last.length).toBeLessThanOrEqual(LLM_TOOL_TURNS_MAX);
    expect(last[0]!.prior_items).toBeDefined();
    expect(last[0]!.call.call_id.startsWith('a')).toBe(true);
  });
});

describe('a subagent', () => {
  const childInput = (budget: { remaining: number; deadline?: number }, rounds: { n: number }) => ({
    handlers: [read], ctx: ctx(), budget, controlRound: () => '', onTool: () => undefined,
    complete: async (_content: string, tools: readonly unknown[] | undefined) => {
      if (!tools) return { text: 'child report' };
      rounds.n += 1;
      return { text: '', tool_calls: [contextCall(`k${rounds.n}`, `{"topic":"k${rounds.n}"}`)] };
    },
  });

  it('gets a share of what the parent has left, not a fixed slice', async () => {
    const wide = { n: 0 };
    await runChildLoop('research', childInput({ remaining: 100 }, wide));
    expect(wide.n).toBe(Math.floor(100 * SUBAGENT_ROUND_SHARE));
    const narrow = { n: 0 };
    await runChildLoop('research', childInput({ remaining: 5 }, narrow));
    expect(narrow.n).toBe(Math.floor(5 * SUBAGENT_ROUND_SHARE));
  });

  it('always gets at least one round while the parent has any', async () => {
    const rounds = { n: 0 };
    await runChildLoop('research', childInput({ remaining: 1 }, rounds));
    expect(rounds.n).toBe(1);
  });

  it('hands back its whole partial answer when it runs out', async () => {
    const partial = `${'finding '.repeat(150)}END`;
    const handler = delegateTaskHandler(async () => ({ exit: 'budget_exhausted', text: partial }));
    const result = await handler.handle({ task: 'research' } as never, ctx());
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain(partial);
  });
});

describe('a tool error', () => {
  const failing = (error: string): ToolHandler<never, never, ToolDispatcherContext> => ({
    name: 'get_crs', description: 'Return a derived CRS summary.', schema: getCrsArgsSchema as never,
    trigger_allowlist: triggerTypeSchema.options.filter((t) => TOOL_PERMISSIONS[t].includes('get_crs')), autonomy_gated: false,
    handle: async () => ({ ok: false, error, code: 'transient' }) as never,
  });
  const call = { id: 'call-error', name: 'get_crs' as const, args: { range_days: 1 } };

  it('keeps a diagnostic well past the old 512 characters', async () => {
    const error = `upstream said: ${'detail '.repeat(150)}`.trim();
    const result = await dispatchTool(call, ctx(), { handlers: [failing(error)] });
    expect(result).toMatchObject({ ok: false, error, reason: 'tool_result_error' });
  });

  it('stores an oversized error whole and shows its head when outputs can be stored', async () => {
    const store = inMemoryToolOutputStore();
    const error = `trace ${'x'.repeat(20_000)}`;
    const result = await dispatchTool(call, ctx(), { handlers: [failing(error)], offload: store });
    const shown = (result as { error: string }).error;
    expect(shown.startsWith(error.slice(0, MAX_TOOL_ERROR_CHARS))).toBe(true);
    const id = /full error stored as (\S+?):/.exec(shown)?.[1];
    expect(id).toBeDefined();
    expect(store.read(id!, 0, 30_000)?.text).toBe(error);
    expect(shown.length).toBeLessThan(MAX_TOOL_ERROR_CHARS + 300);
  });

  it('cuts an oversized error at the bound when nothing can store it', async () => {
    const error = `trace ${'x'.repeat(20_000)}`;
    const result = await dispatchTool(call, ctx(), { handlers: [failing(error)] });
    const shown = (result as { error: string }).error;
    expect(shown.startsWith(error.slice(0, MAX_TOOL_ERROR_CHARS))).toBe(true);
    expect(shown).toContain(`[cut: ${error.length - MAX_TOOL_ERROR_CHARS} more characters]`);
  });

  it('never shows an oversized error the offload guard refuses', async () => {
    const error = `leak ${CANARIES[0]} ${'x'.repeat(20_000)}`;
    const result = await dispatchTool(call, ctx(), { handlers: [failing(error)], offload: inMemoryToolOutputStore() });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).not.toContain(CANARIES[0]);
  });
});

describe('reasoning effort', () => {
  const request = (effort?: 'low' | 'medium'): LLMGatewayRequest => ({
    request: { model: OPENAI_GPT_6_LUNA_MODEL, messages: [{ role: 'user', content: 'Hi.' }], max_tokens: 32, temperature: 0, ...(effort ? { reasoning_effort: effort } : {}) },
    route: { trigger: 'user_message', primary: { provider: OPENAI_PROVIDER, model: OPENAI_GPT_6_LUNA_MODEL, cache: 'none' }, fallback: [], floor: 'template' },
    step: { provider: OPENAI_PROVIDER, model: OPENAI_GPT_6_LUNA_MODEL, cache: 'none' },
    context: 'full_context', fallback_step: 'configured_model', headers: { 'cf-aig-collect-log-payload': 'false' },
  });
  const sentEffort = async (effort?: 'low' | 'medium') => {
    let sent: { reasoning?: { effort?: string } } | undefined;
    const client = { responses: { create: async (body: typeof sent) => { sent = body; return { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } }; } } } as unknown as OpenAIResponsesClient;
    await new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client }).complete(request(effort));
    return sent?.reasoning?.effort;
  };

  it('sends the effort the request asks for, and low when it names none', async () => {
    expect(await sentEffort('medium')).toBe('medium');
    expect(await sentEffort()).toBe('low');
  });

  it('owner turns think at medium until the cost brake engages', () => {
    expect(ownerTurnEffort(undefined)).toBe('medium');
    expect(ownerTurnEffort(spendPosture(7.9, 10))).toBe('medium');
    expect(ownerTurnEffort(spendPosture(8, 10))).toBe('low');
    expect(ownerTurnEffort(spendPosture(12, 10))).toBe('low');
  });
});
