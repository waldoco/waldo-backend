import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TaskResult } from '@waldo/contracts';
import type { GoogleClient, MailItem } from '../src/connectors/google';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { updateBook, type UpdateBook } from '../src/channels/update-cards';
import { updateSweepApplier, updateSweepCheck, type SweepGate } from '../src/channels/update-sweep';
import { numericHealthIn } from '../src/scribe/sanitiser';
import type { TaskHost } from '../src/tasks/brain';
import { jobBook, taskBrief, type JobBook, type JobRow } from '../src/tasks/jobs';
import { runJobsLane } from '../src/tasks/lane';
import { HEALTH_DETAIL_DROPPED } from '../src/tasks/machine';
import { applySchedulePreferences, schedulePreferences } from '../src/channels/schedule-preferences';
import { dayPlanBook } from '../src/channels/day-cards';
import { loopBook } from '../src/channels/loops';
import { Scheduler } from '../src/scheduler/multiplexer';
import { ensureSchema } from '../src/tracer/schema';

// The update sweep as a machine job. The brain reads what changed, then writes the update record, the watermarks and the
// reader job in one transaction; the worker judges the changes; the brain's apply turn writes one update card, only when
// the worker found something.
const T0 = Date.parse('2026-10-20T09:00:00Z');
const DAY = '2026-10-20';
const MAIL: MailItem = { id: 'm-1', thread_id: 't-1', from: 'Asha <asha@client.example>', subject: 'Quote signed', snippet: 'Signed copy attached; can we start Monday?', at: '2026-10-20T08:55:00Z' };
const FOUND: TaskResult = { status: 'done', summary: 'Asha signed the quote.', findings: [{ text: 'Asha signed the quote and asks to start Monday.', source_ref: 'mail:t-1' }], proposals: [], left: [] };
const NOTHING: TaskResult = { status: 'done', summary: 'Nothing worth telling.', findings: [], proposals: [], left: [] };

type Harness = Readonly<{
  sql: SqlStorage; storage: DurableObjectStorage; clock: { at: number }; updates: UpdateBook; book: JobBook; mail: MailItem[]; reads: { n: number };
  gate: { code: SweepGate | null }; down: { breaker: boolean }; held: number[];
  check(over?: Partial<Parameters<typeof updateSweepCheck>[0]>): ReturnType<typeof updateSweepCheck>;
  jobs(): JobRow[]; rows(): { id: number; changes: string; text: string | null }[]; since(): (number | null)[];
}>;
let seq = 0;
const withSweep = <T,>(work: (h: Harness) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`update-sweep-${seq += 1}`)), async (_instance, state) => {
    const sql = state.storage.sql;
    const clock = { at: T0 };
    let n = 0;
    const book = jobBook(sql, { now: () => clock.at, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const updates = updateBook(sql);
    updates.mark('mail_since', T0 - 600_000);
    updates.mark('calendar_since', T0 - 600_000);
    const mail: MailItem[] = [], reads = { n: 0 }, gate = { code: null as SweepGate | null }, down = { breaker: false }, held: number[] = [];
    const google = {
      changedEvents: async () => { reads.n += 1; return []; },
      newMail: async () => { reads.n += 1; return [...mail]; },
    } as unknown as GoogleClient;
    const check = (over: Partial<Parameters<typeof updateSweepCheck>[0]> = {}) => updateSweepCheck({
      updates, jobs: book, google, now: clock.at, day: DAY, timezone: 'UTC', surface: 'app', sourceFollowups: true,
      gate: () => gate.code, providerDown: () => down.breaker, transaction: work => state.storage.transactionSync(work),
      enqueued: job => { held.push(job.created_at); }, ...over,
    });
    return work({
      sql, storage: state.storage, clock, updates, book, mail, reads, gate, down, held, check,
      jobs: () => sql.exec<JobRow>('SELECT * FROM task_jobs ORDER BY created_at').toArray(),
      rows: () => sql.exec<{ id: number; changes: string; text: string | null }>('SELECT id, changes, text FROM update_cards ORDER BY id').toArray(),
      since: () => [updates.since('mail_since'), updates.since('calendar_since')],
    });
  });

describe('the sweep check writes a machine job', () => {
  it('golden: new mail becomes one update record and one reader job, with the watermarks, in one write', async () => {
    await withSweep(async (h) => {
      h.mail.push(MAIL);
      const result = await h.check();
      expect(result.code).toBe('enqueued');
      const [job] = h.jobs();
      expect(h.jobs()).toHaveLength(1);
      expect(job).toMatchObject({ origin: 'machine:update_sweep', profile: 'reader', taint: 'external', status: 'queued', idempotency_key: `machine:update_sweep:${T0 - 600_000}:${T0 - 600_000}` });
      const brief = taskBrief(job!);
      const [row] = h.rows();
      expect(brief.machine).toMatchObject({ job: 'update_sweep', scope: 'owner', refs: ['mail:t-1'], record_id: row!.id });
      expect(brief.context).toContain('[mail:t-1]');
      expect(brief.context).toContain('Quote signed');
      expect(h.since()).toEqual([T0, T0]);
      expect(h.held).toEqual([T0]);
    });
  });

  it('unchanged data writes no job and no update record', async () => {
    await withSweep(async (h) => {
      const result = await h.check();
      expect(result.code).toBe('unchanged');
      expect(h.jobs()).toEqual([]);
      expect(h.rows()).toEqual([]);
    });
  });

  it('a closed gate keeps the changes for the next main card and writes no job', async () => {
    await withSweep(async (h) => {
      h.mail.push(MAIL);
      h.gate.code = 'held_quiet';
      expect((await h.check()).code).toBe('held_quiet');
      expect(h.jobs()).toEqual([]);
      expect(h.rows()).toHaveLength(1);
      expect(h.since()).toEqual([T0, T0]);
    });
  });

  it('while a sweep job is open the next tick reads nothing and moves no watermark, so the next job coalesces', async () => {
    await withSweep(async (h) => {
      h.mail.push(MAIL);
      await h.check();
      const reads = h.reads.n;
      h.clock.at = T0 + 600_000;
      h.mail.push({ ...MAIL, id: 'm-2', thread_id: 't-2', subject: 'Second' });
      expect((await h.check({ now: h.clock.at })).code).toBe('held_open_job');
      expect(h.reads.n).toBe(reads);
      expect(h.since()).toEqual([T0, T0]);
      expect(h.jobs()).toHaveLength(1);
    });
  });

  it('with every worker provider down it reads nothing, writes nothing and moves no watermark', async () => {
    await withSweep(async (h) => {
      h.mail.push(MAIL);
      h.down.breaker = true;
      expect((await h.check()).code).toBe('held_breaker');
      expect([h.reads.n, h.jobs().length, h.rows().length]).toEqual([0, 0, 0]);
      expect(h.since()).toEqual([T0 - 600_000, T0 - 600_000]);
    });
  });

  it('a crash between the reads and the write leaves nothing; the next tick writes one job with the same changes', async () => {
    await withSweep(async (h) => {
      h.mail.push(MAIL);
      await expect(h.check({ transaction: () => { throw new Error('crash-injection: evicted before the write'); } })).rejects.toThrow('crash-injection');
      expect([h.jobs().length, h.rows().length]).toEqual([0, 0]);
      expect(h.since()).toEqual([T0 - 600_000, T0 - 600_000]);
      h.clock.at = T0 + 1_000;
      expect((await h.check({ now: h.clock.at })).code).toBe('enqueued');
      expect(h.jobs()).toHaveLength(1);
      expect(JSON.parse(h.rows()[0]!.changes)).toMatchObject([{ source: 'mail', source_ref: 'mail:t-1' }]);
    });
  });

  it('a crash after the write leaves one queued job and one update record', async () => {
    await withSweep(async (h) => {
      h.mail.push(MAIL);
      await expect(h.check({ transaction: work => { h.storage.transactionSync(work); throw new Error('crash-injection: evicted after the write'); } })).rejects.toThrow('crash-injection');
      expect(h.jobs().map(job => job.status)).toEqual(['queued']);
      expect(h.rows()).toHaveLength(1);
    });
  });

  it('a mail carrying a health value keeps its ref in the brief and drops its words', async () => {
    await withSweep(async (h) => {
      h.mail.push({ ...MAIL, subject: 'Your results', snippet: 'Your HRV 38 ms and resting heart rate 52 bpm look fine.' });
      await h.check();
      const [job] = h.jobs();
      expect(taskBrief(job!).context).toContain(`[mail:t-1] ${HEALTH_DETAIL_DROPPED}`);
      expect(numericHealthIn(job!.brief_json)).toBe(false);
    });
  });
});

type Apply = Readonly<{ turns: { trace: string; text: string }[]; delivered: { id: string; text: string; recordId: number }[]; reply: { text: string }; log: TurnLogEntry[]; lane(): Promise<void> }>;
const applying = (h: Harness): Apply => {
  const turns: Apply['turns'] = [], delivered: Apply['delivered'] = [], reply = { text: 'Update\nAsha signed the quote and wants to start Monday.' }, log: TurnLogEntry[] = [];
  const handler = updateSweepApplier({
    updates: h.updates, timezone: 'UTC', now: () => h.clock.at, sourceFollowups: () => true, gate: () => h.gate.code,
    transaction: work => h.storage.transactionSync(work),
    context: async () => ({ ledger: '', feedback: '', volume: 'normal' }),
    turn: async (trace, text, current) => { await current(); turns.push({ trace, text }); return reply.text; },
    deliver: async (id, _trace, text, recordId, commit) => { h.storage.transactionSync(() => { commit(); delivered.push({ id, text, recordId }); }); },
  });
  const host = { fence: () => undefined, cancelled: () => undefined, busy: () => new Set<string>() } as unknown as TaskHost;
  const refuse = async (): Promise<never> => { throw new Error('a machine job took the owner task path'); };
  return {
    turns, delivered, reply, log,
    lane: () => runJobsLane({ book: h.book, host, now: () => h.clock.at, timezone: 'UTC', log: entry => { log.push(entry); }, startWorker: async () => undefined,
      turn: refuse, applyTools: () => { throw new Error('a machine job reached applyTools()'); }, deliver: refuse, room: () => true, heldTopics: () => [],
      machine: { update_sweep: handler } }).then(() => undefined),
  };
};
const report = (h: Harness, result: TaskResult) => {
  const [job] = h.jobs();
  expect(h.book.report(h.book.startAttempt(job!.id)!, result, { rounds: 1, costUsd: 0.001 })).toBe('accepted');
  return job!;
};
const judged = (sql: SqlStorage) => sql.exec<{ judged: number }>('SELECT judged FROM observed_mail').toArray().map(row => row.judged);

describe('applying a sweep job', () => {
  it('golden: one apply turn on the job\'s changes, one update card under the job\'s key, the mail judged with it', async () => {
    await withSweep(async (h) => {
      h.mail.push(MAIL);
      await h.check();
      const job = report(h, FOUND);
      const a = applying(h);
      await a.lane();
      await a.lane();
      expect(a.turns).toHaveLength(1);
      expect(a.turns[0]!.trace).toBe(`task:${job.id}:apply`);
      expect(a.turns[0]!.text).toContain('Quote signed');
      expect(a.turns[0]!.text).toContain('<task_result>');
      expect(a.turns[0]!.text).toContain('Asha signed the quote and asks to start Monday.');
      expect(a.delivered).toEqual([{ id: `update:${job.id}`, text: a.reply.text, recordId: h.rows()[0]!.id }]);
      expect(judged(h.sql)).toEqual([1]);
      expect(h.book.get(job.id)!.status).toBe('applied');
      expect(a.log.filter(entry => entry.hop === 'machine_applied')).toHaveLength(1);
      // The card is recorded as sent only once it is delivered, never at queue time.
      expect(h.rows()[0]!.text).toBeNull();
    });
  });

  it('the apply turn says SKIP: no card, and the mail is judged so it is not offered again', async () => {
    await withSweep(async (h) => {
      h.mail.push(MAIL);
      await h.check();
      report(h, FOUND);
      const a = applying(h);
      a.reply.text = 'SKIP';
      await a.lane();
      expect(a.delivered).toEqual([]);
      expect(judged(h.sql)).toEqual([1]);
      expect(h.updates.pendingMail()).toEqual([]);
    });
  });

  it('the worker found nothing: no apply turn, no card, and the mail is judged', async () => {
    await withSweep(async (h) => {
      h.mail.push(MAIL);
      await h.check();
      const job = report(h, NOTHING);
      const a = applying(h);
      await a.lane();
      expect([a.turns, a.delivered]).toEqual([[], []]);
      expect(judged(h.sql)).toEqual([1]);
      expect(h.book.get(job.id)!.status).toBe('applied');
    });
  });

  it('quiet hours by apply time: the job settles held with no apply turn; the changes stay for the next main card', async () => {
    await withSweep(async (h) => {
      h.mail.push(MAIL);
      await h.check();
      report(h, FOUND);
      h.gate.code = 'held_quiet';
      const a = applying(h);
      await a.lane();
      expect([a.turns, a.delivered]).toEqual([[], []]);
      expect(a.log.find(entry => entry.hop === 'machine_held')).toMatchObject({ code: 'held_quiet' });
      expect(h.updates.unfolded('UTC')).toContain('Quote signed');
    });
  });

  it('mail that arrived after the job was written is not judged by it: the next sweep still offers it', async () => {
    await withSweep(async (h) => {
      h.mail.push(MAIL);
      await h.check();
      report(h, NOTHING);
      // A second message lands on another thread before the job applies; it is recorded by a later sweep.
      h.updates.observeMail('mail:t-9', 't-9', T0 + 1_000, 'm-9');
      h.updates.record(DAY, T0 + 1_000, [{ source: 'mail', kind: 'new', detail: '{"subject":"Later"}', source_ref: 'mail:t-9', source_message_id: 'm-9' }], null);
      await applying(h).lane();
      expect(h.updates.pendingMail().map(change => change.source_ref)).toEqual(['mail:t-9']);
    });
  });
});

describe('the owner turning the sweep off', () => {
  it('cancels its open job with the owner as the reason, and its worker\'s late report is fenced', async () => {
    await withSweep(async (h) => {
      ensureSchema(h.storage);
      h.mail.push(MAIL);
      await h.check();
      const [job] = h.jobs();
      const ticket = h.book.startAttempt(job!.id)!;
      const prefs = schedulePreferences(h.sql, loopBook(h.sql, { now: () => h.clock.at, newId: () => 'x' }));
      prefs.set('event_briefs', false);
      const cancelled: string[] = [];
      await applySchedulePreferences(prefs.all(), { scheduler: new Scheduler(h.sql, h.storage, { now: () => h.clock.at, newRunId: () => 'r', newOutboxId: () => 'o', sha256Hex: async () => 's' }),
        plans: dayPlanBook(h.sql), timezone: 'UTC', now: h.clock.at, cancelMachine: kind => { for (const id of h.book.cancelMachine(kind)) cancelled.push(id); } }, 'event_briefs');
      expect(cancelled).toEqual([job!.id]);
      expect(h.book.get(job!.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'owner' });
      expect(h.book.report(ticket, FOUND, { rounds: 1, costUsd: 0 })).toBe('fenced');
    });
  });
});
