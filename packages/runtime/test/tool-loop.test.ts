import { describe, expect, it } from 'vitest';
import { buildSessionState, type LLMTool, type LLMToolTurn } from '@waldo/contracts';
import { runToolLoop } from '../src/conversation/tool-loop';
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

  it('reports an unknown tool to the model instead of throwing', async () => {
    const outputs: string[] = [];
    await runToolLoop({
      handlers, ctx, maxSteps: 1,
      onTool: (event) => outputs.push(event.output),
      step: async (tools) => (tools ? { text: '', tool_calls: [{ call_id: 'x', name: 'launch_rocket', arguments: '{}' }] } : { text: 'ok' }),
    });
    expect(JSON.parse(outputs[0]!)).toEqual({ ok: false, error: 'Unknown tool launch_rocket.' });
  });
});
