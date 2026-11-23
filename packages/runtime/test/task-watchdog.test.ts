import { env } from 'cloudflare:workers';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';
import { flatConfig } from '../../../scripts/wrangler-vars.mjs';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { LLMToolTurn, ToolName } from '@waldo/contracts';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { sanitise } from '../src/scribe/sanitiser';
import { taskHost, type TaskHostDeps } from '../src/tasks/brain';
import { jobBook, TASK_LEASE_MS, type CreateJob, type JobBook, type TaskBrief, type TaskTicket } from '../src/tasks/jobs';
import { runJobsLane, type JobsLaneDeps } from '../src/tasks/lane';
import type { TaskHost } from '../src/tasks/brain';
import { PARK_WORDS } from '../src/prompt/fixed-lines';
import { taskBriefText } from '../src/tasks/worker-loop';
import {
  LANE_LATE_MS, JUDGE_EVERY_MS, JUDGE_MIN_ROUNDS, NUDGE_LINES, NUDGES_MAX, runWatchdog, STALL_MS, watchdogStore, WATCHDOG_JUDGMENTS_PER_HOUR,
  type WatchdogJudge, type WatchdogStore, type WatchdogVerdict,
} from '../src/tasks/watchdog';
import { DASHBOARD_WATCHDOG_PATH, consoleWatchdog, watchdogView, watchdogViewSchema } from '../src/channels/dashboard-watchdog';

// The progress watchdog over the real job book on Durable Object SQLite, on a fake clock. The judge is a fake that answers
// what each case scripts; what is under test is when the watchdog asks, what it records and how it acts through the book.
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const brief: TaskBrief = { title: 'Supplier quotes', goal: 'Find the three latest supplier quotes in mail.', context: 'Quotes come as PDFs.', done_when: 'Three quotes with dates.', effort: 'standard', timezone: 'UTC', started_at: T0 };
const task = (key: string, extra: Partial<CreateJob> = {}): CreateJob => ({ kind: 'task', profile: 'reader', idempotencyKey: key, origin: 'tg-1', surface: 'app', brief, dueAt: T0, deadlineAt: T0 + 6 * 60 * MIN, ...extra });
const turn = (n: number): LLMToolTurn => ({ call: { call_id: `c${n}`, name: 'search_communication', arguments: JSON.stringify({ query: 'quote' }) }, output: '{"ok":true,"data":{"hits":0}}' });

type Harness = Readonly<{
  book: JobBook; store: WatchdogStore; clock: { at: number }; log: TurnLogEntry[]; fenced: string[]; asked: string[];
  verdicts: (WatchdogVerdict | 'throws')[]; sql: SqlStorage;
  watch(over?: Partial<Parameters<typeof runWatchdog>[0]>): Promise<number | null>;
  run(key: string): TaskTicket;
  rounds(ticket: TaskTicket, count: number, step?: number): void;
}>;
let seq = 0;
const withWatchdog = <T,>(work: (h: Harness) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`task-watchdog-${seq += 1}`)), async (_instance, state) => {
    const clock = { at: T0 };
    let n = 0;
    const book = jobBook(state.storage.sql, { now: () => clock.at, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const store = watchdogStore(state.storage.sql);
    const log: TurnLogEntry[] = [], fenced: string[] = [], asked: string[] = [];
    const verdicts: (WatchdogVerdict | 'throws')[] = [];
    const judge: WatchdogJudge = async ({ jobId, text }) => {
      asked.push(jobId);
      expect(text).toContain(brief.goal);
      const next = verdicts.shift();
      if (next === undefined || next === 'throws') throw new Error('no provider answered');
      return next;
    };
    const watch = (over: Partial<Parameters<typeof runWatchdog>[0]> = {}) => runWatchdog({
      book, store, now: () => clock.at, judge, room: () => true, fence: id => { fenced.push(id); }, log: entry => { log.push(entry); }, lateMs: 0, ...over,
    });
    const run = (key: string) => { const { job } = book.create(task(key)); return book.startAttempt(job.id)!; };
    // A worker taking `count` rounds over the clock, each checkpointed, so its lease stays held.
    const rounds = (ticket: TaskTicket, count: number, step = MIN) => {
      for (let i = 0; i < count; i += 1) {
        clock.at += step;
        const row = book.get(ticket.jobId)!;
        const done = JSON.parse(row.checkpoint_json ?? '{"turns":[]}') as { turns: LLMToolTurn[] };
        expect(book.checkpoint(ticket, row.checkpoint_seq + 1, { turns: [...done.turns, turn(row.checkpoint_seq + 1)] }, { rounds: 1, costUsd: 0.001 })).toBe('ok');
      }
    };
    return work({ book, store, clock, log, fenced, asked, verdicts, sql: state.storage.sql, watch, run, rounds });
  });

const findings = (store: WatchdogStore, jobId?: string) => store.findings().filter(row => jobId === undefined || row.job_id === jobId);

describe('the progress watchdog', () => {
  it('leaves a healthy worker alone and does not ask again until new rounds have run', async () => {
    await withWatchdog(async ({ book, store, clock, asked, verdicts, watch, run, rounds }) => {
      const ticket = run('healthy');
      // Too early: fewer rounds than a judgment needs and not long enough running.
      rounds(ticket, 2);
      expect(await watch()).toBeNull();
      expect(asked).toEqual([]);
      rounds(ticket, JUDGE_MIN_ROUNDS + 6);
      verdicts.push({ verdict: 'progressing', action: 'none' });
      expect(await watch()).toBeNull();
      expect(asked).toEqual([ticket.jobId]);
      expect(findings(store, ticket.jobId).map(row => [row.code, row.action])).toEqual([['progressing', 'none']]);
      expect(book.get(ticket.jobId)!.status).toBe('running');
      // Time passes but no new round runs: nothing to judge.
      clock.at += JUDGE_EVERY_MS * 2;
      book.touch(ticket, null);
      await watch();
      expect(asked).toHaveLength(1);
      expect(store.nudgeFor(ticket.jobId, book.get(ticket.jobId)!.checkpoint_seq)).toBeNull();
    });
  });

  it('nudges a looping worker once, the nudge reaches its next claim, and a second looping verdict parks it with an honest reason', async () => {
    await withWatchdog(async ({ book, store, fenced, verdicts, watch, run, rounds }) => {
      const ticket = run('looping');
      rounds(ticket, JUDGE_EVERY_MS / MIN);
      // A park before any nudge was given is taken as a nudge: the worker hears what was seen first.
      verdicts.push({ verdict: 'looping', action: 'park' });
      expect(await watch()).toBeNull();
      expect(book.get(ticket.jobId)!.status).toBe('running');
      expect(findings(store, ticket.jobId).map(row => [row.code, row.action])).toEqual([['looping', 'nudge']]);
      const seqAtClaim = book.get(ticket.jobId)!.checkpoint_seq;
      expect(store.nudgeFor(ticket.jobId, seqAtClaim)).toBe('looping');
      // Delivered once.
      expect(store.nudgeFor(ticket.jobId, seqAtClaim)).toBeNull();
      rounds(ticket, JUDGE_EVERY_MS / MIN);
      verdicts.push({ verdict: 'looping', action: 'park' });
      expect(await watch()).toBe(book.get(ticket.jobId)!.updated_at);
      const parked = book.get(ticket.jobId)!;
      expect([parked.status, parked.park_reason, parked.lease_token]).toEqual(['reported', 'no_progress', null]);
      expect(fenced).toEqual([ticket.jobId]);
      expect(findings(store, ticket.jobId).map(row => [row.code, row.action])).toEqual([['looping', 'nudge'], ['looping', 'park']]);
      // The worker's next call is fenced: the book moved on.
      expect(book.touch(ticket, null)).toBe(false);
    });
  });

  it('nudges a drifting worker and the nudge is a fixed line in its brief, never model text', async () => {
    await withWatchdog(async ({ book, store, verdicts, watch, run, rounds }) => {
      const ticket = run('drifting');
      rounds(ticket, JUDGE_EVERY_MS / MIN);
      verdicts.push({ verdict: 'drifting', action: 'nudge' });
      await watch();
      const nudge = store.nudgeFor(ticket.jobId, book.get(ticket.jobId)!.checkpoint_seq);
      expect(nudge).toBe('drifting');
      const text = taskBriefText(brief, 3, nudge!);
      expect(text.endsWith(NUDGE_LINES.drifting)).toBe(true);
      expect(taskBriefText(brief, 3)).not.toContain(NUDGE_LINES.drifting);
      // A changed task drifts from its changes, not from the goal it started with.
      expect(NUDGE_LINES.drifting).toMatch(/changes Waldo made/);
    });
  });

  it('records a stuck lease and a late wake, and clears them once the job runs again and the wake is on time', async () => {
    await withWatchdog(async ({ book, store, clock, watch, run, rounds }) => {
      const ticket = run('stuck');
      rounds(ticket, 1);
      // The worker stopped calling in, and the wake that should have caught it came late.
      clock.at += TASK_LEASE_MS + LANE_LATE_MS;
      expect(book.lapse()).toEqual([{ id: ticket.jobId, parked: false }]);
      await watch({ lateMs: LANE_LATE_MS + MIN });
      expect(store.open().map(row => row.code).sort()).toEqual(['lane_late', 'lease_lapsed']);
      // Re-checked on the next pass: still open while nothing changed.
      await watch({ lateMs: LANE_LATE_MS + MIN });
      expect(store.open().map(row => row.code).sort()).toEqual(['lane_late', 'lease_lapsed']);
      expect(findings(store).filter(row => row.code === 'lease_lapsed')).toHaveLength(1);
      // A new attempt makes progress and the wake is on time: both clear.
      const next = book.startAttempt(ticket.jobId)!;
      rounds(next, 1);
      await watch({ lateMs: 0 });
      expect(store.open()).toEqual([]);
      expect(findings(store).every(row => row.cleared_at !== null)).toBe(true);
    });
  });

  it('re-checks a judge that could not answer until it answers, once an interval, so a failing judge cannot spend the hour', async () => {
    await withWatchdog(async ({ store, asked, verdicts, watch, run, rounds }) => {
      const ticket = run('outage');
      rounds(ticket, JUDGE_EVERY_MS / MIN);
      verdicts.push('throws');
      await watch();
      expect(store.open().map(row => row.code)).toEqual(['judge_unavailable']);
      // Passes a lease apart, with the worker running on, do not ask again inside the interval.
      for (let pass = 0; pass < 3; pass += 1) {
        rounds(ticket, JUDGE_MIN_ROUNDS, TASK_LEASE_MS / JUDGE_MIN_ROUNDS);
        verdicts.push('throws');
        await watch();
      }
      expect(asked).toEqual([ticket.jobId]);
      verdicts.length = 0;
      // Asked again once the interval has passed.
      rounds(ticket, JUDGE_MIN_ROUNDS);
      verdicts.push({ verdict: 'progressing', action: 'none' });
      await watch();
      expect(asked).toEqual([ticket.jobId, ticket.jobId]);
      expect(store.open()).toEqual([]);
    });
  });

  it('records a stall at exactly twenty minutes without a checkpoint on the same attempt, not a millisecond before, and clears it on progress', async () => {
    await withWatchdog(async ({ book, store, clock, watch, run, rounds }) => {
      const ticket = run('stalled');
      rounds(ticket, 1);
      await watch();
      const since = clock.at;
      clock.at = since + STALL_MS - 1;
      book.touch(ticket, null);
      await watch();
      expect(store.open()).toEqual([]);
      clock.at = since + STALL_MS;
      await watch();
      expect(store.open().map(row => [row.job_id, row.code, row.action])).toEqual([[ticket.jobId, 'stalled', 'recheck']]);
      rounds(ticket, 1);
      await watch();
      expect(store.open()).toEqual([]);
    });
  });

  it('records provider errors when the deferral count rises, and clears them once the job runs again', async () => {
    await withWatchdog(async ({ book, store, clock, watch, run, rounds }) => {
      const ticket = run('deferred');
      rounds(ticket, 1);
      await watch();
      expect(book.defer(ticket, clock.at + MIN, { rounds: 0, costUsd: 0 })).toBe('deferred');
      await watch();
      expect(store.open().map(row => [row.job_id, row.code])).toEqual([[ticket.jobId, 'provider_errors']]);
      // Re-checked, not recorded twice.
      await watch();
      expect(findings(store, ticket.jobId).filter(row => row.code === 'provider_errors')).toHaveLength(1);
      clock.at += MIN;
      rounds(book.startAttempt(ticket.jobId)!, 1);
      await watch();
      expect(store.open()).toEqual([]);
    });
  });

  it('gives one job at most NUDGES_MAX nudges; a later nudge verdict changes nothing', async () => {
    await withWatchdog(async ({ book, store, verdicts, watch, run, rounds }) => {
      const ticket = run('nudged-out');
      for (let i = 0; i < NUDGES_MAX + 1; i += 1) {
        rounds(ticket, JUDGE_EVERY_MS / MIN);
        verdicts.push({ verdict: 'drifting', action: 'nudge' });
        await watch();
        store.nudgeFor(ticket.jobId, book.get(ticket.jobId)!.checkpoint_seq);
      }
      expect(findings(store, ticket.jobId).map(row => row.action)).toEqual([...Array<string>(NUDGES_MAX).fill('nudge'), 'none']);
      expect(store.seen(ticket.jobId)).toMatchObject({ nudges: NUDGES_MAX, nudge: null });
    });
  });

  it('holds a park when the judged attempt was replaced or a step is in flight, and asks again on the next pass', async () => {
    await withWatchdog(async ({ book, store, clock, fenced, asked, verdicts, watch, run, rounds }) => {
      const ticket = run('moved-on');
      rounds(ticket, JUDGE_EVERY_MS / MIN);
      verdicts.push({ verdict: 'looping', action: 'nudge' });
      await watch();
      store.nudgeFor(ticket.jobId, book.get(ticket.jobId)!.checkpoint_seq);
      rounds(ticket, JUDGE_EVERY_MS / MIN);
      // While the judge answers, the worker's attempt is lost and a new one starts.
      let next: TaskTicket | null = null;
      await watch({ judge: async ({ jobId }) => {
        asked.push(jobId);
        clock.at += TASK_LEASE_MS + 1;
        book.lapse();
        next = book.startAttempt(ticket.jobId);
        return { verdict: 'looping', action: 'park' };
      } });
      expect(next).not.toBeNull();
      expect(book.get(ticket.jobId)!.status).toBe('running');
      expect(findings(store, ticket.jobId).at(-1)!.action).toBe('held');
      // Not asked again inside the interval.
      await watch();
      expect(asked).toHaveLength(2);
      // Asked again after it without new rounds; this time a step that cannot be replayed is in flight.
      clock.at += JUDGE_EVERY_MS;
      expect(book.beginEffect(next!, { tool: 'browse_act', call_id: 'c-x' })).toBe(true);
      verdicts.push({ verdict: 'looping', action: 'park' });
      await watch();
      expect(asked).toHaveLength(3);
      expect(book.get(ticket.jobId)!.status).toBe('running');
      expect(findings(store, ticket.jobId).at(-1)!.action).toBe('held');
      expect(fenced).toEqual([]);
    });
  });

  it('parks a worker that took another round on the same attempt while the judge answered', async () => {
    await withWatchdog(async ({ book, store, fenced, verdicts, watch, run, rounds }) => {
      const ticket = run('same-attempt');
      rounds(ticket, JUDGE_EVERY_MS / MIN);
      verdicts.push({ verdict: 'looping', action: 'nudge' });
      await watch();
      store.nudgeFor(ticket.jobId, book.get(ticket.jobId)!.checkpoint_seq);
      rounds(ticket, JUDGE_EVERY_MS / MIN);
      await watch({ judge: async () => { rounds(ticket, 1); return { verdict: 'looping', action: 'park' }; } });
      expect(book.get(ticket.jobId)!.park_reason).toBe('no_progress');
      expect(fenced).toEqual([ticket.jobId]);
    });
  });

  it('judges only running tasks: a job waiting on the owner, a queued job and a retried turn are never judged', async () => {
    await withWatchdog(async ({ book, store, asked, clock, verdicts, watch, run, rounds }) => {
      const waiting = run('waiting');
      rounds(waiting, JUDGE_EVERY_MS / MIN);
      expect(book.await(waiting, { approval_id: 'appr-1', call: { call_id: 'c-act', name: 'browse_act', arguments: '{}' } })).toBe(true);
      book.create(task('queued', { dueAt: T0 + 24 * 60 * MIN }));
      const { job: retry } = book.create({ kind: 'retry_turn', profile: null, idempotencyKey: 'retry-1', origin: 'tg-1', surface: 'app', brief: { message_ref: 'm1', text: 'hello', conversation_ref: 'main', said_at: clock.at, promised_by: clock.at + 60 * MIN }, dueAt: clock.at, deadlineAt: clock.at + 60 * MIN });
      // A retried turn that has taken as many rounds as a task would need to be judged.
      rounds(book.startAttempt(retry.id)!, JUDGE_EVERY_MS / MIN);
      clock.at += JUDGE_EVERY_MS * 2;
      verdicts.push({ verdict: 'looping', action: 'park' });
      await watch();
      expect(asked).toEqual([]);
      expect(store.findings()).toEqual([]);
    });
  });

  it('asks the judge at most N times an hour across all jobs, and not when the alarm has no room', async () => {
    await withWatchdog(async ({ asked, clock, verdicts, watch, run, rounds }) => {
      const tickets = Array.from({ length: WATCHDOG_JUDGMENTS_PER_HOUR + 2 }, (_, i) => run(`busy-${i}`));
      for (let pass = 0; pass < 6; pass += 1) {
        clock.at += JUDGE_EVERY_MS;
        for (const ticket of tickets) rounds(ticket, JUDGE_MIN_ROUNDS, 0);
        for (let i = 0; i < tickets.length; i += 1) verdicts.push({ verdict: 'progressing', action: 'none' });
        await watch();
      }
      expect(asked.length).toBe(WATCHDOG_JUDGMENTS_PER_HOUR);
      const before = asked.length;
      clock.at += 60 * MIN;
      for (const ticket of tickets) rounds(ticket, JUDGE_MIN_ROUNDS, 0);
      await watch({ room: () => false });
      expect(asked.length).toBe(before);
    });
  });

  it('logs codes and ids only: no text field and no words of the brief', async () => {
    await withWatchdog(async ({ log, verdicts, watch, run, rounds }) => {
      const ticket = run('logged');
      rounds(ticket, JUDGE_EVERY_MS / MIN);
      verdicts.push({ verdict: 'drifting', action: 'nudge' });
      await watch();
      expect(log.some(entry => entry.hop === 'watchdog_finding' && entry.code === 'task:drifting:nudge' && entry.job_id === ticket.jobId)).toBe(true);
      for (const entry of log) {
        expect(entry).not.toHaveProperty('text');
        expect(JSON.stringify(entry).toLowerCase()).not.toContain('supplier');
      }
    });
  });
});

describe('the parked report', () => {
  it('tells the owner a task parked for no progress, in the fixed park words', async () => {
    await withWatchdog(async ({ book, verdicts, store, watch, run, rounds }) => {
      const ticket = run('told');
      rounds(ticket, JUDGE_EVERY_MS / MIN);
      verdicts.push({ verdict: 'looping', action: 'nudge' });
      await watch();
      store.nudgeFor(ticket.jobId, book.get(ticket.jobId)!.checkpoint_seq);
      rounds(ticket, JUDGE_EVERY_MS / MIN);
      verdicts.push({ verdict: 'looping', action: 'park' });
      await watch();
      const texts: string[] = [];
      const host = { fence: () => undefined, cancelled: () => undefined, busy: () => new Set<string>(), endAsk: () => undefined } as unknown as TaskHost;
      const deps: JobsLaneDeps = {
        book, host, now: () => book.get(ticket.jobId)!.updated_at, timezone: 'UTC', surface: 'app', quiet: () => false, log: () => undefined,
        startWorker: async () => undefined, turn: async (_job, _trace, text) => { texts.push(text); return 'Told.'; },
        applyTools: () => ['search_communication'] as ToolName[], deliver: async (_id, _trace, _text, commit) => { commit(); }, room: () => true,
        heldTopics: () => [], startReplay: () => undefined, approvals: { replays: () => [], replayReceipt: () => '', settleReplay: () => false }, followUp: true,
      };
      await runJobsLane(deps);
      expect(texts.some(text => text.includes(PARK_WORDS.no_progress))).toBe(true);
      // Not retried as a crash or an outage would be.
      expect(book.get(ticket.jobId)!.status).toBe('parked');
    });
  });
});

describe('the watchdog cadence', () => {
  it('needs no wake of its own: while a job runs, the jobs lane wakes again within a lease', async () => {
    await withWatchdog(async ({ book, clock, run, rounds }) => {
      const ticket = run('cadence');
      rounds(ticket, 1);
      const host = { fence: () => undefined, cancelled: () => undefined, busy: () => new Set<string>(), endAsk: () => undefined } as unknown as TaskHost;
      const next = await runJobsLane({
        book, host, now: () => clock.at, timezone: 'UTC', surface: 'app', quiet: () => false, log: () => undefined, startWorker: async () => undefined,
        turn: async () => '', applyTools: () => [], deliver: async (_id, _trace, _text, commit) => { commit(); }, room: () => true, heldTopics: () => [],
        startReplay: () => undefined, approvals: { replays: () => [], replayReceipt: () => '', settleReplay: () => false },
      });
      expect(next).not.toBeNull();
      expect(next!).toBeLessThanOrEqual(clock.at + TASK_LEASE_MS);
    });
  });
});

describe('the nudge at the worker claim', () => {
  it('rides the next claim of the attempt once, and only when the deploy delivers nudges', async () => {
    await withWatchdog(async ({ book, store, verdicts, watch, run, rounds }) => {
      const ticket = run('claimed');
      rounds(ticket, JUDGE_EVERY_MS / MIN);
      verdicts.push({ verdict: 'looping', action: 'nudge' });
      await watch();
      const deps = (nudge?: TaskHostDeps['nudge']): TaskHostDeps => ({
        book, now: () => book.get(ticket.jobId)!.updated_at, handlers: () => [] as unknown as ReturnType<TaskHostDeps['handlers']>,
        context: () => ({ authenticatedUserId: 'owner-1', sanitise, egressAllowlist: [] }), serialBrowser: (_scope, work) => work(), releaseBrowser: () => undefined,
        log: () => undefined, wake: async () => undefined, replayApproval: async () => ({ status: 'failed', message: 'none' }), ...(nudge ? { nudge } : {}),
      });
      const off = await taskHost(deps()).claim(ticket);
      expect(off !== 'fenced' && off.nudge).toBeFalsy();
      const host = taskHost(deps((id, at) => store.nudgeFor(id, at)));
      const first = await host.claim(ticket);
      expect(first !== 'fenced' && first.nudge).toBe('looping');
      const second = await host.claim(ticket);
      expect(second !== 'fenced' && second.nudge).toBeFalsy();
    });
  });
});

describe('the console watchdog read', () => {
  it('answers codes, counts and job ids, with the job status and park reason, and nothing else', async () => {
    await withWatchdog(async ({ sql, clock, verdicts, watch, run, rounds }) => {
      const ticket = run('viewed');
      rounds(ticket, JUDGE_EVERY_MS / MIN);
      verdicts.push({ verdict: 'drifting', action: 'nudge' });
      await watch({ lateMs: LANE_LATE_MS * 2 });
      const view = watchdogView(sql, clock.at, true);
      expect(watchdogViewSchema.parse(view)).toEqual(view);
      expect(view.counts_24h).toEqual({ drifting: 1, lane_late: 1 });
      expect(view.judgments_last_hour).toBe(1);
      expect(view.recent.find(row => row.code === 'drifting')).toMatchObject({ job_id: ticket.jobId, job_kind: 'task', action: 'nudge', job_status: 'running', park_reason: null });
      expect(JSON.stringify(view).toLowerCase()).not.toContain('supplier');
      const limited = { at: 0 };
      const answer = await consoleWatchdog({ request: new Request(`https://w.test${DASHBOARD_WATCHDOG_PATH}`), sql, now: clock.at, enabled: true, limited: () => (limited.at += 1, null) });
      expect(answer.status).toBe(200);
      expect(limited.at).toBe(1);
      expect((await consoleWatchdog({ request: new Request(`https://w.test${DASHBOARD_WATCHDOG_PATH}?x=1`), sql, now: clock.at, enabled: true, limited: () => null })).status).toBe(400);
      expect((await consoleWatchdog({ request: new Request(`https://w.test${DASHBOARD_WATCHDOG_PATH}`, { method: 'POST' }), sql, now: clock.at, enabled: true, limited: () => null })).status).toBe(405);
    });
  });
});

describe('the console watchdog read for an owner the watchdog never ran for', () => {
  it('answers an empty view and creates no tables', async () => {
    await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`task-watchdog-${seq += 1}`)), async (_instance, state) => {
      const sql = state.storage.sql;
      const answer = await consoleWatchdog({ request: new Request(`https://w.test${DASHBOARD_WATCHDOG_PATH}`), sql, now: T0, enabled: false, limited: () => null });
      expect(answer.status).toBe(200);
      expect(watchdogViewSchema.parse(await answer.json())).toMatchObject({ enabled: false, last_check_at: null, open: [], recent: [], counts_24h: {} });
      expect(sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'watchdog%'").toArray()).toEqual([]);
    });
  });
});

describe('WALDO_WATCHDOG in the Worker config', () => {
  it('is off in production and on in staging', () => {
    const parsed = flatConfig(parseJsonc(config)) as { vars: Record<string, string>; env: { staging: { vars: Record<string, string> } } };
    expect(parsed.vars.WALDO_WATCHDOG).toBe('0');
    expect(parsed.env.staging.vars.WALDO_WATCHDOG).toBe('1');
  });
});
