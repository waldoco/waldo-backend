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
// A fact a connected account asserts about the owner that a forget can name when the owner's words don't spell it out.
export const providerFieldSchema = z.enum(['name', 'phone']);
export type ProviderField = z.infer<typeof providerFieldSchema>;
export const forgetMemoryArgsSchema = z.strictObject({
  claim_ids: z.array(z.int().positive()).min(1).optional(),
  topic: z.string().trim().min(1).optional(),
  source: z.strictObject({ message_ref: z.string().min(1), start: z.int().nonnegative(), end: z.int().positive() }).refine(span => span.end > span.start, 'end must follow start').optional(),
  provider_fields: z.array(providerFieldSchema).min(1).max(2).optional().describe("The owner's own name or phone number as their connected account gives it, when the owner asks to forget that without spelling it out."),
  scope_note: z.string().trim().min(1),
}).refine(args => args.claim_ids !== undefined || args.topic !== undefined || args.source !== undefined || args.provider_fields !== undefined, 'a forget selector is required');
export type ForgetMemoryArgs = z.infer<typeof forgetMemoryArgsSchema>;
