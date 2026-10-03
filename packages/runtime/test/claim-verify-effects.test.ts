import { toolNameSchema } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { TOOL_CLAIM_EFFECT } from '../src/hooks/claim-verify-effects';

describe('claim-verify effect table', () => {
  it('has exactly one row per tool in the contract union', () => {
    expect(Object.keys(TOOL_CLAIM_EFFECT).sort()).toEqual([...toolNameSchema.options].sort());
  });
  it('every tool whose handler sets mutates_state and acts in this tree has a label', () => {
    // Hand list: the handlers need desks and stores to construct, so their flag is not read here.
    const mutating = ['send_message', 'send_email', 'propose_calendar_change', 'draft_email', 'create_artifact', 'revise_artifact', 'export_artifact', 'browse_act', 'workspace_write', 'workspace_render', 'set_reminder', 'cancel_reminder', 'open_loop', 'close_loop', 'set_proactivity', 'log_meal', 'log_workout', 'set_standing_order', 'cancel_standing_order', 'skills_install', 'skills_disable', 'skills_load'] as const;
    for (const tool of mutating) expect(TOOL_CLAIM_EFFECT[tool], tool).not.toBeNull();
  });
  it('approval-card tools are labelled as proposals, never as done', () => {
    for (const tool of ['send_message', 'send_email', 'propose_calendar_change'] as const) expect(TOOL_CLAIM_EFFECT[tool], tool).toMatch(/_proposed$/);
  });
  it('skill selection does not claim instructions were loaded or tools granted', () => {
    expect(TOOL_CLAIM_EFFECT.skills_list).toBeNull();
    expect(TOOL_CLAIM_EFFECT.skills_install).toBe('skill_enabled');
    expect(TOOL_CLAIM_EFFECT.skills_disable).toBe('skill_disabled');
    expect(TOOL_CLAIM_EFFECT.skills_load).toBe('skill_selected');
  });
  it('effect labels are unique', () => {
    const labels = Object.values(TOOL_CLAIM_EFFECT).filter((e): e is string => e !== null);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
