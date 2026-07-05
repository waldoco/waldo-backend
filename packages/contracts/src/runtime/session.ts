import { z } from 'zod';
import { canaryTokensSchema, triggerTypeSchema } from '../core/trigger';
import { toolNameSchema, TOOL_PERMISSIONS } from '../tools/permissions';
import type { ToolName } from '../tools/permissions';
import type { TriggerType } from '../core/trigger';

export function expectedSessionTools(trigger: TriggerType): readonly ToolName[] {
  return TOOL_PERMISSIONS[trigger];
}

export function hasExactTriggerAcl(session: {
  trigger: TriggerType;
  authorized_tools: readonly ToolName[];
}): boolean {
  const expected = expectedSessionTools(session.trigger);
  return (
    session.authorized_tools.length === expected.length &&
    session.authorized_tools.every((tool, index) => tool === expected[index])
  );
}

// ADR-0033 session rebuild contract. A DO wake constructs this from the trigger ACL and
// fresh canaries; prior approvals and sandbox authority never carry into the new session.
export const sessionStateSchema = z
  .strictObject({
    session_id: z.string().min(1),
    user_id: z.string().min(1),
    trigger: triggerTypeSchema,
    canary_tokens: canaryTokensSchema,
    authorized_tools: z.array(toolNameSchema),
    pending_approval_ids: z.array(z.string()).length(0),
    sandbox_tokens: z.array(z.string()).length(0),
    created_at: z.int().nonnegative(),
    rebuilt_at: z.int().nonnegative(),
  })
  .refine(hasExactTriggerAcl, {
    error: 'authorized_tools must exactly match TOOL_PERMISSIONS for the trigger',
    path: ['authorized_tools'],
  });
export type SessionState = z.infer<typeof sessionStateSchema>;
