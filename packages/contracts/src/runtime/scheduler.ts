import { z } from 'zod';
import { briefVariantSchema, triggerTypeSchema } from '../core/trigger';
import type { TriggerType } from '../core/trigger';

export const schedulerScheduleKindSchema = z.enum([
  'journal',
  'handoff',
  'pre_activity_spot',
  'brief',
  'pre_brief_sweep',
  'patrol',
  'dreaming',
]);
export type SchedulerScheduleKind = z.infer<typeof schedulerScheduleKindSchema>;

export const schedulerScheduleStatusSchema = z.enum(['armed', 'quarantined']);
export type SchedulerScheduleStatus = z.infer<typeof schedulerScheduleStatusSchema>;

export const schedulerKindPriority: Readonly<Record<SchedulerScheduleKind, number>> = {
  journal: 0,
  handoff: 1,
  pre_activity_spot: 2,
  brief: 3,
  pre_brief_sweep: 4,
  patrol: 5,
  dreaming: 6,
};

export const schedulerDurabilityKinds: readonly SchedulerScheduleKind[] = ['journal', 'handoff'];
export const schedulerProductKinds: readonly SchedulerScheduleKind[] = [
  'pre_activity_spot',
  'brief',
  'pre_brief_sweep',
  'patrol',
  'dreaming',
];

export function schedulerKindCanQuarantine(kind: SchedulerScheduleKind): boolean {
  return !schedulerDurabilityKinds.includes(kind);
}

export const schedulerDirectTriggerKindSchema = z.enum([
  'pre_activity_spot',
  'brief',
  'pre_brief_sweep',
  'patrol',
  'dreaming',
]);
export type SchedulerDirectTriggerKind = z.infer<typeof schedulerDirectTriggerKindSchema>;

export const schedulerDirectTriggerByKind: Readonly<Record<SchedulerDirectTriggerKind, TriggerType>> = {
  pre_activity_spot: 'pre_activity_spot',
  brief: 'brief',
  pre_brief_sweep: 'pre_brief_sweep',
  patrol: 'patrol',
  dreaming: 'dreaming_mode',
};

export const schedulerTriggerResolutionSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('direct'),
    kind: schedulerDirectTriggerKindSchema,
    trigger: triggerTypeSchema,
  }),
  z.strictObject({
    source: z.literal('resumed_run'),
    kind: z.enum(['journal', 'handoff']),
  }),
]);
export type SchedulerTriggerResolution = z.infer<typeof schedulerTriggerResolutionSchema>;

export function resolveSchedulerTrigger(kind: SchedulerScheduleKind): SchedulerTriggerResolution {
  if (kind === 'journal' || kind === 'handoff') {
    return { source: 'resumed_run', kind };
  }
  return { source: 'direct', kind, trigger: schedulerDirectTriggerByKind[kind] };
}

const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const schedulerRecurrenceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('interval'),
    interval_ms: z.int().positive(),
    phase_ms: z.int().nonnegative().default(0),
  }),
  z.strictObject({
    type: z.literal('daily_local'),
    local_time: localTimeSchema,
    timezone: z.string().min(1),
    jitter_window_ms: z.int().nonnegative().default(0),
  }),
]);
export type SchedulerRecurrence = z.infer<typeof schedulerRecurrenceSchema>;

const payloadValueSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/^-?\d+(\.\d+)?$/.test(value), {
    error: 'schedule payload values must be opaque identifiers or cursors, not bare numbers',
  });

// ids/cursors only. Meeting content, health values, prompt text, and tool output are fetched
// at fire time behind the executor ACL, not stored in the scheduler row.
export const schedulerPayloadSchema = z.record(z.string().min(1), payloadValueSchema);
export type SchedulerPayload = z.infer<typeof schedulerPayloadSchema>;

function idMatchesKind(id: string, kind: SchedulerScheduleKind): boolean {
  switch (kind) {
    case 'journal':
      return id === 'journal';
    case 'handoff':
      return /^handoff:.+/.test(id);
    case 'pre_activity_spot':
      return /^spot:.+/.test(id);
    case 'brief':
      return briefVariantSchema.options.some((variant) => id === `brief:${variant}`);
    case 'pre_brief_sweep':
      return briefVariantSchema.options.some((variant) => id === `sweep:${variant}`);
    case 'patrol':
      return id === 'patrol';
    case 'dreaming':
      return id === 'dreaming' || id === 'dreaming:chain';
  }
}

export const schedulerScheduleEntrySchema = z
  .strictObject({
    id: z.string().min(1),
    kind: schedulerScheduleKindSchema,
    occurrence_at: z.int().nonnegative(),
    due_at: z.int().nonnegative(),
    recurrence: schedulerRecurrenceSchema.nullable(),
    payload: schedulerPayloadSchema,
    status: schedulerScheduleStatusSchema,
    attempts: z.int().nonnegative(),
    last_fired_at: z.int().nonnegative().nullable(),
    quarantined_until: z.int().nonnegative().nullable(),
    created_at: z.int().nonnegative(),
    updated_at: z.int().nonnegative(),
  })
  .refine((entry) => idMatchesKind(entry.id, entry.kind), {
    error: 'schedule id prefix must match schedule kind',
    path: ['id'],
  })
  .refine((entry) => schedulerKindCanQuarantine(entry.kind) || entry.status !== 'quarantined', {
    error: 'durability schedules may not be quarantined',
    path: ['status'],
  })
  .refine((entry) => entry.status !== 'quarantined' || entry.quarantined_until !== null, {
    error: 'quarantined schedules require quarantined_until',
    path: ['quarantined_until'],
  });
export type SchedulerScheduleEntry = z.infer<typeof schedulerScheduleEntrySchema>;

export type ScheduleExecutor<Ctx> = (
  entry: SchedulerScheduleEntry,
  ctx: Ctx,
  deadlineMs: number,
) => Promise<void>;

export const fleetHeartbeatSourceSchema = z.enum(['alarm_fire', 'ensure_armed']);
export type FleetHeartbeatSource = z.infer<typeof fleetHeartbeatSourceSchema>;

export function fleetHeartbeatCanResetMisses(source: FleetHeartbeatSource): boolean {
  return source === 'alarm_fire';
}

export const fleetLivenessRowSchema = z.strictObject({
  user_id: z.string().min(1),
  next_expected_wake: z.int().nonnegative().nullable(),
  last_wake_at: z.int().nonnegative().nullable(),
  last_wake_kind: schedulerScheduleKindSchema.nullable(),
  consecutive_misses: z.int().nonnegative(),
  updated_at: z.int().nonnegative(),
});
export type FleetLivenessRow = z.infer<typeof fleetLivenessRowSchema>;

export const watchdogRunRowSchema = z.strictObject({
  id: z.string().min(1),
  started_at: z.int().nonnegative(),
  finished_at: z.int().nonnegative().nullable(),
  overdue_selected: z.int().nonnegative(),
  pokes_attempted: z.int().nonnegative(),
  pokes_succeeded: z.int().nonnegative(),
  pokes_failed: z.int().nonnegative(),
});
export type WatchdogRunRow = z.infer<typeof watchdogRunRowSchema>;
