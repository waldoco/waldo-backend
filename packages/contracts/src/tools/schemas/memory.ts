import { z } from 'zod';
import { lifeAreaSchema } from '../../memory/area';
import { claimOnDateSchema, PEOPLE_PER_CLAIM_MAX, personLinkSchema } from '../../memory/people';

// A claim id as a bare number or as the model reads it at the head of a pinned or recalled memory line (c12).
const claimIdSchema = z.union([z.int().positive(), z.string().regex(/^c[1-9][0-9]{0,15}$/).transform(id => Number(id.slice(1))).pipe(z.int().positive())]);
export const memoryClaimKindSchema = z.enum(['fact', 'preference', 'routine', 'goal', 'followup', 'health', 'event', 'pattern', 'observation']);
export const rememberArgsSchema = z.strictObject({
  kind: memoryClaimKindSchema,
  text: z.string().trim().min(1),
  evidence_quote: z.string().min(1),
  replaces_id: claimIdSchema.optional(),
  aliases: z.array(z.string().trim().min(1)).max(5).optional(),
  area: lifeAreaSchema.optional(),
  // Who the claim is about or names, so the people it concerns are one person each across memory.
  people: z.array(personLinkSchema).min(1).max(PEOPLE_PER_CLAIM_MAX).optional(),
  // The day the claim is about when it comes round again or is fixed: a birthday, an anniversary, a due date.
  on_date: claimOnDateSchema.optional(),
});
export type RememberArgs = z.infer<typeof rememberArgsSchema>;
export const forgetMemoryArgsSchema = z.strictObject({
  claim_ids: z.array(claimIdSchema).min(1).optional(),
  topic: z.string().trim().min(1).optional(),
  source: z.strictObject({ message_ref: z.string().min(1), start: z.int().nonnegative(), end: z.int().positive() }).refine(span => span.end > span.start, 'end must follow start').optional(),
  // One person and everything memory holds about them: their claims, their name and the addresses Waldo knew them by.
  person: z.int().positive().optional(),
  scope_note: z.string().trim().min(1),
}).refine(args => args.claim_ids !== undefined || args.topic !== undefined || args.source !== undefined || args.person !== undefined, 'a forget selector is required');
export type ForgetMemoryArgs = z.infer<typeof forgetMemoryArgsSchema>;
