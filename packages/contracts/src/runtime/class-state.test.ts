import { describe, expect, it } from 'vitest';
import {
  classStateSchema,
  dailyPushBudgetSchema,
  deliveryClassCounterSchema,
  exemptTelemetrySchema,
} from './class-state';

describe('deliveryClassCounter', () => {
  it('accepts a fresh counter and an epoch-ms timestamp', () => {
    expect(deliveryClassCounterSchema.safeParse({ count: 0, last_sent_at: null }).success).toBe(
      true,
    );
    expect(
      deliveryClassCounterSchema.safeParse({ count: 2, last_sent_at: 1_700_000_000_000 }).success,
    ).toBe(true);
  });

  it('rejects a negative count and a non-int count', () => {
    expect(deliveryClassCounterSchema.safeParse({ count: -1, last_sent_at: null }).success).toBe(
      false,
    );
    expect(deliveryClassCounterSchema.safeParse({ count: 1.5, last_sent_at: null }).success).toBe(
      false,
    );
  });
});

describe('classState', () => {
  it('accepts counters keyed by push class', () => {
    expect(
      classStateSchema.safeParse({
        fetch_alert: { count: 2, last_sent_at: 1_000 },
        pre_activity_spot: { count: 1, last_sent_at: null },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown push class key', () => {
    expect(
      classStateSchema.safeParse({
        made_up: { count: 1, last_sent_at: null },
      }).success,
    ).toBe(false);
  });
});

describe('dailyPushBudget', () => {
  it('accepts the ADR-0068 daily row and defaults optional fields', () => {
    expect(dailyPushBudgetSchema.parse({ sends_total: 0 })).toEqual({
      sends_total: 0,
      exempt_sends: 0,
      class_state: {},
    });
    expect(
      dailyPushBudgetSchema.safeParse({
        local_date: '2026-07-05',
        sends_total: 2,
        exempt_sends: 1,
        class_state: { fetch_alert: { count: 1, last_sent_at: 1_000 } },
      }).success,
    ).toBe(true);
  });

  it('rejects a negative total and malformed local date', () => {
    expect(dailyPushBudgetSchema.safeParse({ sends_total: -1 }).success).toBe(false);
    expect(
      dailyPushBudgetSchema.safeParse({ local_date: '07/05/2026', sends_total: 0 }).success,
    ).toBe(false);
  });
});

describe('exemptTelemetry', () => {
  it('accepts a non-negative exempt-send count and rejects a non-int', () => {
    expect(exemptTelemetrySchema.safeParse({ exempt_sends: 1 }).success).toBe(true);
    expect(exemptTelemetrySchema.safeParse({ exempt_sends: 0.5 }).success).toBe(false);
  });
});
