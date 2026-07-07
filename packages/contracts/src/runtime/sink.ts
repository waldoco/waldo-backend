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

// The duty that makes the outbox's at-least-once resume safe: a delivery sink MUST be
// idempotent on idempotency_key — a repeated send for a key it has already accepted returns
// the prior ack WITHOUT a second physical delivery. The literal `true` forces every
// implementation to declare the duty in its type; a sink that cannot satisfy it must be
// wrapped by one that can, never wired directly.
export interface DeliverySink {
  readonly idempotentOnKey: true;
  send(req: SinkRequest): SinkAck;
}

// Runtime half of the duty: the wiring seam refuses a sink that does not declare
// idempotency, so the exactly-once invariant cannot silently degrade to at-least-once.
export function assertIdempotentSink(sink: object): asserts sink is DeliverySink {
  if ((sink as { idempotentOnKey?: unknown }).idempotentOnKey !== true) {
    throw new Error('delivery sink must declare idempotency on idempotency_key');
  }
}
