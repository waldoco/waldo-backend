import { DurableObject } from 'cloudflare:workers';
import type { JournalRow } from '@waldo/contracts';
import {
  FETCH_ALERT_POLICY,
  assertIdempotentSink,
  canonicalDeliverySerialization,
} from '@waldo/contracts';
import { productionDeps, type Deps } from '../seams/deps';
import { ensureSchema } from './schema';
import { Journal } from './journal';
import { Outbox } from './outbox';
import { Store } from './store';
import { Scheduler } from './scheduler';
import { FakeSink } from './sink';
import { admit } from './governor';
import { computeVerdict } from './gate';

const KIND = 'fetch_alert' as const;

// The four genuinely mid-flight points that need an in-handler crash: pre-commit of the GATED
// transaction (#3), post-attempt-marker before the sink is reached (#4), post-sink before the
// ack is recorded (#5), and post-ack before the handler returns (#6). The natural committed
// boundaries (#1/#2) need no fault code — evict and re-drive.
type CrashPoint =
  | 'pre_gate_commit'
  | 'post_attempt_pre_send'
  | 'post_sink_pre_ack'
  | 'post_ack_pre_return';

// The DO that wakes on the alarm and drives the one path: DO alarm -> Loop Governor -> journal ->
// DeliveryGate (one transactionSync) -> outbox -> sink, exactly once, resumable purely from
// committed DO SQLite. Eviction wipes every in-memory field; alarm() reconstructs from SQLite alone.
export class TracerDO extends DurableObject<Cloudflare.Env> {
  private readonly deps: Deps;
  private readonly journal: Journal;
  private readonly outbox: Outbox;
  private readonly store: Store;
  private readonly scheduler: Scheduler;
  private readonly sink: FakeSink;

  // Crash-injection seam. Undefined in production; poked ONLY by tests via runInDurableObject before
  // the alarm is re-driven. This is the sole spot test-serving state touches the production handler.
  __crashAfter?: CrashPoint;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.deps = productionDeps();
    ensureSchema(ctx.storage.sql);
    this.journal = new Journal(ctx.storage.sql, this.deps);
    this.outbox = new Outbox(ctx.storage.sql, this.deps);
    this.store = new Store(ctx.storage.sql);
    this.scheduler = new Scheduler(ctx.storage.sql, ctx.storage, this.deps);
    this.sink = new FakeSink();
    // The wiring seam refuses a sink that does not declare the idempotency duty — the
    // in-doubt resume re-sends the same key and is only safe against a declared sink.
    assertIdempotentSink(this.sink);
  }

  // Opens the run journal at RUN_OPENED and arms the one-shot alarm through the armAlarm seam.
  async schedule(input: { userId: string; trigger: string; occurrenceAt: number }): Promise<string> {
    const runId = this.deps.newRunId();
    this.journal.openRun({
      runId,
      userId: input.userId,
      trigger: input.trigger,
      occurrenceAt: input.occurrenceAt,
    });
    await this.scheduler.arm({ id: runId, occurrenceAt: input.occurrenceAt });
    return runId;
  }

  // START-OR-RESUME, reconstructed purely from committed DO SQLite. Each step runs only if the run
  // has not yet passed its committed boundary, so a fresh start (RUN_OPENED) runs every step while a
  // resume enters at its committed state and runs only the remainder. GATED and later never recompute
  // the verdict — it is read from the journal row. The step order mirrors runStateTransitions.
  // GATED and SINK_SENT both enter flush(): the first marks its attempt and advances, the
  // second is the in-doubt resume that re-marks and re-sends the same idempotency key.
  override async alarm(): Promise<void> {
    const run = this.journal.findOpenRun();
    if (run === null) return;

    if (run.state === 'RUN_OPENED') {
      this.journal.advance(run.run_id, admitToState(admit('fetch')));
    }
    if (this.journal.readState(run.run_id) === 'GOVERNOR_ADMITTED') {
      await this.runGate(run);
    }
    const flushable = this.journal.readState(run.run_id);
    if (flushable === 'GATED' || flushable === 'SINK_SENT') {
      this.flush(run.run_id);
    }
    if (this.journal.readState(run.run_id) === 'ACK_RECORDED') {
      this.finalize(run.run_id);
    }
  }

  // The DeliveryGate step. The verdict is computed pure and the idempotency key is hashed BEFORE the
  // transaction (both async / read work must stay out of the synchronous transactionSync closure).
  // Crash #3 throws before the commit -> full rollback -> state stays GOVERNOR_ADMITTED, no verdict,
  // no class/telemetry change, no outbox row. Resume re-evaluates the gate from scratch.
  private async runGate(run: JournalRow): Promise<void> {
    const classState = this.store.readClassState(run.user_id);
    const admission = computeVerdict(
      { push_class: KIND, now: this.deps.now() },
      classState,
      FETCH_ALERT_POLICY,
    );
    const payload = 'synthetic-token-01';
    const idemKey = await this.deps.sha256Hex(
      canonicalDeliverySerialization({ run_id: run.run_id, kind: KIND, payload }),
    );

    if (this.__crashAfter === 'pre_gate_commit') {
      throw new Error('crash-injection:pre_gate_commit');
    }

    this.ctx.storage.transactionSync(() => {
      this.journal.stampVerdict(run.run_id, admission.verdict);
      this.store.incrementClassState(run.user_id, this.deps.now());
      this.store.incrementExemptSend(run.user_id);
      this.outbox.insert({
        run_id: run.run_id,
        kind: KIND,
        idempotency_key: idemKey,
        payload,
        created_at: this.deps.now(),
      });
      this.journal.advance(run.run_id, 'GATED');
    });
  }

  // The flush step, entered fresh (GATED) or as an in-doubt resume (SINK_SENT). The send
  // attempt commits durably BEFORE the sink is reached and the ack commits after it, so a
  // crash between the two resumes here and re-sends the SAME idempotency key — at-least-once
  // from the runtime, collapsed to one physical delivery by the sink's declared idempotency.
  private flush(runId: string): void {
    const row = this.outbox.readRow(runId, KIND);
    if (row === null) throw new Error(`flush: no outbox row for ${runId}`);

    // The exactly-once floor: a durably acked row must never reach a sink again, whatever
    // the journal claims. Unreachable via the FSM (ack + ACK_RECORDED commit atomically);
    // load-bearing against a partial-write or forged-state bug, and red-proof tested.
    if (row.status === 'acked') {
      this.ctx.storage.transactionSync(() => this.journal.advance(runId, 'ACK_RECORDED'));
      return;
    }

    this.ctx.storage.transactionSync(() => {
      this.outbox.markSendAttempt(runId, KIND, this.deps.now());
      if (this.journal.readState(runId) === 'GATED') {
        this.journal.advance(runId, 'SINK_SENT');
      }
    });

    if (this.__crashAfter === 'post_attempt_pre_send') {
      throw new Error('crash-injection:post_attempt_pre_send');
    }

    try {
      this.sink.send({ idempotency_key: row.idempotency_key, payload: row.payload });
    } catch (err) {
      // Record the failure durably, then re-raise: the next wake re-drives this in-doubt
      // row. The payload is contract-guarded opaque, so the message cannot carry health values.
      this.outbox.recordSendError(runId, KIND, err instanceof Error ? err.message : String(err));
      throw err;
    }

    if (this.__crashAfter === 'post_sink_pre_ack') {
      throw new Error('crash-injection:post_sink_pre_ack');
    }

    this.ctx.storage.transactionSync(() => {
      this.outbox.markAcked(runId, KIND, this.deps.now());
      this.journal.advance(runId, 'ACK_RECORDED');
    });
  }

  private finalize(runId: string): void {
    if (this.__crashAfter === 'post_ack_pre_return') {
      throw new Error('crash-injection:post_ack_pre_return');
    }
    this.journal.advance(runId, 'DONE');
  }
}

function admitToState(verdict: 'admit' | 'deny'): 'GOVERNOR_ADMITTED' | 'FAILED' {
  return verdict === 'admit' ? 'GOVERNOR_ADMITTED' : 'FAILED';
}
