import { describe, expect, it } from 'vitest';
import { sinkAckSchema, sinkRequestSchema } from './sink';

const key = 'b'.repeat(64);

describe('sinkRequest', () => {
  it('accepts an opaque-token payload with a valid key', () => {
    expect(
      sinkRequestSchema.safeParse({ idempotency_key: key, payload: 'synthetic-token-01' }).success,
    ).toBe(true);
  });

  it('rejects a numeric physiological payload', () => {
    expect(sinkRequestSchema.safeParse({ idempotency_key: key, payload: '72' }).success).toBe(
      false,
    );
  });

  it('rejects a malformed key', () => {
    expect(
      sinkRequestSchema.safeParse({ idempotency_key: 'nope', payload: 'synthetic-token-01' })
        .success,
    ).toBe(false);
  });
});

describe('sinkAck', () => {
  it('accepts an accepted:true ack and rejects accepted:false', () => {
    expect(sinkAckSchema.safeParse({ idempotency_key: key, accepted: true }).success).toBe(true);
    expect(sinkAckSchema.safeParse({ idempotency_key: key, accepted: false }).success).toBe(false);
  });
});
