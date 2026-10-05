import { toolNameSchema } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { TOOL_CLAIM_EFFECT } from '../src/hooks/claim-verify-effects';
import { replayDecision, TOOL_REPLAY_CLASS } from '../src/hooks/tool-replay-class';

// Vite replaces a literal import.meta.glob call at build time; this package carries no vite client types, hence the directive.
// @ts-expect-error vite-only API
const sources: Record<string, string> = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('tool replay-class table', () => {
  it('has exactly one row per tool in the contract union', () => {
    expect(Object.keys(TOOL_REPLAY_CLASS).sort()).toEqual([...toolNameSchema.options].sort());
  });
  it('every row says why', () => {
    for (const [tool, row] of Object.entries(TOOL_REPLAY_CLASS)) expect(row.basis.length, tool).toBeGreaterThan(10);
  });
  it('a tool with a claimable effect is never classed safe_read', () => {
    for (const tool of toolNameSchema.options) {
      if (TOOL_CLAIM_EFFECT[tool] !== null) expect(TOOL_REPLAY_CLASS[tool].replay, tool).not.toBe('safe_read');
    }
  });
  it('any class that claims a key or a lookup is checked against the source it cites', () => {
    for (const [tool, row] of Object.entries(TOOL_REPLAY_CLASS)) {
      if (row.replay === 'provider_idempotent' || row.replay === 'reconcilable_write') expect(row.evidence, tool).toBeDefined();
      if (!row.evidence) continue;
      const text = sources[`../src/${row.evidence.file}`];
      expect(text, `${tool}: ${row.evidence.file} not found`).toBeDefined();
      expect(text, `${tool}: ${row.evidence.needle}`).toContain(row.evidence.needle);
    }
  });
  it('send_message is not classed idempotent: the key collapses only at approval', () => {
    expect(TOOL_REPLAY_CLASS.send_message.replay).toBe('non_replayable_uncertain');
  });
  it('no mutating tool is safe_read (hand list from the claim-verify test)', () => {
    const mutating = ['send_message', 'send_email', 'propose_calendar_change', 'draft_email', 'create_artifact', 'revise_artifact', 'export_artifact', 'browse_act', 'workspace_write', 'workspace_render', 'set_reminder', 'cancel_reminder', 'open_loop', 'close_loop', 'set_proactivity', 'log_meal', 'log_workout', 'set_standing_order', 'cancel_standing_order', 'skills_install', 'skills_disable', 'skills_load'] as const;
    for (const tool of mutating) expect(TOOL_REPLAY_CLASS[tool].replay, tool).not.toBe('safe_read');
  });
});

describe('replayDecision', () => {
  const byClass = (replay: string) => toolNameSchema.options.filter(tool => TOOL_REPLAY_CLASS[tool].replay === replay);
  it('an unseen call runs and a settled call reuses its stored result, for every tool', () => {
    for (const tool of toolNameSchema.options) {
      expect(replayDecision(tool, 'unseen'), tool).toBe('run');
      expect(replayDecision(tool, 'settled'), tool).toBe('reuse_result');
    }
  });
  it('after a crash window each class decides from the table, and an uninspected tool never runs again', () => {
    for (const tool of byClass('safe_read')) expect(replayDecision(tool, 'started_unsettled'), tool).toBe('run');
    for (const tool of byClass('provider_idempotent')) expect(replayDecision(tool, 'started_unsettled'), tool).toBe('run');
    for (const tool of byClass('reconcilable_write')) expect(replayDecision(tool, 'started_unsettled'), tool).toBe('reconcile_first');
    for (const tool of byClass('non_replayable_uncertain')) expect(replayDecision(tool, 'started_unsettled'), tool).toBe('refuse_uncertain');
    expect(replayDecision('set_reminder', 'started_unsettled')).toBe('refuse_uncertain');
    expect(replayDecision('workspace_write', 'started_unsettled')).toBe('run');
    expect(replayDecision('send_email', 'started_unsettled')).toBe('reconcile_first');
    expect(replayDecision('get_context', 'started_unsettled')).toBe('run');
  });
});
