import { env } from 'cloudflare:workers';
import { NO_REPLAYS } from './helpers/no-replays';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TaskResult } from '@waldo/contracts';
import type { CalendarChange, GoogleClient, MailItem } from '../src/connectors/google';
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
  sql: SqlStorage; storage: DurableObjectStorage; clock: { at: number }; updates: UpdateBook; book: JobBook; mail: MailItem[]; events: CalendarChange[]; reads: { n: number };
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
    const mail: MailItem[] = [], events: CalendarChange[] = [], reads = { n: 0 }, gate = { code: null as SweepGate | null }, down = { breaker: false }, held: number[] = [];
    const google = {
      changedEvents: async () => { reads.n += 1; return [...events]; },
      newMail: async () => { reads.n += 1; return [...mail]; },
    } as unknown as GoogleClient;
    const check = (over: Partial<Parameters<typeof updateSweepCheck>[0]> = {}) => updateSweepCheck({
      updates, jobs: book, google, now: clock.at, day: DAY, timezone: 'UTC', surface: 'app', sourceFollowups: true,
      gate: () => gate.code, providerDown: () => down.breaker, transaction: work => state.storage.transactionSync(work),
      enqueued: job => { held.push(job.created_at); }, held: () => [], dayChanged: async () => undefined, ...over,
    });
    return work({
      sql, storage: state.storage, clock, updates, book, mail, events, reads, gate, down, held, check,
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

  it('an item whose words are dropped is named by a ref a reader can open: the event id, or the message id without a source', async () => {
    await withSweep(async (h) => {
      h.events.push({ id: 'ev-7', title: 'Cardiology follow-up: BP 150/95 last time', start: '2026-10-20T15:00:00Z', end: '2026-10-20T15:30:00Z', all_day: false, status: 'confirmed', created: '2026-10-20T08:58:00Z' } as CalendarChange);
      h.mail.push({ ...MAIL, snippet: 'Your HRV 38 ms looks fine.' });
      await h.check({ sourceFollowups: false });
      const [job] = h.jobs();
      expect(taskBrief(job!).machine!.refs).toEqual(['event:ev-7', 'message:m-1']);
      expect(taskBrief(job!).machine!.withheld).toEqual(['event:ev-7', 'message:m-1']);
      expect(taskBrief(job!).context).toContain(`[event:ev-7] ${HEALTH_DETAIL_DROPPED}`);
      expect(numericHealthIn(job!.brief_json)).toBe(false);
    });
  });

  // Weight follows the day: a change the sweep read on the owner's today asks for one health recompute, after the record
  // commits, whatever the card does. A failed ask never costs the update.
  const TODAY_MEETING = { id: 'ev-1', title: 'Budget review', start: '2026-10-20T15:00:00Z', end: '2026-10-20T16:00:00Z', all_day: false, status: 'confirmed', created: '2026-10-20T08:58:00Z' } as CalendarChange;
  it('a read with a change on today asks for the recompute once, and one that throws still writes the job', async () => {
    for (const fails of [false, true]) {
      await withSweep(async (h) => {
        h.events.push(TODAY_MEETING);
        let asked = 0;
        const check = await h.check({ dayChanged: async () => { asked += 1; if (fails) throw new Error('recompute unavailable'); } });
        expect(asked).toBe(1);
        expect(check.code).toBe('enqueued');
        expect(h.jobs()).toHaveLength(1);
        expect(h.rows()).toHaveLength(1);
      });
    }
  });
  it('asks for the recompute with the card held, and not for a change on another day or when nothing was read', async () => {
    await withSweep(async (h) => {
      let asked = 0;
      const dayChanged = async () => { asked += 1; };
      h.events.push({ ...TODAY_MEETING, id: 'ev-2', start: '2026-10-21T15:00:00Z', end: '2026-10-21T16:00:00Z' });
      await h.check({ dayChanged });
      expect(asked).toBe(0);
      h.events.splice(0, 1, TODAY_MEETING);
      h.clock.at = T0 + 600_000;
      // An open sweep job holds the window, so nothing is read and nothing is asked; the read after it settles asks.
      expect((await h.check({ now: h.clock.at, dayChanged })).code).toBe('held_open_job');
      expect(asked).toBe(0);
      for (const job of h.jobs()) h.book.cancel(job.id, 'owner');
      h.gate.code = 'held_quiet';
      expect((await h.check({ now: h.clock.at, dayChanged })).code).toBe('held_quiet');
      expect(asked).toBe(1);
    });
  });

  it('a change carrying a topic the owner is forgetting writes nothing and moves no watermark; once it settles the next tick writes the job', async () => {
    await withSweep(async (h) => {
      h.mail.push(MAIL);
      expect((await h.check({ held: () => ['Quote signed'] })).code).toBe('held_topic');
      expect([h.jobs(), h.rows(), h.since()]).toEqual([[], [], [T0 - 600_000, T0 - 600_000]]);
      expect(h.sql.exec('SELECT COUNT(*) AS n FROM observed_mail').one()).toEqual({ n: 0 });
      const result = await h.check({ held: () => [] });
      expect(result.code).toBe('enqueued');
      expect(h.jobs().map(job => job.idempotency_key)).toEqual([`machine:update_sweep:${T0 - 600_000}:${T0 - 600_000}`]);
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
    lane: () => runJobsLane({ book: h.book, host, now: () => h.clock.at, timezone: 'UTC', surface: 'app', quiet: () => false, log: entry => { log.push(entry); }, startWorker: async () => undefined,
      turn: refuse, applyTools: () => { throw new Error('a machine job reached applyTools()'); }, deliver: refuse, room: () => true, heldTopics: () => [], ...NO_REPLAYS,
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

  it('the worker found nothing on a mail it was not shown: the apply turn judges it, told which one, and only then is it judged', async () => {
    await withSweep(async (h) => {
      h.mail.push({ ...MAIL, subject: 'Your results', snippet: 'Your HRV 38 ms and resting heart rate 52 bpm look fine.' });
      await h.check();
      report(h, NOTHING);
      const a = applying(h);
      a.reply.text = 'SKIP';
      expect(judged(h.sql)).toEqual([0]);
      await a.lane();
      expect(a.turns).toHaveLength(1);
      expect(a.turns[0]!.text).toContain('Items not shown to the worker: mail:t-1.');
      expect(judged(h.sql)).toEqual([1]);
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
