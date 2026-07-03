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

export const outboxRowSchema = z.strictObject({
  run_id: z.string().min(1),
  kind: z.literal('fetch_alert'),
  idempotency_key: idempotencyKeySchema,
  payload: opaquePayloadSchema,
  created_at: z.int().nonnegative(),
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
