import { manualAlarmStorage } from './helpers/manual-alarm-storage';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TaskResult } from '@waldo/contracts';
import { dayPlanBook } from '../src/channels/day-cards';
import { HEARTBEAT_ID, heartbeatTick, settleHeartbeat, type HeartbeatCheck } from '../src/channels/heartbeat';
import { heartbeatApplier, heartbeatJobSpec } from '../src/channels/heartbeat-job';
import { loopBook } from '../src/channels/loops';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { TelegramFinalOutbox, type FinalRecord, type HeartbeatReceipt } from '../src/channels/telegram-final-outbox';
import { applySchedulePreferences, schedulePreferences } from '../src/channels/schedule-preferences';
import { Scheduler, type ScheduleExecutors } from '../src/scheduler/multiplexer';
import { ensureSchema } from '../src/tracer/schema';
import type { TaskHost } from '../src/tasks/brain';
import { jobBook, taskBrief, type JobBook, type JobRow } from '../src/tasks/jobs';
import { runJobsLane, type JobsLaneDeps } from '../src/tasks/lane';
import { enqueueMachine } from '../src/tasks/machine';

// The heartbeat check-back as a machine job. The tick decides deterministically that loops are past due and writes a
// reader job in the same transaction as that scan; the worker checks the loops; the brain's apply turn writes the message
// only when the worker found something, under the loops' cooldown as before.
const at = (iso: string) => Date.parse(iso);
const TZ = 'Asia/Kolkata';
const RESULT: TaskResult = { status: 'done', summary: 'The call happened; no notes yet.', findings: [{ text: 'Asha wrote after the call: the notes come tomorrow.', source_ref: 'msg-9' }], proposals: [], left: [] };

type Run = { outcome: string; heartbeat_result: string | null; delivery: string | null };
type Harness = Readonly<{
  sql: SqlStorage; storage: DurableObjectStorage; clock: { at: number }; book: JobBook; loops: ReturnType<typeof loopBook>; scheduler: Scheduler;
  checks: HeartbeatCheck[]; down: { breaker: boolean; crash: boolean };
  tick(occurrence: number): Promise<void>;
  runs(): Run[]; jobs(): JobRow[];
}>;
let sequence = 0;
const withHeartbeat = <T,>(now: number, work: (h: Harness) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`machine-heartbeat-${sequence += 1}`)), async (_instance, state) => {
    ensureSchema(state.storage);
    const sql = state.storage.sql;
    const clock = { at: now };
    let n = 0;
    const book = jobBook(sql, { now: () => clock.at, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const loops = loopBook(sql, { newId: () => `l${n += 1}`, now: () => clock.at });
    const scheduler = new Scheduler(sql, manualAlarmStorage(state.storage), { now: () => clock.at, newRunId: () => `run-${n += 1}`, newOutboxId: () => 'o', sha256Hex: async () => 's' });
    const checks: HeartbeatCheck[] = [];
    const down = { breaker: false, crash: false };
    const tick = async (occurrence: number) => {
      clock.at = occurrence;
      await scheduler.schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt: occurrence, dueAt: occurrence, payloadRefs: { id: HEARTBEAT_ID } }).catch(() => undefined);
      await scheduler.dispatchDue({
        heartbeat: heartbeatTick({
          scheduler, sql, loops, plans: dayPlanBook(sql), timezone: TZ, now: () => clock.at,
          transaction: work => state.storage.transactionSync(work),
          providerDown: () => down.breaker,
          enqueue: (due, ctx) => {
            const made = enqueueMachine(book, heartbeatJobSpec(due, { ...ctx, surface: 'app', timezone: TZ }));
            if (down.crash) { down.crash = false; throw new Error('crash-injection: after the job write, inside its transaction'); }
            return made.code;
          },
          checked: code => { checks.push(code); },
        }),
      } as ScheduleExecutors).catch(() => undefined);
    };
    return work({
      sql, storage: state.storage, clock, book, loops, scheduler, checks, down, tick,
      runs: () => sql.exec<Run>("SELECT outcome, heartbeat_result, delivery FROM schedule_runs WHERE schedule_id = ? ORDER BY id", HEARTBEAT_ID).toArray(),
      jobs: () => sql.exec<JobRow>('SELECT * FROM task_jobs ORDER BY created_at').toArray(),
    });
  });

// 16:00 IST: a loop due at 14:00 IST is past due; quiet hours are not set.
const NOW = at('2026-09-26T10:30:00Z');
const report = (book: JobBook, job: JobRow, result: TaskResult = RESULT) => {
  const ticket = book.startAttempt(job.id)!;
  expect(book.report(ticket, result, { rounds: 1, costUsd: 0.001 })).toBe('accepted');
};

describe('the heartbeat tick writes a machine job', () => {
  it('golden: a past-due loop becomes one queued reader job, written with the scan, and the tick asks no model', async () => {
    await withHeartbeat(NOW, async ({ loops, tick, jobs, runs, checks }) => {
      const loop = loops.open({ title: 'Check how the late call with Asha went', due: '2026-09-26T14:00' });
      await tick(NOW);
      const [job] = jobs();
      expect(jobs()).toHaveLength(1);
      expect(job).toMatchObject({ origin: 'machine:heartbeat', profile: 'reader', status: 'queued', taint: 'external', idempotency_key: `machine:heartbeat:${HEARTBEAT_ID}:${NOW}` });
      const brief = taskBrief(job!);
      expect(brief.context).toContain(`[${loop.id}] Check how the late call with Asha went`);
      expect(brief.machine).toMatchObject({ job: 'heartbeat', scope: 'owner', run_id: expect.any(String) });
      expect(checks).toEqual(['enqueued']);
      // The tick's own run is done: the job carries the rest.
      expect(runs()).toEqual([{ outcome: 'ok', heartbeat_result: 'acted', delivery: null }]);
    });
  });

  it('unchanged data writes no row', async () => {
    await withHeartbeat(NOW, async ({ loops, tick, jobs, runs, checks }) => {
      loops.open({ title: 'Later today', due: '2026-09-26T22:00' });
      loops.open({ title: 'Someday', due: null });
      await tick(NOW);
      expect(jobs()).toEqual([]);
      expect(checks).toEqual(['unchanged']);
      expect(runs()).toEqual([{ outcome: 'ok', heartbeat_result: 'quiet', delivery: null }]);
    });
  });

  it('quiet hours, low volume and a provider outage write no row; the next open tick does', async () => {
    await withHeartbeat(at('2026-09-26T01:00:00Z'), async ({ loops, tick, jobs, checks, down }) => {
      loops.open({ title: 'Morning thing', due: '2026-09-26' });
      loops.setProactivity({ quiet_start: '23:00', quiet_end: '07:30', volume: 'normal' });
      await tick(at('2026-09-26T01:00:00Z'));
      loops.setProactivity({ quiet_start: '23:00', quiet_end: '07:30', volume: 'low' });
      await tick(at('2026-09-26T03:00:00Z'));
      loops.setProactivity({ quiet_start: '23:00', quiet_end: '07:30', volume: 'normal' });
      down.breaker = true;
      await tick(at('2026-09-26T03:30:00Z'));
      expect(jobs()).toEqual([]);
      down.breaker = false;
      await tick(at('2026-09-26T04:00:00Z'));
      expect(checks).toEqual(['held_quiet', 'held_volume', 'held_breaker', 'enqueued']);
      expect(jobs()).toHaveLength(1);
    });
  });

  it('a re-fired alarm makes one job, and a later tick while it is open makes none', async () => {
    await withHeartbeat(NOW, async ({ loops, tick, jobs, checks, book }) => {
      loops.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      await tick(NOW);
      // The same occurrence again, as a re-fired alarm delivers it.
      const [job] = jobs();
      expect(enqueueMachine(book, heartbeatJobSpec(loops.list(), { entryId: HEARTBEAT_ID, occurrence: NOW, runId: 'run-x', now: NOW, surface: 'app', timezone: TZ }))).toMatchObject({ code: 'existing', job: { id: job!.id } });
      await tick(NOW + 30 * 60_000);
      expect(jobs()).toHaveLength(1);
      expect(checks).toEqual(['enqueued', 'held_open_job']);
    });
  });

  it('a crash inside the job\'s transaction leaves no row and no decision; the retried tick writes exactly one job', async () => {
    await withHeartbeat(NOW, async ({ loops, tick, jobs, runs, down }) => {
      loops.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      down.crash = true;
      await tick(NOW);
      expect(jobs()).toEqual([]);
      expect(runs()[0]).toMatchObject({ outcome: 'running', heartbeat_result: null });
      // The platform fires the crashed occurrence again.
      await tick(NOW);
      expect(jobs()).toHaveLength(1);
      expect(jobs()[0]!.status).toBe('queued');
    });
  });
});

// The applier over the real job book, loop book and final outbox; the apply turn is a fake that records what it was given.
type Apply = Readonly<{ turns: { trace: string; text: string; loops: string[] }[]; reply: { text: string }; enabled: { on: boolean }; lane(): Promise<void>; outbox: TelegramFinalOutbox; ack(): Promise<void>; log: TurnLogEntry[] }>;
const applying = (h: Harness): Apply => {
  const turns: Apply['turns'] = [], reply = { text: 'The call happened; Asha sends notes tomorrow. Close this one?' }, enabled = { on: true }, log: TurnLogEntry[] = [];
  const outbox = new TelegramFinalOutbox(h.storage.kv, () => h.clock.at);
  const applier = heartbeatApplier({
    sql: h.sql, loops: h.loops, timezone: TZ, now: () => h.clock.at, enabled: () => enabled.on,
    transaction: work => h.storage.transactionSync(work),
    turn: async (trace, due, text, current) => { await current(); turns.push({ trace, text, loops: due.map(loop => loop.id) }); return reply.text; },
    deliver: async (id, trace, text, heartbeat, commit) => {
      if (outbox.records().some(record => record.id === id)) { h.storage.transactionSync(commit); return; }
      await outbox.enqueueFenced({ id, trace, payload: { chat_id: 7, text }, ownerSubject: '7', doName: 'owner-7', heartbeat }, work => h.storage.transactionSync(() => { work(); commit(); }));
    },
  });
  const host = { fence: () => undefined, cancelled: () => undefined, busy: () => new Set<string>() } as unknown as TaskHost;
  const deps: JobsLaneDeps = {
    book: h.book, host, now: () => h.clock.at, timezone: TZ, surface: 'app', quiet: () => false, log: entry => { log.push(entry); }, startWorker: async () => undefined,
    turn: async () => { throw new Error('a machine job took the task apply turn'); }, applyTools: () => { throw new Error('a machine job reached applyTools()'); },
    deliver: async () => { throw new Error('a machine job took the task delivery'); }, room: () => true, heldTopics: () => [], machine: { heartbeat: applier },
  };
  return {
    turns, reply, enabled, outbox, log,
    lane: async () => { await runJobsLane(deps); },
    ack: async () => {
      h.clock.at += 1_000;
      await outbox.drain({ allowed: async () => true, send: async () => ({ message_id: 1, chat: { id: 7 } }), settled: async (record: FinalRecord) => { settleHeartbeat(record, h.sql, h.scheduler); } });
    },
  };
};
const notified = (sql: SqlStorage) => sql.exec<{ loop_id: string }>('SELECT loop_id FROM heartbeat_notified').toArray().map(row => row.loop_id);

describe('applying a heartbeat job', () => {
  it('golden: the worker found something; one apply turn on the current loops, one outbox record with the receipt, cooldown at ACK', async () => {
    await withHeartbeat(NOW, async (h) => {
      const loop = h.loops.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      await h.tick(NOW);
      const [job] = h.jobs();
      report(h.book, job!);
      const a = applying(h);
      await a.lane();
      await a.lane();
      expect(a.turns).toHaveLength(1);
      expect(a.turns[0]).toMatchObject({ trace: `task:${job!.id}:apply`, loops: [loop.id] });
      expect(a.turns[0]!.text).toContain('[Check-back due now');
      expect(a.turns[0]!.text).toContain('Asha wrote after the call: the notes come tomorrow.');
      expect(a.turns[0]!.text).toContain('<task_result>');
      const records = a.outbox.records();
      expect(records.map(record => record.id)).toEqual([`heartbeat:${job!.id}`]);
      expect(records[0]!.heartbeat).toMatchObject({ id: HEARTBEAT_ID, loops: [{ id: loop.id, due: '2026-09-26T14:00', status: 'open' }] } satisfies Partial<HeartbeatReceipt>);
      expect(h.book.get(job!.id)!.status).toBe('applied');
      expect(notified(h.sql)).toEqual([]);
      await a.ack();
      expect(notified(h.sql)).toEqual([loop.id]);
      expect(a.log.filter(entry => entry.hop === 'machine_applied')).toHaveLength(1);
    });
  });

  it('the apply turn says SKIP: nothing is queued and the loops hold their cooldown as if told', async () => {
    await withHeartbeat(NOW, async (h) => {
      const loop = h.loops.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      await h.tick(NOW);
      report(h.book, h.jobs()[0]!);
      const a = applying(h);
      a.reply.text = 'SKIP';
      await a.lane();
      expect(a.outbox.records()).toEqual([]);
      expect(notified(h.sql)).toEqual([loop.id]);
      expect(h.book.get(h.jobs()[0]!.id)!.status).toBe('applied');
      // The cooldown holds: the next tick has nothing new to check.
      await h.tick(NOW + 30 * 60_000);
      expect(h.checks.at(-1)).toBe('unchanged');
    });
  });

  it('the worker found nothing: no apply turn, and the loops hold their cooldown', async () => {
    await withHeartbeat(NOW, async (h) => {
      const loop = h.loops.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      await h.tick(NOW);
      report(h.book, h.jobs()[0]!, { status: 'done', summary: 'Nothing new.', findings: [], proposals: [], left: [] });
      const a = applying(h);
      await a.lane();
      expect(a.turns).toEqual([]);
      expect(a.outbox.records()).toEqual([]);
      expect(h.book.get(h.jobs()[0]!.id)!.status).toBe('applied');
      expect(notified(h.sql)).toEqual([loop.id]);
      await h.tick(NOW + 30 * 60_000);
      expect(h.checks.at(-1)).toBe('unchanged');
    });
  });

  it('a check-back is asked again once the cooldown ends: each occurrence is its own job', async () => {
    await withHeartbeat(NOW, async (h) => {
      h.loops.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      await h.tick(NOW);
      report(h.book, h.jobs()[0]!);
      const a = applying(h);
      a.reply.text = 'SKIP';
      await a.lane();
      await h.tick(NOW + 4 * 60 * 60_000 + 60_000);
      expect(h.checks.at(-1)).toBe('enqueued');
      expect(h.jobs()).toHaveLength(2);
    });
  });

  it('the apply turn sees only the loops the worker checked, not one that fell due since', async () => {
    await withHeartbeat(NOW, async (h) => {
      const checked = h.loops.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      await h.tick(NOW);
      report(h.book, h.jobs()[0]!);
      h.loops.open({ title: 'A loop nobody checked yet', due: '2026-09-26T15:00' });
      const a = applying(h);
      await a.lane();
      expect(a.turns.map(turn => turn.loops)).toEqual([[checked.id]]);
      expect(a.turns[0]!.text).not.toContain('A loop nobody checked yet');
    });
  });

  it('quiet hours by apply time: the job settles held, with no apply turn and nothing queued', async () => {
    await withHeartbeat(at('2026-09-26T17:00:00Z'), async (h) => {
      // 22:30 IST: past due, before quiet. The worker reports after quiet starts at 23:00.
      h.loops.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      h.loops.setProactivity({ quiet_start: '23:00', quiet_end: '07:30', volume: 'normal' });
      await h.tick(at('2026-09-26T17:00:00Z'));
      report(h.book, h.jobs()[0]!);
      h.clock.at = at('2026-09-26T17:45:00Z');
      const a = applying(h);
      await a.lane();
      expect(a.turns).toEqual([]);
      expect(a.outbox.records()).toEqual([]);
      expect(h.book.get(h.jobs()[0]!.id)!.status).toBe('applied');
      expect(a.log.find(entry => entry.hop === 'machine_held')).toMatchObject({ code: 'held_quiet' });
    });
  });

  it('a loop closed before apply, or the heartbeat turned off, holds the job with no apply turn', async () => {
    await withHeartbeat(NOW, async (h) => {
      const loop = h.loops.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      await h.tick(NOW);
      report(h.book, h.jobs()[0]!);
      h.loops.close(loop.id, 'done');
      const a = applying(h);
      await a.lane();
      expect(a.turns).toEqual([]);
      expect(a.log.find(entry => entry.hop === 'machine_held')).toMatchObject({ code: 'held_stale' });

      h.loops.open({ title: 'Another', due: '2026-09-26T14:30' });
      await h.tick(NOW + 30 * 60_000);
      report(h.book, h.jobs()[1]!);
      a.enabled.on = false;
      await a.lane();
      expect(a.turns).toEqual([]);
      expect(a.log.filter(entry => entry.hop === 'machine_held').map(entry => entry.code)).toEqual(['held_stale', 'held_preference']);
    });
  });

  it('a forget while the worker runs cancels the job and fences it: its late report is discarded and nothing is sent', async () => {
    await withHeartbeat(NOW, async (h) => {
      h.loops.open({ title: 'Check how the late call with Asha went', due: '2026-09-26T14:00' });
      await h.tick(NOW);
      const job = h.jobs()[0]!;
      const ticket = h.book.startAttempt(job.id)!;
      expect(h.book.forget(['Asha'])).toEqual([job.id]);
      expect(h.book.report(ticket, RESULT, { rounds: 1, costUsd: 0 })).toBe('fenced');
      const a = applying(h);
      await a.lane();
      expect(a.turns).toEqual([]);
      expect(a.outbox.records()).toEqual([]);
      expect(h.book.get(job.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten' });
    });
  });

  it('the owner turning the heartbeat off cancels its open job with the owner as the reason', async () => {
    await withHeartbeat(NOW, async (h) => {
      h.loops.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      await h.tick(NOW);
      const job = h.jobs()[0]!;
      const ticket = h.book.startAttempt(job.id)!;
      const cancelled: string[] = [];
      const prefs = schedulePreferences(h.sql, h.loops);
      prefs.set('heartbeat', false);
      await applySchedulePreferences(prefs.all(), { scheduler: h.scheduler, plans: dayPlanBook(h.sql), timezone: TZ, now: h.clock.at,
        cancelMachine: kind => { for (const id of h.book.cancelMachine(kind)) cancelled.push(id); } }, 'heartbeat');
      expect(cancelled).toEqual([job.id]);
      expect(h.book.get(job.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'owner' });
      expect(h.book.report(ticket, RESULT, { rounds: 1, costUsd: 0 })).toBe('fenced');
    });
  });
});
