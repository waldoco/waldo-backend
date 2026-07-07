import type {
  DeliverySink,
  DeliveryVerdict,
  JournalRow,
  OutboxIntent,
  OutboxRow,
} from '@waldo/contracts';
import {
  FETCH_ALERT_POLICY,
  assertIdempotentSink,
  canonicalDeliverySerialization,
  deliveryVerdictSchema,
  outboxIntentSchema,
  sinkAckSchema,
  sinkRequestSchema,
} from '@waldo/contracts';
import type { Deps } from '../seams/deps';
import { computeVerdict } from '../tracer/gate';
import { admit } from '../tracer/governor';
import { Journal } from '../tracer/journal';
import { Outbox } from '../tracer/outbox';
import { Store } from '../tracer/store';

const KIND = 'fetch_alert' as const;
const PAYLOAD = 'synthetic-token-01';

export type RunJournalOutboxCrashPoint =
  | 'pre_gate_commit'
  | 'post_attempt_pre_send'
  | 'post_sink_pre_ack'
  | 'post_ack_pre_return';

export type StartRunInput = {
  userId: string;
  trigger: typeof KIND;
  occurrenceAt: number;
};

export type EnqueueOutboxInput = Pick<OutboxIntent, 'run_id' | 'kind' | 'created_at'> & {
  verdict: DeliveryVerdict;
};

type FaultHooks = {
  crashPoint?: () => RunJournalOutboxCrashPoint | undefined;
};

export class RunJournalOutbox {
  private readonly journal: Journal;
  private readonly outbox: Outbox;
  private readonly store: Store;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly deps: Deps,
    private readonly sink: DeliverySink,
    private readonly hooks: FaultHooks = {},
  ) {
    assertIdempotentSink(sink);
    this.journal = new Journal(storage.sql, deps);
    this.outbox = new Outbox(storage.sql, deps);
    this.store = new Store(storage.sql);
  }

  startRun(input: StartRunInput): string {
    assertValidStartRunInput(input);
    const runId = this.deps.newRunId();
    this.journal.openRun({
      runId,
      userId: input.userId,
      trigger: input.trigger,
      occurrenceAt: input.occurrenceAt,
    });
    return runId;
  }

  // Read and validate the committed journal row after eviction. Progress is driven by tickRun so
  // a caller can inspect durable state without accidentally sending.
  resumeRun(runId: string): JournalRow | null {
    return this.journal.read(runId);
  }

  async tickRun(runId: string): Promise<void> {
    const run = this.journal.read(runId);
    if (run === null || run.state === 'DONE' || run.state === 'FAILED') return;

    if (run.state === 'RUN_OPENED') {
      this.journal.advance(run.run_id, admitToState(admit('fetch')));
    }
    const afterAdmit = this.journal.read(runId);
    if (afterAdmit?.state === 'GOVERNOR_ADMITTED') {
      await this.runGate(afterAdmit);
    }
    const flushable = this.journal.readState(runId);
    if (flushable === 'GATED' || flushable === 'SINK_SENT') {
      this.flushOutbox(runId, KIND);
    }
    if (this.journal.readState(runId) === 'ACK_RECORDED') {
      this.finalize(runId);
    }
  }

  async tickNextOpenRun(): Promise<void> {
    const run = this.journal.findOpenRun();
    if (run === null) return;
    await this.tickRun(run.run_id);
  }

  // Gate-owned enqueue: caller supplies the verdict and timing, while the runtime owns the opaque
  // payload and deterministic idempotency key.
  async enqueueOutbox(input: EnqueueOutboxInput): Promise<OutboxRow> {
    const verdict = deliveryVerdictSchema.parse(input.verdict);
    if (verdict !== 'send') {
      throw new Error('enqueueOutbox requires a send verdict');
    }
    const idempotencyKey = await this.deps.sha256Hex(
      canonicalDeliverySerialization({
        run_id: input.run_id,
        kind: input.kind,
        payload: PAYLOAD,
      }),
    );
    const parsed = outboxIntentSchema.parse({
      run_id: input.run_id,
      kind: input.kind,
      idempotency_key: idempotencyKey,
      payload: PAYLOAD,
      created_at: input.created_at,
    });
    let row: OutboxRow | null = null;
    this.storage.transactionSync(() => {
      const run = this.journal.read(input.run_id);
      if (run === null) throw new Error(`enqueueOutbox: no journal row for ${input.run_id}`);
      if (run.state !== 'GOVERNOR_ADMITTED') {
        throw new Error(`enqueueOutbox requires GOVERNOR_ADMITTED, got ${run.state}`);
      }
      this.journal.stampVerdict(run.run_id, verdict);
      this.store.incrementClassState(run.user_id, this.deps.now());
      this.store.incrementExemptSend(run.user_id);
      this.outbox.insert(parsed);
      this.journal.advance(run.run_id, 'GATED');
      row = this.outbox.readRow(parsed.run_id, parsed.kind);
    });
    if (row === null) throw new Error(`enqueueOutbox: no outbox row for ${parsed.run_id}`);
    return row;
  }

  // kind is a single literal in SLICE-3b; the parameter keeps the call site ready for the deferred
  // multi-kind outbox without widening this slice.
  flushOutbox(runId: string, kind: typeof KIND): void {
    const run = this.journal.read(runId);
    if (run === null) throw new Error(`flushOutbox: no journal row for ${runId}`);
    if (run.state !== 'GATED' && run.state !== 'SINK_SENT') {
      throw new Error(`flushOutbox requires GATED or SINK_SENT, got ${run.state}`);
    }
    if (run.verdict !== 'send') {
      throw new Error('flushOutbox requires a send verdict');
    }

    const row = this.outbox.readRow(runId, kind);
    if (row === null) throw new Error(`flushOutbox: no outbox row for ${runId}`);
    if (run.state === 'SINK_SENT' && row.status === 'pending') {
      throw new Error('journal/outbox delivery state mismatch');
    }
    if (run.state === 'GATED' && row.status === 'sent_unacked') {
      throw new Error('journal/outbox delivery state mismatch');
    }

    if (row.status === 'acked') {
      this.storage.transactionSync(() => this.journal.advance(runId, 'ACK_RECORDED'));
      return;
    }

    this.storage.transactionSync(() => {
      this.outbox.markSendAttempt(runId, kind, this.deps.now());
      if (this.journal.readState(runId) === 'GATED') {
        this.journal.advance(runId, 'SINK_SENT');
      }
    });

    this.crash('post_attempt_pre_send');

    const request = sinkRequestSchema.parse({
      idempotency_key: row.idempotency_key,
      payload: row.payload,
    });

    let ack: unknown;
    try {
      ack = this.sink.send(request);
    } catch (err) {
      this.outbox.recordSendError(runId, kind);
      throw err;
    }

    this.crash('post_sink_pre_ack');

    const parsedAck = sinkAckSchema.parse(ack);
    if (parsedAck.idempotency_key !== row.idempotency_key) {
      throw new Error('sink ack idempotency key mismatch');
    }

    this.storage.transactionSync(() => {
      this.outbox.markAcked(runId, kind, parsedAck.idempotency_key, this.deps.now());
      this.journal.advance(runId, 'ACK_RECORDED');
    });
  }

  private async runGate(run: JournalRow): Promise<void> {
    const classState = this.store.readClassState(run.user_id);
    const admission = computeVerdict(
      { push_class: KIND, now: this.deps.now() },
      classState,
      FETCH_ALERT_POLICY,
    );

    if (admission.verdict !== 'send') {
      this.journal.advance(run.run_id, 'FAILED');
      return;
    }

    this.crash('pre_gate_commit');

    await this.enqueueOutbox({
      run_id: run.run_id,
      kind: KIND,
      created_at: this.deps.now(),
      verdict: admission.verdict,
    });
  }

  private finalize(runId: string): void {
    this.crash('post_ack_pre_return');
    this.journal.advance(runId, 'DONE');
  }

  private crash(point: RunJournalOutboxCrashPoint): void {
    if (this.hooks.crashPoint?.() === point) {
      throw new Error(`crash-injection:${point}`);
    }
  }
}

function admitToState(verdict: 'admit' | 'deny'): 'GOVERNOR_ADMITTED' | 'FAILED' {
  return verdict === 'admit' ? 'GOVERNOR_ADMITTED' : 'FAILED';
}

function assertValidStartRunInput(input: StartRunInput): void {
  if (typeof input !== 'object' || input === null) {
    throw new Error('startRun requires an input object');
  }
  if (typeof input.userId !== 'string' || input.userId.length === 0) {
    throw new Error('startRun requires a non-empty userId');
  }
  if (input.trigger !== KIND) {
    throw new Error('startRun requires trigger fetch_alert');
  }
  if (!Number.isInteger(input.occurrenceAt) || input.occurrenceAt < 0) {
    throw new Error('startRun requires a non-negative integer occurrenceAt');
  }
}
