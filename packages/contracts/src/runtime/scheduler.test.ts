import { describe, expect, it } from 'vitest';
import {
  fleetHeartbeatCanResetMisses,
  fleetLivenessRowSchema,
  resolveSchedulerTrigger,
  schedulerDirectTriggerByKind,
  schedulerKindCanQuarantine,
  schedulerKindPriority,
  schedulerPayloadSchema,
  schedulerScheduleEntrySchema,
  schedulerScheduleKindSchema,
  schedulerTriggerResolutionSchema,
  watchdogRunRowSchema,
} from './scheduler';

const baseEntry = {
  id: 'patrol',
  kind: 'patrol' as const,
  occurrence_at: 1_000,
  due_at: 1_000,
  recurrence: { type: 'interval' as const, interval_ms: 900_000, phase_ms: 0 },
  payload: {},
  status: 'armed' as const,
  attempts: 0,
  last_fired_at: null,
  quarantined_until: null,
  created_at: 1_000,
  updated_at: 1_000,
};

describe('schedulerScheduleKind', () => {
  it('pins the seven ADR-0065 logical schedules in priority order', () => {
    expect(schedulerScheduleKindSchema.options).toEqual([
      'journal',
      'handoff',
      'pre_activity_spot',
      'brief',
      'pre_brief_sweep',
      'patrol',
      'dreaming',
    ]);
    expect(schedulerKindPriority).toEqual({
      journal: 0,
      handoff: 1,
      pre_activity_spot: 2,
      brief: 3,
      pre_brief_sweep: 4,
      patrol: 5,
      dreaming: 6,
    });
  });
});

describe('schedulerScheduleEntry', () => {
  it('accepts legal kind/id pairs', () => {
    const cases = [
      { id: 'journal', kind: 'journal' },
      { id: 'handoff:run-1', kind: 'handoff' },
      { id: 'spot:calendar-instance-1', kind: 'pre_activity_spot' },
      { id: 'brief:morning', kind: 'brief' },
      { id: 'sweep:midday', kind: 'pre_brief_sweep' },
      { id: 'patrol', kind: 'patrol' },
      { id: 'dreaming', kind: 'dreaming' },
      { id: 'dreaming:chain', kind: 'dreaming' },
    ] as const;

    for (const c of cases) {
      expect(schedulerScheduleEntrySchema.safeParse({ ...baseEntry, ...c }).success).toBe(true);
    }
  });

  it('rejects mismatched ids and unknown variants', () => {
    expect(
      schedulerScheduleEntrySchema.safeParse({
        ...baseEntry,
        id: 'brief:morning',
        kind: 'pre_brief_sweep',
      }).success,
    ).toBe(false);
    expect(
      schedulerScheduleEntrySchema.safeParse({
        ...baseEntry,
        id: 'brief:night',
        kind: 'brief',
      }).success,
    ).toBe(false);
  });

  it('accepts daily-local recurrence and rejects invalid local times', () => {
    expect(
      schedulerScheduleEntrySchema.safeParse({
        ...baseEntry,
        id: 'brief:evening',
        kind: 'brief',
        recurrence: {
          type: 'daily_local',
          local_time: '18:00',
          timezone: 'Asia/Kolkata',
          jitter_window_ms: 0,
        },
      }).success,
    ).toBe(true);
    expect(
      schedulerScheduleEntrySchema.safeParse({
        ...baseEntry,
        recurrence: {
          type: 'daily_local',
          local_time: '25:00',
          timezone: 'Asia/Kolkata',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects durability-kind quarantine', () => {
    expect(schedulerKindCanQuarantine('journal')).toBe(false);
    expect(schedulerKindCanQuarantine('handoff')).toBe(false);
    expect(
      schedulerScheduleEntrySchema.safeParse({
        ...baseEntry,
        id: 'journal',
        kind: 'journal',
        status: 'quarantined',
        quarantined_until: 2_000,
      }).success,
    ).toBe(false);
  });

  it('allows product-kind quarantine only with a reap time', () => {
    expect(schedulerKindCanQuarantine('brief')).toBe(true);
    expect(
      schedulerScheduleEntrySchema.safeParse({
        ...baseEntry,
        id: 'brief:morning',
        kind: 'brief',
        status: 'quarantined',
        quarantined_until: 2_000,
      }).success,
    ).toBe(true);
    expect(
      schedulerScheduleEntrySchema.safeParse({
        ...baseEntry,
        id: 'brief:morning',
        kind: 'brief',
        status: 'quarantined',
        quarantined_until: null,
      }).success,
    ).toBe(false);
  });
});

describe('schedulerPayload', () => {
  it('accepts bounded opaque ids and cursors', () => {
    expect(
      schedulerPayloadSchema.safeParse({
        cursor: 'health-sync-anchor-1',
        calendar_instance_id: 'event-instance-1',
      }).success,
    ).toBe(true);
  });

  it('rejects bare numeric payload values and non-string content', () => {
    expect(schedulerPayloadSchema.safeParse({ cursor: '42' }).success).toBe(false);
    expect(schedulerPayloadSchema.safeParse({ count: 42 }).success).toBe(false);
  });
});

describe('schedulerTriggerResolution', () => {
  it('maps direct schedule kinds to trigger types', () => {
    expect(schedulerDirectTriggerByKind).toEqual({
      pre_activity_spot: 'pre_activity_spot',
      brief: 'brief',
      pre_brief_sweep: 'pre_brief_sweep',
      patrol: 'patrol',
      dreaming: 'dreaming_mode',
    });
    expect(resolveSchedulerTrigger('pre_brief_sweep')).toEqual({
      source: 'direct',
      kind: 'pre_brief_sweep',
      trigger: 'pre_brief_sweep',
    });
    expect(schedulerTriggerResolutionSchema.safeParse(resolveSchedulerTrigger('brief')).success).toBe(
      true,
    );
  });

  it('leaves journal and handoff under the resumed run trigger', () => {
    expect(resolveSchedulerTrigger('journal')).toEqual({ source: 'resumed_run', kind: 'journal' });
    expect(resolveSchedulerTrigger('handoff')).toEqual({ source: 'resumed_run', kind: 'handoff' });
  });
});

describe('fleet liveness', () => {
  it('allows paused users with no expected wake', () => {
    expect(
      fleetLivenessRowSchema.safeParse({
        user_id: 'user-1',
        next_expected_wake: null,
        last_wake_at: null,
        last_wake_kind: null,
        consecutive_misses: 0,
        updated_at: 1_000,
      }).success,
    ).toBe(true);
  });

  it('keeps source-split heartbeat semantics', () => {
    expect(fleetHeartbeatCanResetMisses('alarm_fire')).toBe(true);
    expect(fleetHeartbeatCanResetMisses('ensure_armed')).toBe(false);
  });

  it('accepts bounded watchdog dead-man counters only', () => {
    expect(
      watchdogRunRowSchema.safeParse({
        id: 'watchdog-1',
        started_at: 1_000,
        finished_at: 1_500,
        overdue_selected: 10,
        pokes_attempted: 10,
        pokes_succeeded: 9,
        pokes_failed: 1,
      }).success,
    ).toBe(true);
    expect(
      watchdogRunRowSchema.safeParse({
        id: 'watchdog-1',
        started_at: 1_000,
        finished_at: 1_500,
        overdue_selected: 10,
        pokes_attempted: 10,
        pokes_succeeded: 9,
        pokes_failed: 1,
        user_ids: ['user-1'],
      }).success,
    ).toBe(false);
  });
});
