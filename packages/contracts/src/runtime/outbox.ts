import { z } from 'zod';

// 64-char lower-hex SHA-256 digest. Upper-case and wrong-length values are rejected so the
// key is a single canonical representation across the UNIQUE(idempotency_key) constraint.
export const idempotencyKeySchema = z.string().regex(/^[0-9a-f]{64}$/);
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

// Opaque synthetic token only — never a physiological value. A purely numeric payload is
// rejected to keep raw health values (HRV, HR, sleep hours, ...) out of the outbox.
export const opaquePayloadSchema = z
  .string()
  .min(1)
  .refine((s) => !/^-?\d+(\.\d+)?$/.test(s), {
    error: 'payload must be an opaque token, not a bare numeric value',
  });
export type OpaquePayload = z.infer<typeof opaquePayloadSchema>;

// Durable delivery state. 'pending' = intent committed in the GATED transaction, sink never
// attempted. 'sent_unacked' = a send attempt is durably marked but no ack is recorded — the
// in-doubt window; a resume re-sends the SAME idempotency key and relies on the sink's
// declared idempotency (see sink.ts) to collapse the repeat. 'acked' = the ack is durable;
// the row must never reach a sink again.
export const outboxStatusSchema = z.enum(['pending', 'sent_unacked', 'acked']);
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

const intentShape = {
  run_id: z.string().min(1),
  kind: z.literal('fetch_alert'),
  idempotency_key: idempotencyKeySchema,
  payload: opaquePayloadSchema,
  created_at: z.int().nonnegative(),
} as const;

// The intent committed atomically with the DeliveryGate verdict: identity + key + payload,
// before any send attempt exists. Delivery state (status/attempts/ack) is runtime-owned and
// lives only on the full row.
export const outboxIntentSchema = z.strictObject(intentShape);
export type OutboxIntent = z.infer<typeof outboxIntentSchema>;

export const outboxRowSchema = z
  .strictObject({
    ...intentShape,
    status: outboxStatusSchema,
    attempts: z.int().nonnegative(),
    next_retry_at: z.int().nonnegative().nullable(),
    acked_at: z.int().nonnegative().nullable(),
    last_error: z.string().min(1).nullable(),
  })
  .refine((row) => (row.status === 'pending') === (row.attempts === 0), {
    error: 'attempts is zero before the first send attempt and positive from then on',
    path: ['attempts'],
  })
  .refine((row) => (row.status === 'acked') === (row.acked_at !== null), {
    error: 'acked_at is recorded exactly when the row is acked',
    path: ['acked_at'],
  })
  .refine((row) => (row.status === 'sent_unacked') === (row.next_retry_at !== null), {
    error: 'exactly the in-doubt (sent_unacked) row carries a next_retry_at stamp',
    path: ['next_retry_at'],
  });
export type OutboxRow = z.infer<typeof outboxRowSchema>;

export const deliverySchema = z.strictObject({
  run_id: z.string().min(1),
  kind: z.literal('fetch_alert'),
  payload: opaquePayloadSchema,
});
export type Delivery = z.infer<typeof deliverySchema>;

// Canonical stable-ordered serialization: the SHA-256 idempotency key is derived from this,
// so a reordered-but-equal delivery MUST serialize identically. Keys are emitted in a fixed
// order rather than relying on JSON.stringify's insertion order.
export function canonicalDeliverySerialization(delivery: Delivery): string {
  return JSON.stringify([
    ['kind', delivery.kind],
    ['payload', delivery.payload],
    ['run_id', delivery.run_id],
  ]);
}
