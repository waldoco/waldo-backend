import { z } from 'zod';

// Task workers: the brain hands long, parallel or untrusted work to a worker that holds no authority (no memory, send or
// approve tools) and returns a structured result the brain applies once. A worker sees only its brief, never the
// conversation, so every part of the brief must stand on its own.
export const TASK_PROFILES = ['reader', 'errand', 'code'] as const;
export const taskProfileSchema = z.enum(TASK_PROFILES);
export type TaskProfile = z.infer<typeof taskProfileSchema>;

export const taskJobIdSchema = z.string().regex(/^job_[0-9a-f]{12}$/);

export const startTaskArgsSchema = z.strictObject({
  profile: taskProfileSchema.describe('reader: mail, calendar, Drive, web. errand: also a browser; submits need approval. code: unavailable.'),
  // A label the owner and later turns read: one short line, so it cannot run on or start a line of its own.
  title: z.string().min(1).max(80).regex(/^[^\r\n\u2028\u2029]*$/, 'One line.'),
  goal: z.string().min(1),
  context: z.string().describe('All it needs from this chat: names, dates, links, decisions, what to avoid.'),
  done_when: z.string().min(1),
  effort: z.enum(['standard', 'deep']).optional(),
});
export type StartTaskArgs = z.infer<typeof startTaskArgsSchema>;

export const cancelTaskArgsSchema = z.strictObject({ job_id: taskJobIdSchema });
export type CancelTaskArgs = z.infer<typeof cancelTaskArgsSchema>;

export const checkTaskArgsSchema = z.strictObject({ job_id: taskJobIdSchema });
export type CheckTaskArgs = z.infer<typeof checkTaskArgsSchema>;

// A change to a running task's work, kept with the job so the task keeps its id. The worker never sees the conversation, so
// the instruction must stand on its own; no length bound, for the same reason as the brief's body parts.
export const steerTaskArgsSchema = z.strictObject({
  job_id: taskJobIdSchema,
  instruction: z.string().min(1),
  mode: z.enum(['interrupt', 'enqueue']).describe('interrupt: a correction; the worker stops after its current step and continues with this. enqueue: an addition; the worker finishes what it is doing, then does this before it reports.'),
});
export type SteerTaskArgs = z.infer<typeof steerTaskArgsSchema>;

// What a worker hands back. findings carry where each came from, so the brain can follow one up; proposals are actions the
// worker suggests, which only the brain can take, on its approval path.
export const taskResultSchema = z.strictObject({
  status: z.enum(['done', 'partial', 'blocked', 'failed']),
  summary: z.string().min(1),
  findings: z.array(z.strictObject({ text: z.string().min(1), source_ref: z.string().optional() })),
  proposals: z.array(z.strictObject({ tool: z.string().min(1), why: z.string().min(1), args: z.record(z.string(), z.unknown()) })),
  left: z.array(z.string()),
});
export type TaskResult = z.infer<typeof taskResultSchema>;
