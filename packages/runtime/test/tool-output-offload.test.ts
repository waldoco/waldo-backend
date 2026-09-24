import { buildSessionState, getContextArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { capToolOutput, runToolLoop, TOOL_OUTPUT_LIMIT } from '../src/conversation/tool-loop';
import { inMemoryToolOutputStore } from '../src/conversation/tool-output-store';
import { resolveRunLoopAdapters } from '../src/run-loop/adapters';
import { readToolOutputHandler } from '../src/tools/read-tool-output';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = {
  authenticatedUserId: 'owner-1', trigger: 'user_message' as const, canaryTokens: CANARIES,
  sourceTaint: null, toolArgSourceTaint: null,
  sanitise: adapters.safety.sanitise, medicalGate: adapters.safety.medicalGate,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }),
};

describe('tool output offload', () => {
  it('stores oversize outputs and reads ranges back', async () => {
    const store = inMemoryToolOutputStore();
    const big = `head-${'x'.repeat(TOOL_OUTPUT_LIMIT + 5_000)}-tail`;
    const capped = capToolOutput(big, store);
    const id = /stored as (to-\d+)/.exec(capped)?.[1];
    expect(id).toBeDefined();
    expect(capped.length).toBeLessThan(TOOL_OUTPUT_LIMIT);
    const handler = readToolOutputHandler(store);
    const first = await handler.handle({ id: id! });
    expect(first).toMatchObject({ ok: true, data: { total: big.length } });
    const firstData = (first as { data: { text: string; next_offset: number | null } }).data;
    expect(firstData.text).toBe(big.slice(0, 4_000));
    const rest = await handler.handle({ id: id!, offset: firstData.next_offset ?? 0, length: big.length });
    expect(rest).toMatchObject({ ok: true, data: { next_offset: null } });
    expect((rest as { data: { text: string } }).data.text.endsWith('-tail')).toBe(true);
    expect(await handler.handle({ id: 'to-999' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('keeps the legacy cut message when no store is wired', () => {
    const big = 'y'.repeat(TOOL_OUTPUT_LIMIT + 100);
    expect(capToolOutput(big)).toContain('[cut: 100 more characters');
  });

  it('threads stored output through the tool loop when offload is on', async () => {
    const store = inMemoryToolOutputStore();
    const big = { rows: 'z'.repeat(TOOL_OUTPUT_LIMIT + 2_000) };
    let seenOutput = '';
    const text = await runToolLoop({
      handlers: [readToolOutputHandler(store), {
        name: 'get_master_metrics',
        description: 'Big metrics dump.',
        schema: getContextArgsSchema,
        trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('get_master_metrics')),
        autonomy_gated: false,
        handle: async () => ({ ok: true as const, data: big, source_taint: null }),
      }] as never,
      ctx, maxSteps: 3, offload: store,
      step: async (_tools, turns) => {
        if (turns.length === 0) return { text: '', tool_calls: [{ call_id: 'c1', name: 'get_master_metrics', arguments: '{}' }] };
        seenOutput = turns[0]!.output;
        return { text: 'done' };
      },
    });
    expect(text).toBe('done');
    expect(seenOutput).toContain('stored_output');
    expect(seenOutput).toContain('to-1');
    expect(seenOutput.length).toBeLessThan(TOOL_OUTPUT_LIMIT + 500);
  });
});
