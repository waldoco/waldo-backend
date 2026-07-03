import { z } from 'zod';
import { idempotencyKeySchema, opaquePayloadSchema } from './outbox';

export const sinkRequestSchema = z.strictObject({
  idempotency_key: idempotencyKeySchema,
  payload: opaquePayloadSchema,
});
export type SinkRequest = z.infer<typeof sinkRequestSchema>;

export const sinkAckSchema = z.strictObject({
  idempotency_key: idempotencyKeySchema,
  accepted: z.literal(true),
});
export type SinkAck = z.infer<typeof sinkAckSchema>;
