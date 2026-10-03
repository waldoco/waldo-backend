import { toolNameSchema } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { TOOL_CLAIM_EFFECT } from '../src/hooks/claim-verify-effects';
import { TOOL_REPLAY_CLASS } from '../src/hooks/tool-replay-class';

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
  it('provider_idempotent is claimed only with a named key in the basis', () => {
    for (const [tool, row] of Object.entries(TOOL_REPLAY_CLASS)) {
      if (row.replay === 'provider_idempotent') expect(row.basis, tool).toMatch(/key|operation_id/);
    }
  });
  it('no mutating tool is safe_read (hand list from the claim-verify test)', () => {
    const mutating = ['send_message', 'send_email', 'propose_calendar_change', 'draft_email', 'create_artifact', 'revise_artifact', 'export_artifact', 'browse_act', 'workspace_write', 'workspace_render', 'set_reminder', 'cancel_reminder', 'open_loop', 'close_loop', 'set_proactivity', 'log_meal', 'log_workout', 'set_standing_order', 'cancel_standing_order', 'skills_install', 'skills_disable', 'skills_load'] as const;
    for (const tool of mutating) expect(TOOL_REPLAY_CLASS[tool].replay, tool).not.toBe('safe_read');
  });
});
