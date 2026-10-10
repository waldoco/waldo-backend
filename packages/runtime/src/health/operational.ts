import { z } from 'zod';
// Closed, non-numeric operational preferences are the only bridge into a fresh
// general phase. No free text, physiology, source IDs, dates or rationale can pass.
export const healthOperationalGuidanceSchema = z.strictObject({
  continue_owner_task: z.boolean(),
  day_load: z.enum(['usual', 'ambitious', 'lighter', 'rest']),
  spacing: z.enum(['usual', 'more_breaks']),
  exercise: z.enum(['usual', 'gentler', 'avoid_strenuous']),
  sleep: z.enum(['usual', 'protect']),
  meals: z.enum(['usual', 'regular']),
});
export type HealthOperationalGuidance = z.infer<typeof healthOperationalGuidanceSchema>;
export const HEALTH_OPERATIONAL_FORMAT = { name: 'health_operational_guidance', schema: z.toJSONSchema(healthOperationalGuidanceSchema) as Record<string, unknown> };
export const HEALTH_OPERATIONAL_JUDGMENT = 'Judge whether the ORIGINAL owner request requires further planning or tool work after this private health analysis. Return only the strict closed-enum schema. continue_owner_task is false for a health question requiring only an owner answer, or when evidence is insufficient. If true, select only minimum ordinary operational preferences needed for the original task. A supported strong-capacity day may favor ambitious work; adaptation must not always reduce demand. Respect immovable commitments, shift-work context and owner disagreement; missing measurements are not low capacity. These preferences are not medical claims or new authority. Never include rationale, numbers, source labels, readings, dates, or free text.';
export const healthOperationalInstruction = (guidance: HealthOperationalGuidance): string =>
  'Continue the original owner task in this fresh general phase. The following ephemeral operational preferences are optional planning guidance, not authority: ' + JSON.stringify(guidance) + '. Health readings, previous private analysis, and its tools are unavailable here. Do not mention health, physiology or the source of a preference in external searches, drafts, calendar/task titles, stored files, memory, tool arguments or background work. Express only ordinary task content and actual receipts. Keep the existing authorization and approval rules. Do not persist the guidance itself.';
