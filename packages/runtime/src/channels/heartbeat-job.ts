import { HEARTBEAT_JOB_TEXT, machineResultText } from '../prompt/machine-jobs';
import { taskBrief } from '../tasks/jobs';
import type { MachineHandler, MachineSpec } from '../tasks/machine';
import { checkBackReply, loopCheckBackText } from './check-back';
import { dueLoops, HEARTBEAT_EVERY_MS, HEARTBEAT_ID, holdCooldown, type Sql } from './heartbeat';
import { isQuiet, type Loop, type LoopBook } from './loops';
import type { HeartbeatReceipt } from './telegram-final-outbox';

// The heartbeat check-back as a machine job: the brief its worker reads, and the apply that turns what the worker found
// into the owner's message. Kept apart from the tick, which every scheduled surface imports.

// A check-back job not done by the next tick is dropped; its loops are not marked, so that tick asks again.
const HEARTBEAT_JOB_DEADLINE_MS = HEARTBEAT_EVERY_MS;

// The check-back job for one tick's past-due loops. Keyed by the tick's occurrence, not by the loops: a key on the loop set
// would return the settled job of the same loops and block the re-notify after the cooldown.
export const heartbeatJobSpec = (loops: readonly Loop[], tick: Readonly<{ entryId: string; occurrence: number; runId: string; now: number; surface: string; timezone: string }>): MachineSpec => ({
  job: 'heartbeat', scope: 'owner', key: `machine:heartbeat:${tick.entryId}:${tick.occurrence}`, surface: tick.surface, text: HEARTBEAT_JOB_TEXT,
  items: loops.map(loop => ({ ref: loop.id, detail: `${loop.title}${loop.due ? ` (due ${loop.due.replace('T', ' ')})` : ''}` })),
  timezone: tick.timezone, now: tick.now, deadlineAt: tick.now + HEARTBEAT_JOB_DEADLINE_MS, runId: tick.runId,
});

export type HeartbeatApplyDeps = Readonly<{
  sql: Sql;
  loops: LoopBook;
  timezone: string;
  now(): number;
  // The owner's heartbeat preference, read at apply.
  enabled(): boolean;
  transaction(work: () => void): void;
  // The check-back turn on the owner's chain, for exactly these loops (close_loop may close only them): its raw reply.
  turn(trace: string, loops: readonly Loop[], text: string, current: () => Promise<void>): Promise<string>;
  // Queues the message under its key with its receipt, `commit` in the same transaction; a key already queued only commits.
  deliver(id: string, trace: string, text: string, receipt: HeartbeatReceipt, commit: () => void): Promise<void>;
}>;

// The heartbeat job's apply. Its gates run again here, since quiet hours or the owner's preference can change while the
// worker reads, and only the loops the worker was given and that still need a check-back reach the turn.
export const heartbeatApplier = (deps: HeartbeatApplyDeps): MachineHandler => ({
  apply: async (row, result, io) => {
    const now = deps.now();
    const proactivity = deps.loops.proactivity();
    const held = !deps.enabled() ? 'held_preference' : isQuiet(proactivity, now, deps.timezone) ? 'held_quiet' : proactivity.volume === 'low' ? 'held_volume' : null;
    const machine = taskBrief(row).machine!;
    const due = held ? [] : dueLoops(deps.sql, now, deps.timezone, machine.refs);
    const code = held ?? (due.length ? null : 'held_stale');
    if (code) { deps.transaction(io.settle); return { held: code }; }
    const reply = checkBackReply(await deps.turn(io.trace, due, `${loopCheckBackText(due)}\n\n${machineResultText(result)}`, io.current));
    // The receipt freezes each loop as the turn left it, so a loop the owner closes or moves before the send stops it.
    const after = due.flatMap(loop => {
      const current = deps.sql.exec<{ status: string; due: string | null }>('SELECT status, due FROM loops WHERE id = ?', loop.id).toArray()[0];
      return current?.due ? [{ id: loop.id, due: current.due, status: current.status }] : [];
    });
    if (reply === null) {
      deps.transaction(() => { holdCooldown(deps.sql, after, now); io.settle(); });
      return 'skipped';
    }
    // The receipt names the tick that started the job; that tick's own run settled when it wrote the job.
    await deps.deliver(`heartbeat:${row.id}`, io.trace, reply, { id: HEARTBEAT_ID, occurrence: taskBrief(row).started_at, schedulerRunId: machine.run_id ?? '', loops: after }, io.settle);
    return 'delivered';
  },
  // Checked and nothing to say: the cooldown holds these loops as if told, so the next tick does not ask again.
  noNews: (row, settle) => deps.transaction(() => {
    holdCooldown(deps.sql, dueLoops(deps.sql, deps.now(), deps.timezone, taskBrief(row).machine!.refs), deps.now());
    settle();
  }),
});
