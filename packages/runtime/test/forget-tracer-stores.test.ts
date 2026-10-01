import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// KNOWN GAP (docs/planning/FORGET_COVERAGE_AUDIT_2026-10-02.md): claimStore.purge verifies and
// redacts claims, episodes, backups, spots, core files, cards, day plan and constellation nodes.
// It does not look at the tracer/scheduler tables below, which store free text (candidate_json,
// outbox payload, schedule payload_json). `it.fails` records the gap without weakening anything:
// when purge covers these stores this test starts passing, `it.fails` turns red, and the owner of
// the fix removes the `.fails` marker in the same change.
const MARKER = 'zephyr-quinoa-anchor';
const CLAIM_TEXT = `Owner uses the ${MARKER} code word`;
const AT = '2026-10-02T00:00:00Z';
let seq = 0;

const withStorage = <T>(fn: (storage: DurableObjectStorage) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`forget-tracer-${seq++}`)), (_i, state) => fn(state.storage));

const survivors = (sql: SqlStorage) => {
  const n = (table: string, column: string) => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${column} LIKE ?`, `%${MARKER}%`).one().n;
  return {
    run_candidates: n('run_candidates', 'candidate_json'),
    outbox: n('outbox', 'payload'),
    held_candidates: n('held_candidates', 'candidate_json'),
    schedule: n('schedule', 'payload_json'),
  };
};

describe('forget coverage - tracer and scheduler stores', () => {
  it.fails('forgetting a claim also clears the same text from run candidates, outbox, held candidates and schedule payloads', async () => {
    await withStorage((storage) => {
      const sql = storage.sql;
      ensureSchema(storage);
      const store = claimStore(sql);
      const claimId = Number(sql.exec<{ id: number }>(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`, CLAIM_TEXT, AT, AT).one().id);
      sql.exec(`INSERT INTO run_candidates (run_id, candidate_json) VALUES ('r1', ?)`, JSON.stringify({ body: CLAIM_TEXT }));
      sql.exec(`INSERT INTO outbox (outbox_id, run_id, kind, idempotency_key, payload, created_at) VALUES ('o1', 'r1', 'push', 'k1', ?, 1)`, JSON.stringify({ text: CLAIM_TEXT }));
      sql.exec(`INSERT INTO held_candidates (user_id, event_id, push_class, candidate_json, hold_until) VALUES ('u', 'e1', 'c', ?, 1)`, JSON.stringify({ body: CLAIM_TEXT }));
      sql.exec(`INSERT INTO schedule (id, kind, occurrence_at, due_at, payload_json, status, created_at, updated_at) VALUES ('s1', 'reminder', 1, 1, ?, 'pending', 1, 1)`, JSON.stringify({ text: CLAIM_TEXT }));
      expect(Object.values(survivors(sql)).every((count) => count === 1)).toBe(true);
      store.purge([claimId], AT);
      expect(survivors(sql)).toEqual({ run_candidates: 0, outbox: 0, held_candidates: 0, schedule: 0 });
    });
  });
});
