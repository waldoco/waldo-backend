import { describe, expect, it } from 'vitest';
import {
  nextWakeBound,
  scheduleEntrySchema,
  scheduleKindCanQuarantine,
  scheduleKindPriority,
  scheduleKindSchema,
  scheduleKindTrigger,
} from './schedule';

const baseEntry = {
  id: 'sched-1',
  kind: 'brief' as const,
  occurrence_at: 1_000,
  due_at: 1_000,
  recurrence: { type: 'daily_local' as const, time: '07:30', timezone: 'Asia/Kolkata' },
  payload_refs: { schedule_id: 'brief:morning' },
  status: 'armed' as const,
  attempts: 0,
  last_fired_at: null,
  quarantined_until: null,
  created_at: 1_000,
  updated_at: 1_000,
};

describe('scheduleKind', () => {
  it('is the seven ADR-0065 scheduler kinds plus owner reminders, in priority order', () => {
    expect(scheduleKindSchema.options).toEqual([
      'journal',
      'handoff',
      'pre_activity_spot',
      'brief',
      'pre_brief_sweep',
      'patrol',
      'dreaming',
      'reminder',
    ]);
    expect(scheduleKindPriority).toEqual({
      journal: 0,
      handoff: 1,
      pre_activity_spot: 2,
      brief: 3,
      pre_brief_sweep: 4,
      patrol: 5,
      dreaming: 6,
      reminder: 7,
    });
  });

  it('maps product schedule kinds to canonical triggers without inventing triggers for durability resumes', () => {
    expect(scheduleKindTrigger).toEqual({
      journal: null,
      handoff: null,
      pre_activity_spot: 'pre_activity_spot',
      brief: 'brief',
      pre_brief_sweep: 'pre_brief_sweep',
      patrol: 'patrol',
      dreaming: 'dreaming_mode',
      reminder: null,
    });
  });

  it('keeps journal and handoff out of product quarantine', () => {
    expect(scheduleKindCanQuarantine('journal')).toBe(false);
    expect(scheduleKindCanQuarantine('handoff')).toBe(false);
    expect(scheduleKindCanQuarantine('brief')).toBe(true);
  });
});

describe('scheduleEntry', () => {
  it('accepts an armed recurring product schedule entry', () => {
    expect(scheduleEntrySchema.safeParse(baseEntry).success).toBe(true);
  });

  it('accepts a one-shot durability schedule entry with reference-only payload', () => {
    expect(
      scheduleEntrySchema.safeParse({
        ...baseEntry,
        id: 'handoff:run-123',
        kind: 'handoff',
        recurrence: null,
        payload_refs: { run_id: 'run-123', cursor: 'step-4' },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(scheduleEntrySchema.safeParse({ ...baseEntry, kind: 'tracer' }).success).toBe(false);
  });

  it('rejects negative attempts', () => {
    expect(scheduleEntrySchema.safeParse({ ...baseEntry, attempts: -1 }).success).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(scheduleEntrySchema.safeParse({ ...baseEntry, status: 'firing' }).success).toBe(false);
  });

  it('rejects due_at before occurrence_at', () => {
    expect(scheduleEntrySchema.safeParse({ ...baseEntry, due_at: 999 }).success).toBe(false);
  });

  it('rejects updated_at before created_at', () => {
    expect(scheduleEntrySchema.safeParse({ ...baseEntry, updated_at: 999 }).success).toBe(false);
  });

  it('requires quarantined_until only for quarantined rows', () => {
    expect(scheduleEntrySchema.safeParse({ ...baseEntry, status: 'quarantined' }).success).toBe(false);
    expect(
      scheduleEntrySchema.safeParse({
        ...baseEntry,
        status: 'quarantined',
        quarantined_until: 86_400_000,
      }).success,
    ).toBe(true);
    expect(scheduleEntrySchema.safeParse({ ...baseEntry, quarantined_until: 2_000 }).success).toBe(false);
  });

  it('keeps payload refs to ids/cursors, not raw content or health values', () => {
    expect(
      scheduleEntrySchema.safeParse({
        ...baseEntry,
        payload_refs: { hrv_ms: 45 },
      }).success,
    ).toBe(false);
    expect(
      scheduleEntrySchema.safeParse({
        ...baseEntry,
        payload_refs: { content: 'full user message body' },
      }).success,
    ).toBe(false);
    expect(
      scheduleEntrySchema.safeParse({
        ...baseEntry,
        payload_refs: { variant: 'morning' },
      }).success,
    ).toBe(false);
  });

  it('validates local daily recurrence shape', () => {
    expect(
      scheduleEntrySchema.safeParse({
        ...baseEntry,
        recurrence: { type: 'daily_local', time: '24:00', timezone: 'Asia/Kolkata' },
      }).success,
    ).toBe(false);
  });
});

describe('nextWakeBound', () => {
  it('returns the earliest armed due_at or quarantined retry time', () => {
    expect(
      nextWakeBound([
        { ...baseEntry, due_at: 5_000 },
        {
          ...baseEntry,
          id: 'brief:late',
          due_at: 3_000,
        },
        {
          ...baseEntry,
          id: 'patrol',
          kind: 'patrol',
          status: 'quarantined',
          due_at: 1_000,
          quarantined_until: 2_000,
        },
      ]),
    ).toBe(2_000);
  });

  it('returns null when no schedule row can wake the DO', () => {
    expect(nextWakeBound([])).toBeNull();
  });
});
