import { z } from 'zod';
import type { TriggerType } from '../core/trigger';

export const scheduleKindSchema = z.enum([
  'journal',
  'handoff',
  'pre_activity_spot',
  'brief',
  'pre_brief_sweep',
  'patrol',
  'dreaming',
  'reminder',
]);
export type ScheduleKind = z.infer<typeof scheduleKindSchema>;

export const scheduleKindPriority: Readonly<Record<ScheduleKind, number>> = {
  journal: 0,
  handoff: 1,
  pre_activity_spot: 2,
  brief: 3,
  pre_brief_sweep: 4,
  patrol: 5,
  dreaming: 6,
  reminder: 7,
};

export const scheduleKindTrigger: Readonly<Record<ScheduleKind, TriggerType | null>> = {
  journal: null,
  handoff: null,
  pre_activity_spot: 'pre_activity_spot',
  brief: 'brief',
  pre_brief_sweep: 'pre_brief_sweep',
  patrol: 'patrol',
  dreaming: 'dreaming_mode',
  reminder: null,
};

export const scheduleStatusSchema = z.enum(['armed', 'quarantined']);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

export const scheduleRecurrenceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('interval'),
    every_ms: z.int().positive(),
    phase_ms: z.int().nonnegative().default(0),
  }),
  z.strictObject({
    type: z.literal('daily_local'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().min(1).max(64),
  }),
]);
export type ScheduleRecurrence = z.infer<typeof scheduleRecurrenceSchema>;

const schedulePayloadRefKeySchema = z
  .string()
  .regex(/^(id|cursor|[a-z][a-z0-9_]*_(id|ids|cursor))$/);
export const schedulePayloadRefsSchema = z.record(
  schedulePayloadRefKeySchema,
  z.string().min(1).max(200),
);
export type SchedulePayloadRefs = z.infer<typeof schedulePayloadRefsSchema>;

export const scheduleEntrySchema = z
  .strictObject({
    id: z.string().min(1),
    kind: scheduleKindSchema,
    occurrence_at: z.int().nonnegative(),
    due_at: z.int().nonnegative(),
    recurrence: scheduleRecurrenceSchema.nullable(),
    payload_refs: schedulePayloadRefsSchema,
    status: scheduleStatusSchema,
    attempts: z.int().nonnegative(),
    last_fired_at: z.int().nonnegative().nullable(),
    quarantined_until: z.int().nonnegative().nullable(),
    created_at: z.int().nonnegative(),
    updated_at: z.int().nonnegative(),
  })
  .refine((entry) => entry.due_at >= entry.occurrence_at, {
    error: 'due_at must be greater than or equal to occurrence_at',
    path: ['due_at'],
  })
  .refine((entry) => entry.updated_at >= entry.created_at, {
    error: 'updated_at must be greater than or equal to created_at',
    path: ['updated_at'],
  })
  .refine((entry) => (entry.status === 'quarantined') === (entry.quarantined_until !== null), {
    error: 'quarantined_until is required only for quarantined schedules',
    path: ['quarantined_until'],
  });
export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;

export function scheduleKindCanQuarantine(kind: ScheduleKind): boolean {
  return kind !== 'journal' && kind !== 'handoff';
}

export function nextWakeBound(entries: readonly unknown[]): number | null {
  let earliest: number | null = null;

  for (const candidate of entries) {
    const entry = scheduleEntrySchema.parse(candidate);
    const bound = entry.status === 'armed' ? entry.due_at : entry.quarantined_until;
    if (bound !== null && (earliest === null || bound < earliest)) {
      earliest = bound;
    }
  }

  return earliest;
}
