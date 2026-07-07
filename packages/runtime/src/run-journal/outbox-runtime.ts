import type {
  DeliveryCandidate,
  DeliverySink,
  DeliveryVerdict,
  JournalRow,
  OutboxIntent,
  OutboxRow,
  PushClass,
  TriggerType,
} from '@waldo/contracts';
import {
  assertIdempotentSink,
  canonicalDeliverySerialization,
  deliveryCandidateSchema,
  deliveryVerdictSchema,
  outboxIntentSchema,
  sinkAckSchema,
  sinkRequestSchema,
  triggerTypeSchema,
} from '@waldo/contracts';
import { computeAdmission } from '../delivery-gate/gate';
import { DeliveryGateStore } from '../delivery-gate/store';
import type { Deps } from '../seams/deps';
import { admit } from '../tracer/governor';
import { Journal } from '../tracer/journal';
import { Outbox } from '../tracer/outbox';

const KIND = 'fetch_alert' as const;
const PAYLOAD = 'synthetic-token-01';

export type RunJournalOutboxCrashPoint =
  | 'pre_gate_commit'
  | 'post_gate_pre_flush'
  | 'post_attempt_pre_send'
  | 'post_sink_pre_ack'
  | 'post_ack_pre_return';

export type StartRunInput = {
  userId: string;
  trigger: TriggerType;
  occurrenceAt: number;
  candidate?: DeliveryCandidate;
};

export type EnqueueOutboxInput = Pick<OutboxIntent, 'run_id' | 'kind' | 'created_at'> & {
  verdict: DeliveryVerdict;
  admissionAt?: number;
};

export type ReleaseHeldInput = {
  userId: string;
  eventId: string;
  occurrenceAt: number;
};

type FaultHooks = {
  crashPoint?: () => RunJournalOutboxCrashPoint | undefined;
};

export class RunJournalOutbox {
  private readonly journal: Journal;
  private readonly outbox: Outbox;
  private readonly store: DeliveryGateStore;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly deps: Deps,
    private readonly sink: DeliverySink,
    private readonly hooks: FaultHooks = {},
  ) {
    assertIdempotentSink(sink);
    this.journal = new Journal(storage.sql, deps);
    this.outbox = new Outbox(storage.sql, deps);
    this.store = new DeliveryGateStore(storage.sql);
  }

  startRun(input: StartRunInput): string {
    const parsed = parseStartRunInput(input);
    const runId = this.deps.newRunId();
    const candidate = parsed.candidate ?? defaultCandidateFor(parsed.trigger, runId);
    this.storage.transactionSync(() => {
      this.journal.openRun({
        runId,
        userId: parsed.userId,
        trigger: parsed.trigger,
        occurrenceAt: parsed.occurrenceAt,
      });
      this.store.writeCandidate(runId, candidate);
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
      this.crash('post_gate_pre_flush');
      this.flushOutbox(runId, this.kindForRun(runId));
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

  releaseHeld(input: ReleaseHeldInput): string | null {
    if (typeof input.userId !== 'string' || input.userId.length === 0) {
      throw new Error('releaseHeld requires a non-empty userId');
    }
    if (typeof input.eventId !== 'string' || input.eventId.length === 0) {
      throw new Error('releaseHeld requires a non-empty eventId');
    }
    if (!Number.isInteger(input.occurrenceAt) || input.occurrenceAt < 0) {
      throw new Error('releaseHeld requires a non-negative integer occurrenceAt');
    }

    const held = this.store.readHeld(input.userId, input.eventId);
    if (held === null) return null;
    if (held.expires_at !== null && held.expires_at <= this.deps.now()) {
      this.store.deleteHeld(input.userId, input.eventId);
      return null;
    }

    const runId = this.deps.newRunId();
    this.storage.transactionSync(() => {
      this.journal.openRun({
        runId,
        userId: input.userId,
        trigger: held.candidate.trigger,
        occurrenceAt: input.occurrenceAt,
      });
      this.store.writeCandidate(runId, held.candidate);
      this.store.deleteHeld(input.userId, input.eventId);
    });
    return runId;
  }

  // Gate-owned enqueue: caller supplies the verdict and timing, while the runtime owns the opaque
  // payload and deterministic idempotency key.
  async enqueueOutbox(input: EnqueueOutboxInput): Promise<OutboxRow> {
    const verdict = deliveryVerdictSchema.parse(input.verdict);
    if (verdict !== 'send' && verdict !== 'degrade') {
      throw new Error('enqueueOutbox requires a send or degrade verdict');
    }
    const admissionAt = input.admissionAt ?? this.deps.now();
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
      const candidate = this.store.readCandidate(input.run_id);
      if (input.kind !== candidate.push_class) {
        throw new Error(
          `enqueueOutbox kind ${input.kind} does not match candidate ${candidate.push_class}`,
        );
      }
      const run = this.journal.read(input.run_id);
      if (run === null) throw new Error(`enqueueOutbox: no journal row for ${input.run_id}`);
      if (run.state !== 'GOVERNOR_ADMITTED') {
        throw new Error(`enqueueOutbox requires GOVERNOR_ADMITTED, got ${run.state}`);
      }
      const admission = computeAdmission({
        candidate,
        classState: this.store.readClassState(run.user_id, candidate, admissionAt),
        subKindState:
          candidate.push_class === 'adjustment' && candidate.sub_kind !== undefined
            ? this.store.readSubKindState(
                run.user_id,
                candidate.push_class,
                candidate.sub_kind,
                admissionAt,
              )
            : undefined,
        countedSends: this.store.readBudget(run.user_id, admissionAt).sends_total,
        now: admissionAt,
      });
      if (admission.verdict !== verdict) {
        throw new Error(
          `enqueueOutbox verdict ${verdict} does not match admission ${admission.verdict}`,
        );
      }
      this.journal.stampVerdict(run.run_id, verdict, admission.reason);
      this.store.applyAdmission(run.user_id, candidate, admission, admissionAt);
      this.outbox.insert(parsed);
      this.journal.advance(run.run_id, 'GATED');
      row = this.outbox.readRow(parsed.run_id, parsed.kind);
    });
    if (row === null) throw new Error(`enqueueOutbox: no outbox row for ${parsed.run_id}`);
    return row;
  }

  // kind is a single literal in SLICE-3b; the parameter keeps the call site ready for the deferred
  // multi-kind outbox without widening this slice.
  flushOutbox(runId: string, kind: PushClass = KIND): void {
    const run = this.journal.read(runId);
    if (run === null) throw new Error(`flushOutbox: no journal row for ${runId}`);
    if (run.state !== 'GATED' && run.state !== 'SINK_SENT') {
      throw new Error(`flushOutbox requires GATED or SINK_SENT, got ${run.state}`);
    }
    if (run.verdict !== 'send' && run.verdict !== 'degrade') {
      throw new Error('flushOutbox requires a send or degrade verdict');
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
    const candidate = this.store.readCandidate(run.run_id);
    const gateAt = run.occurrence_at;
    const classState = this.store.readClassState(run.user_id, candidate, gateAt);
    const budget = this.store.readBudget(run.user_id, gateAt);
    const admission = computeAdmission({
      candidate,
      classState,
      subKindState:
        candidate.push_class === 'adjustment' && candidate.sub_kind !== undefined
          ? this.store.readSubKindState(
              run.user_id,
              candidate.push_class,
              candidate.sub_kind,
              gateAt,
            )
          : undefined,
      countedSends: budget.sends_total,
      now: gateAt,
    });

    if (admission.verdict === 'hold') {
      this.storage.transactionSync(() => {
        this.journal.stampVerdict(run.run_id, admission.verdict, admission.reason);
        this.store.recordHeld(run.user_id, candidate, admission);
        this.journal.advance(run.run_id, 'FAILED');
      });
      return;
    }

    if (admission.verdict !== 'send' && admission.verdict !== 'degrade') {
      this.storage.transactionSync(() => {
        this.journal.stampVerdict(run.run_id, admission.verdict, admission.reason);
        this.journal.advance(run.run_id, 'FAILED');
      });
      return;
    }

    this.crash('pre_gate_commit');

    await this.enqueueOutbox({
      run_id: run.run_id,
      kind: candidate.push_class,
      created_at: gateAt,
      verdict: admission.verdict,
      admissionAt: gateAt,
    });
  }

  private kindForRun(runId: string): PushClass {
    return this.store.readCandidate(runId).push_class;
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

function parseStartRunInput(input: StartRunInput): StartRunInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('startRun requires an input object');
  }
  if (typeof input.userId !== 'string' || input.userId.length === 0) {
    throw new Error('startRun requires a non-empty userId');
  }
  const triggerResult = triggerTypeSchema.safeParse(input.trigger);
  if (!triggerResult.success) {
    throw new Error('startRun requires a known trigger');
  }
  const trigger = triggerResult.data;
  if (!Number.isInteger(input.occurrenceAt) || input.occurrenceAt < 0) {
    throw new Error('startRun requires a non-negative integer occurrenceAt');
  }
  const candidate =
    input.candidate === undefined ? undefined : deliveryCandidateSchema.parse(input.candidate);
  if (candidate !== undefined && candidate.trigger !== trigger) {
    throw new Error('startRun candidate trigger must match run trigger');
  }
  return { ...input, trigger, candidate };
}

function defaultCandidateFor(trigger: TriggerType, runId: string): DeliveryCandidate {
  if (trigger !== KIND) {
    throw new Error(`startRun requires a candidate for trigger ${trigger}`);
  }
  return deliveryCandidateSchema.parse({
    push_class: KIND,
    trigger,
    event_id: runId,
    expires_at: null,
  });
}
