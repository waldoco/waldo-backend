import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Scheduler } from '../src/scheduler/multiplexer';
import type { Deps } from '../src/seams/deps';

let seq = 0;
const freshStub = (): Parameters<typeof runInDurableObject>[0] => {
  seq += 1;
  const ns = (env as never as { TRACER_DO: { idFromName(n: string): unknown; get(i: unknown): never } }).TRACER_DO;
  return ns.get(ns.idFromName(`unreadable-row-${seq}`));
};
const MINUTE = 60_000;

// A row as an older Worker meets it after a rollback: written by a newer Worker, with a kind this build does not know.
const plantUnknownKind = (sql: SqlStorage, id: string, dueAt: number) => sql.exec(
  `INSERT INTO schedule (id, kind, occurrence_at, due_at, recurrence_json, payload_json, status, attempts, last_fired_at, quarantined_until, created_at, updated_at)
   VALUES (?, 'kind_from_a_newer_worker', ?, ?, NULL, ?, 'armed', 0, NULL, NULL, ?, ?)`, id, dueAt, dueAt, JSON.stringify({ id }), dueAt, dueAt);
const rowsLike = (sql: SqlStorage, prefix: string) => sql.exec("SELECT * FROM schedule WHERE id >= ? AND id < ? ORDER BY id", prefix, `${prefix}~`).toArray();
const invalidLogs = (log: { mock: { calls: unknown[][] } }) => log.mock.calls.flatMap(([line]) => {
  try { const parsed = JSON.parse(String(line)); return parsed.hop === 'schedule_row_invalid' ? [parsed] : []; } catch { return []; }
});
const at = (now: number): Deps => ({ now: () => now, newRunId: () => crypto.randomUUID(), newOutboxId: () => crypto.randomUUID(), sha256Hex: async () => '0'.repeat(64) });

afterEach(() => vi.restoreAllMocks());

describe('a schedule row this Worker cannot read', () => {
  it('does not stop the owner\'s other due work, is logged once per pass by count only, and is left exactly as it was', async () => {
    for (const bad of [1, 8]) {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const now = Date.now();
      const fired = await runInDurableObject(freshStub(), async (_instance, state) => {
        const scheduler = new Scheduler(state.storage.sql, state.storage, at(now));
        await scheduler.schedule({ id: 'valid', kind: 'brief', occurrenceAt: now - MINUTE, dueAt: now - MINUTE, payloadRefs: { id: 'valid' }, recurrence: null });
        // As many unreadable rows as one alarm may dispatch, all due earlier than the valid one.
        for (let i = 0; i < bad; i += 1) plantUnknownKind(state.storage.sql, `unreadable-${i}`, now - 2 * MINUTE);
        const before = rowsLike(state.storage.sql, 'unreadable-');
        const ran: string[] = [];
        await scheduler.dispatchDue({ brief: async entry => { ran.push(entry.id); } });
        expect(rowsLike(state.storage.sql, 'unreadable-')).toEqual(before);
        expect(before.every(row => row.status === 'armed')).toBe(true);
        return ran;
      });
      expect([bad, fired]).toEqual([bad, ['valid']]);
      expect([bad, invalidLogs(log)]).toEqual([bad, [{ hop: 'schedule_row_invalid', ok: false, count: bad }]]);
      expect(JSON.stringify(log.mock.calls)).not.toContain('unreadable-');
      log.mockRestore();
    }
  });

  it('leaves the alarm on the next readable row, and never wakes for the unreadable one', async () => {
    const now = Date.now();
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const scheduler = new Scheduler(state.storage.sql, state.storage, at(now));
      plantUnknownKind(state.storage.sql, 'unreadable-soon', now + 10 * MINUTE);
      await scheduler.schedule({ id: 'valid', kind: 'brief', occurrenceAt: now + 60 * MINUTE, dueAt: now + 60 * MINUTE, payloadRefs: { id: 'valid' }, recurrence: null });
      await scheduler.rearm();
      expect(await state.storage.getAlarm()).toBe(now + 60 * MINUTE);
      // With only an unreadable row due, nothing is due and no alarm keeps waking for it.
      await scheduler.cancel('valid');
      plantUnknownKind(state.storage.sql, 'unreadable-due', now - MINUTE);
      expect(scheduler.hasDue()).toBe(false);
      await scheduler.rearm();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(rowsLike(state.storage.sql, 'unreadable-').map(row => row.status)).toEqual(['armed', 'armed']);
    });
  });
});
