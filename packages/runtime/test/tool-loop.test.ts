import { describe, expect, it } from 'vitest';
import { buildSessionState, type LLMTool, type LLMToolTurn } from '@waldo/contracts';
import { capToolOutput, NO_PROGRESS_LIMIT, runToolLoop, TOOL_OUTPUT_LIMIT, WARN_WINDOW_ROUNDS } from '../src/conversation/tool-loop';
import { googleHandlers } from '../src/tools/live/google';
import { resolveRunLoopAdapters } from '../src/run-loop/adapters';
import { getContextHandler } from '../src/tools/live/get-context';
import { webSearchHandler } from '../src/tools/live/web-search';

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

describe('external taint through the model boundary', () => {
  it('a successful external result keeps source_taint external in the JSON the model reads; internal results stay untainted', async () => {
    const seen: (readonly LLMToolTurn[])[] = [];
    const web = webSearchHandler('test-key', async () => Response.json({ web: { results: [{ title: 'T', url: 'https://x.test', description: 'D' }] } }));
    const text = await runToolLoop({
      handlers: [...handlers, web], ctx, maxSteps: 4,
      step: async (_tools, turns) => {
        seen.push(turns);
        if (turns.length === 0) return { text: '', tool_calls: [{ call_id: 'c1', name: 'web_search', arguments: '{"query":"q"}' }] };
        if (turns.length === 1) return { text: '', tool_calls: [{ call_id: 'c2', name: 'get_context', arguments: '{}' }] };
        return { text: 'done' };
      },
    });
    expect(text).toBe('done');
    const webOut = JSON.parse(seen[1]![0]!.output);
    expect(webOut.ok).toBe(true);
    expect(webOut.source_taint).toBe('external'); // provider text never presents as internal truth
    const internalOut = JSON.parse(seen[2]![1]!.output);
    expect(internalOut.ok).toBe(true);
    expect(internalOut.source_taint).toBeUndefined();
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

describe('warn-first budget notice and semantic no-progress', () => {
  const okFetcher = async (): Promise<Response> =>
    Response.json({ web: { results: [{ title: 'T', url: 'https://x.test', description: 'D' }] } });

  it('attaches a remaining-rounds notice inside the last WARN_WINDOW_ROUNDS rounds and still hard-stops at the cap', async () => {
    const web = webSearchHandler('test-key', okFetcher);
    const seenAt: string[][] = [];
    let n = 0;
    const maxSteps = WARN_WINDOW_ROUNDS + 3;
    const text = await runToolLoop({
      handlers: [web], ctx, maxSteps,
      step: async (tools, turns) => {
        seenAt.push(turns.map((t) => t.output));
        n += 1;
        return tools ? { text: '', tool_calls: [{ call_id: `w${n}`, name: 'web_search', arguments: `{"query":"topic ${n}"}` }] } : { text: 'wrapped up.' };
      },
    });
    expect(text).toBe('wrapped up.');
    expect(seenAt[1]![0]).not.toContain('[budget:');
    expect(seenAt.some((turns) => turns.some((o) => o.includes('[budget: 4 tool rounds left this turn - start wrapping up')))).toBe(true);
    expect(seenAt.some((turns) => turns.some((o) => o.includes('[budget: 2 tool rounds left this turn - wrap up and answer now')))).toBe(true);
    const lastDelivered = seenAt[seenAt.length - 1]!;
    expect(lastDelivered[lastDelivered.length - 1]).toContain('[budget: tool budget exhausted this turn');
  });

  it('refuses a call whose stabilized (tool, args, result) triple repeats NO_PROGRESS_LIMIT times, pre-dispatch', async () => {
    let fetched = 0;
    const volatileFetcher = async (): Promise<Response> => {
      fetched += 1;
      return Response.json({ web: { results: [{ title: 'T', url: 'https://x.test', description: 'D', request_id: `req-${fetched}-0123456789abcdef`, at: `2026-09-26T10:0${fetched}:00Z` }] } });
    };
    const web = webSearchHandler('test-key', volatileFetcher);
    let n = 0;
    const outputs: string[] = [];
    const text = await runToolLoop({
      handlers: [web], ctx, maxSteps: 25,
      onTool: (e) => outputs.push(e.output),
      step: async (tools) => {
        n += 1;
        return tools ? { text: '', tool_calls: [{ call_id: `p${n}`, name: 'web_search', arguments: `{"query":"status check cursor-token-${n}-abcdefgh"}` }] } : { text: 'stopped.' };
      },
    });
    expect(text).toBe('stopped.');
    expect(fetched).toBe(NO_PROGRESS_LIMIT);
    expect(outputs[outputs.length - 1]).toContain('No progress');
  });

  it('does not flag calls whose small-integer args genuinely differ (pagination survives stabilization)', async () => {
    let fetched = 0;
    const web = webSearchHandler('test-key', async (): Promise<Response> => { fetched += 1; return okFetcher(); });
    let n = 0;
    const text = await runToolLoop({
      handlers: [web], ctx, maxSteps: 25,
      step: async (tools) => {
        n += 1;
        return tools && n <= 5 ? { text: '', tool_calls: [{ call_id: `g${n}`, name: 'web_search', arguments: `{"query":"topic page ${n}"}` }] } : { text: 'done.' };
      },
    });
    expect(text).toBe('done.');
    expect(fetched).toBe(5);
  });
});

describe('refusals never feed the failure streak', () => {
  it('refusal-only rounds neither withdraw tools nor reset a genuine failure streak', async () => {
    let n = 0;
    const offered: boolean[] = [];
    const text = await runToolLoop({
      handlers, ctx, maxSteps: 25,
      step: async (tools) => {
        offered.push(tools !== undefined);
        n += 1;
        if (!tools) return { text: 'closed.' };
        // rounds 1-2: same identical call (2nd is refused); round 3: unknown tool (genuine
        // failure); rounds 4-5: refusals again. If refusals fed the streak, tools would be
        // withdrawn by round 4-5.
        if (n <= 2) return { text: '', tool_calls: [call] };
        if (n === 3) return { text: '', tool_calls: [{ call_id: 'x3', name: 'launch_rocket', arguments: '{"limit":1}' }] };
        if (n <= 6) return { text: '', tool_calls: [call] };
        return { text: 'closed.' };
      },
    });
    expect(text).toBe('closed.');
    // Tools were still offered after two refusal rounds + one genuine failure + three more
    // refusal rounds: the streak only reached 1, never FAILED_ROUNDS_LIMIT, so the loop never
    // withdrew tools before the model chose to close.
    expect(offered).toEqual([true, true, true, true, true, true, true]);
  });
});
