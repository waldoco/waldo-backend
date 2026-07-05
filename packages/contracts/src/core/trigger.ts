import { z } from 'zod';

export const triggerTypeSchema = z.enum([
  'brief',
  'fetch_alert',
  'patrol',
  'handoff_explore',
  'handoff_plan',
  'handoff_act',
  'handoff_replan',
  'intervention',
  'user_message',
  'dreaming_mode',
  'pre_activity_spot',
  'pre_brief_sweep',
]);
export type TriggerType = z.infer<typeof triggerTypeSchema>;

export const briefVariantSchema = z.enum(['morning', 'midday', 'evening', 'event']);
export type BriefVariant = z.infer<typeof briefVariantSchema>;

// A canary is a 16-char hex token the agent must never emit; leaked output signals injection.
export const canaryTokenSchema = z.string().regex(/^[0-9a-f]{16}$/i);

// Three independent tokens per session (ADR-0032) widen the leak-detection surface;
// duplicates would collapse it, so the set must be unique. Every boundary that carries
// canaries reuses this one invariant.
export const canaryTokensSchema = z
  .array(canaryTokenSchema)
  .length(3)
  .refine((tokens) => new Set(tokens.map((t) => t.toLowerCase())).size === tokens.length, {
    error: 'canary tokens must be unique',
  });
export type CanaryTokens = z.infer<typeof canaryTokensSchema>;
