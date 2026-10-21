import { expect, it } from 'vitest';
import { z } from 'zod';
import { buildSessionState, TOOL_PERMISSIONS, triggerTypeSchema, type LLMToolTurn, type ToolName } from '@waldo/contracts';
import { clearedToolResult, runToolLoop, TOOL_OUTPUT_LIMIT, TOOL_RESULTS_KEEP_CHARS } from '../src/conversation/tool-loop';
import { resolveRunLoopAdapters } from '../src/llm/run-loop-adapters';

// A long turn resends every earlier result each round. Old results are cleared first, before anything else gives way:
// the newest round always reaches the model whole, the calls stay visible, and what was cleared stays cleared.

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = () => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message' as const, canaryTokens: CANARIES, sourceTaint: null, toolArgSourceTaint: null,
  sanitise: adapters.safety.sanitise, session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }),
});
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly ToolName[]).includes(name));
// A read whose result is just under the per-result cap, so each round adds about TOOL_OUTPUT_LIMIT characters.
const bigRead = {
  name: 'read_memory', description: 'fixture read', schema: z.object({ query: z.string() }), autonomy_gated: false, trigger_allowlist: allowlist('read_memory'),
  handle: async (args: unknown) => ({ ok: true, data: { query: (args as { query: string }).query, text: 'x'.repeat(TOOL_OUTPUT_LIMIT - 200) }, source_taint: null }),
};
const size = (turns: readonly LLMToolTurn[]) => turns.reduce((sum, turn) => sum + turn.output.length, 0);

it('a turn whose results outgrow the keep budget clears the oldest results, keeps every call and the newest round whole, and stays within budget', async () => {
  const sent: (readonly LLMToolTurn[])[] = [];
  const rounds = 24;
  let step = 0;
  const text = await runToolLoop({
    handlers: [bigRead] as never, ctx: ctx(), maxSteps: rounds + 1,
    step: async (_tools, turns) => {
      sent.push(turns.map((turn) => ({ ...turn })));
      step += 1;
      return step <= rounds ? { text: '', tool_calls: [{ call_id: `c${step}`, name: 'read_memory', arguments: JSON.stringify({ query: `topic ${step}` }) }] } : { text: 'Done.' };
    },
  });
  expect(text).toBe('Done.');
  const last = sent.at(-1)!;
  // every call is still there, in order; only results gave way
  expect(last.map((turn) => JSON.parse(turn.call.arguments).query)).toEqual(Array.from({ length: rounds }, (_value, index) => `topic ${index + 1}`));
  expect(last[0]!.output).toBe(clearedToolResult('read_memory'));
  expect(JSON.parse(last.at(-1)!.output.split('\n[')[0]!)).toMatchObject({ ok: true, data: { query: `topic ${rounds}` } });
  for (const turns of sent) expect(size(turns)).toBeLessThanOrEqual(TOOL_RESULTS_KEEP_CHARS + TOOL_OUTPUT_LIMIT);
  // without clearing the last request would carry every result
  expect(rounds * (TOOL_OUTPUT_LIMIT - 200)).toBeGreaterThan(2 * TOOL_RESULTS_KEEP_CHARS);
});

it('clearing only moves forward: a result once cleared is sent cleared in every later round, and a kept one is never rewritten', async () => {
  const sent: (readonly LLMToolTurn[])[] = [];
  let step = 0;
  await runToolLoop({
    handlers: [bigRead] as never, ctx: ctx(), maxSteps: 16,
    step: async (_tools, turns) => {
      sent.push(turns.map((turn) => ({ ...turn })));
      step += 1;
      return step <= 15 ? { text: '', tool_calls: [{ call_id: `c${step}`, name: 'read_memory', arguments: JSON.stringify({ query: `topic ${step}` }) }] } : { text: 'Done.' };
    },
  });
  for (let round = 1; round < sent.length; round += 1) {
    const before = sent[round - 1]!, after = sent[round]!;
    for (const [index, turn] of before.entries()) {
      if (turn.output === clearedToolResult('read_memory')) expect(after[index]!.output).toBe(turn.output);
      else expect([turn.output, clearedToolResult('read_memory')]).toContain(after[index]!.output);
    }
  }
  // it clears in steps down to half the budget, not one result per round, so most rounds resend the same prefix
  const clears = sent.slice(1).filter((turns, round) => turns.filter((turn) => turn.output === clearedToolResult('read_memory')).length > sent[round]!.filter((turn) => turn.output === clearedToolResult('read_memory')).length).length;
  expect(clears).toBeGreaterThan(0);
  expect(clears).toBeLessThan(sent.length / 2);
});

it('a turn under the keep budget is sent exactly as before', async () => {
  const sent: (readonly LLMToolTurn[])[] = [];
  let step = 0;
  await runToolLoop({
    handlers: [bigRead] as never, ctx: ctx(), maxSteps: 4,
    step: async (_tools, turns) => {
      sent.push(turns);
      step += 1;
      return step <= 3 ? { text: '', tool_calls: [{ call_id: `c${step}`, name: 'read_memory', arguments: JSON.stringify({ query: `topic ${step}` }) }] } : { text: 'Done.' };
    },
  });
  expect(sent.at(-1)!.every((turn) => turn.output !== clearedToolResult('read_memory'))).toBe(true);
});
