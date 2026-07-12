import type {
  CanaryTokens,
  DeliveryCandidate,
  DeliverySink,
  DeliveryVerdict,
  JournalRow,
  LoopType,
  OutboxIntent,
  OutboxRow,
  PushClass,
  RunState,
  TriggerType,
} from '@waldo/contracts';
import {
  assertIdempotentSink,
  canonicalDeliverySerialization,
  deliveryCandidateSchema,
  deliveryVerdictSchema,
  outboxIntentSchema,
  runtimeOperationalRefSchema,
  sinkAckSchema,
  sinkRequestSchema,
  triggerTypeSchema,
} from '@waldo/contracts';
import { computeAdmission } from '../delivery-gate/gate';
import { DeliveryGateStore } from '../delivery-gate/store';
import type {
  GovernorDecision,
  LoopEgressInput,
  LoopObservationInput,
  LoopUsageInput,
  SetLoopKillFlagInput,
} from '../loop-governor/governor';
import { LoopGovernor } from '../loop-governor/governor';
import { prepareWithScribe, type StrictSchema } from '../scribe/prepare';
import type { Deps } from '../seams/deps';
import { Journal } from '../tracer/journal';
import { Outbox } from '../tracer/outbox';

const KIND = 'fetch_alert' as const;
const PAYLOAD = 'synthetic-token-01';
const PERSISTENCE_CANARY_TOKENS: CanaryTokens = [
  'aaaaaaaaaaaaaaaa',
  'bbbbbbbbbbbbbbbb',
  'cccccccccccccccc',
];

type OperationalIdentityEnvelope = { value: string };
const operationalIdentityEnvelopeSchema: StrictSchema<OperationalIdentityEnvelope> = {
  safeParse(value) {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Reflect.ownKeys(value).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(value, 'value')
    ) {
      return { success: false };
    }
    const identity = runtimeOperationalRefSchema.safeParse(
      (value as { value?: unknown }).value,
    );
    return identity.success
      ? { success: true, data: { value: identity.data } }
      : { success: false };
  },
};

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
  loopType?: LoopType;
  occurrenceId?: string;
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

type GateCommitInput = {
  runId: string;
  kind: PushClass;
  candidate: DeliveryCandidate;
  admissionAt: number;
  outbox: OutboxIntent;
  expectedVerdict?: 'send' | 'degrade';
};

export class RunJournalOutbox {
  private readonly journal: Journal;
  private readonly outbox: Outbox;
  private readonly store: DeliveryGateStore;
  private readonly governor: LoopGovernor;

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
    this.governor = new LoopGovernor(storage.sql, deps);
  }

  startRun(input: StartRunInput): string {
    const parsed = parseStartRunInput(input);
    const runId = this.deps.newRunId();
    const candidate =
      parsed.candidate === undefined
        ? prepareCandidateForPersistence(defaultCandidateFor(parsed.trigger, runId), runId)
        : prepareCandidateForPersistence(parsed.candidate);
    this.storage.transactionSync(() => {
      this.journal.openRun({
        runId,
        userId: parsed.userId,
        trigger: parsed.trigger,
        occurrenceAt: parsed.occurrenceAt,
      });
      this.governor.startRun({
        runId,
        userId: parsed.userId,
        trigger: parsed.trigger,
        occurrenceAt: parsed.occurrenceAt,
        loopType: parsed.loopType,
        occurrenceId: parsed.occurrenceId,
      });
      this.store.writeCandidate(runId, candidate);
    });
    return runId;
  }

  // Read and validate the committed journal row after eviction. Progress is driven by tickRun so
  // a caller can inspect durable state without accidentally sending.
  resumeRun(runId: string): JournalRow | null {
    const run = this.journal.read(runId);
    if (run !== null) this.readPreparedCandidate(runId);
    return run;
  }

  readRunState(runId: string): RunState | null {
    return this.journal.readState(runId);
  }

  admitRun(runId: string): GovernorDecision {
    this.readPreparedCandidate(runId);
    let decision: GovernorDecision | null = null;
    this.storage.transactionSync(() => {
      const run = this.journal.read(runId);
      if (run === null) throw new Error(`admitRun: no journal row for ${runId}`);
      if (run.state !== 'RUN_OPENED') {
        throw new Error(`admitRun requires RUN_OPENED, got ${run.state}`);
      }
      decision = this.governor.admitRun(runId);
      this.journal.advance(runId, admitToState(decision.verdict));
    });
    if (decision === null) throw new Error(`admitRun: no governor decision for ${runId}`);
    return decision;
  }

  readGovernorDecision(runId: string): GovernorDecision | null {
    return this.governor.readDecision(runId);
  }

  recordLoopUsage(input: LoopUsageInput): GovernorDecision {
    return this.recordPostAdmissionDecision(input.runId, 'recordLoopUsage', () =>
      this.governor.recordUsage(input),
    );
  }

  recordLoopObservation(input: LoopObservationInput): GovernorDecision {
    return this.recordPostAdmissionDecision(input.runId, 'recordLoopObservation', () =>
      this.governor.recordObservation(input),
    );
  }

  checkLoopEgress(input: LoopEgressInput): GovernorDecision {
    return this.recordPostAdmissionDecision(input.runId, 'checkLoopEgress', () =>
      this.governor.checkEgress(input),
    );
  }

  setLoopKillFlag(input: SetLoopKillFlagInput): void {
    this.governor.setKillFlag(input);
  }

  private recordPostAdmissionDecision(
    runId: string,
    operation: string,
    record: () => GovernorDecision,
  ): GovernorDecision {
    let decision: GovernorDecision | null = null;
    this.storage.transactionSync(() => {
      const state = this.journal.readState(runId);
      if (state === null) throw new Error(`${operation}: no journal row for ${runId}`);
      if (state === 'DONE' || state === 'FAILED') {
        decision = this.governor.readDecision(runId);
        if (decision === null) {
          throw new Error(`${operation}: terminal run has no governor decision for ${runId}`);
        }
        return;
      }
      if (state !== 'GOVERNOR_ADMITTED') {
        throw new Error(`${operation} requires GOVERNOR_ADMITTED, got ${state}`);
      }
      decision = record();
      if (decision.verdict === 'deny') {
        this.journal.advance(runId, 'FAILED');
      }
    });
    if (decision === null) {
      throw new Error(`${operation}: no governor decision for ${runId}`);
    }
    return decision;
  }

  async tickRun(runId: string): Promise<void> {
    const run = this.journal.read(runId);
    if (run === null || run.state === 'DONE' || run.state === 'FAILED') return;

    if (run.state === 'RUN_OPENED') {
      this.admitRun(run.run_id);
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

  async gateRun(runId: string): Promise<JournalRow> {
    const run = this.journal.read(runId);
    if (run === null) throw new Error(`gateRun: no journal row for ${runId}`);
    if (run.state === 'GATED' || run.state === 'FAILED') return run;
    if (run.state !== 'GOVERNOR_ADMITTED') {
      throw new Error(`gateRun requires GOVERNOR_ADMITTED, got ${run.state}`);
    }
    await this.runGate(run);
    const gated = this.journal.read(runId);
    if (gated === null) throw new Error(`gateRun: no journal row after gate for ${runId}`);
    return gated;
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

    let held;
    try {
      held = this.store.readHeld(input.userId, input.eventId);
    } catch {
      this.store.deleteHeld(input.userId, input.eventId);
      throw new Error('scribe:invalid_payload');
    }
    if (held === null) return null;
    let userId: string;
    try {
      userId = prepareOperationalIdentity(input.userId, 'releaseHeld userId');
    } catch (error) {
      this.store.deleteHeld(input.userId, input.eventId);
      throw error;
    }
    if (held.expires_at !== null && held.expires_at <= this.deps.now()) {
      this.store.deleteHeld(input.userId, input.eventId);
      return null;
    }
    let candidate: DeliveryCandidate;
    try {
      candidate = prepareCandidateForPersistence(held.candidate);
    } catch (error) {
      this.store.deleteHeld(input.userId, input.eventId);
      throw error;
    }

    const runId = this.deps.newRunId();
    this.storage.transactionSync(() => {
      this.journal.openRun({
        runId,
        userId,
        trigger: candidate.trigger,
        occurrenceAt: input.occurrenceAt,
      });
      this.governor.startRun({
        runId,
        userId,
        trigger: candidate.trigger,
        occurrenceAt: input.occurrenceAt,
      });
      this.store.writeCandidate(runId, candidate);
      this.store.deleteHeld(input.userId, input.eventId);
    });
    return runId;
  }

  // Public enqueue keeps its caller-provided verdict as an assertion. The internal gate path
  // commits its own current decision after hashing, so an async yield cannot stale that decision.
  async enqueueOutbox(input: EnqueueOutboxInput): Promise<OutboxRow> {
    const verdict = deliveryVerdictSchema.parse(input.verdict);
    if (verdict !== 'send' && verdict !== 'degrade') {
      throw new Error('enqueueOutbox requires a send or degrade verdict');
    }
    const candidate = this.readPreparedCandidate(input.run_id);
    const admissionAt = input.admissionAt ?? this.deps.now();
    const outbox = await this.createOutboxIntent(input.run_id, input.kind, input.created_at);
    const row = this.commitGate({
      runId: input.run_id,
      kind: input.kind,
      candidate,
      admissionAt,
      outbox,
      expectedVerdict: verdict,
    });
    if (row === null) throw new Error(`enqueueOutbox: no outbox row for ${outbox.run_id}`);
    return row;
  }

  private async createOutboxIntent(
    runId: string,
    kind: PushClass,
    createdAt: number,
  ): Promise<OutboxIntent> {
    const idempotencyKey = await this.deps.sha256Hex(
      canonicalDeliverySerialization({
        run_id: runId,
        kind,
        payload: PAYLOAD,
      }),
    );
    return outboxIntentSchema.parse({
      run_id: runId,
      kind,
      idempotency_key: idempotencyKey,
      payload: PAYLOAD,
      created_at: createdAt,
    });
  }

  private commitGate(input: GateCommitInput): OutboxRow | null {
    let row: OutboxRow | null = null;
    this.storage.transactionSync(() => {
      if (input.kind !== input.candidate.push_class) {
        throw new Error(
          `enqueueOutbox kind ${input.kind} does not match candidate ${input.candidate.push_class}`,
        );
      }
      const run = this.journal.read(input.runId);
      if (run === null) throw new Error(`enqueueOutbox: no journal row for ${input.runId}`);
      if (run.state !== 'GOVERNOR_ADMITTED') {
        // A duplicate internal tick can yield while hashing, then find that the first tick already
        // committed the run. Public enqueue and unexpected state regressions remain loud.
        if (
          input.expectedVerdict === undefined &&
          (run.state === 'GATED' ||
            run.state === 'SINK_SENT' ||
            run.state === 'ACK_RECORDED' ||
            run.state === 'DONE' ||
            run.state === 'FAILED')
        ) {
          return;
        }
        throw new Error(`enqueueOutbox requires GOVERNOR_ADMITTED, got ${run.state}`);
      }
      const admission = this.computeGateAdmission(run, input.candidate, input.admissionAt);
      if (input.expectedVerdict !== undefined && admission.verdict !== input.expectedVerdict) {
        throw new Error(
          `enqueueOutbox verdict ${input.expectedVerdict} does not match admission ${admission.verdict}`,
        );
      }
      if (admission.verdict === 'hold') {
        this.journal.stampVerdict(run.run_id, admission.verdict, admission.reason);
        this.store.recordHeld(run.user_id, input.candidate, admission);
        this.journal.advance(run.run_id, 'FAILED');
        return;
      }
      if (admission.verdict === 'drop') {
        this.journal.stampVerdict(run.run_id, admission.verdict, admission.reason);
        this.journal.advance(run.run_id, 'FAILED');
        return;
      }
      this.journal.stampVerdict(run.run_id, admission.verdict, admission.reason);
      this.store.applyAdmission(run.user_id, input.candidate, admission, input.admissionAt);
      this.outbox.insert(input.outbox);
      this.journal.advance(run.run_id, 'GATED');
      row = this.outbox.readRow(input.outbox.run_id, input.outbox.kind);
    });
    return row;
  }

  private computeGateAdmission(
    run: JournalRow,
    candidate: DeliveryCandidate,
    admissionAt: number,
  ) {
    return computeAdmission({
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
  }

  // kind is a single literal in SLICE-3b; the parameter keeps the call site ready for the deferred
  // multi-kind outbox without widening this slice.
  flushOutbox(runId: string, kind: PushClass = KIND): void {
    this.readPreparedCandidate(runId);
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
    const candidate = this.readPreparedCandidate(run.run_id);
    const gateAt = run.occurrence_at;
    const admission = this.computeGateAdmission(run, candidate, gateAt);

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

    const outbox = await this.createOutboxIntent(run.run_id, candidate.push_class, gateAt);

    this.crash('pre_gate_commit');
    this.commitGate({
      runId: run.run_id,
      kind: candidate.push_class,
      candidate,
      admissionAt: gateAt,
      outbox,
    });
  }

  private kindForRun(runId: string): PushClass {
    return this.readPreparedCandidate(runId).push_class;
  }

  private readPreparedCandidate(runId: string): DeliveryCandidate {
    try {
      const candidateJson = this.store.readCandidateJson(runId);
      if (candidateJson === null) throw new Error('scribe:invalid_payload');
      let candidate: unknown;
      try {
        candidate = JSON.parse(candidateJson);
      } catch {
        throw new Error('scribe:invalid_payload');
      }
      return prepareCandidateForPersistence(candidate, runId);
    } catch (error) {
      this.storage.transactionSync(() => {
        this.store.deleteCandidate(runId);
        const state = this.journal.readState(runId);
        if (state !== null && state !== 'DONE' && state !== 'FAILED') {
          this.journal.advance(runId, 'FAILED');
        }
      });
      throw error;
    }
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
  const userId = prepareOperationalIdentity(input.userId, 'startRun userId');
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
  const occurrenceId =
    input.occurrenceId === undefined
      ? undefined
      : prepareOperationalIdentity(input.occurrenceId, 'startRun occurrenceId');
  return { ...input, userId, occurrenceId, trigger, candidate };
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

function prepareCandidateForPersistence(
  candidate: unknown,
  trustedGeneratedEventId?: string,
): DeliveryCandidate {
  const original = deliveryCandidateSchema.safeParse(candidate);
  if (!original.success) throw new Error('scribe:invalid_payload');
  const prepared = prepareWithScribe(
    original.data,
    deliveryCandidateSchema,
    'internal_context',
    null,
    PERSISTENCE_CANARY_TOKENS,
  );
  if (!prepared.ok) throw new Error(`scribe:${prepared.reason}`);
  if (prepared.value.event_id !== original.data.event_id) {
    if (
      trustedGeneratedEventId === original.data.event_id &&
      runtimeOperationalRefSchema.safeParse(trustedGeneratedEventId).success
    ) {
      return original.data;
    }
    throw new Error('scribe:invalid_payload');
  }
  return prepared.value;
}

export function prepareOperationalIdentity(value: unknown, field: string): string {
  const identity = runtimeOperationalRefSchema.safeParse(value);
  if (!identity.success) throw new Error(`${field} must be an opaque operational reference`);
  const prepared = prepareWithScribe(
    { value: identity.data },
    operationalIdentityEnvelopeSchema,
    'internal_context',
    null,
    PERSISTENCE_CANARY_TOKENS,
  );
  if (!prepared.ok) throw new Error(`scribe:${prepared.reason}`);
  if (prepared.value.value !== identity.data) {
    throw new Error(`${field} must remain unchanged`);
  }
  return prepared.value.value;
}
