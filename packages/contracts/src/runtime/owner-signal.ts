import { z } from 'zod';

// Owner signals are moments reported by the owner's own devices and automations (an iPhone
// Shortcut on wake-up, an Apple Watch workout ending, a meeting-notes app finishing a note).
// They start a proactive turn; the model decides whether anything is worth saying.
//
// No field carries a physiological reading. strictObject turns a drifted-in metric (calories,
// heart rate, sleep length) into a parse failure, and `activity` admits no digits so a workout
// label cannot smuggle a number.

export const OWNER_SIGNAL_SECRET_HEADER = 'X-Waldo-Signal-Secret';

const text = (max: number) => z.string().trim().min(1).max(max);

export const ownerSignalContextSchema = z.strictObject({
  weather: text(500).optional(),
  calendar: text(20_000).optional(),
});
export type OwnerSignalContext = z.infer<typeof ownerSignalContextSchema>;

export const ownerSignalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('woke_up'), context: ownerSignalContextSchema.optional() }),
  z.strictObject({ kind: z.literal('winding_down'), context: ownerSignalContextSchema.optional() }),
  z.strictObject({
    kind: z.literal('workout_ended'),
    activity: z.string().trim().regex(/^[\p{L}][\p{L} '&/-]{0,39}$/u).optional(),
    context: ownerSignalContextSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('meeting_notes'),
    id: z.string().trim().regex(/^[\w.:-]{1,128}$/).optional(),
    title: text(300).optional(),
    notes: text(100_000),
    context: ownerSignalContextSchema.optional(),
  }),
]);
export type OwnerSignal = z.infer<typeof ownerSignalSchema>;
export type OwnerSignalKind = OwnerSignal['kind'];
