import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import { parseHarnessCommand, traceBook } from '../src/channels/harness';

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

  it('reads the last request from one trace, not the newest row per step', async () => {
    await withSql((sql) => {
      const book = traceBook(sql, 50);
      const at = Date.parse('2026-09-23T04:30:00Z');
      book.record({ trace: 'tg-1', hop: 'llm_reply', ms: 900, ok: true }, at);
      book.record({ trace: 'tg-1', hop: 'memory', ms: 400, ok: true }, at);
      book.record({ trace: 'tg-2', hop: 'llm_reply', ms: 800, ok: false, error: 'model timeout' }, at + 60_000);
      book.record({ trace: 'r-9', hop: 'reminder', ms: 10, ok: true }, at + 120_000);
      const last = book.lastRequest('UTC');
      expect(last).toEqual({ trace: 'tg-2', at: '2026-09-23 04:31', ok: false, hops: [{ hop: 'llm_reply', ok: false, ms: 800, note: 'model timeout' }] });
      expect(traceBook(sql, 50).steps('UTC').find((step) => step.step === 'Memory update')?.state).toBe('ok');
    });
  });

  it('has no last request before any chat reply was attempted', async () => {
    await withSql((sql) => {
      const book = traceBook(sql, 5);
      book.record({ trace: 'r-9', hop: 'reminder', ms: 10, ok: true }, 1);
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
