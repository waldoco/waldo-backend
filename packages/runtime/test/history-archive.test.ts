// Retention means archive, never delete. Each case drives the real books on real Durable Object SQLite and checks one
// falsifier of the history archive design: a moved row is not gone, a row still read is never moved, the dry run writes
// nothing, the hot reads are the same bytes whether the archive is on or off, and search_history pages across hot and
// archived rows and refuses any turn but the owner's. Every row is synthetic.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { buildSessionState, type SearchHistoryResult } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { appApprovalLink, appCaller } from '../src/channels/surfaces/app';
import { forgetBarrier, resultOrigin } from '../src/context-composer/forget-barrier';
import { approvalDesk, ledgerSummary } from '../src/channels/approvals';
import { MAX_RUN_ROWS, runBook } from '../src/channels/background-runs';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { OWNER_TURN_ONLY_TOOLS } from '../src/channels/owner-turn';
import { archiveMode, historyArchive, SCHEDULE_RUNS_ARCHIVE_AFTER_MS, searchHistory, sweepScheduleRuns, type ArchiveMode } from '../src/history/archive';
import { Scheduler, type ScheduleExecutors } from '../src/scheduler/multiplexer';
import { sanitise } from '../src/scribe/sanitiser';
import { jobBook, MACHINE_SETTLED_KEPT, MACHINE_SETTLED_KEPT_MS, TASK_SETTLED_KEPT } from '../src/tasks/jobs';
import { dispatchTool } from '../src/tools/dispatcher';
import { searchHistoryHandler } from '../src/tools/live/search-history';
import type { TestStorageDO } from './support/worker-entry';

let seq = 0;
const stub = () => env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`history-archive-${(seq += 1)}`)) as DurableObjectStub<TestStorageDO>;
const DAY = 24 * 60 * 60_000;
type Logged = Readonly<{ hop: string; source: string; count: number }>;
const archiveFor = (state: DurableObjectState, mode: ArchiveMode, now: () => number = Date.now, logged: Logged[] = []) =>
  ({ sql: state.storage.sql, transaction: <T>(work: () => T) => state.storage.transactionSync(work), mode, now, log: (event: Logged) => { logged.push(event); } });
const tables = (sql: SqlStorage) => sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map(row => row.name);
const archived = (sql: SqlStorage) => sql.exec<{ id: string; source: string; kind: string; status: string; summary: string | null; row_json: string }>('SELECT id, source, kind, status, summary, row_json FROM history_archive ORDER BY id').toArray();

// 500 settled runs a minute apart, the oldest first, then one start past the cap.
const fillRuns = (state: DurableObjectState, mode: ArchiveMode, logged: Logged[] = [], runningOldest = false) => {
  let at = 1_000_000, n = 0;
  const book = runBook(state.storage.sql, { timezone: 'UTC', now: () => new Date(at) }, () => `r${String(++n).padStart(4, '0')}`, historyArchive(archiveFor(state, mode, () => at, logged)));
  const first = book.start('reminder', null);
  if (!runningOldest) book.finish(first.id, 'completed', 'reminder sent: dentist');
  for (let i = 1; i < MAX_RUN_ROWS; i += 1) { at += 60_000; const run = book.start('loop', null); book.finish(run.id, 'completed', `loop ${i}`); }
  at += 60_000;
  book.start('brief', null);
  return { book, first };
};

describe('background_runs past the cap', () => {
  it('moves the oldest settled run into the archive instead of deleting it', async () => {
    const result = await runInDurableObject(stub(), (_instance, state) => {
      fillRuns(state, 'off');
      return { gone: state.storage.sql.exec("SELECT * FROM background_runs WHERE id = 'bg:r0001'").toArray(), tables: tables(state.storage.sql) };
    });
    // Off: today's delete, and no archive.
    expect(result.gone).toEqual([]);
    expect(result.tables).not.toContain('history_archive');
    const moved = await runInDurableObject(stub(), (_instance, state) => {
      fillRuns(state, 'on');
      return { hot: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM background_runs').one().n, rows: archived(state.storage.sql) };
    });
    expect(moved.hot).toBe(MAX_RUN_ROWS);
    expect(moved.rows).toHaveLength(1);
    expect(moved.rows[0]).toMatchObject({ id: 'background_runs:bg:r0001', source: 'background_runs', kind: 'reminder', status: 'completed', summary: 'reminder sent: dentist' });
    expect(JSON.parse(moved.rows[0]!.row_json)).toEqual({ id: 'bg:r0001', kind: 'reminder', status: 'completed', summary: 'reminder sent: dentist', parent_id: null, started_at: 1_000_000, ended_at: 1_000_000 });
  });

  it('never moves a running run, so its finish still lands', async () => {
    const result = await runInDurableObject(stub(), (_instance, state) => {
      const { book, first } = fillRuns(state, 'on', [], true);
      const finished = book.finish(first.id, 'completed', 'long loop done');
      return { finished, row: book.byId(first.id), archive: tables(state.storage.sql).includes('history_archive') ? archived(state.storage.sql) : [] };
    });
    expect(result.finished).toBe(true);
    expect(result.row).toMatchObject({ status: 'completed', summary: 'long loop done' });
    expect(result.archive).toEqual([]);
  });

  it('keeps the hot reads byte-equal whether the archive is on or off', async () => {
    const read = (mode: ArchiveMode) => runInDurableObject(stub(), (_instance, state) => {
      const { book } = fillRuns(state, mode);
      return JSON.stringify({ list: book.list(MAX_RUN_ROWS + 10), page: book.listPage(50), latest: book.latestActivity(), between: book.between(0, Number.MAX_SAFE_INTEGER, 10) });
    });
    expect(await read('on')).toBe(await read('off'));
  });

  it('writes nothing on a dry run: no move, no delete, and a count per source in the log', async () => {
    const result = await runInDurableObject(stub(), (_instance, state) => {
      const logged: Logged[] = [];
      fillRuns(state, 'dry', logged);
      return { hot: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM background_runs').one().n, tables: tables(state.storage.sql), logged };
    });
    expect(result.hot).toBe(MAX_RUN_ROWS + 1);
    expect(result.tables).not.toContain('history_archive');
    expect(result.logged).toEqual([{ hop: 'history_archive_dry', source: 'background_runs', count: 1 }]);
  });

  it('reads the switch strictly: only "1" moves and only "dry" counts', () => {
    expect([undefined, '', '0', 'on', 'true', '1', 'dry'].map(archiveMode)).toEqual(['off', 'off', 'off', 'off', 'off', 'on', 'dry']);
  });
});

describe('task_jobs trim', () => {
  const settledJobs = (state: DurableObjectState, mode: ArchiveMode, logged: Logged[] = []) => {
    let now = 10 * DAY, n = 0;
    const book = jobBook(state.storage.sql, { now: () => now, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n}`, archive: historyArchive(archiveFor(state, mode, () => now, logged)) });
    const make = (origin: string, title: string) => {
      const { job } = book.create({ kind: 'task', profile: null, idempotencyKey: `k-${title}`, origin, surface: 'app', brief: { title, goal: 'g', context: 'c', done_when: 'd', effort: 'standard', started_at: now }, dueAt: now, deadlineAt: now + DAY });
      book.cancel(job.id, 'owner');
      now += 1_000;
      return job.id;
    };
    const owner = Array.from({ length: TASK_SETTLED_KEPT + 2 }, (_, i) => make('turn-1', `owner task ${i}`));
    const machine = Array.from({ length: MACHINE_SETTLED_KEPT + 1 }, (_, i) => make('machine:heartbeat', `machine job ${i}`));
    now += MACHINE_SETTLED_KEPT_MS + 1;
    const trimmed = book.trim();
    return { book, owner, machine, trimmed };
  };

  it('moves both trims into the archive, keeping each row whole and its title as the summary', async () => {
    const result = await runInDurableObject(stub(), (_instance, state) => {
      const { owner, machine, trimmed } = settledJobs(state, 'on');
      const hot = new Set(state.storage.sql.exec<{ id: string }>('SELECT id FROM task_jobs').toArray().map(row => row.id));
      return { trimmed, owner, machine, hot: [...hot], rows: archived(state.storage.sql) };
    });
    expect(result.trimmed).toBe(3);
    expect(result.rows.map(row => row.id)).toEqual([result.owner[0], result.owner[1], result.machine[0]].map(id => `task_jobs:${id}`).sort());
    expect(result.hot).not.toContain(result.owner[0]);
    const first = result.rows.find(row => row.id === `task_jobs:${result.owner[0]}`)!;
    expect(first).toMatchObject({ source: 'task_jobs', kind: 'task', status: 'cancelled', summary: 'owner task 0' });
    // The brief is kept as JSON, not as a string of it.
    expect(JSON.parse(first.row_json)).toMatchObject({ id: result.owner[0], origin: 'turn-1', brief_json: { title: 'owner task 0' }, cancel_reason: 'owner' });
  });

  it('trims as it always did while the archive is off', async () => {
    const result = await runInDurableObject(stub(), (_instance, state) => {
      const { trimmed } = settledJobs(state, 'off');
      return { trimmed, tables: tables(state.storage.sql) };
    });
    expect(result.trimmed).toBe(3);
    expect(result.tables).not.toContain('history_archive');
  });

  it('writes nothing on a dry run', async () => {
    const result = await runInDurableObject(stub(), (_instance, state) => {
      const logged: Logged[] = [];
      const { trimmed, owner, machine } = settledJobs(state, 'dry', logged);
      return { trimmed, hot: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM task_jobs').one().n, expected: owner.length + machine.length, tables: tables(state.storage.sql), logged };
    });
    expect(result.trimmed).toBe(0);
    expect(result.hot).toBe(result.expected);
    expect(result.tables).not.toContain('history_archive');
    expect(result.logged).toEqual([{ hop: 'history_archive_dry', source: 'task_jobs', count: 2 }, { hop: 'history_archive_dry', source: 'task_jobs', count: 1 }]);
  });
});

describe('schedule_runs sweep', () => {
  const deps = (now: number) => ({ now: () => now, newRunId: () => 'run', newOutboxId: () => 'out', sha256Hex: async () => 'sha' });
  const crash = { brief: async () => { throw new Error('crash-injection: forced'); } } as ScheduleExecutors;
  const ok = { brief: async () => undefined } as ScheduleExecutors;

  it('moves only whole settled occurrences older than 30 days, never a running one or the one its schedule is on', async () => {
    const result = await runInDurableObject(stub(), async (_instance, state) => {
      const at = (now: number) => new Scheduler(state.storage.sql, state.storage, deps(now));
      // old-done: settled long ago, schedule gone. old-crashed: a run left running long ago (its retry settles beside it
      // later, but the crashed row stays running). recent: settled yesterday.
      await at(1_000).schedule({ id: 'old-done', kind: 'brief', occurrenceAt: 900, dueAt: 900, payloadRefs: {} });
      await at(1_000).dispatchDue(ok);
      await at(1_000).schedule({ id: 'old-crashed', kind: 'brief', occurrenceAt: 900, dueAt: 900, payloadRefs: {} });
      await expect(at(1_000).dispatchDue(crash)).rejects.toThrow('crash-injection');
      const now = 1_000 + SCHEDULE_RUNS_ARCHIVE_AFTER_MS + 40 * DAY;
      await at(now - DAY).schedule({ id: 'recent', kind: 'brief', occurrenceAt: now - DAY, dueAt: now - DAY, payloadRefs: {} });
      await at(now - DAY).dispatchDue(ok);
      // A schedule still on an old occurrence it has not settled past (quarantined): its rows are still read.
      state.storage.sql.exec("INSERT INTO schedule_runs (id, schedule_id, kind, fired_at, attempt, outcome, settled_at) VALUES ('current:900:1', 'current', 'brief', 1000, 1, 'failed', 1000)");
      state.storage.sql.exec("INSERT INTO schedule (id, kind, occurrence_at, due_at, recurrence_json, payload_json, status, attempts, last_fired_at, quarantined_until, created_at, updated_at) VALUES ('current', 'brief', 900, ?, NULL, '{}', 'armed', 1, 1000, NULL, 1, 1)", now + DAY);
      const kv = state.storage.kv;
      const moved = sweepScheduleRuns({ ...archiveFor(state, 'on', () => now), kv });
      const again = sweepScheduleRuns({ ...archiveFor(state, 'on', () => now + 1_000), kv });
      return { moved, again, hot: state.storage.sql.exec<{ id: string }>('SELECT id FROM schedule_runs ORDER BY id').toArray().map(row => row.id), rows: archived(state.storage.sql) };
    });
    expect(result.moved).toBe(1);
    expect(result.again).toBe(0);
    expect(result.rows.map(row => [row.id, row.kind, row.status])).toEqual([['schedule_runs:old-done:900:1', 'brief', 'ok']]);
    expect(result.hot).toEqual(['current:900:1', 'old-crashed:900:1', 'old-crashed:900:2', `recent:${1_000 + SCHEDULE_RUNS_ARCHIVE_AFTER_MS + 39 * DAY}:1`]);
  });

  it('does nothing while off, and writes nothing on a dry run', async () => {
    const result = await runInDurableObject(stub(), async (_instance, state) => {
      await new Scheduler(state.storage.sql, state.storage, deps(1_000)).schedule({ id: 'old', kind: 'brief', occurrenceAt: 900, dueAt: 900, payloadRefs: {} });
      await new Scheduler(state.storage.sql, state.storage, deps(1_000)).dispatchDue(ok);
      const now = 1_000 + SCHEDULE_RUNS_ARCHIVE_AFTER_MS + DAY, logged: Logged[] = [], kv = state.storage.kv;
      const off = sweepScheduleRuns({ ...archiveFor(state, 'off', () => now), kv });
      const dry = sweepScheduleRuns({ ...archiveFor(state, 'dry', () => now, logged), kv });
      return { off, dry, logged, hot: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM schedule_runs').one().n, tables: tables(state.storage.sql) };
    });
    expect(result).toMatchObject({ off: 0, dry: 0, hot: 1, logged: [{ hop: 'history_archive_dry', source: 'schedule_runs', count: 1 }] });
    expect(result.tables).not.toContain('history_archive');
  });
});

describe('search_history', () => {
  const seeded = (state: DurableObjectState) => {
    const { book } = fillRuns(state, 'on');
    const desk = approvalDesk(state.storage.sql, {
      surface: 'app', owner: 7_000_000_000_001, call: appCaller(), appLink: appApprovalLink, google: async () => null, newId: () => 'x', now: () => Date.now(), timezone: 'UTC', log: () => undefined,
      commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, () => Date.now()),
    });
    void desk;
    state.storage.sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at, decided_at) VALUES ('a1', 'calendar_change', 'done', 'Move dentist to Friday 10:00', '{}', 1000, 2000000)");
    state.storage.sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at, decided_at) VALUES ('a2', 'calendar_change', 'open', 'Move dentist to Monday', '{}', 3000, NULL)");
    return { book, search: (args: Record<string, unknown>) => searchHistory(state.storage.sql, { limit: 10, ...args }, id => ledgerSummary(state.storage.sql, id)) };
  };

  it('finds an archived run and a decided card, and leaves the open card to the desk', async () => {
    const result = await runInDurableObject(stub(), (_instance, state) => seeded(state).search({ query: 'dentist' }));
    expect(result.total).toBe(2);
    expect(result.entries.map(entry => [entry.ref, entry.kind, entry.type, entry.status, entry.summary, entry.archived])).toEqual([
      ['ledger:a1', 'approval', 'calendar_change', 'done', 'Move dentist to Friday 10:00', false],
      ['background_runs:bg:r0001', 'run', 'reminder', 'completed', 'reminder sent: dentist', true],
    ]);
    expect(result.next_cursor).toBeNull();
  });

  it('pages newest first with a cursor that neither repeats nor skips a row moved between pages', async () => {
    const result = await runInDurableObject(stub(), (_instance, state) => {
      const { book, search } = seeded(state);
      const seen: string[] = [];
      let page: SearchHistoryResult = search({ kinds: ['run'], limit: 20 });
      const total = page.total;
      seen.push(...page.entries.map(entry => entry.ref));
      // Two more starts move two more of the oldest settled runs into the archive between pages.
      book.start('brief', null); book.start('brief', null);
      const after = search({ kinds: ['run'], limit: 20, cursor: page.next_cursor! }).entries[0]!.ref;
      for (let pages = 0; page.next_cursor !== null && pages < 100; pages += 1) {
        page = search({ kinds: ['run'], limit: 20, cursor: page.next_cursor });
        seen.push(...page.entries.map(entry => entry.ref));
      }
      return { total, seen, after };
    });
    expect(result.total).toBe(MAX_RUN_ROWS + 1);
    // The two starts after the first page are newer than it, so the walk sees the original rows exactly once each.
    expect(result.seen).toHaveLength(MAX_RUN_ROWS + 1);
    expect(new Set(result.seen).size).toBe(MAX_RUN_ROWS + 1);
    expect(result.seen.at(-1)).toBe('background_runs:bg:r0001');
    expect(result.seen[20]).toBe(result.after);
  });

  it('narrows by window and by kind', async () => {
    const result = await runInDurableObject(stub(), (_instance, state) => {
      const { search } = seeded(state);
      return {
        window: search({ from: new Date(1_000_000).toISOString(), to: new Date(1_000_000 + 60_000).toISOString() }),
        approvals: search({ kinds: ['approval'] }),
      };
    });
    expect(result.window.entries.map(entry => entry.ref)).toEqual(['background_runs:bg:r0001']);
    expect(result.approvals.entries.map(entry => entry.ref)).toEqual(['ledger:a1']);
  });

  it('drops a whole entry that carries a topic still being forgotten, as it does for the owner\'s other stores', async () => {
    const result = await runInDurableObject(stub(), (_instance, state) => seeded(state).search({ query: 'dentist' }));
    const tally = { dropped: 0, redacted: 0 };
    const kept = forgetBarrier(['Friday']).structured({ ok: true, data: result }, resultOrigin('search_history'), tally);
    expect(resultOrigin('search_history')).toBe('owner_store');
    expect(kept?.data.entries.map(entry => entry.ref)).toEqual(['background_runs:bg:r0001']);
    expect(tally.dropped).toBe(1);
  });

  it('is offered on the owner\'s turns only, and the dispatcher refuses it on any other turn', async () => {
    const handler = searchHistoryHandler({ exec: () => { throw new Error('not reached'); } } as never, () => null);
    expect(handler.trigger_allowlist).toEqual(['user_message']);
    expect(OWNER_TURN_ONLY_TOOLS.has('search_history')).toBe(true);
    const context = { authenticatedUserId: 'owner', trigger: 'brief' as const, turnId: 'turn-1', session: buildSessionState({ trigger: 'brief', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1 }), hasApproval: () => false, sourceTaint: null, toolArgSourceTaint: null, sanitise };
    const result = await dispatchTool({ id: 'c1', name: 'search_history', args: {} }, context as never, { handlers: [handler as never] });
    expect(result).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
