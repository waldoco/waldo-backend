import { describe, expect, it } from 'vitest';
import { buildSessionState, EXTERNAL_ORIGIN_TOOLS, TOOL_PERMISSIONS, type LLMToolCall, type LLMToolTurn, type ToolHandler, type ToolName, type TriggerType } from '@waldo/contracts';
import { HEALTH_FENCED_TOOLS } from '../src/conversation/health-fence';
import { runToolLoop } from '../src/conversation/tool-loop';
import { TOOL_ARG_SCHEMAS } from '../src/hooks/registry';
import { sanitise } from '../src/scribe/sanitiser';
import { EGRESS_READ_TOOLS } from '../src/tasks/profiles';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

// Once the model has been shown the owner's health readings beside outside content, a call it makes could carry a reading
// out at the outside content's request. So from the next call on, nothing that sends model-chosen text to a third party runs
// for the rest of the turn, in either order. Reads that stay in the owner's accounts go on. Synthetic readings only.
const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const READING = '67.4';
const allowlist = (tool: ToolName): TriggerType[] => (Object.keys(TOOL_PERMISSIONS) as TriggerType[]).filter((trigger) => TOOL_PERMISSIONS[trigger].includes(tool));
const context = (over: Partial<ToolDispatcherContext> = {}): ToolDispatcherContext => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message', canaryTokens: CANARIES, sourceTaint: null, toolArgSourceTaint: null,
  sanitise, hasApproval: () => true, turnId: 'turn-1', egressAllowlist: ['example.com'], ownerInitiated: true,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: Date.now() }),
  ...over,
});
const READINGS = { state: 'available', timezone: 'UTC', from: '2026-10-12', to: '2026-10-12', signals: [{ signal: 'hrv', unit: 'ms', source: 'apple', method: 'sdnn', days: [{ day: '2026-10-12', value: Number(READING) }] }] };
const fakes = () => {
  const ran: string[] = [];
  const handler = (tool: ToolName, data: unknown): ToolHandler<unknown, unknown, ToolDispatcherContext> => ({
    name: tool, description: tool, schema: TOOL_ARG_SCHEMAS[tool] as never, trigger_allowlist: allowlist(tool), autonomy_gated: false,
    handle: async (args) => { ran.push(`${tool} ${JSON.stringify(args)}`); return { ok: true, data, source_taint: EXTERNAL_ORIGIN_TOOLS.includes(tool) ? 'external' : null }; },
  });
  return { ran, handlers: [
    handler('get_health', READINGS), handler('query_calendar', { events: [{ title: 'Board call' }] }), handler('web_search', { results: [] }),
    handler('read_mcp_tool', { text: 'ok' }), handler('get_context', { now: '2026-10-13T06:30' }),
  ] };
};
const call = (id: string, name: string, args: unknown): LLMToolCall => ({ call_id: id, name, arguments: JSON.stringify(args) });
const HEALTH = call('h', 'get_health', { signals: ['hrv'], from: '2026-10-12', to: '2026-10-12' });
const CALENDAR = call('c', 'query_calendar', { date_range: { from: '2026-10-14T00:00:00Z', to: '2026-10-15T00:00:00Z' } });
const SEARCH = call('s', 'web_search', { query: `hrv ${READING} meaning` });
// One round per entry, then a reply; returns the turns of the last request and what each round's request held.
const scripted = async (rounds: readonly (readonly LLMToolCall[])[], ctx = context()) => {
  const { ran, handlers } = fakes();
  let last: readonly LLMToolTurn[] = [];
  let round = 0;
  await runToolLoop({ handlers, ctx, maxSteps: 10, step: async (_tools, turns) => { last = turns; return round < rounds.length ? { text: '', tool_calls: [...rounds[round++]!] } : { text: 'Done.' }; } });
  const outcome = (id: string) => JSON.parse(last.find((turn) => turn.call.call_id === id)!.output) as { ok: boolean; error_code?: string };
  return { ran, last, outcome };
};

describe('health readings beside outside text fence every call that sends text out', () => {
  it('outside text first, then the readings: the next search is refused and nothing is sent', async () => {
    const { ran, last, outcome } = await scripted([[CALENDAR], [HEALTH], [SEARCH]]);
    expect(last.find((turn) => turn.call.call_id === 'h')!.output).toContain(READING);
    expect(outcome('s')).toMatchObject({ ok: false, error_code: 'egress_denied' });
    expect(ran.filter((line) => line.startsWith('web_search'))).toEqual([]);
  });

  it('the readings first, then outside text: the next search is refused and nothing is sent', async () => {
    const { ran, outcome } = await scripted([[HEALTH], [CALENDAR], [SEARCH]]);
    expect(outcome('s')).toMatchObject({ ok: false, error_code: 'egress_denied' });
    expect(ran.filter((line) => line.startsWith('web_search'))).toEqual([]);
  });

  it('both in one round: every call that sends text out is refused from the next round on, and own-account reads go on', async () => {
    const egress = [...HEALTH_FENCED_TOOLS].map((tool, index) => call(`e${index}`, tool, {}));
    const wrapped = [call('p1', 'propose_action', { tool: 'web_search', args: { query: READING }, reasoning: 'r' }), call('p2', 'use_tool', { name: 'web_search', arguments: { query: READING } })];
    const { ran, outcome } = await scripted([[HEALTH, CALENDAR], [...egress, ...wrapped, call('g', 'get_context', {})]]);
    for (const [index] of [...HEALTH_FENCED_TOOLS].entries()) expect(outcome(`e${index}`), [...HEALTH_FENCED_TOOLS][index]).toMatchObject({ ok: false, error_code: 'egress_denied' });
    expect(outcome('p1')).toMatchObject({ ok: false, error_code: 'egress_denied' });
    expect(outcome('g')).toMatchObject({ ok: true });
    expect(ran.filter((line) => !line.startsWith('get_health') && !line.startsWith('query_calendar') && !line.startsWith('get_context'))).toEqual([]);
  });

  it('a turn started on outside text (a forward) is fenced as soon as the readings are shown', async () => {
    const { outcome } = await scripted([[HEALTH], [SEARCH]], context({ toolArgSourceTaint: 'external' }));
    expect(outcome('s')).toMatchObject({ ok: false, error_code: 'egress_denied' });
  });

  it('readings alone, or outside text alone, leave the search running', async () => {
    for (const rounds of [[[HEALTH], [SEARCH]], [[CALENDAR], [SEARCH]]]) {
      const { ran, outcome } = await scripted(rounds);
      expect(outcome('s')).toMatchObject({ ok: true });
      expect(ran.some((line) => line.startsWith('web_search'))).toBe(true);
    }
  });

  it('a task worker\'s remote loop is fenced the same way', async () => {
    const { handlers } = fakes();
    const sent: string[] = [];
    const dispatch = async (made: LLMToolCall) => {
      sent.push(made.name);
      const handler = handlers.find((entry) => entry.name === made.name)!;
      const result = await handler.handle(JSON.parse(made.arguments), context());
      return { ...result, ...(result.ok ? {} : {}) } as never;
    };
    let round = 0;
    const rounds = [[HEALTH, CALENDAR], [SEARCH]];
    await runToolLoop({ handlers: [], ctx: context(), maxSteps: 10, remote: { tools: handlers.map((handler) => ({ name: handler.name, description: handler.name, parameters: { type: 'object' } })) as never, dispatch },
      step: async () => (round < rounds.length ? { text: '', tool_calls: [...rounds[round++]!] } : { text: 'Done.' }) });
    expect(sent).toEqual(['get_health', 'query_calendar']);
  });

  it('fences the reads that send text out and every other tool that carries model-chosen text to a third party', () => {
    expect([...HEALTH_FENCED_TOOLS].sort()).toEqual([...EGRESS_READ_TOOLS, 'browse_act', 'call_mcp_tool', 'delegate_task', 'start_task'].sort());
  });
});
