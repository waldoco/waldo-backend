import { DurableObject } from 'cloudflare:workers';
import type { JournalRow, OutboxRow } from '@waldo/contracts';
import type {
  GovernorDecision,
  LoopEgressInput,
  LoopObservationInput,
  LoopUsageInput,
  SetLoopKillFlagInput,
} from '../loop-governor/governor';
import {
  type EnqueueOutboxInput,
  type ReleaseHeldInput,
  RunJournalOutbox,
  type RunJournalOutboxCrashPoint,
  type StartRunInput,
} from '../run-journal/outbox-runtime';
import { type ScheduleEntry, scheduleKindTrigger } from '@waldo/contracts';
import { Scheduler, type ScheduleExecutors } from '../scheduler/multiplexer';
import { productionDeps, type Deps } from '../seams/deps';
import { ensureSchema } from './schema';
import { FakeSink } from './sink';

const KIND = 'fetch_alert' as const;

type CrashPoint = RunJournalOutboxCrashPoint;
type ReconcileRunRow = {
  run_id: string;
  state: string;
  occurrence_at: number;
};

// The DO that wakes on the alarm and drives the one path: DO alarm -> Loop Governor -> journal ->
// DeliveryGate (one transactionSync) -> outbox -> sink, exactly once, resumable purely from
// committed DO SQLite. Eviction wipes every in-memory field; alarm() reconstructs from SQLite alone.
export class TracerDO extends DurableObject<Cloudflare.Env> {
  private readonly runtime: RunJournalOutbox;
  private readonly scheduler: Scheduler;
  private readonly deps: Deps;

  // Crash-injection seam. Undefined in production; poked ONLY by tests via runInDurableObject before
  // the alarm is re-driven. This is the sole spot test-serving state touches the production handler.
  __crashAfter?: CrashPoint;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const deps = productionDeps();
    const sink = new FakeSink();
    ensureSchema(ctx.storage);
    this.deps = deps;
    this.scheduler = new Scheduler(ctx.storage.sql, ctx.storage, deps);
    this.runtime = new RunJournalOutbox(ctx.storage, deps, sink, {
      crashPoint: () => this.__crashAfter,
    });
  }

  // Opens the run journal at RUN_OPENED and arms the one-shot alarm through the armAlarm seam.
  async schedule(input: StartRunInput): Promise<string> {
    const runId = await this.startRun(input);
    const run = this.runtime.resumeRun(runId);
    if (run === null) throw new Error(`schedule: no run ${runId}`);
    await this.scheduler.schedule({
      id: `handoff:${runId}`,
      kind: 'handoff',
      occurrenceAt: run.occurrence_at,
      dueAt: input.occurrenceAt,
      payloadRefs: { run_id: runId, cursor: 'tracer' },
    });
    return runId;
  }

  async scheduleRun(input: { runId: string; dueAt: number }): Promise<void> {
    const run = this.runtime.resumeRun(input.runId);
    if (run === null) throw new Error(`scheduleRun: no run ${input.runId}`);
    await this.scheduler.schedule({
      id: `handoff:${input.runId}`,
      kind: 'handoff',
      occurrenceAt: run.occurrence_at,
      dueAt: input.dueAt,
      payloadRefs: { run_id: input.runId },
    });
  }

  async scheduleOutboxRetry(input: { runId: string; dueAt: number }): Promise<void> {
    const run = this.runtime.resumeRun(input.runId);
    if (run === null) throw new Error(`scheduleOutboxRetry: no run ${input.runId}`);
    await this.scheduler.schedule({
      id: `journal:${input.runId}`,
      kind: 'journal',
      occurrenceAt: run.occurrence_at,
      dueAt: input.dueAt,
      payloadRefs: { run_id: input.runId },
    });
  }

  async scheduleProactiveWake(input: {
    id: string;
    kind: 'brief' | 'pre_activity_spot';
    userId: string;
    dueAt: number;
    occurrenceAt: number;
  }): Promise<void> {
    await this.scheduler.schedule({
      id: input.id,
      kind: input.kind,
      occurrenceAt: input.occurrenceAt,
      dueAt: input.dueAt,
      payloadRefs: { id: input.id, user_id: input.userId },
    });
  }

  async startRun(input: StartRunInput): Promise<string> {
    return this.runtime.startRun(input);
  }

  async resumeRun(runId: string): Promise<JournalRow | null> {
    return this.runtime.resumeRun(runId);
  }

  async admitRun(runId: string): Promise<GovernorDecision> {
    return this.runtime.admitRun(runId);
  }

  async recordLoopUsage(input: LoopUsageInput): Promise<GovernorDecision> {
    return this.runtime.recordLoopUsage(input);
  }

  async recordLoopObservation(input: LoopObservationInput): Promise<GovernorDecision> {
    return this.runtime.recordLoopObservation(input);
  }

  async checkLoopEgress(input: LoopEgressInput): Promise<GovernorDecision> {
    return this.runtime.checkLoopEgress(input);
  }

  async setLoopKillFlag(input: SetLoopKillFlagInput): Promise<void> {
    this.runtime.setLoopKillFlag(input);
  }

  async tickRun(runId: string): Promise<void> {
    await this.runtime.tickRun(runId);
  }

  async enqueueOutbox(input: EnqueueOutboxInput): Promise<OutboxRow> {
    return this.runtime.enqueueOutbox(input);
  }

  async releaseHeld(input: ReleaseHeldInput): Promise<string | null> {
    return this.runtime.releaseHeld(input);
  }

  flushOutbox(runId: string, kind: typeof KIND = KIND): void {
    this.runtime.flushOutbox(runId, kind);
  }

  // Delegates alarm wake to the promoted runtime interface; committed-state resume logic lives in
  // RunJournalOutbox.
  override async alarm(): Promise<void> {
    await this.reconcileStaleRuns();
    await this.scheduler.dispatchDue(this.scheduleExecutors());
  }

  private async reconcileStaleRuns(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<ReconcileRunRow>(
        `SELECT run_id, state, occurrence_at
           FROM journal
          WHERE state NOT IN ('DONE', 'FAILED')
            AND NOT EXISTS (
              SELECT 1
                FROM schedule
               WHERE schedule.id = 'handoff:' || journal.run_id
                  OR schedule.id = 'journal:' || journal.run_id
            )
          ORDER BY created_at, run_id
          LIMIT 8`,
      )
      .toArray();

    for (const row of rows) {
      const kind = shouldReconcileAsJournal(row.state) ? 'journal' : 'handoff';
      await this.scheduler.schedule({
        id: `${kind}:${row.run_id}`,
        kind,
        occurrenceAt: row.occurrence_at,
        dueAt: Math.max(this.deps.now(), row.occurrence_at),
        payloadRefs: { run_id: row.run_id, cursor: 'reconcile' },
      });
    }
  }

  private scheduleExecutors(): ScheduleExecutors {
    return {
      journal: async (entry) => this.tickScheduledRun(entry),
      handoff: async (entry) => this.tickScheduledRun(entry),
      brief: async (entry) => this.startScheduledProactiveRun(entry),
      pre_activity_spot: async (entry) => this.startScheduledProactiveRun(entry),
    };
  }

  private async tickScheduledRun(entry: ScheduleEntry): Promise<void> {
    const runId = requiredPayloadRef(entry, 'run_id');
    await this.runtime.tickRun(runId);
  }

  private async startScheduledProactiveRun(entry: ScheduleEntry): Promise<void> {
    const trigger = scheduleKindTrigger[entry.kind];
    if (trigger === null) throw new Error(`schedule kind ${entry.kind} cannot start a trigger`);
    const pushClass = entry.kind === 'brief' ? 'brief' : 'pre_activity_spot';
    const userId = requiredPayloadRef(entry, 'user_id');
    const runId = this.runtime.startRun({
      userId,
      trigger,
      occurrenceAt: entry.occurrence_at,
      candidate: {
        push_class: pushClass,
        trigger,
        event_id: entry.payload_refs.id ?? entry.id,
        expires_at: null,
      },
    });
    await this.runtime.tickRun(runId);
  }
}

function requiredPayloadRef(entry: ScheduleEntry, key: string): string {
  const value = entry.payload_refs[key];
  if (value === undefined) {
    throw new Error(`schedule ${entry.id} missing payload ref ${key}`);
  }
  return value;
}

function shouldReconcileAsJournal(state: string): boolean {
  return state === 'GATED' || state === 'SINK_SENT' || state === 'ACK_RECORDED';
}
