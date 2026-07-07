import { describe, expect, it } from 'vitest';
import {
  canonicalDeliverySerialization,
  outboxIntentSchema,
  outboxRowSchema,
} from './outbox';

// ADR-0054: outbox payloads are opaque synthetic references, never raw health values or free text.
const key = 'a'.repeat(64);

const baseIntent = {
  run_id: 'run-1',
  kind: 'fetch_alert' as const,
  idempotency_key: key,
  payload: 'synthetic-token-01',
  created_at: 1_000,
};

const pendingRow = {
  ...baseIntent,
  status: 'pending' as const,
  attempts: 0,
  next_retry_at: null,
  acked_at: null,
  last_error: null,
};

const inDoubtRow = {
  ...pendingRow,
  status: 'sent_unacked' as const,
  attempts: 1,
  next_retry_at: 2_000,
};

const failedSendRow = {
  ...inDoubtRow,
  last_error: 'send_failed',
};

const ackedRow = {
  ...pendingRow,
  status: 'acked' as const,
  attempts: 1,
  acked_at: 3_000,
};

describe('outboxIntent', () => {
  it('accepts the gate-committed intent shape', () => {
    expect(outboxIntentSchema.safeParse(baseIntent).success).toBe(true);
  });

  it('rejects delivery-state fields on the intent (strict)', () => {
    expect(outboxIntentSchema.safeParse({ ...baseIntent, status: 'pending' }).success).toBe(false);
  });
});

describe('outboxRow', () => {
  it('accepts each of the three delivery states with consistent fields', () => {
    expect(outboxRowSchema.safeParse(pendingRow).success).toBe(true);
    expect(outboxRowSchema.safeParse(inDoubtRow).success).toBe(true);
    expect(outboxRowSchema.safeParse(ackedRow).success).toBe(true);
  });

  it('rejects a wrong-length key', () => {
    expect(
      outboxRowSchema.safeParse({ ...pendingRow, idempotency_key: 'a'.repeat(63) }).success,
    ).toBe(false);
  });

  it('rejects an upper-hex key', () => {
    expect(
      outboxRowSchema.safeParse({ ...pendingRow, idempotency_key: 'A'.repeat(64) }).success,
    ).toBe(false);
  });

  it('rejects the wrong kind', () => {
    expect(outboxRowSchema.safeParse({ ...pendingRow, kind: 'brief' }).success).toBe(false);
  });

  it('rejects a bare numeric (physiological-looking) payload', () => {
    expect(outboxRowSchema.safeParse({ ...pendingRow, payload: '42' }).success).toBe(false);
    expect(outboxRowSchema.safeParse({ ...pendingRow, payload: '58.5' }).success).toBe(false);
  });

  it('rejects free-text payloads instead of treating them as opaque references', () => {
    expect(outboxRowSchema.safeParse({ ...pendingRow, payload: 'free form text' }).success).toBe(
      false,
    );
    expect(outboxRowSchema.safeParse({ ...pendingRow, payload: 'name@example.test' }).success).toBe(
      false,
    );
  });

  it('accepts only the bounded send failure marker in last_error', () => {
    expect(outboxRowSchema.safeParse(failedSendRow).success).toBe(true);
    expect(
      outboxRowSchema.safeParse({ ...failedSendRow, last_error: 'provider said HRV 42' }).success,
    ).toBe(false);
  });

  it('rejects caller-less reference prefixes until a real sink owns them', () => {
    expect(
      outboxRowSchema.safeParse({ ...pendingRow, payload: 'delivery-ref-01' }).success,
    ).toBe(false);
    expect(outboxRowSchema.safeParse({ ...pendingRow, payload: 'outbox-ref-01' }).success).toBe(
      false,
    );
  });

  it('rejects a pending row that claims a send attempt', () => {
    expect(outboxRowSchema.safeParse({ ...pendingRow, attempts: 1 }).success).toBe(false);
  });

  it('rejects an attempted row with zero attempts', () => {
    expect(outboxRowSchema.safeParse({ ...inDoubtRow, attempts: 0 }).success).toBe(false);
  });

  it('rejects an acked row without acked_at, and acked_at outside acked', () => {
    expect(outboxRowSchema.safeParse({ ...ackedRow, acked_at: null }).success).toBe(false);
    expect(outboxRowSchema.safeParse({ ...inDoubtRow, acked_at: 3_000 }).success).toBe(false);
  });

  it('rejects an in-doubt row without next_retry_at, and next_retry_at on settled rows', () => {
    expect(outboxRowSchema.safeParse({ ...inDoubtRow, next_retry_at: null }).success).toBe(false);
    expect(outboxRowSchema.safeParse({ ...pendingRow, next_retry_at: 2_000 }).success).toBe(false);
    expect(
      outboxRowSchema.safeParse({ ...ackedRow, next_retry_at: 2_000 }).success,
    ).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(outboxRowSchema.safeParse({ ...pendingRow, status: 'sending' }).success).toBe(false);
  });
});

describe('canonicalDeliverySerialization', () => {
  it('is stable under key reordering', () => {
    const a = canonicalDeliverySerialization({
      run_id: 'run-1',
      kind: 'fetch_alert',
      payload: 'synthetic-token-01',
    });
    const b = canonicalDeliverySerialization({
      payload: 'synthetic-token-01',
      kind: 'fetch_alert',
      run_id: 'run-1',
    });
    expect(a).toBe(b);
  });

  it('differs when the payload differs', () => {
    const a = canonicalDeliverySerialization({
      run_id: 'run-1',
      kind: 'fetch_alert',
      payload: 'synthetic-token-01',
    });
    const b = canonicalDeliverySerialization({
      run_id: 'run-1',
      kind: 'fetch_alert',
      payload: 'synthetic-token-02',
    });
    expect(a).not.toBe(b);
  });
});
