import { describe, expect, it } from 'vitest';
import { classStateSchema, dailyPushBudgetSchema, exemptTelemetrySchema } from './class-state';

describe('classState', () => {
  it('accepts a fresh counter (count 0, last_sent_at null) and an epoch-ms timestamp', () => {
    expect(
      classStateSchema.safeParse({ fetch_alert: { count: 0, last_sent_at: null } }).success,
    ).toBe(true);
    expect(
      classStateSchema.safeParse({ fetch_alert: { count: 2, last_sent_at: 1_700_000_000_000 } })
        .success,
    ).toBe(true);
  });

  it('rejects a negative count, a non-int count, and a missing fetch_alert key', () => {
    expect(
      classStateSchema.safeParse({ fetch_alert: { count: -1, last_sent_at: null } }).success,
    ).toBe(false);
    expect(
      classStateSchema.safeParse({ fetch_alert: { count: 1.5, last_sent_at: null } }).success,
    ).toBe(false);
    expect(classStateSchema.safeParse({}).success).toBe(false);
  });
});

describe('dailyPushBudget', () => {
  it('accepts a non-negative total and rejects a negative one', () => {
    expect(dailyPushBudgetSchema.safeParse({ sends_total: 0 }).success).toBe(true);
    expect(dailyPushBudgetSchema.safeParse({ sends_total: -1 }).success).toBe(false);
  });
});

describe('exemptTelemetry', () => {
  it('accepts a non-negative exempt-send count and rejects a non-int', () => {
    expect(exemptTelemetrySchema.safeParse({ exempt_sends: 1 }).success).toBe(true);
    expect(exemptTelemetrySchema.safeParse({ exempt_sends: 0.5 }).success).toBe(false);
  });
});
