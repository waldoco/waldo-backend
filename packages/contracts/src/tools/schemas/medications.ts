import { z } from 'zod';

// The owner's medicines: when to remind them, whether each dose was taken, and when to reorder (ADR-0081 amendment of
// 1 November 2026). Waldo never advises on medicine, so no schema here has a dose, amount or instruction field. The name is
// the owner's own label, kept word for word, an amount in it included; the reminder's words are composed by the harness from
// it, never by the model.
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const medicationId = z.uuid().describe('Medication id from list_medications or track_medication.');

export const trackMedicationArgsSchema = z.strictObject({
  medication_id: medicationId.optional().describe('To change one already tracked; omit to start tracking a new one.'),
  name: z.string().min(1).max(80).refine(name => name.trim() !== '' && !/\p{Cc}/u.test(name), { error: 'a name on one line' })
    .describe("The medicine's name exactly as the owner says it, label words included."),
  times: z.array(clock).min(1).max(6).refine(times => new Set(times).size === times.length, { error: 'times repeat' })
    .describe("Each daily reminder time, HH:MM in the owner's local time."),
  supply: z.int().min(0).max(2000).optional().describe('How many the owner says they have on hand now; doses taken count it down.'),
  refill_at: z.int().min(1).max(500).optional().describe("Remind to reorder when this many are left; omit for a week's worth."),
});
export type TrackMedicationArgs = z.infer<typeof trackMedicationArgsSchema>;

export const logMedicationArgsSchema = z.strictObject({
  medication_id: medicationId,
  status: z.enum(['taken', 'skipped']),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional()
    .describe("The dose's time as YYYY-MM-DDTHH:MM in the owner's local time; omit for the dose nearest now."),
});
export type LogMedicationArgs = z.infer<typeof logMedicationArgsSchema>;

export const listMedicationsArgsSchema = z.strictObject({});
export type ListMedicationsArgs = z.infer<typeof listMedicationsArgsSchema>;

export const stopMedicationArgsSchema = z.strictObject({ medication_id: medicationId });
export type StopMedicationArgs = z.infer<typeof stopMedicationArgsSchema>;
