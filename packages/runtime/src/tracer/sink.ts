import type { DeliverySink, SinkAck, SinkRequest } from '@waldo/contracts';

// Module-scoped so the fake models the EXTERNAL service's own persistence: APNs/Telegram
// keep their receipt state when a DO instance dies, so it must survive eviction within the
// test process. This store is deliberately NOT the exactly-once proof — the tests assert
// the runtime's behavior through sendAttempts/keys and the durable outbox columns;
// `deliveries` only corroborates that a declared-idempotent sink collapses a same-key
// re-send to one physical delivery.
const acks = new Map<string, SinkAck>();
let deliveries = 0;
let sendAttempts = 0;
const keys: string[] = [];
let failNext: string | null = null;
let invalidAckNext = false;
let wrongAckKeyNext: string | null = null;

// In-memory stand-in for APNs/Telegram, satisfying the DeliverySink idempotency duty:
// a repeat key returns the prior ack WITHOUT recording a second delivery.
export class FakeSink implements DeliverySink {
  readonly idempotentOnKey = true;

  // Arms a one-shot send failure, modelling a sink outage on the next attempt.
  static failNextSend(message: string): void {
    failNext = message;
  }

  static returnInvalidAckOnce(): void {
    invalidAckNext = true;
  }

  static returnWrongAckKeyOnce(idempotencyKey: string): void {
    wrongAckKeyNext = idempotencyKey;
  }

  send(req: SinkRequest): SinkAck {
    sendAttempts += 1;
    keys.push(req.idempotency_key);
    if (failNext !== null) {
      const message = failNext;
      failNext = null;
      throw new Error(message);
    }
    const prior = acks.get(req.idempotency_key);
    if (prior) return prior;
    if (invalidAckNext) {
      invalidAckNext = false;
      deliveries += 1;
      return { idempotency_key: req.idempotency_key, accepted: false } as unknown as SinkAck;
    }
    if (wrongAckKeyNext !== null) {
      const ack: SinkAck = { idempotency_key: wrongAckKeyNext, accepted: true };
      wrongAckKeyNext = null;
      acks.set(req.idempotency_key, ack);
      deliveries += 1;
      return ack;
    }
    const ack: SinkAck = { idempotency_key: req.idempotency_key, accepted: true };
    acks.set(req.idempotency_key, ack);
    deliveries += 1;
    return ack;
  }

  observedDeliveries(): number {
    return deliveries;
  }

  // Every send call, including same-key repeats and failed attempts — the runtime-side
  // at-least-once/at-most-once assertions read this, not the deduped delivery count.
  observedSendAttempts(): number {
    return sendAttempts;
  }

  observedKeys(): readonly string[] {
    return keys;
  }

  reset(): void {
    acks.clear();
    deliveries = 0;
    sendAttempts = 0;
    keys.length = 0;
    failNext = null;
    invalidAckNext = false;
    wrongAckKeyNext = null;
  }
}
