// A chat call has a ceiling on its whole input. Its history is held to the conversation layer's budget, and within a turn,
// once the tool turns would carry the request past the hard ceiling, every result but the newest round's is cleared. The
// owner's words are never what gives way.
import { expect, it } from 'vitest';
import { z } from 'zod';
import { buildSessionState, TOOL_PERMISSIONS, triggerTypeSchema, type LLMToolTurn, type ToolName } from '@waldo/contracts';
import { COMPACTION, compactionSettings } from '../src/conversation/compaction';
import { CONVERSATION_INPUT_BUDGET_TOKENS } from '../src/conversation/window';
import { runToolLoop, TOOL_OUTPUT_LIMIT } from '../src/conversation/tool-loop';
import { resolveRunLoopAdapters } from '../src/llm/run-loop-adapters';
import { CONTEXT_BUDGET } from '../src/conversation/context-budget';

it('the switch holds every chat chain to the conversation layer budget, and leaves the rest of the settings as they were', () => {
  expect(compactionSettings({}).budgetTokens).toBe(CONVERSATION_INPUT_BUDGET_TOKENS);
  expect(compactionSettings({ WALDO_CALL_CEILINGS: '0' }).budgetTokens).toBe(CONVERSATION_INPUT_BUDGET_TOKENS);
  expect(compactionSettings({ WALDO_CALL_CEILINGS: 'on' }).budgetTokens).toBe(CONVERSATION_INPUT_BUDGET_TOKENS);
  expect(compactionSettings({ WALDO_CALL_CEILINGS: '1' })).toEqual({ ...COMPACTION, budgetTokens: CONTEXT_BUDGET.historyTokens });
  // What a summary reads stays where it was, so a smaller window compacts sooner without summarising less.
  expect(compactionSettings({ WALDO_CALL_CEILINGS: '1' }).summaryInputTokens).toBe(CONVERSATION_INPUT_BUDGET_TOKENS);
  expect(compactionSettings({ WALDO_CALL_CEILINGS: '1', WALDO_COMPACTION: 'on', WALDO_STEPPED_WINDOW: '1' }))
    .toEqual({ ...COMPACTION, enabled: true, steppedWindow: true, budgetTokens: CONTEXT_BUDGET.historyTokens });
});

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = () => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message' as const, canaryTokens: CANARIES, sourceTaint: null, toolArgSourceTaint: null,
  sanitise: adapters.safety.sanitise, session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }),
});
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly ToolName[]).includes(name));
const bigRead = {
  name: 'read_memory', description: 'fixture read', schema: z.object({ query: z.string() }), autonomy_gated: false, trigger_allowlist: allowlist('read_memory'),
  handle: async (args: unknown) => ({ ok: true, data: { query: (args as { query: string }).query, text: 'x'.repeat(TOOL_OUTPUT_LIMIT - 200) }, source_taint: null }),
};
const isCleared = (output: string) => output.startsWith('[cleared: ');
const loop = async (resultRoomBytes?: () => number | undefined) => {
  const sent: (readonly LLMToolTurn[])[] = [];
  let step = 0;
  await runToolLoop({
    handlers: [bigRead] as never, ctx: ctx(), maxSteps: 8, ...(resultRoomBytes ? { resultRoomBytes } : {}),
    step: async (_tools, turns) => {
      sent.push(turns.map((turn) => ({ ...turn })));
      step += 1;
      return step <= 7 ? { text: '', tool_calls: [{ call_id: `c${step}`, name: 'read_memory', arguments: JSON.stringify({ query: `topic ${step}` }) }] } : { text: 'Done.' };
    },
  });
  return sent;
};

it('past the room the call has left for tool results, every result but the newest round is cleared, and every call stays', async () => {
  const room = 2 * TOOL_OUTPUT_LIMIT;
  const sent = await loop(() => room);
  for (const turns of sent) {
    if (turns.length === 0) continue;
    expect(isCleared(turns.at(-1)!.output)).toBe(false);
    // Over the room, only the newest result goes whole: what the room is measured in is the turns as the request sends them.
    if (new TextEncoder().encode(JSON.stringify(turns)).byteLength > room) expect(turns.slice(0, -1).every((turn) => isCleared(turn.output))).toBe(true);
  }
  const last = sent.at(-1)!;
  expect(last.map((turn) => JSON.parse(turn.call.arguments).query)).toEqual(Array.from({ length: 7 }, (_value, index) => `topic ${index + 1}`));
  expect(last.slice(0, -1).every((turn) => isCleared(turn.output))).toBe(true);
});

it('a turn with room for its results, or with no ceiling, is sent as before', async () => {
  const plain = await loop();
  expect(plain.at(-1)!.some((turn) => isCleared(turn.output))).toBe(false);
  expect(await loop(() => 100 * TOOL_OUTPUT_LIMIT)).toEqual(plain);
  expect(await loop(() => undefined)).toEqual(plain);
});
