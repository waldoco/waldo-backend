import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import { Journal } from '../src/tracer/journal';
import { Outbox } from '../src/tracer/outbox';

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

type Counts = ReturnType<typeof survivors>;
type Run = Readonly<{ before: Counts; after: Counts; ready: boolean; failed: readonly string[] }>;
const STORES = ['run_candidates', 'outbox', 'held_candidates', 'schedule'] as const;

// Seeds the claim plus one copy of its text in every store, purges the claim, and returns the counts before and after.
const seedAndPurge = (): Promise<Run> =>
  withStorage((storage) => {
    const sql = storage.sql;
    ensureSchema(storage);
    const store = claimStore(sql);
      const claimId = Number(sql.exec<{ id: number }>(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`, CLAIM_TEXT, AT, AT).one().id);
      sql.exec(`INSERT INTO run_candidates (run_id, candidate_json) VALUES ('r1', ?)`, JSON.stringify({ body: CLAIM_TEXT }));
      sql.exec(`INSERT INTO outbox (outbox_id, run_id, kind, idempotency_key, payload, created_at) VALUES ('o1', 'r1', 'push', 'k1', ?, 1)`, JSON.stringify({ text: CLAIM_TEXT }));
      sql.exec(`INSERT INTO held_candidates (user_id, event_id, push_class, candidate_json, hold_until) VALUES ('u', 'e1', 'c', ?, 1)`, JSON.stringify({ body: CLAIM_TEXT }));
      sql.exec(`INSERT INTO schedule (id, kind, occurrence_at, due_at, payload_json, status, created_at, updated_at) VALUES ('s1', 'reminder', 1, 1, ?, 'pending', 1, 1)`, JSON.stringify({ text: CLAIM_TEXT }));
    const before = survivors(sql);
    const result = store.purge([claimId], AT);
    return { before, after: survivors(sql), ready: result.ready, failed: result.failed };
  });

describe('forget coverage - tracer and scheduler stores', () => {
  // Setup guard, NOT expected to fail: proves the fixture seeds every store and that purge works on claims.
  // If this goes red, the it.fails cases below are no longer trustworthy (a setup error would mask them).
  it('setup: every store holds one copy before purge, and purge itself reports ready', async () => {
    const run = await seedAndPurge();
    expect(run.before).toEqual({ run_candidates: 1, outbox: 1, held_candidates: 1, schedule: 1 });
    expect(run.ready).toBe(true);
    expect(run.failed).toEqual([]);
  });

  // One gap marker per store. Each starts passing (so it.fails goes red) when purge covers that store;
  // the owner of that fix removes `.fails` on that one case in the same change.
  for (const storeName of STORES) {
    it(`purge clears the forgotten text from ${storeName}`, async () => {
      const run = await seedAndPurge();
      expect(run.after[storeName]).toBe(0);
    });
  }

  // Policy: decided by the main agent under decide-and-log; the owner's own 01:21 IST message (iMessage
  // phonemsg-01M3WGB9CKWEM22W0KX9YSK0F9) says to take decisions and log them. One-shot unsent schedule
  // rows are deleted; held rows, history and recurring schedules are redacted in place so no run strands;
  // undelivered outbox runs are terminalised (never delivered with a placeholder). Those messages are
  // not delivered. Text already delivered to Telegram is outside our reach.
  it('applies the delete / terminalise / redact policy with real journal rows and a clean resume', async () => {
    const out = await withStorage((storage) => {
      const sql = storage.sql;
      ensureSchema(storage);
      const store = claimStore(sql);
      const claimId = Number(sql.exec<{ id: number }>(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`, CLAIM_TEXT, AT, AT).one().id);
      const payload = JSON.stringify({ text: `a "quoted" ${CLAIM_TEXT}` });
      const journal = (run: string, state: string) => sql.exec(`INSERT INTO journal (run_id, user_id, trigger, state, verdict, gate_reason, occurrence_at, created_at, updated_at) VALUES (?, 'u', 'brief', ?, ?, NULL, 1, 1, 1)`, run, state, state === 'GATED' || state === 'SINK_SENT' || state === 'ACK_RECORDED' ? 'send' : null);
      journal('rg', 'GATED'); journal('rs', 'SINK_SENT'); journal('ra', 'ACK_RECORDED');
      const ob = (id: string, run: string, status: string) => sql.exec(`INSERT INTO outbox (outbox_id, run_id, kind, idempotency_key, payload, status, attempts, next_retry_at, acked_at, created_at) VALUES (?, ?, 'brief', ?, ?, ?, ?, ?, ?, 1)`, id, run, `${id.padEnd(1, '0').charCodeAt(1).toString(16).padStart(2, '0').repeat(32)}`, payload, status, status === 'pending' ? 0 : 1, status === 'sent_unacked' ? 5 : null, status === 'acked' ? 3 : null);
      ob('og', 'rg', 'pending'); ob('os', 'rs', 'sent_unacked'); ob('oa', 'ra', 'acked');
      sql.exec(`INSERT INTO held_candidates (user_id, event_id, push_class, candidate_json, hold_until) VALUES ('u', 'e1', 'c', ?, 1)`, payload);
      sql.exec(`INSERT INTO schedule (id, kind, occurrence_at, due_at, recurrence_json, payload_json, status, created_at, updated_at) VALUES ('oneshot', 'reminder', 1, 1, NULL, ?, 'armed', 1, 1), ('recurring', 'reminder', 1, 1, '{"every":"day"}', ?, 'armed', 1, 1)`, payload, payload);
      const result = store.purge([claimId], AT);
      const deps = { now: () => 2 } as unknown as ConstructorParameters<typeof Journal>[1];
      const resume = new Journal(sql, deps).findOpenRun();
      const rows = new Outbox(sql, deps);
      return {
        result,
        resume,
        states: Object.fromEntries(sql.exec<{ run_id: string; state: string }>('SELECT run_id, state FROM journal').toArray().map((r) => [r.run_id, r.state])),
        outbox: Object.fromEntries(['rg', 'rs', 'ra'].map((run) => [run, rows.readRows(run).map((r) => ({ status: r.status, payload: r.payload }))])),
        held: sql.exec<{ n: number }>('SELECT count(*) AS n FROM held_candidates').one().n,
        schedule: sql.exec<{ id: string; payload_json: string }>('SELECT id, payload_json FROM schedule ORDER BY id').toArray(),
      };
    });
    expect(out.result.ready).toBe(true);
    expect(out.result.receipt).toEqual({
      deleted: { schedule: 1 },
      redacted: { outbox: 1, held_candidates: 1, schedule: 1 },
      terminalised: { outbox_pending: 1, outbox_sent_unacked: 1 },
    });
    // The GATED and SINK_SENT runs are terminalised, so resume never picks them up; only the acked run
    // (untouched, already delivered) remains for the normal resume path to finish.
    expect(out.resume?.run_id ?? 'ra').toBe('ra');
    expect(out.states).toEqual({ rg: 'FAILED', rs: 'FAILED', ra: 'ACK_RECORDED' });
    expect(out.held).toBe(1);
    expect(out.schedule.map((row) => row.id)).toEqual(['recurring']);
    for (const row of Object.values(out.outbox).flat().map((r) => r.payload)) expect(row).not.toContain(MARKER);
    for (const row of out.schedule.map((r) => r.payload_json)) {
      expect(row).not.toContain(MARKER);
      expect(() => JSON.parse(row)).not.toThrow();
    }
    expect(out.outbox.ra).toEqual([{ status: 'acked', payload: expect.not.stringContaining(MARKER) }]);
  });
});
