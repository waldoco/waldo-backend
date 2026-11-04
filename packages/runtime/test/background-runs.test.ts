import { describe, expect, it } from 'vitest';
import { MAX_RUN_ROWS, runBook, type BackgroundRun } from '../src/channels/background-runs';

const fakeSql = () => {
  const rows = new Map<string, BackgroundRun>();
  return {
    rows,
    exec(query: string, ...args: unknown[]) {
      if (query.startsWith('CREATE TABLE')) return { toArray: () => [] as BackgroundRun[], rowsWritten: 0 };
      if (query.startsWith('INSERT INTO background_runs')) {
        // Arity guard: the fake must fail the way D1 does when bindings and placeholders drift
        // apart - the 2026-09-27 staging outage was exactly this drift passing CI.
        const placeholders = (query.match(/\?/g) ?? []).length;
        if (placeholders !== args.length) throw new Error(`placeholder/arg drift: ${placeholders} placeholders, ${args.length} args`);
        const [id, kind, status, parent_id, started_at] = args as [string, BackgroundRun['kind'], BackgroundRun['status'], string | null, number];
        rows.set(id, { id, kind, status, summary: null, parent_id, started_at, ended_at: null });
        return { toArray: () => [] as BackgroundRun[], rowsWritten: 1 };
      }
      if (query.startsWith('UPDATE background_runs')) {
        const [status, summary, ended_at, id] = args as [BackgroundRun['status'], string, number, string];
        const row = rows.get(id);
        if (!row) return { toArray: () => [] as BackgroundRun[], rowsWritten: 0 };
        rows.set(id, { ...row, status, summary, ended_at });
        return { toArray: () => [] as BackgroundRun[], rowsWritten: 1 };
      }
      if (query.startsWith('DELETE FROM background_runs')) {
        const keep = [...rows.values()].sort((a, b) => b.started_at - a.started_at).slice(0, args[0] as number);
        const keepIds = new Set(keep.map((r) => r.id));
        let written = 0;
        for (const id of [...rows.keys()]) if (!keepIds.has(id)) { rows.delete(id); written += 1; }
        return { toArray: () => [] as BackgroundRun[], rowsWritten: written };
      }
      if (query.startsWith('SELECT * FROM background_runs WHERE id')) {
        const row = rows.get(args[0] as string);
        return { toArray: () => (row ? [row] : []), rowsWritten: 0 };
      }
      if (query.startsWith('SELECT * FROM background_runs WHERE (?1 IS NULL OR started_at < ?1)')) {
        const [before, take] = args as [number | null, number];
        const all = [...rows.values()].filter((r) => before === null || r.started_at < before).sort((a, b) => b.started_at - a.started_at).slice(0, take);
        return { toArray: () => all, rowsWritten: 0 };
      }
      if (query.startsWith('SELECT * FROM background_runs ORDER BY')) {
        const byActivity = query.includes('COALESCE(ended_at, started_at)');
        return { toArray: () => [...rows.values()].sort((a, b) => byActivity
          ? (b.ended_at ?? b.started_at) - (a.ended_at ?? a.started_at) || b.started_at - a.started_at
          : b.started_at - a.started_at).slice(0, (args[0] as number | undefined) ?? 1), rowsWritten: 0 };
      }
      throw new Error(`unexpected query: ${query}`);
    },
  };
};

// OwnerClock.now() returns a Date; a strictly increasing clock keeps row ordering deterministic.
let tick = 0;
const seqClock = { timezone: 'Asia/Kolkata', now: () => new Date(new Date('2026-09-27T01:30:00Z').getTime() + ++tick * 1000) };

describe('background run book (A5b)', () => {
  it('start records a running row with the parent trace hop; finish lands status, capped summary and end time', () => {
    const book = runBook(fakeSql() as never, seqClock, () => 'x1');
    const run = book.start('delegate_task', 'turn:parent-9');
    expect(run).toMatchObject({ id: 'bg:x1', kind: 'delegate_task', status: 'running', parent_id: 'turn:parent-9', ended_at: null });
    expect(book.finish(run.id, 'completed', 'done: ' + 'y'.repeat(300))).toBe(true);
    const row = book.byId(run.id)!;
    expect(row.status).toBe('completed');
    expect(row.summary).toHaveLength(200);
    expect(row.ended_at).not.toBeNull();
  });

  it('finish on an unknown id reports false and writes nothing', () => {
    const book = runBook(fakeSql() as never, seqClock, () => 'x2');
    expect(book.finish('bg:ghost', 'failed', 'nope')).toBe(false);
    expect(book.byId('bg:ghost')).toBeNull();
  });

  it('list returns newest first within the limit', () => {
    let n = 0;
    const book = runBook(fakeSql() as never, seqClock, () => `id${++n}`);
    book.start('reminder', null);
    book.start('loop', 'turn:a');
    book.start('standing_order', null);
    const listed = book.list(2);
    expect(listed).toHaveLength(2);
    expect(listed[0]!.kind).toBe('standing_order');
    expect(listed[1]!.kind).toBe('loop');
    expect(listed[1]!.parent_id).toBe('turn:a');
  });

  it('latest activity uses finish time over a newer start', () => {
    const sql = fakeSql();
    const book = runBook(sql as never, seqClock, () => 'x');
    sql.rows.set('older', { id: 'older', kind: 'loop', status: 'completed', summary: 'finished', parent_id: null, started_at: 10, ended_at: 40 });
    sql.rows.set('newer', { id: 'newer', kind: 'reminder', status: 'running', summary: null, parent_id: null, started_at: 30, ended_at: null });
    expect(book.latestActivity()?.id).toBe('older');
  });

  it('trims the oldest rows past the cap so the table never grows without bound', () => {
    let n = 0;
    const sql = fakeSql();
    const book = runBook(sql as never, seqClock, () => `cap${++n}`);
    for (let i = 0; i < MAX_RUN_ROWS + 5; i += 1) book.start('heartbeat', null);
    expect(sql.rows.size).toBe(MAX_RUN_ROWS);
    expect(book.list(MAX_RUN_ROWS + 10)).toHaveLength(MAX_RUN_ROWS);
    // the newest rows survive the trim
    expect(book.byId(`bg:cap${MAX_RUN_ROWS + 5}`)).not.toBeNull();
  });

  it('pages the run list by keyset cursor until it runs out', () => {
    const sql = fakeSql();
    const book = runBook(sql as never, { now: () => new Date(2000) } as never, () => `run-${sql.rows.size}`);
    const base = Date.parse('2026-09-27T00:00:00Z');
    for (let i = 0; i < 5; i += 1) {
      sql.rows.set(`r${i}`, { id: `r${i}`, kind: 'loop', status: 'completed', summary: null, parent_id: null, started_at: base + i, ended_at: base + i + 1 });
    }
    const first = book.listPage(2);
    expect(first.rows.map((r) => r.id)).toEqual(['r4', 'r3']);
    expect(first.next).toBe(base + 3);
    const second = book.listPage(2, first.next ?? undefined);
    expect(second.rows.map((r) => r.id)).toEqual(['r2', 'r1']);
    const third = book.listPage(2, second.next ?? undefined);
    expect(third.rows.map((r) => r.id)).toEqual(['r0']);
    expect(third.next).toBeNull();
  });
});
