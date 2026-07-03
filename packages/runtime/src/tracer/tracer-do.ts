import { DurableObject } from 'cloudflare:workers';
import type { JournalRow } from '@waldo/contracts';
import {
  FETCH_ALERT_POLICY,
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

// The three genuinely mid-flight points that need an in-handler crash: pre-commit of the GATED
// transaction (#3), post-sink before the ack is recorded (#5), and post-ack before the handler
// returns (#6). The natural committed boundaries (#1/#2/#4) need no fault code — evict and re-drive.
type CrashPoint = 'pre_gate_commit' | 'post_sink_pre_ack' | 'post_ack_pre_return';

// The DO that wakes on the alarm and drives the one path: DO alarm -> Loop Governor -> journal ->
// DeliveryGate (one transactionSync) -> outbox -> fake sink, exactly once, resumable purely from
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
  override async alarm(): Promise<void> {
    const run = this.journal.findOpenRun();
    if (run === null) return;

    if (run.state === 'RUN_OPENED') {
      this.journal.advance(run.run_id, admitToState(admit('fetch')));
    }
    if (this.journal.readState(run.run_id) === 'GOVERNOR_ADMITTED') {
      await this.runGate(run);
    }
    if (this.journal.readState(run.run_id) === 'GATED') {
      this.flushOutbox(run.run_id);
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

  // Post-commit flush. Reads the committed outbox row and delivers to the idempotent sink. The sink
  // call is not a durable step until the ack lands: crash #5 (sent, ack not recorded) re-drives with
  // the SAME idempotency key, so the sink returns the prior ack without a second delivery.
  private flushOutbox(runId: string): void {
    const row = this.outbox.readRow(runId, KIND);
    if (row === null) throw new Error(`flushOutbox: no outbox row for ${runId}`);
    this.sink.send({ idempotency_key: row.idempotency_key, payload: row.payload });

    if (this.__crashAfter === 'post_sink_pre_ack') {
      throw new Error('crash-injection:post_sink_pre_ack');
    }

    this.ctx.storage.transactionSync(() => {
      this.journal.advance(runId, 'SINK_SENT');
      this.outbox.markAcked(runId, KIND);
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
