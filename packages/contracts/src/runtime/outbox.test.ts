import { describe, expect, it } from 'vitest';
import { canonicalDeliverySerialization, outboxRowSchema } from './outbox';

const key = 'a'.repeat(64);

const baseRow = {
  run_id: 'run-1',
  kind: 'fetch_alert' as const,
  idempotency_key: key,
  payload: 'synthetic-token-01',
  created_at: 1_000,
};

describe('outboxRow', () => {
  it('accepts a row with a 64-char lower-hex key and an opaque payload', () => {
    expect(outboxRowSchema.safeParse(baseRow).success).toBe(true);
  });

  it('rejects a wrong-length key', () => {
    expect(outboxRowSchema.safeParse({ ...baseRow, idempotency_key: 'a'.repeat(63) }).success).toBe(
      false,
    );
  });

  it('rejects an upper-hex key', () => {
    expect(
      outboxRowSchema.safeParse({ ...baseRow, idempotency_key: 'A'.repeat(64) }).success,
    ).toBe(false);
  });

  it('rejects the wrong kind', () => {
    expect(outboxRowSchema.safeParse({ ...baseRow, kind: 'brief' }).success).toBe(false);
  });

  it('rejects a bare numeric (physiological-looking) payload', () => {
    expect(outboxRowSchema.safeParse({ ...baseRow, payload: '42' }).success).toBe(false);
    expect(outboxRowSchema.safeParse({ ...baseRow, payload: '58.5' }).success).toBe(false);
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
