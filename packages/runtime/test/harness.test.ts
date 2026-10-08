import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import { COST_LEDGER_DDL, costLedger } from '../src/llm/cost-ledger';
import { OWNER_REQUEST_HOP, parseHarnessCommand, traceBook } from '../src/channels/harness';

let sequence = 0;
const withSql = <T>(fn: (sql: SqlStorage) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`harness-${sequence++}`)), (_instance, state) => fn(state.storage.sql));

describe('owner harness', () => {
  it('parses fire, trace and e2e commands and ignores ordinary text', () => {
    expect(parseHarnessCommand('/fire brief')).toEqual({ kind: 'fire', target: 'card:brief' });
    expect(parseHarnessCommand('/fire fetch')).toEqual({ kind: 'fire', target: 'fetch' });
    expect(parseHarnessCommand('/fire nonsense')).toEqual({ kind: 'fire', target: null });
    expect(parseHarnessCommand('/trace tg-12')).toEqual({ kind: 'trace', filter: 'tg-12' });
    expect(parseHarnessCommand('/e2e')).toEqual({ kind: 'e2e' });
    expect(parseHarnessCommand('/usage')).toEqual({ kind: 'usage' });
    expect(parseHarnessCommand('/langfuse')).toEqual({ kind: 'langfuse' });
    expect(parseHarnessCommand('fire the brief please')).toBeNull();
    expect(parseHarnessCommand(undefined)).toBeNull();
  });

  it('shows the newest owner request, not a background job that also calls the model', async () => {
    await withSql((sql) => {
      const book = traceBook(sql, 50);
      const at = Date.parse('2026-09-23T04:30:00Z');
      book.record({ trace: 'tg-812', hop: OWNER_REQUEST_HOP, ms: 0, ok: true }, at);
      book.record({ trace: 'tg-812', hop: 'llm_reply', ms: 2140, ok: true }, at + 3_000);
      book.record({ trace: 'card:brief:2', hop: 'llm_reply', ms: 900, ok: true }, at + 60_000);
      book.record({ trace: 'card:brief:2', hop: 'day_card', ms: 10, ok: true }, at + 61_000);
      expect(book.lastRequest('UTC')).toEqual({ trace: 'tg-812', at: '2026-09-23 04:30', ok: true, partial: false, recorded_steps: 2,
        hops: [{ hop: OWNER_REQUEST_HOP, ok: true, ms: 0, note: '' }, { hop: 'llm_reply', ok: true, ms: 2140, note: '' }] });
    });
  });

  it('does not skip a newer owner request that failed before the model was called', async () => {
    await withSql((sql) => {
      const book = traceBook(sql, 50);
      const at = Date.parse('2026-09-23T04:30:00Z');
      book.record({ trace: 'tg-1', hop: OWNER_REQUEST_HOP, ms: 0, ok: true }, at);
      book.record({ trace: 'tg-1', hop: 'llm_reply', ms: 800, ok: true }, at);
      book.record({ trace: 'tg-2', hop: OWNER_REQUEST_HOP, ms: 0, ok: true }, at + 60_000);
      book.record({ trace: 'tg-2', hop: 'health_context', ms: 5, ok: false, error: 'read failed' }, at + 61_000);
      const last = book.lastRequest('UTC');
      expect(last?.trace).toBe('tg-2');
      expect(last?.ok).toBe(false);
      expect(last?.hops.map((hop) => hop.hop)).toEqual([OWNER_REQUEST_HOP, 'health_context']);
    });
  });

  it('keeps the whole-request outcome after the bounded trace pruned its steps', async () => {
    await withSql((sql) => {
      const book = traceBook(sql, 3);
      const at = Date.parse('2026-09-23T04:30:00Z');
      book.record({ trace: 'tg-1', hop: OWNER_REQUEST_HOP, ms: 0, ok: true }, at);
      book.record({ trace: 'tg-1', hop: 'memory', ms: 400, ok: false, error: 'bad json' }, at);
      book.record({ trace: 'tg-1', hop: 'llm_reply', ms: 900, ok: true }, at);
      for (let n = 0; n < 4; n += 1) book.record({ trace: `r-${n}`, hop: 'reminder', ms: 1, ok: true }, at + 1_000 * n);
      const last = book.lastRequest('UTC');
      expect(last).toMatchObject({ trace: 'tg-1', at: '2026-09-23 04:30', ok: false, partial: true, recorded_steps: 3, hops: [] });
    });
  });

  it('has no last request before any owner request was admitted', async () => {
    await withSql((sql) => {
      const book = traceBook(sql, 5);
      book.record({ trace: 'r-9', hop: 'reminder', ms: 10, ok: true }, 1);
      book.record({ trace: 'card:brief:2', hop: 'llm_reply', ms: 10, ok: true }, 2);
      expect(book.lastRequest('UTC')).toBeNull();
    });
  });

  it('keeps a bounded trace and marks E2E steps from their latest hop', async () => {
    await withSql((sql) => {
      const book = traceBook(sql, 3);
      const at = Date.parse('2026-09-23T04:30:00Z');
      book.record({ trace: 'tg-1', hop: 'llm_reply', ms: 900, ok: true }, at);
      book.record({ trace: 'tg-1', hop: 'memory', ms: 400, ok: false, error: 'bad json' }, at);
      book.record({ trace: 'tg-2', hop: 'llm_reply', ms: 800, ok: true }, at);
      book.record({ trace: 'card:brief:1', hop: 'day_card', ms: 1200, ok: true, detail: 'card:brief' }, at);
      expect(book.recent('Asia/Kolkata', null).split('\n')).toHaveLength(3);
      expect(book.recent('Asia/Kolkata', 'tg-2')).toBe('10:00 ok llm_reply 800ms tg-2');
      const checklist = book.checklist('Asia/Kolkata');
      expect(checklist).toContain('[x] Chat reply: ok at 2026-09-23 10:00');
      expect(checklist).toContain('[!] Memory update: failed at 2026-09-23 10:00 - bad json');
      expect(checklist).toContain('[ ] Constellation promotion: not seen');
    });
  });

  it('pages the trace rows by keyset cursor until it runs out', async () => {
    await withSql((sql) => {
      const book = traceBook(sql, 50);
      const base = Date.parse('2026-09-27T00:00:00Z');
      for (let i = 0; i < 5; i += 1) book.record({ trace: `t${i}`, hop: 'llm_reply', ms: 10, ok: true }, base + i * 1000);
      const first = book.rowsPage('UTC', 2);
      expect(first.rows.map((r) => r.trace)).toEqual(['t3', 't4']);
      expect(first.next).toBe(base + 3000);
      const second = book.rowsPage('UTC', 2, first.next ?? undefined);
      expect(second.rows.map((r) => r.trace)).toEqual(['t1', 't2']);
      const third = book.rowsPage('UTC', 2, second.next ?? undefined);
      expect(third.rows.map((r) => r.trace)).toEqual(['t0']);
      expect(third.next).toBeNull();
    });
  });

  it('stores the emitting owner on every span so an alarm or card is attributable', async () => {
    await withSql((sql) => {
      const book = traceBook(sql, 3);
      const at = Date.parse('2026-09-23T04:30:00Z');
      book.record({ trace: 'card:close:1', hop: 'day_card', ms: 800, ok: true, owner: 'do-old' }, at);
      const rows = sql.exec<{ owner: string | null }>('SELECT owner FROM trace_log').toArray();
      expect(rows).toEqual([{ owner: 'do-old' }]);
    });
  });

  it('rolls up model usage by billing type across the pre-usage schema migration', async () => {
    await withSql((sql) => {
      // The pre-usage table shape, as existing owner DOs hold it.
      sql.exec('CREATE TABLE trace_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, trace TEXT NOT NULL, hop TEXT NOT NULL, ok INTEGER NOT NULL, ms INTEGER NOT NULL, note TEXT)');
      sql.exec("INSERT INTO trace_log (at, trace, hop, ok, ms, note) VALUES (1, 'tg-0', 'llm_reply', 1, 100, NULL)");
      const book = traceBook(sql);
      const at = Date.parse('2026-09-24T04:30:00Z');
      book.record({ trace: 'tg-1', hop: 'llm_reply', ms: 900, ok: true, usage: { model: WALDO_CHAT_MODEL, input: 2000, output: 100, cached: 1500 }, shape: { system_bytes: 1024, request_bytes: 4096 } }, at);
      book.record({ trace: 'tg-1', hop: 'memory', ms: 400, ok: true }, at);
      const report = book.usage();
      expect(report).toContain(`${WALDO_CHAT_MODEL}: 1 calls, 2.0k in (75% cached), 100 out, $0.0001`);
      expect(report).toContain('avg request 4.0kB (system 1.0kB)');
      expect(book.recent('Asia/Kolkata', null).split('\n')).toHaveLength(3);
    });
  });
});

it('parses /heldrows with an optional table', () => {
  expect(parseHarnessCommand('/heldrows update_cards')).toEqual({ kind: 'heldrows', table: 'update_cards', from: null });
  expect(parseHarnessCommand('/heldrows')).toEqual({ kind: 'heldrows', table: null, from: null });
});

it('parses the /heldrows continue rowid as given and rejects a garbage one', () => {
  expect(parseHarnessCommand('/heldrows day_plan 250')).toEqual({ kind: 'heldrows', table: 'day_plan', from: 250 });
  expect(parseHarnessCommand('/heldrows day_plan -5')).toEqual({ kind: 'heldrows', table: 'day_plan', from: -5 });
  expect(parseHarnessCommand('/heldrows day_plan abc')).toEqual({ kind: 'heldrows', table: 'day_plan', from: 'invalid' });
  expect(parseHarnessCommand('/heldrows day_plan 99999999999999999999')).toEqual({ kind: 'heldrows', table: 'day_plan', from: 'invalid' });
});

describe('cost ledger', () => {
  const usage = { model: WALDO_CHAT_MODEL, input: 12_000, output: 800, cached: 4_000 };
  const at = Date.parse('2026-10-08T04:30:00Z');

  it('ledger sum equals the trace_log usd for a turn and separates background by kind', async () => {
    await withSql((sql) => {
      for (const ddl of COST_LEDGER_DDL) sql.exec(ddl);
      const ledger = costLedger(sql);
      const book = traceBook(sql, 50, ledger);
      book.record({ trace: 'tg-1', hop: OWNER_REQUEST_HOP, ms: 0, ok: true }, at);
      book.record({ trace: 'tg-1', hop: 'llm_reply', ms: 900, ok: true, usage }, at + 1_000);
      book.record({ trace: 'tg-1', hop: 'memory', ms: 400, ok: true, usage }, at + 2_000);
      book.record({ trace: 'hb-1', hop: 'llm_reply', ms: 300, ok: true, usage, cost_kind: 'heartbeat', responsibility_id: 'resp-1' }, at + 3_000);
      book.record({ trace: 'nightly-1', hop: 'nightly_memory', ms: 300, ok: true, usage }, at + 4_000);
      const traceUsd = (trace: string) => sql.exec<{ usd: number }>('SELECT SUM(usd) AS usd FROM trace_log WHERE trace = ?', trace).toArray()[0]!.usd;
      const ledgerUsd = (kind: string) => sql.exec<{ usd: number }>('SELECT SUM(usd) AS usd FROM cost_ledger WHERE kind = ?', kind).toArray()[0]!.usd;
      expect(ledgerUsd('turn')).toBeCloseTo(traceUsd('tg-1'), 12);
      expect(ledgerUsd('heartbeat')).toBeCloseTo(traceUsd('hb-1'), 12);
      expect(ledgerUsd('background')).toBeCloseTo(traceUsd('nightly-1'), 12);
      expect(ledger.byResponsibility(at)).toHaveLength(1);
      expect(ledger.monthByKind(at).map((row) => row.kind).sort()).toEqual(['background', 'heartbeat', 'turn']);
    });
  });

  it('does not ledger a call with no priced usage', async () => {
    await withSql((sql) => {
      for (const ddl of COST_LEDGER_DDL) sql.exec(ddl);
      const ledger = costLedger(sql);
      const book = traceBook(sql, 50, ledger);
      book.record({ trace: 'tg-2', hop: 'llm_reply', ms: 1, ok: true, usage: { ...usage, model: 'unpriced-model' } }, at);
      expect(ledger.monthTotal(at)).toBe(0);
    });
  });
});
