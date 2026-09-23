import { describe, expect, it } from 'vitest';
import { assertIdempotentSink, sinkAckSchema, sinkRequestSchema } from './sink';

// ADR-0054: sink egress accepts only idempotent requests with opaque, non-health payloads.
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

  it('rejects free-text payloads', () => {
    expect(
      sinkRequestSchema.safeParse({ idempotency_key: key, payload: 'free form text' }).success,
    ).toBe(false);
  });

  it('rejects speculative reference prefixes without a runtime owner', () => {
    expect(
      sinkRequestSchema.safeParse({ idempotency_key: key, payload: 'delivery-ref-01' }).success,
    ).toBe(false);
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

describe('assertIdempotentSink', () => {
  const send = () => ({ idempotency_key: key, accepted: true as const });

  it('accepts a sink that declares idempotency on the key', () => {
    expect(() => assertIdempotentSink({ idempotentOnKey: true, send })).not.toThrow();
  });

  it('rejects a sink without the declaration or with a non-literal one', () => {
    expect(() => assertIdempotentSink({ send })).toThrow(/must declare idempotency/);
    expect(() => assertIdempotentSink({ idempotentOnKey: 'yes', send })).toThrow(
      /must declare idempotency/,
    );
  });
});
