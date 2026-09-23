import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
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
    expect(parseHarnessCommand('fire the brief please')).toBeNull();
    expect(parseHarnessCommand(undefined)).toBeNull();
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
});
