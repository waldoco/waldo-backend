import type { SinkAck, SinkRequest } from '@waldo/contracts';

// Module-scope so a DO instance reconstructed after eviction still observes prior deliveries
// within the same test process — that is what lets crash #5 (sent, ack not yet recorded) prove
// the re-driven resume re-sends the SAME key and gets the prior ack without a second delivery.
const acks = new Map<string, SinkAck>();
let deliveries = 0;

// In-memory stand-in for APNs/Telegram. Idempotent on idempotency_key: a repeat key returns the
// prior ack WITHOUT recording a second delivery. This dedupe is deliberately NOT the exactly-once
// proof — the durable-layer outbox/journal/counter assertions are; the sink count only corroborates.
export class FakeSink {
  send(req: SinkRequest): SinkAck {
    const prior = acks.get(req.idempotency_key);
    if (prior) return prior;
    const ack: SinkAck = { idempotency_key: req.idempotency_key, accepted: true };
    acks.set(req.idempotency_key, ack);
    deliveries += 1;
    return ack;
  }

  observedDeliveries(): number {
    return deliveries;
  }

  reset(): void {
    acks.clear();
    deliveries = 0;
  }
}
