import type { DeliverySink, SinkAck, SinkRequest } from '@waldo/contracts';

export class FakeSink implements DeliverySink {
  readonly idempotentOnKey = true;
  private acks = new Map<string, SinkAck>();
  private deliveries = 0;
  private sendAttempts = 0;
  private keys: string[] = [];
  private failNext: string | null = null;
  private invalidAckNext = false;
  private wrongAckKeyNext: string | null = null;

  // Shared singleton for tests that don't use per-DO sinks (kept for backward compatibility).
  private static defaultSink: FakeSink | null = null;

  static get shared(): FakeSink {
    if (FakeSink.defaultSink === null) FakeSink.defaultSink = new FakeSink();
    return FakeSink.defaultSink;
  }

  /** @deprecated Use per-DO-instance sinks via FakeSink.forDO() instead. */
  static reset(): void {
    FakeSink.shared.reset();
  }

  // Per-DO-instance sink registry. Each TracerDO creates/retrieves its own FakeSink keyed by
  // ctx.id.toString() so eviction + resume preserves the delivery counter across instances.
  private static instances = new Map<string, FakeSink>();

  static forDO(doName: string): FakeSink {
    let sink = FakeSink.instances.get(doName);
    if (sink === undefined) {
      sink = new FakeSink();
      FakeSink.instances.set(doName, sink);
    }
    return sink;
  }

  static resetAll(): void {
    FakeSink.instances.clear();
  }

  failNextSend(message: string): void {
    this.failNext = message;
  }

  returnInvalidAckOnce(): void {
    this.invalidAckNext = true;
  }

  returnWrongAckKeyOnce(idempotencyKey: string): void {
    this.wrongAckKeyNext = idempotencyKey;
  }

  send(req: SinkRequest): SinkAck {
    this.sendAttempts += 1;
    this.keys.push(req.idempotency_key);
    if (this.failNext !== null) {
      const message = this.failNext;
      this.failNext = null;
      throw new Error(message);
    }
    const prior = this.acks.get(req.idempotency_key);
    if (prior) return prior;
    if (this.invalidAckNext) {
      this.invalidAckNext = false;
      this.deliveries += 1;
      return { idempotency_key: req.idempotency_key, accepted: false } as unknown as SinkAck;
    }
    if (this.wrongAckKeyNext !== null) {
      const ack: SinkAck = { idempotency_key: this.wrongAckKeyNext, accepted: true };
      this.wrongAckKeyNext = null;
      this.acks.set(req.idempotency_key, ack);
      this.deliveries += 1;
      return ack;
    }
    const ack: SinkAck = { idempotency_key: req.idempotency_key, accepted: true };
    this.acks.set(req.idempotency_key, ack);
    this.deliveries += 1;
    return ack;
  }

  observedDeliveries(): number {
    return this.deliveries;
  }

  observedSendAttempts(): number {
    return this.sendAttempts;
  }

  observedKeys(): readonly string[] {
    return this.keys;
  }

  reset(): void {
    this.acks.clear();
    this.deliveries = 0;
    this.sendAttempts = 0;
    this.keys = [];
    this.failNext = null;
    this.invalidAckNext = false;
    this.wrongAckKeyNext = null;
  }
}
