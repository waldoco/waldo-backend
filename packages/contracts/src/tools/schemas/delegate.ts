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
});
export type DelegateTaskArgs = z.infer<typeof delegateTaskArgsSchema>;
