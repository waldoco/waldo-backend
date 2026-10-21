import { z } from 'zod';

// Task workers: the brain hands long, parallel or untrusted work to a worker that holds no authority (no memory, send or
// approve tools) and returns a structured result the brain applies once. A worker sees only its brief, never the
// conversation, so every part of the brief must stand on its own.
export const TASK_PROFILES = ['reader', 'errand', 'code'] as const;
export const taskProfileSchema = z.enum(TASK_PROFILES);
export type TaskProfile = z.infer<typeof taskProfileSchema>;

export const taskJobIdSchema = z.string().regex(/^job_[0-9a-f]{12}$/);

export const startTaskArgsSchema = z.strictObject({
  profile: taskProfileSchema.describe('reader: mail, calendar, contacts, tasks, Drive and the web. errand: reader plus a browser for multi-step web errands; a submit comes back to you as an approval card. code: not available yet.'),
  title: z.string().min(1).describe('A short name the owner sees in progress notes, such as "Inbox since Monday".'),
  goal: z.string().min(1).describe('What the task must find or do.'),
  context: z.string().describe('Everything the worker needs from this conversation: names, dates, addresses, links, what the owner already said and decided.'),
  constraints: z.string().optional().describe('What the worker must avoid or respect.'),
  done_when: z.string().min(1).describe('What a good result looks like, so the worker knows when to stop.'),
  effort: z.enum(['standard', 'deep']).optional().describe('deep for careful reasoning across many sources.'),
});
export type StartTaskArgs = z.infer<typeof startTaskArgsSchema>;

export const cancelTaskArgsSchema = z.strictObject({ job_id: taskJobIdSchema });
export type CancelTaskArgs = z.infer<typeof cancelTaskArgsSchema>;

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
