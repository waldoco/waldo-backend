import { toolNameSchema } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { TOOL_CLAIM_EFFECT } from '../src/hooks/claim-verify-effects';

describe('claim-verify effect table', () => {
  it('has exactly one row per tool in the contract union', () => {
    expect(Object.keys(TOOL_CLAIM_EFFECT).sort()).toEqual([...toolNameSchema.options].sort());
  });
  it('every tool that can be allowed to mutate has an effect label', () => {
    const mutating = ['execute_action', 'send_message', 'write_task', 'update_task', 'draft_document', 'create_artifact', 'revise_artifact', 'draft_email', 'write_sheet_cell', 'workspace_write', 'update_memory', 'set_reminder', 'cancel_reminder', 'log_meal', 'log_workout', 'set_standing_order', 'cancel_standing_order', 'delete_message', 'restore_message'] as const;
    for (const tool of mutating) expect(TOOL_CLAIM_EFFECT[tool], tool).not.toBeNull();
  });
  it('effect labels are unique', () => {
    const labels = Object.values(TOOL_CLAIM_EFFECT).filter((e): e is string => e !== null);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
