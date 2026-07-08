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
import { productionDeps } from '../seams/deps';
import { ensureSchema } from './schema';
import { Scheduler } from './scheduler';
import { FakeSink } from './sink';

const KIND = 'fetch_alert' as const;

type CrashPoint = RunJournalOutboxCrashPoint;

// The DO that wakes on the alarm and drives the one path: DO alarm -> Loop Governor -> journal ->
// DeliveryGate (one transactionSync) -> outbox -> sink, exactly once, resumable purely from
// committed DO SQLite. Eviction wipes every in-memory field; alarm() reconstructs from SQLite alone.
export class TracerDO extends DurableObject<Cloudflare.Env> {
  private readonly runtime: RunJournalOutbox;
  private readonly scheduler: Scheduler;

  // Crash-injection seam. Undefined in production; poked ONLY by tests via runInDurableObject before
  // the alarm is re-driven. This is the sole spot test-serving state touches the production handler.
  __crashAfter?: CrashPoint;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const deps = productionDeps();
    const sink = new FakeSink();
    ensureSchema(ctx.storage);
    this.scheduler = new Scheduler(ctx.storage.sql, ctx.storage, deps);
    this.runtime = new RunJournalOutbox(ctx.storage, deps, sink, {
      crashPoint: () => this.__crashAfter,
    });
  }

  // Opens the run journal at RUN_OPENED and arms the one-shot alarm through the armAlarm seam.
  async schedule(input: StartRunInput): Promise<string> {
    const runId = await this.startRun(input);
    await this.scheduler.arm({ id: runId, occurrenceAt: input.occurrenceAt });
    return runId;
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
    await this.runtime.tickNextOpenRun();
  }
}
