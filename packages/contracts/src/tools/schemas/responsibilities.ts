import { z } from 'zod';

export const RESPONSIBILITY_STATUSES = ['open', 'waiting', 'done', 'dropped', 'uncertain'] as const;
export const TODO_STATUSES = ['pending', 'running', 'blocked', 'done', 'failed', 'cancelled'] as const;

export const trackResponsibilityArgsSchema = z.strictObject({
  title: z.string().min(1).max(200).describe('What Waldo took on, in a few plain words.'),
  intent: z.string().min(1).max(1000).describe("What the owner wants done and any limits they set, in Waldo's words."),
  items: z.array(z.strictObject({
    title: z.string().min(1).max(200),
    owner: z.enum(['waldo', 'owner']).default('waldo'),
    depends_on: z.array(z.number().int().min(0).max(19)).max(19).default([]).describe('Zero-based positions of items in this list that must finish first.'),
  })).max(20).default([]).describe('The steps, when the work has more than one.'),
  next_check_at: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/).nullable().default(null).describe("When to look at this again, in the owner's local time, or null."),
});
export type TrackResponsibilityArgs = z.infer<typeof trackResponsibilityArgsSchema>;

export const updateTodoArgsSchema = z.strictObject({
  item_id: z.string().min(1).max(100),
  status: z.enum(TODO_STATUSES),
  result: z.string().max(4000).optional().describe('What came of the step, when it finished or failed.'),
});
export type UpdateTodoArgs = z.infer<typeof updateTodoArgsSchema>;

export const listResponsibilitiesArgsSchema = z.strictObject({
  status: z.enum([...RESPONSIBILITY_STATUSES, 'all']).default('open'),
});
export type ListResponsibilitiesArgs = z.infer<typeof listResponsibilitiesArgsSchema>;

export const closeResponsibilityArgsSchema = z.strictObject({
  id: z.string().min(1).max(100),
  outcome: z.enum(['done', 'dropped']),
  evidence_ref: z.string().trim().min(1).max(300).describe('What shows it is finished: a receipt or provider id from this conversation, or the owner saying so (quote their words).'),
});
export type CloseResponsibilityArgs = z.infer<typeof closeResponsibilityArgsSchema>;
