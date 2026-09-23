import { z } from 'zod';
import { canaryTokensSchema, triggerTypeSchema } from '../core/trigger';
import { TOOL_PERMISSIONS, toolNameSchema } from '../tools/permissions';
import type { ToolName } from '../tools/permissions';

export const sessionRateLimitWindowSchema = z.strictObject({
  started_at: z.int().nonnegative(),
  tool_counts: z.partialRecord(toolNameSchema, z.int().nonnegative()),
});
export type SessionRateLimitWindow = z.infer<typeof sessionRateLimitWindowSchema>;

export const sessionResetInputSchema = z.strictObject({
  trigger: triggerTypeSchema,
  canary_tokens: canaryTokensSchema,
  started_at: z.int().nonnegative(),
});
export type SessionResetInput = z.infer<typeof sessionResetInputSchema>;

export const sessionStateSchema = z
  .strictObject({
    trigger: triggerTypeSchema,
    tool_permissions: z.array(toolNameSchema),
    canary_tokens: canaryTokensSchema,
    context: z.null(),
    iteration_count: z.literal(0),
    cost_spent: z.literal(0),
    pending_approvals: z.array(z.never()).length(0),
    active_sandbox: z.null(),
    rate_limit_window: sessionRateLimitWindowSchema,
  })
  .superRefine((session, ctx) => {
    const expected = TOOL_PERMISSIONS[session.trigger];
    const exactMatch =
      session.tool_permissions.length === expected.length &&
      session.tool_permissions.every((tool, index) => tool === expected[index]);

    if (!exactMatch) {
      ctx.addIssue({
        code: 'custom',
        message: 'tool_permissions must match TOOL_PERMISSIONS[trigger]',
        path: ['tool_permissions'],
      });
    }
  });
export type SessionState = z.infer<typeof sessionStateSchema>;

export function buildSessionState(input: SessionResetInput): SessionState {
  const parsed = sessionResetInputSchema.parse(input);

  return sessionStateSchema.parse({
    trigger: parsed.trigger,
    tool_permissions: [...TOOL_PERMISSIONS[parsed.trigger]],
    canary_tokens: parsed.canary_tokens,
    context: null,
    iteration_count: 0,
    cost_spent: 0,
    pending_approvals: [],
    active_sandbox: null,
    rate_limit_window: {
      started_at: parsed.started_at,
      tool_counts: {},
    },
  });
}

export function sessionToolAllowed(
  session: Pick<SessionState, 'tool_permissions'>,
  tool: ToolName,
): boolean {
  return session.tool_permissions.includes(tool);
}
