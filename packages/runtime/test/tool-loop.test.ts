import { describe, expect, it } from 'vitest';
import { buildSessionState, type LLMTool, type LLMToolTurn } from '@waldo/contracts';
import { capToolOutput, runToolLoop, TOOL_OUTPUT_LIMIT } from '../src/conversation/tool-loop';
import { googleHandlers } from '../src/tools/live/google';
import { resolveRunLoopAdapters } from '../src/run-loop/adapters';
import { getContextHandler } from '../src/tools/live/get-context';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = {
  authenticatedUserId: 'owner-1', trigger: 'user_message' as const, canaryTokens: CANARIES,
  sourceTaint: null, toolArgSourceTaint: null,
  sanitise: adapters.safety.sanitise, medicalGate: adapters.safety.medicalGate,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }),
};
const handlers = [getContextHandler({ timezone: 'Asia/Kolkata', now: () => new Date('2026-09-23T08:20:00Z') })];
const call = { call_id: 'c1', name: 'get_context', arguments: '{}' };

describe('runToolLoop', () => {
  it('runs a tool through the dispatcher and hands its result back to the model', async () => {
    const seen: (readonly LLMToolTurn[])[] = [];
    const text = await runToolLoop({
      handlers, ctx, maxSteps: 4,
      step: async (tools, turns) => {
        seen.push(turns);
        return turns.length === 0 ? { text: '', tool_calls: [call] } : { text: 'It is 1:50 pm.' };
      },
    });
    expect(text).toBe('It is 1:50 pm.');
    expect(JSON.parse(seen[1]![0]!.output)).toMatchObject({ ok: true, data: { timezone: 'Asia/Kolkata', local_time: expect.stringContaining('13:50') } });
  });

  it('refuses a repeated identical call and ends with no tools offered', async () => {
    const offered: (readonly LLMTool[] | undefined)[] = [];
    const outputs: string[] = [];
    const text = await runToolLoop({
      handlers, ctx, maxSteps: 2,
      onTool: (event) => outputs.push(event.output),
      step: async (tools) => {
        offered.push(tools);
        return tools ? { text: '', tool_calls: [call] } : { text: 'Done.' };
      },
    });
    expect(text).toBe('Done.');
    expect(offered.map((tools) => tools?.map((tool) => tool.name))).toEqual([['get_context'], ['get_context'], undefined]);
    expect(JSON.parse(outputs[1]!)).toMatchObject({ ok: false });
  });

  it('withdraws tools after three rounds in a row where every call failed', async () => {
    const offered: boolean[] = [];
    let n = 0;
    const text = await runToolLoop({
      handlers, ctx, maxSteps: 25,
      step: async (tools) => {
        offered.push(tools !== undefined);
        n += 1;
        return tools ? { text: '', tool_calls: [{ call_id: `x${n}`, name: 'launch_rocket', arguments: `{"limit":${n}}` }] } : { text: 'Could not do that.' };
      },
    });
    expect(text).toBe('Could not do that.');
    expect(offered).toEqual([true, true, true, false]);
  });

  it('reports an unknown tool to the model instead of throwing', async () => {
    const outputs: string[] = [];
    await runToolLoop({
      handlers, ctx, maxSteps: 1,
      onTool: (event) => outputs.push(event.output),
      step: async (tools) => (tools ? { text: '', tool_calls: [{ call_id: 'x', name: 'launch_rocket', arguments: '{}' }] } : { text: 'ok' }),
    });
    expect(JSON.parse(outputs[0]!)).toEqual({ ok: false, error: 'Unknown tool launch_rocket.' });
  });

  it('caps an oversized tool result and says how much was cut', () => {
    const big = 'x'.repeat(TOOL_OUTPUT_LIMIT + 500);
    const capped = capToolOutput(big);
    expect(capped.startsWith('x'.repeat(TOOL_OUTPUT_LIMIT))).toBe(true);
    expect(capped).toContain('[cut: 500 more characters not shown; narrow the request]');
    expect(capToolOutput('small')).toBe('small');
  });
});

describe('reasoning passback', () => {
  it('threads response output items into the next round first turn', async () => {
    const seenTurns: Array<readonly unknown[]> = [];
    const text = await runToolLoop({
      handlers: [],
      ctx: {} as never,
      maxSteps: 3,
      step: async (_tools, turns) => {
        seenTurns.push(turns);
        if (turns.length === 0) {
          return { text: '', tool_calls: [{ call_id: 'c1', name: 'get_context', arguments: '{}' }], output_items: [{ type: 'reasoning', id: 'rs_1' }, { type: 'function_call', call_id: 'c1' }] };
        }
        return { text: 'done' };
      },
    });
    expect(text).toBe('done');
    const first = seenTurns[1]![0] as { prior_items?: unknown[] };
    expect(first.prior_items).toHaveLength(2);
  });
});

// S4 (CONNECT_FLOW_DESIGN 4.4): a tool's typed auth intent reaches the channel's offerConnect
// seam exactly once per (service, reason) per turn, even across repeated failing calls.
describe('runToolLoop connect intents', () => {
  // The REAL tier-2 handler with no Google connection - the intent comes from production code.
  const failing = googleHandlers(
    { client: async () => null },
    { propose: async () => 'p', proposeSendEmail: async () => 'p', record: () => undefined },
    { timezone: 'UTC', now: () => new Date() },
  ).find((h) => h.name === 'query_calendar')!;

  it('fires onConnect once per (service, reason) per turn, on the first failure only', async () => {
    const offered: string[] = [];
    let n = 0;
    await runToolLoop({
      handlers: [failing as never], ctx, maxSteps: 6,
      onConnect: async (intent) => { offered.push(`${intent.service}:${intent.reason}:${intent.feature}`); return true; },
      step: async (tools) => {
        n += 1;
        return tools ? { text: '', tool_calls: [{ call_id: `c${n}`, name: 'query_calendar', arguments: `{"limit":${n}}` }] } : { text: 'done' };
      },
    });
    expect(offered).toEqual(['google:not_connected:calendar']);
  });

  it('a throwing offerConnect never breaks the turn', async () => {
    const text = await runToolLoop({
      handlers: [failing as never], ctx, maxSteps: 2,
      onConnect: async () => { throw new Error('telegram down'); },
      step: async (tools) => (tools ? { text: '', tool_calls: [{ call_id: 'c1', name: 'query_calendar', arguments: '{}' }] } : { text: 'still answered' }),
    });
    expect(text).toBe('still answered');
  });

  it('the intent rides the model-visible tool output as data, never as a link', async () => {
    const outputs: string[] = [];
    await runToolLoop({
      handlers: [failing as never], ctx, maxSteps: 1,
      onTool: (event) => outputs.push(event.output),
      step: async (tools) => (tools ? { text: '', tool_calls: [{ call_id: 'c1', name: 'query_calendar', arguments: '{}' }] } : { text: 'done' }),
    });
    expect(JSON.parse(outputs[0]!)).toMatchObject({ ok: false, connect: { status: 'auth_required', service: 'google' } });
    expect(outputs[0]).not.toMatch(/https?:|state=/);
  });
});
