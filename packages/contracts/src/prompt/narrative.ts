import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import { formZoneSchema, loadZoneSchema, recoveryZoneSchema } from '../health/crs';

// The derived-only body+mind block the builder threads into the REASONS O layer (ADR-0028).
// Body state arrives as zone words from the health/crs single owner — every field is an enum
// or a bounded string, so a raw biometric value cannot exist on the shape. Structure is the
// wall's schema half; the egress overlay that swaps numeric scores for these words is
// ADR-0024 — ADR-0011 supplies only the vocabulary.
export const narrativeContextSchema = z.strictObject({
  zone: formZoneSchema,
  recovery_descriptor: recoveryZoneSchema,
  load_descriptor: loadZoneSchema,
  day_summary: z.string().max(2000),
  active_goals: z.array(z.string().min(1)).default([]),
  upcoming_high_stakes: z.array(z.string().min(1)).default([]),
  compiled_at: iso8601Schema,
});
export type NarrativeContext = z.infer<typeof narrativeContextSchema>;
