import { describe, expect, it } from 'vitest';
import { raiseApprovalArgsSchema } from './approvals';
import { toolNameSchema, TOOL_PERMISSIONS } from '../permissions';

describe('raise_approval args', () => {
  it.each([
    [{ operation: 'list' }],
    [{ operation: 'raise', approval_id: 'p0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8' }],
  ])('accepts %j', args => {
    expect(raiseApprovalArgsSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    [{}],
    [{ operation: 'raise' }],
    [{ operation: 'list', approval_id: 'p1' }],
    [{ operation: 'raise', approval_id: 'r1' }],
    [{ operation: 'raise', approval_id: `p${'a'.repeat(64)}` }],
    [{ operation: 'raise', approval_id: 'p1', extra: true }],
    [{ operation: 'present', approval_id: 'p1' }],
  ])('rejects %j', args => {
    expect(raiseApprovalArgsSchema.safeParse(args).success).toBe(false);
  });

  it('is an owner chat tool only', () => {
    expect(toolNameSchema.options).toContain('raise_approval');
    expect(Object.entries(TOOL_PERMISSIONS).filter(([, tools]) => (tools as readonly string[]).includes('raise_approval')).map(([trigger]) => trigger)).toEqual(['user_message']);
  });
});
