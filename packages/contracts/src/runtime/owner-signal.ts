import { z } from 'zod';

// An owner signal reports that something happened in the owner's day: a device, automation or
// connected app noticed a moment (woke up, arrived somewhere, a meeting note finished, a flight
// was delayed, an email from a client landed). It starts a proactive turn in which the model
// decides what, if anything, the moment changes for the owner. The vocabulary is open: senders
// name their own source and event, so a nurse's shift handover and a parent's school pickup
// need no backend change.
//
// Health is the exception. Body-state moments come only from the closed `health` branch, which
// has no free text and no numeric field; strictObject turns a drifted-in reading (calories,
// heart rate, sleep length) into a parse failure, and the activity label admits no digits.

export const OWNER_SIGNAL_SECRET_HEADER = 'X-Waldo-Signal-Secret';

const text = (max: number) => z.string().trim().min(1).max(max);
const slug = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_.-]{0,47}$/);

export const ownerSignalContextSchema = z
  .record(slug, text(20_000))
  .refine((context) => Object.keys(context).length <= 12, { error: 'at most 12 context entries' });
export type OwnerSignalContext = z.infer<typeof ownerSignalContextSchema>;

export const healthSignalEventSchema = z.enum([
  'woke_up',
  'wind_down',
  'workout_started',
  'workout_ended',
]);
export type HealthSignalEvent = z.infer<typeof healthSignalEventSchema>;

const idempotencyKey = z.string().trim().regex(/^[\w.:-]{1,128}$/);

export const healthSignalSchema = z.strictObject({
  source: z.literal('health'),
  event: healthSignalEventSchema,
  activity: z.string().trim().regex(/^[\p{L}][\p{L} '&/-]{0,39}$/u).optional(),
  id: idempotencyKey.optional(),
  context: ownerSignalContextSchema.optional(),
});

export const momentSignalSchema = z.strictObject({
  source: slug.refine((source) => source !== 'health', { error: 'health moments use the health branch' }),
  event: slug,
  detail: text(100_000).optional(),
  id: idempotencyKey.optional(),
  context: ownerSignalContextSchema.optional(),
});

export const ownerSignalSchema = z.union([healthSignalSchema, momentSignalSchema]);
export type OwnerSignal = z.infer<typeof ownerSignalSchema>;
export type HealthSignal = z.infer<typeof healthSignalSchema>;
export type MomentSignal = z.infer<typeof momentSignalSchema>;

// Sound because the moment branch refuses the `health` source.
export const isHealthSignal = (signal: OwnerSignal): signal is HealthSignal => signal.source === 'health';
