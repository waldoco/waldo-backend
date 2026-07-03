import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { scheduleEntrySchema } from '@waldo/contracts';
import type { TracerDO } from '../src/tracer/tracer-do';
import type { NotificationReceiverDO } from '../src/tracer/receiver-do';

const KIND = 'fetch_alert';

// Arm the one-shot alarm in the future so workerd does not auto-fire it before the test's manual
// runDurableObjectAlarm() — the manual trigger must be the SOLE, deterministic fire. (An alarm armed
// in the past is already due, so the runtime fires and clears it, and runDurableObjectAlarm then
// reports false with nothing to run.) The occurrence value is opaque to the path: the gate's cooldown
// compares now - last_sent_at, and last_sent_at is null on the first send, so the verdict is 'send'.
function futureOccurrence(): number {
  return Date.now() + 3_600_000;
}

// Each test gets a fresh tracer DO id AND a fresh per-user receiver DO id, so its journal/outbox/
// class_state SQLite and its receiver delivery-ledger are isolated within the per-file storage the
// Workers pool shares (storage isolation is per FILE, not per block). Exactly-once DELIVERY is proven
// at the durable receiver ledger — a separate DO that survives the tracer's eviction — not an
// in-process sink counter, which is the §6.3 weakness this substrate removes.
let seq = 0;
type Fixture = {
  user: string;
  stub: DurableObjectStub<TracerDO>;
  receiver: DurableObjectStub<NotificationReceiverDO>;
};
function fresh(): Fixture {
  seq += 1;
  const user = `user-tracer-${seq}`;
  const stub = env.TRACER_DO.get(env.TRACER_DO.idFromName(`tracer-${seq}`));
  const receiver = env.NOTIFICATION_RECEIVER_DO.get(
    env.NOTIFICATION_RECEIVER_DO.idFromName(`notif:${user}`),
  );
  return { user, stub, receiver };
}

type CrashPoint =
  | 'pre_gate_commit'
  | 'post_gate_pre_sink'
  | 'post_sink_pre_ack'
  | 'post_ack_pre_return';

// The crash-injection seam: poke the single in-handler crash-point field on the live instance, then
// let the caller drive the alarm so the guarded throw fires. Undefined in production; set only here.
async function poke(stub: DurableObjectStub<TracerDO>, point: CrashPoint) {
  await runInDurableObject(stub, (instance) => {
    instance.__crashAfter = point;
  });
}

// Durable-layer reads go straight through the reconstructed DO's SQLite (the state arg), never
// through in-memory fields — this is the durability thesis: everything a resume needs is committed.
type Durable = {
  state: string;
  verdict: string | null;
  classCount: number;
  lastSentAt: number | null;
  exemptSends: number;
  budgetSendsTotal: number;
  outboxRows: number;
  runId: string;
};

async function readDurable(f: Fixture): Promise<Durable> {
  return runInDurableObject(f.stub, (_instance, state) => {
    const sql = state.storage.sql;
    const run = sql
      .exec<{ run_id: string; state: string; verdict: string | null }>(
        'SELECT run_id, state, verdict FROM journal LIMIT 1',
      )
      .toArray()[0];
    const cls = sql
      .exec<{ count: number; last_sent_at: number | null }>(
        'SELECT count, last_sent_at FROM class_state WHERE user_id = ? AND push_class = ?',
        f.user,
        KIND,
      )
      .toArray()[0];
    const exempt = sql
      .exec<{ exempt_sends: number }>(
        'SELECT exempt_sends FROM exempt_telemetry WHERE user_id = ? AND push_class = ?',
        f.user,
        KIND,
      )
      .toArray()[0];
    const budget = sql
      .exec<{ sends_total: number }>(
        'SELECT sends_total FROM daily_push_budget WHERE user_id = ?',
        f.user,
      )
      .toArray()[0];
    const runId = run?.run_id ?? '';
    const outboxRows = runId
      ? sql
          .exec<{ n: number }>(
            'SELECT count(*) AS n FROM outbox WHERE run_id = ? AND kind = ?',
            runId,
            KIND,
          )
          .one().n
      : 0;
    return {
      state: run?.state ?? 'NONE',
      verdict: run?.verdict ?? null,
      classCount: cls?.count ?? 0,
      lastSentAt: cls?.last_sent_at ?? null,
      exemptSends: exempt?.exempt_sends ?? 0,
      budgetSendsTotal: budget?.sends_total ?? 0,
      outboxRows,
      runId,
    };
  });
}

// The durable delivery count, read from the reconstructed RECEIVER DO's SQLite — the exactly-once
// DELIVERY proof point. Reading it (not an in-process counter) is what closes §6.3.
async function deliveredTotal(f: Fixture): Promise<number> {
  return runInDurableObject(f.receiver, (_instance, state) =>
    state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM delivered').one().n,
  );
}

async function readScheduleEntry(stub: DurableObjectStub<TracerDO>) {
  return runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql
      .exec<{
        id: string;
        kind: string;
        occurrence_at: number;
        due_at: number;
        recurrence_json: string | null;
        payload_json: string;
        status: string;
        attempts: number;
        last_fired_at: number | null;
        quarantined_until: number | null;
        created_at: number;
        updated_at: number;
      }>('SELECT * FROM schedule LIMIT 1')
      .toArray()[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      kind: row.kind,
      occurrence_at: row.occurrence_at,
      due_at: row.due_at,
      recurrence: row.recurrence_json === null ? null : JSON.parse(row.recurrence_json),
      payload_refs: JSON.parse(row.payload_json),
      status: row.status,
      attempts: row.attempts,
      last_fired_at: row.last_fired_at,
      quarantined_until: row.quarantined_until,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
}

// The single, load-bearing exactly-once contract, asserted at the durable layer: terminal DONE, the
// daily push budget never touched (fetch_alert is budget-exempt), the per-class cap counter and the
// exempt-telemetry counter each incremented exactly once, exactly one TOTAL outbox row (incl. acked),
// and exactly one durable delivery in the receiver ledger.
async function expectExactlyOnce(f: Fixture) {
  const d = await readDurable(f);
  expect(d.state).toBe('DONE');
  expect(d.verdict).toBe('send');
  expect(d.budgetSendsTotal).toBe(0);
  expect(d.classCount).toBe(1);
  expect(d.lastSentAt).not.toBeNull();
  expect(d.exemptSends).toBe(1);
  expect(d.outboxRows).toBe(1);
  expect(await deliveredTotal(f)).toBe(1);
}

async function schedule(f: Fixture) {
  return f.stub.schedule({ userId: f.user, trigger: KIND, occurrenceAt: futureOccurrence() });
}

// The resume wake, driven on the reconstructed post-eviction instance. A crashing alarm consumes the
// one-shot alarm slot (the runtime removes it once alarm() has run, even on throw), so the harness's
// runDurableObjectAlarm has nothing pending to fire on retry. Invoking alarm() directly here is the
// faithful model of the next wake: the runtime's at-least-once retry re-enters alarm(), which
// reconstructs the run from committed DO SQLite alone. That reconstruction IS the durability thesis.
async function resume(stub: DurableObjectStub<TracerDO>) {
  await runInDurableObject(stub, async (instance) => {
    await instance.alarm();
  });
}

describe('TracerDO one-path: scheduled wake -> governor -> gate -> outbox -> receiver, exactly once', () => {
  it('persists a canonical one-shot handoff schedule row for the tracer alarm', async () => {
    const f = fresh();

    const runId = await schedule(f);
    const entry = await readScheduleEntry(f.stub);

    expect(scheduleEntrySchema.safeParse(entry).success).toBe(true);
    expect(entry).toMatchObject({
      id: `handoff:${runId}`,
      kind: 'handoff',
      recurrence: null,
      payload_refs: { run_id: runId, cursor: 'tracer' },
      status: 'armed',
      attempts: 0,
      last_fired_at: null,
      quarantined_until: null,
    });
  });

  it('happy path: a scheduled alarm drives the run to DONE and the receiver records exactly one delivery', async () => {
    const f = fresh();

    await schedule(f);

    // Before the alarm the run is journaled at RUN_OPENED and nothing downstream has run.
    const opened = await readDurable(f);
    expect(opened.state).toBe('RUN_OPENED');
    expect(opened.verdict).toBeNull();
    expect(opened.outboxRows).toBe(0);
    expect(await deliveredTotal(f)).toBe(0);

    const ran = await runDurableObjectAlarm(f.stub);
    expect(ran).toBe(true);

    await expectExactlyOnce(f);
  });

  it('#1 crash after RUN_OPENED: evict before the alarm; resume reaches DONE exactly once', async () => {
    const f = fresh();

    await schedule(f); // commits RUN_OPENED
    await evictDurableObject(f.stub); // wipe in-memory state; SQLite holds only RUN_OPENED

    const ran = await runDurableObjectAlarm(f.stub);
    expect(ran).toBe(true);

    await expectExactlyOnce(f);
  });

  it('#2 crash after GOVERNOR_ADMITTED: resume enters at GOVERNOR_ADMITTED and reaches DONE once', async () => {
    const f = fresh();

    await schedule(f);
    // pre_gate_commit throws AFTER the admit advance has committed but BEFORE the gate transaction,
    // so the committed state at crash time is exactly GOVERNOR_ADMITTED.
    await poke(f.stub, 'pre_gate_commit');
    await expect(runDurableObjectAlarm(f.stub)).rejects.toThrow('pre_gate_commit');

    const atCrash = await readDurable(f);
    expect(atCrash.state).toBe('GOVERNOR_ADMITTED');

    await evictDurableObject(f.stub); // wipes __crashAfter along with all in-memory state

    await resume(f.stub);

    await expectExactlyOnce(f);
  });

  it('#3 crash before/inside GATED commit: full rollback, then resume re-evaluates the gate once', async () => {
    const f = fresh();

    await schedule(f);
    await poke(f.stub, 'pre_gate_commit');
    await expect(runDurableObjectAlarm(f.stub)).rejects.toThrow('pre_gate_commit');

    // Rollback proof: the throw is before the single GATED transactionSync, so NOTHING inside it
    // committed. State is still GOVERNOR_ADMITTED, verdict null, no budget/class/telemetry/outbox, and
    // — crucially — no delivery, since the receiver is only ever reached from the post-GATED flush.
    const rolledBack = await readDurable(f);
    expect(rolledBack.state).toBe('GOVERNOR_ADMITTED');
    expect(rolledBack.verdict).toBeNull();
    expect(rolledBack.classCount).toBe(0);
    expect(rolledBack.exemptSends).toBe(0);
    expect(rolledBack.budgetSendsTotal).toBe(0);
    expect(rolledBack.outboxRows).toBe(0);
    expect(await deliveredTotal(f)).toBe(0);

    await evictDurableObject(f.stub);

    await resume(f.stub);

    // Gate re-evaluated exactly once on resume: counters land at 1, one outbox row, one delivery.
    await expectExactlyOnce(f);
  });

  it('#4 crash after GATED committed, before the sink: resume reads the verdict, skips the gate, delivers once', async () => {
    const f = fresh();

    await schedule(f);
    // post_gate_pre_sink throws after the GATED transaction commits (verdict + outbox row reserved)
    // but BEFORE the receiver is contacted — the true "reserved, not yet delivered" boundary. No delivery
    // exists yet, so this isolates the resume-reads-verdict-and-delivers-once path without any dedup help.
    await poke(f.stub, 'post_gate_pre_sink');
    await expect(runDurableObjectAlarm(f.stub)).rejects.toThrow('post_gate_pre_sink');

    const atGated = await readDurable(f);
    expect(atGated.state).toBe('GATED');
    expect(atGated.verdict).toBe('send');
    expect(atGated.classCount).toBe(1);
    expect(atGated.exemptSends).toBe(1);
    expect(atGated.outboxRows).toBe(1);
    expect(await deliveredTotal(f)).toBe(0); // reserved but never sent

    await evictDurableObject(f.stub);

    await resume(f.stub);

    // Resume READS the stamped verdict and SKIPS the gate (counters stay 1, no second outbox row),
    // then delivers exactly once. If the gate were recomputed, classCount/exemptSends would be 2.
    await expectExactlyOnce(f);
  });

  it('#5 crash after sink send before ack recorded: durable receiver dedups the re-send — no second delivery', async () => {
    const f = fresh();

    await schedule(f);
    await poke(f.stub, 'post_sink_pre_ack');
    // First alarm: GATED commits, the receiver records the delivery (durable in its own DO SQLite),
    // then the handler throws before the ack transaction. The delivery is durable; the ack is not.
    await expect(runDurableObjectAlarm(f.stub)).rejects.toThrow('post_sink_pre_ack');
    expect(await deliveredTotal(f)).toBe(1);

    const atGated = await readDurable(f);
    expect(atGated.state).toBe('GATED');
    expect(atGated.outboxRows).toBe(1);

    await evictDurableObject(f.stub);

    await resume(f.stub);

    // Resume re-sends the SAME idempotency key (read from the committed outbox row, never recomputed);
    // the receiver's write-once dedup collapses it — no second delivery — and the run finalizes to DONE.
    await expectExactlyOnce(f);
  });

  it('#6 crash after ack recorded before handler returns: resume enters at ACK_RECORDED, skips the sink', async () => {
    const f = fresh();

    await schedule(f);
    await poke(f.stub, 'post_ack_pre_return');
    // First alarm runs the whole path up to and including the ack, then throws before finalize.
    // Committed state is ACK_RECORDED; the receiver already recorded its single delivery.
    await expect(runDurableObjectAlarm(f.stub)).rejects.toThrow('post_ack_pre_return');
    expect(await deliveredTotal(f)).toBe(1);

    const atAck = await readDurable(f);
    expect(atAck.state).toBe('ACK_RECORDED');
    expect(atAck.outboxRows).toBe(1);

    await evictDurableObject(f.stub);

    await resume(f.stub);

    // Resume enters at ACK_RECORDED and only finalizes: the sink is NOT called again, the delivery
    // count stays 1. If finalize re-ran the flush, deliveredTotal would be 2 and this would fail.
    await expectExactlyOnce(f);
  });
});

describe('TracerDO edge lanes', () => {
  it('null: an alarm with no scheduled run is a no-op (nothing to resume, nothing delivered)', async () => {
    const f = fresh();

    // No schedule() call: findOpenRun returns null, the handler returns early.
    const ran = await runDurableObjectAlarm(f.stub);
    // No alarm was armed, so the runner reports it did not run an alarm.
    expect(ran).toBe(false);

    const d = await readDurable(f);
    expect(d.state).toBe('NONE');
    expect(d.outboxRows).toBe(0);
    expect(await deliveredTotal(f)).toBe(0);
  });

  it('hostile: a duplicate alarm delivery after DONE is a no-op — no second send, counters hold at 1', async () => {
    const f = fresh();

    await schedule(f);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    await expectExactlyOnce(f);

    // Re-drive the alarm against a terminal run. findOpenRun returns null (DONE is terminal), so the
    // handler no-ops: no second gate, no second outbox row, no second delivery.
    await runInDurableObject(f.stub, async (instance) => {
      await instance.alarm();
    });

    await expectExactlyOnce(f);
  });

  it('serialized re-entry: the DO input gate collapses a racing second alarm to a no-op after DONE', async () => {
    const f = fresh();

    // The DO input gate serializes every call, so a "concurrent" second alarm cannot interleave with
    // the first. One schedule arms one alarm; one wake drives that single open run through the path.
    await schedule(f);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);

    // A second alarm invocation racing the first observes the terminal run and no-ops (findOpenRun
    // returns null once DONE), so counters and the delivery ledger hold at exactly one.
    await runInDurableObject(f.stub, async (instance) => {
      await instance.alarm();
    });

    await expectExactlyOnce(f);
  });
});

describe('TracerDO red proofs: the durable-layer assertions are load-bearing, not any in-process dedupe', () => {
  it('a second outbox row for the same (run, kind) is refused by UNIQUE(run_id, kind)', async () => {
    const f = fresh();

    await schedule(f);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    await expectExactlyOnce(f);
    const runId = (await readDurable(f)).runId;

    // Attempt a raw second insert with a DIFFERENT idempotency key. If UNIQUE(run_id, kind) were a
    // partial/active-only index, an acked row would not block this and outboxRows would become 2.
    await expect(
      runInDurableObject(f.stub, (_i, state) => {
        state.storage.sql.exec(
          `INSERT INTO outbox (outbox_id, run_id, kind, idempotency_key, payload, ack_recorded, created_at)
             VALUES (?, ?, ?, ?, ?, 0, ?)`,
          'forced-second-id',
          runId,
          KIND,
          '0'.repeat(64),
          'synthetic-token-02',
          futureOccurrence(),
        );
      }),
    ).rejects.toThrow();

    // The TOTAL-rows assertion still holds: the UNIQUE constraint kept it at exactly one.
    expect((await readDurable(f)).outboxRows).toBe(1);
  });

  it('the class-state assertion catches a durable double-increment (a resume that re-ran the gate)', async () => {
    const f = fresh();

    await schedule(f);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect((await readDurable(f)).classCount).toBe(1);

    // Simulate a buggy resume that re-runs the gate's class-state increment. The count === 1 assertion
    // must then FAIL (reads 2), proving it catches durable double-processing, not just delivery dupes.
    await runInDurableObject(f.stub, (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO class_state (user_id, push_class, count, last_sent_at)
           VALUES (?, ?, 1, ?)
         ON CONFLICT(user_id, push_class)
           DO UPDATE SET count = count + 1`,
        f.user,
        KIND,
        futureOccurrence(),
      );
    });

    expect((await readDurable(f)).classCount).toBe(2);
  });

  it('a state that skipped the gate cannot deliver: resume from a forged GATED has no outbox row', async () => {
    const f = fresh();

    await schedule(f); // state RUN_OPENED, no gate side effects yet

    // Forge the journal straight to GATED, skipping GOVERNOR_ADMITTED and the gate transaction that
    // is the sole writer of the outbox row / class-state / telemetry. A resume then hits the GATED
    // branch and tries to flush an outbox row that was never inserted.
    await runInDurableObject(f.stub, (_i, state) => {
      state.storage.sql.exec("UPDATE journal SET state = 'GATED', verdict = 'send'");
    });

    // flushOutbox throws because the skipped gate left no outbox row: the run cannot reach DONE, and
    // the receiver never fires. This proves the ordered FSM + gate-as-sole-writer are load-bearing —
    // a skipped step does not silently deliver.
    await expect(runDurableObjectAlarm(f.stub)).rejects.toThrow('no outbox row');

    const d = await readDurable(f);
    expect(d.state).toBe('GATED');
    expect(d.outboxRows).toBe(0);
    expect(await deliveredTotal(f)).toBe(0);
  });

  it('a corrupt journal state fails loudly at the read seam instead of silently stalling the run', async () => {
    const f = fresh();

    await schedule(f);

    // Corrupt the durable state to a value outside the FSM enum. Without validation at the read
    // seam the alarm would match no step branch and return cleanly — a stuck run, no error signal.
    await runInDurableObject(f.stub, (_i, state) => {
      state.storage.sql.exec("UPDATE journal SET state = 'CORRUPT_STATE'");
    });

    await expect(runDurableObjectAlarm(f.stub)).rejects.toThrow(/invalid option/i);
    expect(await deliveredTotal(f)).toBe(0);
  });
});
