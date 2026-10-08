import { z } from 'zod';

export const memoryClaimKindSchema = z.enum(['fact', 'preference', 'routine', 'goal', 'followup', 'health', 'event', 'pattern', 'observation']);
export const rememberArgsSchema = z.strictObject({
  kind: memoryClaimKindSchema,
  text: z.string().trim().min(1),
  evidence_quote: z.string().min(1),
  replaces_id: z.int().positive().optional(),
  aliases: z.array(z.string().trim().min(1)).max(5).optional(),
});
export type RememberArgs = z.infer<typeof rememberArgsSchema>;
export const forgetMemoryArgsSchema = z.strictObject({
  claim_ids: z.array(z.int().positive()).min(1).optional(),
  topic: z.string().trim().min(1).optional(),
  source: z.strictObject({ message_ref: z.string().min(1), start: z.int().nonnegative(), end: z.int().positive() }).refine(span => span.end > span.start, 'end must follow start').optional(),
  scope_note: z.string().trim().min(1),
}).refine(args => args.claim_ids !== undefined || args.topic !== undefined || args.source !== undefined, 'a forget selector is required');
export type ForgetMemoryArgs = z.infer<typeof forgetMemoryArgsSchema>;
