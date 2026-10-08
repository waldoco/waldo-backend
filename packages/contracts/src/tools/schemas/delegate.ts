import { z } from 'zod';

// Subagent orchestration v1 (spec: waldo-subagent-orchestration-spec-2026-09-26; owner-delegated
// decisions 2026-09-26). The task must be self-contained: the child runs its own tool loop with a
// narrowed read-only tool set and reports back a summary plus a truthful exit classification.
export const delegateTaskArgsSchema = z.strictObject({
  task: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'Complete, self-contained instruction for the subagent: what to find or do, and what to report back. The child sees only this text, not the conversation.',
    ),
  item_id: z.string().min(1).max(100).optional().describe('The todo item this task works on; its result is stored on that item.'),
  tools: z.array(z.string().min(1).max(60)).max(20).optional().describe('Read tools the child may use; omit for the default research set.'),
  background: z.boolean().optional().describe('Run after this turn ends and report through the item; the result is not available in this reply.'),
});
export type DelegateTaskArgs = z.infer<typeof delegateTaskArgsSchema>;
