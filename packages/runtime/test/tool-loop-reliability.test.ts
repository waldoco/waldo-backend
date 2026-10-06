import { describe, expect, it } from 'vitest';
import { buildSessionState, getContextArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type LLMToolCall } from '@waldo/contracts';
import { runToolLoop, type ToolLoopEvent, type LoopExit } from '../src/conversation/tool-loop';
import { googleHandlers } from '../src/tools/live/google';
import { getContextHandler } from '../src/tools/live/get-context';
import { webSearchHandler } from '../src/tools/live/web-search';
import { ClosedRunError, type RunEffectScope } from '../src/channels/run-effect-scope';
import { sanitise } from '../src/scribe/sanitiser';
import type { ToolDispatcherContext, DispatchToolOptions } from '../src/tools/dispatcher';

const clock = { timezone: 'UTC', now: () => new Date('2026-10-05T12:00:00Z') };
const context = (): ToolDispatcherContext => ({
  authenticatedUserId: 'synthetic-owner', trigger: 'user_message',
  canaryTokens: ['1111111111111111', '2222222222222222', '3333333333333333'],
  sourceTaint: null, toolArgSourceTaint: null, sanitise, hasApproval: () => true,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1 }),
});
type Handlers = DispatchToolOptions<ToolDispatcherContext>['handlers'];
const calendar = (events: (from?: string) => Promise<never[]>) => googleHandlers(
  { client: async () => ({ events } as never) },
  { propose: async () => 'synthetic', proposeSendEmail: async () => 'synthetic', record: () => undefined },
  clock,
).find((handler) => handler.name === 'query_calendar')!;
const read = { name: 'query_calendar', arguments: '{}' };
async function journey(handlers: Handlers, calls: readonly Omit<LLMToolCall, 'call_id'>[], maxSteps = 10) {
  const events: ToolLoopEvent[] = [];
  let exit: LoopExit | undefined;
  let round = 0;
  await runToolLoop({
    handlers, ctx: context(), maxSteps, onTool: (event) => events.push(event), onSettle: (value) => { exit = value; },
    step: async (tools) => tools && round < calls.length
      ? { text: '', tool_calls: [{ ...calls[round++]!, call_id: `call-${round}` }] }
      : { text: 'synthetic closing' },
  });
  return { events, exit };
}

describe('bounded tool-loop read recovery', () => {
  it('recovers an identical transient Calendar read and keeps the actual error', async () => {
    let attempts = 0;
    const handler = calendar(async () => { if (++attempts === 1) throw Error('synthetic provider timeout'); return []; });
    const { events, exit } = await journey([handler], [read, read]);
    expect(attempts).toBe(2);
    expect(events[0]).toMatchObject({ ok: false, code: 'transient', error: 'synthetic provider timeout' });
    expect(events[1]?.ok).toBe(true);
    expect(exit).toBe('completed');
  });

  it('bounds identical transient reads by the hard round budget and keeps each actual error', async () => {
    let attempts = 0;
    const handler = calendar(async () => { throw Error(`synthetic timeout ${++attempts}`); });
    const { events, exit } = await journey([handler], Array.from({ length: 8 }, () => read), 5);
    expect(attempts).toBe(5);
    expect(events).toHaveLength(5);
    expect(events.map((event) => event.error)).toEqual([1, 2, 3, 4, 5].map((n) => `synthetic timeout ${n}`));
    expect(exit).toBe('budget_exhausted');
  });

  it('recovers on the fourth identical read when the hard budget still permits it', async () => {
    let attempts = 0;
    const handler = calendar(async () => { if (++attempts <= 3) throw Error(`synthetic timeout ${attempts}`); return []; });
    const { events, exit } = await journey([handler], [read, read, read, read], 5);
    expect(attempts).toBe(4);
    expect(events[3]?.ok).toBe(true);
    expect(exit).toBe('completed');
  });

  it('a landed mutation cannot replenish the hard recovery budget', async () => {
    let attempts = 0;
    const handler = calendar(async () => { throw Error(`synthetic timeout ${++attempts}`); });
    const mutation = {
      name: 'get_context' as const, description: 'Synthetic state mutation with no I/O', schema: getContextArgsSchema,
      trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('get_context')),
      autonomy_gated: false, mutates_state: true as const,
      handle: async () => ({ ok: true as const, data: { changed: true }, source_taint: null }),
    };
    const { events, exit } = await journey([handler, mutation], [read, read, read, { name: 'get_context', arguments: '{}' }, read], 4);
    expect(attempts).toBe(3);
    expect(events).toHaveLength(4);
    expect(events[3]?.ok).toBe(true);
    expect(exit).toBe('budget_exhausted');
  });

  it('does not retry identical nonretryable auth errors and retains their cause', async () => {
    let attempts = 0;
    const handler = calendar(async () => []);
    handler.handle = async () => { attempts++; return { ok: false, code: 'auth_failed', error: 'synthetic credentials revoked', source_taint: 'external' }; };
    const { events } = await journey([handler], [read, read]);
    expect(attempts).toBe(1);
    expect(events.every((event) => event.code === 'auth_failed' && event.error === 'synthetic credentials revoked')).toBe(true);
  });

  it('dispatches four distinct empty Calendar date windows', async () => {
    const windows: (string | undefined)[] = [];
    const handler = calendar(async (from) => { windows.push(from); return []; });
    const calls = [1, 2, 3, 4].map((day) => ({ name: 'query_calendar', arguments: JSON.stringify({ date_range: { from: `2026-10-0${day}T00:00:00Z`, to: `2026-10-0${day}T23:59:00Z` } }) }));
    const { events } = await journey([handler], calls);
    expect(windows).toEqual([1, 2, 3, 4].map((day) => `2026-10-0${day}T00:00:00Z`));
    expect(events.every((event) => event.ok)).toBe(true);
  });

  it.each(['UUID', 'cursor', 'revision'])('preserves distinct %s search identities with empty results', async (kind) => {
    let attempts = 0;
    const handler = webSearchHandler('synthetic', async () => { attempts++; return Response.json({ web: { results: [] } }); });
    const identities = [1, 2, 3, 4].map((n) => kind === 'UUID' ? `abcdefab-cdef-4abc-8def-abcdefabcde${n}` : `${kind}-token-${n}-abcdefghijklmno`);
    const { events } = await journey([handler], identities.map((identity) => ({ name: 'web_search', arguments: JSON.stringify({ query: identity }) })));
    expect(attempts).toBe(4);
    expect(events.every((event) => event.ok)).toBe(true);
  });

  it('offers a healthy clock after three distinct failed Calendar reads', async () => {
    const handler = calendar(async () => { throw Error('synthetic provider HTTP 503'); });
    const calls = [1, 2, 3].map((day) => ({ name: 'query_calendar', arguments: JSON.stringify({ date_range: { from: `2026-10-0${day}T00:00:00Z`, to: `2026-10-0${day}T23:59:00Z` } }) }));
    const { events, exit } = await journey([handler, getContextHandler(clock)], [...calls, { name: 'get_context', arguments: '{}' }]);
    expect(events.slice(0, 3).every((event) => event.code === 'transient' && event.error === 'synthetic provider HTTP 503')).toBe(true);
    expect(JSON.parse(events[3]!.output)).toMatchObject({ ok: true, data: { timezone: 'UTC' } });
    expect(exit).toBe('completed');
  });

  it('never retries a transient mutation, even when its completion is ambiguous', async () => {
    let effects = 0;
    const handler = {
      name: 'get_context' as const, description: 'Synthetic state mutation with no I/O', schema: getContextArgsSchema,
      trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('get_context')),
      autonomy_gated: false, mutates_state: true as const,
      handle: async () => { effects++; return { ok: false as const, code: 'transient' as const, error: 'synthetic receipt unavailable' }; },
    };
    const { events } = await journey([handler], Array.from({ length: 4 }, () => ({ name: 'get_context', arguments: '{}' })));
    expect(effects).toBe(1);
    expect(events.every((event) => event.error === 'synthetic receipt unavailable')).toBe(true);
  });

  it('does not deny an executed read when the model omits its final answer', async () => {
    let attempts = 0;
    let steps = 0;
    const handler = calendar(async () => { attempts++; return []; });
    const text = await runToolLoop({ handlers: [handler], ctx: context(), maxSteps: 3,
      step: async () => ++steps === 1 ? { text: '', tool_calls: [{ ...read, call_id: 'call' }] } : { text: '' },
    });
    expect(attempts).toBe(1);
    expect(text).toBe('');
  });

  it('gives an initially empty tool ceiling one bounded refusal and closing step', async () => {
    let steps = 0;
    let observed = '';
    const text = await runToolLoop({ handlers: [], ctx: context(), maxSteps: 2,
      step: async (tools, turns) => {
        expect(tools).toBeUndefined();
        steps++;
        if (steps === 1) return { text: '', tool_calls: [{ name: 'delegate_task', arguments: '{"task":"synthetic"}', call_id: 'call' }] };
        observed = turns[0]?.output ?? '';
        return { text: 'synthetic closing' };
      },
    });
    expect(steps).toBe(2);
    expect(observed).toContain('handler_unavailable');
    expect(text).toBe('synthetic closing');
  });

  it('bounds repeated illegal requests under an empty ceiling without executing them', async () => {
    let steps = 0;
    const budget = { remaining: 3 };
    const text = await runToolLoop({ handlers: [], ctx: context(), maxSteps: 10, budget,
      step: async () => { steps++; return { text: '', tool_calls: [{ name: 'delegate_task', arguments: '{}', call_id: 'call' }] }; },
    });
    expect(steps).toBe(2);
    expect(budget.remaining).toBe(2);
    expect(text).toContain('No tools are available');
  });

  it.each([0, 1])('does not replenish exhausted shared budget under an empty ceiling (remaining %s)', async (remaining) => {
    let steps = 0;
    let exit: LoopExit | undefined;
    const budget = { remaining };
    await runToolLoop({ handlers: [], ctx: context(), maxSteps: 10, budget, onSettle: (value) => { exit = value; },
      step: async () => { steps++; return { text: '', tool_calls: [{ name: 'delegate_task', arguments: '{}', call_id: 'call' }] }; },
    });
    expect(steps).toBe(remaining === 0 ? 1 : 2);
    expect(budget.remaining).toBe(0);
    expect(exit).toBe('budget_exhausted');
  });

  it('rejects calls returned after the local budget is exhausted', async () => {
    let attempts = 0;
    let exit: LoopExit | undefined;
    let steps = 0;
    const handler = calendar(async () => { attempts++; return []; });
    const text = await runToolLoop({ handlers: [handler], ctx: context(), maxSteps: 1,
      onSettle: (value) => { exit = value; },
      step: async () => ++steps < 3 ? { text: '', tool_calls: [{ ...read, arguments: JSON.stringify({ limit: steps }), call_id: `call-${steps}` }] } : { text: 'synthetic closing' },
    });
    expect(attempts).toBe(1);
    expect(exit).toBe('budget_exhausted');
    expect(text).toContain('budget exhausted');
  });

  it('uses a shared hard budget for transient recovery and rejects final-step calls', async () => {
    let attempts = 0;
    const budget = { remaining: 1 };
    const handler = calendar(async () => { throw Error(`synthetic timeout ${++attempts}`); });
    let exit: LoopExit | undefined;
    let steps = 0;
    await runToolLoop({ handlers: [handler], ctx: context(), maxSteps: 10, budget,
      onSettle: (value) => { exit = value; }, step: async () => ++steps < 3 ? { text: '', tool_calls: [{ ...read, call_id: `call-${steps}` }] } : { text: 'synthetic closing' },
    });
    expect(attempts).toBe(1);
    expect(budget.remaining).toBe(0);
    expect(exit).toBe('budget_exhausted');
  });

  it.each(['model', 'handler'])('rejects a late %s result after the scope closes', async (boundary) => {
    let attempts = 0;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const controller = new AbortController();
    const scope: RunEffectScope = {
      runId: 'synthetic-run', attempt: 'synthetic-attempt', deadline: Date.now() + 60_000, signal: controller.signal,
      admit() { if (controller.signal.aborted || Date.now() >= this.deadline) throw new ClosedRunError(); },
      commit(work) { this.admit(); return work(); },
    };
    const handler = calendar(async () => {
      attempts++;
      if (boundary === 'handler') { entered(); await gate; }
      throw Error('synthetic provider timeout');
    });
    const pending = runToolLoop({ handlers: [handler], ctx: { ...context(), runScope: scope }, maxSteps: 10,
      step: async () => {
        if (boundary === 'model') { entered(); await gate; }
        return { text: '', tool_calls: [{ ...read, call_id: 'call' }] };
      },
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(ClosedRunError);
    await ready;
    controller.abort();
    release();
    await rejected;
    expect(attempts).toBe(boundary === 'handler' ? 1 : 0);
  });

  it('keeps a closed-run admission fence ahead of the model and dispatch', async () => {
    let steps = 0;
    let attempts = 0;
    const handler = calendar(async () => { attempts++; return []; });
    await expect(runToolLoop({ handlers: [handler], ctx: { ...context(), runScope: { admit: () => { throw Error('synthetic closed run'); } } as never }, maxSteps: 10,
      step: async () => { steps++; return { text: '', tool_calls: [{ ...read, call_id: 'call' }] }; },
    })).rejects.toThrow('synthetic closed run');
    expect(steps).toBe(0);
    expect(attempts).toBe(0);
  });
});
