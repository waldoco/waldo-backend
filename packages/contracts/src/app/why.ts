import { z } from 'zod';
import { epochMsV1Schema } from './parts';

// "Why this changed": the steps behind a proposal, each one a read the proposing turn really made. The time is the read's,
// the verb and the one line are the model's, and the source says what kind of thing was read. The app never receives the
// provider's id for it. A health step names the score or signal it read, never a value, so its line carries no digit.
export const appWhyVerbV1Schema = z.enum(['read', 'checked', 'found', 'prepared', 'watching']);
export const appWhySourceV1Schema = z.enum(['calendar_event', 'calendar_free_busy', 'mail_thread', 'memory_node', 'health_score']);
export const APP_WHY_LABEL_MAX_V1 = 120;
export const APP_WHY_STEPS_MAX_V1 = 8;
export const appWhyLabelV1Schema = z.string().min(1).max(APP_WHY_LABEL_MAX_V1).regex(/\S/).regex(/^[^\r\n\u2028\u2029]*$/);
export const appWhyStepV1Schema = z.strictObject({ at: epochMsV1Schema, verb: appWhyVerbV1Schema, label: appWhyLabelV1Schema, source: appWhySourceV1Schema })
  .refine(step => step.source !== 'health_score' || !/\d/.test(step.label), { error: 'a health step names the score, never a value', path: ['label'] });
export const appWhyV1Schema = z.array(appWhyStepV1Schema).min(1).max(APP_WHY_STEPS_MAX_V1)
  .refine(steps => steps.every((step, i) => i === 0 || step.at >= steps[i - 1]!.at), 'steps out of order');
export type AppWhyStepV1 = z.infer<typeof appWhyStepV1Schema>;
export type AppWhyV1 = z.infer<typeof appWhyV1Schema>;
