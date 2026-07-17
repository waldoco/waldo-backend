import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { scheduleEntrySchema } from '@waldo/contracts';
import { FakeSink } from '../src/tracer/sink';
import type { TracerDO } from '../src/tracer/tracer-do';

const KIND = 'fetch_alert';
const USER = 'user-tracer-01';

// Keep the schedule inside the scheduler's due-work lookahead while still avoiding a past alarm that
// workerd could auto-fire before the manual runDurableObjectAlarm() call. The occurrence value is
// opaque to the path: the gate's cooldown compares now - last_sent_at, and last_sent_at is null on
// the first send, so the verdict is 'send'.
function futureOccurrence(): number {
  return Date.now() + 500;
}

function utcLocalDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

// The FakeSink counter/ack map is module-scoped so an evicted-then-rebuilt DO still observes prior
// deliveries within one process. That same global state leaks across tests, so reset it per test —
// otherwise observedDeliveries() accumulates and the exactly-once corroboration goes vacuous.
beforeEach(() => {
  new FakeSink().reset();
});

// Each test gets a fresh DO id so its journal/outbox/class_state SQLite is isolated. crash #5 relies
// on the process-global sink surviving eviction, which the per-test sink.reset() above scopes cleanly.
let seq = 0;
function freshStub() {
  seq += 1;
  const id = env.TRACER_DO.idFromName(`tracer-${seq}`);
  return env.TRACER_DO.get(id);
}

type CrashPoint =
  | 'pre_gate_commit'
  | 'post_attempt_pre_send'
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

async function readDurable(stub: DurableObjectStub<TracerDO>): Promise<Durable> {
  return runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const run = sql
      .exec<{
        run_id: string;
        state: string;
        verdict: string | null;
        occurrence_at: number;
      }>(
        'SELECT run_id, state, verdict, occurrence_at FROM journal LIMIT 1',
      )
      .toArray()[0];
    const localDate = run === undefined ? '' : utcLocalDate(run.occurrence_at);
    const cls = sql
      .exec<{ count: number; last_sent_at: number | null }>(
        `SELECT count, last_sent_at
           FROM class_state
          WHERE user_id = ? AND local_date = ? AND push_class = ?`,
        USER,
        localDate,
        KIND,
      )
      .toArray()[0];
    const exempt = sql
      .exec<{ exempt_sends: number }>(
        'SELECT exempt_sends FROM exempt_telemetry WHERE user_id = ? AND push_class = ?',
        USER,
        KIND,
      )
      .toArray()[0];
    const budget = sql
      .exec<{ sends_total: number }>(
        'SELECT sends_total FROM daily_push_budget WHERE user_id = ? AND local_date = ?',
        USER,
        localDate,
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

// The single, load-bearing exactly-once contract, asserted at the durable layer (not just the sink):
// terminal DONE, the daily push budget never touched (fetch_alert is budget-exempt), the per-class
// cap counter and the exempt-telemetry counter each incremented exactly once, and exactly one TOTAL
// outbox row (incl. acked). The sink count corroborates but is not the sole proof.
function expectExactlyOnce(d: Durable, sink: FakeSink) {
  expect(d.state).toBe('DONE');
  expect(d.verdict).toBe('send');
  expect(d.budgetSendsTotal).toBe(0);
  expect(d.classCount).toBe(1);
  expect(d.lastSentAt).not.toBeNull();
  expect(d.exemptSends).toBe(1);
  expect(d.outboxRows).toBe(1);
  expect(sink.observedDeliveries()).toBe(1);
}

async function schedule(stub: DurableObjectStub<TracerDO>, occurrenceAt = futureOccurrence()) {
  return stub.schedule({ userId: USER, trigger: KIND, occurrenceAt });
}

async function forceScheduleDue(stub: DurableObjectStub<TracerDO>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const now = Date.now();
    state.storage.sql.exec(
      'UPDATE schedule SET occurrence_at = ?, due_at = ?, updated_at = ?',
      now,
      now,
      now,
    );
  });
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

describe('TracerDO one-path: scheduled wake -> governor -> gate -> outbox -> sink, exactly once', () => {
  it('persists a canonical one-shot handoff schedule row for the tracer alarm', async () => {
    const stub = freshStub();

    const runId = await schedule(stub);
    const entry = await readScheduleEntry(stub);

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

  it('happy path: a scheduled alarm drives the run to DONE and the sink observes exactly one send', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);

    // Before the alarm the run is journaled at RUN_OPENED and nothing downstream has run.
    const opened = await readDurable(stub);
    expect(opened.state).toBe('RUN_OPENED');
    expect(opened.verdict).toBeNull();
    expect(opened.outboxRows).toBe(0);

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    expectExactlyOnce(await readDurable(stub), sink);
  });

  it('#1 crash after RUN_OPENED: evict before the alarm; resume reaches DONE exactly once', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub); // commits RUN_OPENED
    await evictDurableObject(stub); // wipe in-memory state; SQLite holds only RUN_OPENED

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    expectExactlyOnce(await readDurable(stub), sink);
  });

  it('#2 crash after GOVERNOR_ADMITTED: resume enters at GOVERNOR_ADMITTED and reaches DONE once', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    // pre_gate_commit throws AFTER the admit advance has committed but BEFORE the gate transaction,
    // so the committed state at crash time is exactly GOVERNOR_ADMITTED.
    await poke(stub, 'pre_gate_commit');
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('pre_gate_commit');

    const atCrash = await readDurable(stub);
    expect(atCrash.state).toBe('GOVERNOR_ADMITTED');

    await evictDurableObject(stub); // wipes __crashAfter along with all in-memory state

    await resume(stub);

    expectExactlyOnce(await readDurable(stub), sink);
  });

  it('#3 crash before/inside GATED commit: full rollback, then resume re-evaluates the gate once', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    await poke(stub, 'pre_gate_commit');
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('pre_gate_commit');

    // Rollback proof: the throw is before the single GATED transactionSync, so NOTHING inside it
    // committed. State is still GOVERNOR_ADMITTED, verdict null, and no budget/class/telemetry/outbox.
    const rolledBack = await readDurable(stub);
    expect(rolledBack.state).toBe('GOVERNOR_ADMITTED');
    expect(rolledBack.verdict).toBeNull();
    expect(rolledBack.classCount).toBe(0);
    expect(rolledBack.exemptSends).toBe(0);
    expect(rolledBack.budgetSendsTotal).toBe(0);
    expect(rolledBack.outboxRows).toBe(0);
    // #3 is indistinguishable-on-resume from #2: both resume from GOVERNOR_ADMITTED.
    expect(rolledBack.state).toBe('GOVERNOR_ADMITTED');

    await evictDurableObject(stub);

    await resume(stub);

    // Gate re-evaluated exactly once on resume: counters land at 1, one outbox row.
    expectExactlyOnce(await readDurable(stub), sink);
  });

  it('#4 crash after the attempt marker, before the send: resume reads the verdict, skips the gate', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    // The attempt marker commits BEFORE the sink is reached, so this crash point isolates the
    // "gate committed, sink not yet called" boundary directly — no sink involvement at all.
    await poke(stub, 'post_attempt_pre_send');
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('post_attempt_pre_send');

    const atMarked = await readDurable(stub);
    expect(atMarked.state).toBe('SINK_SENT');
    expect(atMarked.verdict).toBe('send');
    expect(atMarked.classCount).toBe(1);
    expect(atMarked.exemptSends).toBe(1);
    expect(atMarked.outboxRows).toBe(1);
    expect(sink.observedDeliveries()).toBe(0);

    await evictDurableObject(stub);

    await resume(stub);

    // Resume READS the stamped verdict and SKIPS the gate (counters stay 1, no second outbox row),
    // then delivers exactly once. If the gate were recomputed, classCount/exemptSends would be 2.
    expectExactlyOnce(await readDurable(stub), sink);
  });

  it('#5 crash after sink call before ack recorded: idempotent sink re-send yields no second delivery', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    await poke(stub, 'post_sink_pre_ack');
    // First alarm: GATED commits, sink.send happens (one delivery), then it throws before the ack
    // transaction. The delivery is durable in the module-scoped sink; the ack is not yet persisted.
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('post_sink_pre_ack');
    expect(sink.observedDeliveries()).toBe(1);

    const inDoubt = await readDurable(stub);
    expect(inDoubt.state).toBe('SINK_SENT');
    expect(inDoubt.outboxRows).toBe(1);

    await evictDurableObject(stub);

    await resume(stub);

    // Resume re-sends the SAME idempotency key; the sink returns the prior ack without a second
    // delivery. The durable counters were never re-incremented (gate skipped).
    expectExactlyOnce(await readDurable(stub), sink);
  });

  it('#6 crash after ack recorded before handler returns: resume enters at ACK_RECORDED, skips the sink', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    await poke(stub, 'post_ack_pre_return');
    // First alarm runs the whole path up to and including the ack, then throws before finalize.
    // Committed state is ACK_RECORDED; the sink already saw its single delivery.
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('post_ack_pre_return');
    expect(sink.observedDeliveries()).toBe(1);

    const atAck = await readDurable(stub);
    expect(atAck.state).toBe('ACK_RECORDED');
    expect(atAck.outboxRows).toBe(1);

    await evictDurableObject(stub);

    await resume(stub);

    // Resume enters at ACK_RECORDED and only finalizes: the sink is NOT called again, counters
    // stay at 1. If finalize re-ran the flush, observedDeliveries would be 2 and this would fail.
    expectExactlyOnce(await readDurable(stub), sink);
  });
});

describe('TracerDO edge lanes', () => {
  it('null: an alarm with no scheduled run is a no-op (nothing to resume, nothing delivered)', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    // No schedule() call: findOpenRun returns null, the handler returns early.
    const ran = await runDurableObjectAlarm(stub);
    // No alarm was armed, so the runner reports it did not run an alarm.
    expect(ran).toBe(false);

    const d = await readDurable(stub);
    expect(d.state).toBe('NONE');
    expect(d.outboxRows).toBe(0);
    expect(sink.observedDeliveries()).toBe(0);
  });

  it('hostile: a duplicate alarm delivery after DONE is a no-op — no second send, counters hold at 1', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expectExactlyOnce(await readDurable(stub), sink);

    // Re-drive the alarm against a terminal run. findOpenRun returns null (DONE is terminal), so the
    // handler no-ops: no second gate, no second outbox row, no second delivery.
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    expectExactlyOnce(await readDurable(stub), sink);
  });

  it('terminal re-entry: a later alarm invocation is a no-op after DONE', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    // Hold the real alarm well beyond test setup, then make the persisted row due immediately
    // before the controlled manual alarm. This prevents workerd from auto-firing the first wake
    // while the test is establishing the terminal re-entry scenario.
    await schedule(stub, Date.now() + 60_000);
    await forceScheduleDue(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // A later alarm invocation observes the terminal run and no-ops (findOpenRun returns null once
    // DONE), so counters and the sink hold at exactly one — no double-processing.
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    expectExactlyOnce(await readDurable(stub), sink);
  });

  it('degraded: sink no-ack on the first attempt, ack on retry — still exactly one delivery', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    // Model a no-ack-then-ack sink by crashing after the sink send but before the ack is recorded
    // (the ack never persisted on attempt one), then letting the retry record it. The idempotent
    // sink makes the retry safe: same key, prior ack, no second delivery.
    await poke(stub, 'post_sink_pre_ack');
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('post_sink_pre_ack');
    expect(sink.observedDeliveries()).toBe(1);

    await evictDurableObject(stub);
    await resume(stub);

    expectExactlyOnce(await readDurable(stub), sink);
  });
});

describe('TracerDO red proofs: the durable-layer assertions are load-bearing, not the sink dedupe', () => {
  it('a second outbox row for the same (run, kind) is refused by UNIQUE(run_id, kind)', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const d = await readDurable(stub);
    expectExactlyOnce(d, sink);

    // Attempt a raw second insert with a DIFFERENT idempotency key. If UNIQUE(run_id, kind) were a
    // partial/active-only index, an acked row would not block this and outboxRows would become 2.
    await expect(
      runInDurableObject(stub, (_i, state) => {
        state.storage.sql.exec(
          `INSERT INTO outbox (outbox_id, run_id, kind, idempotency_key, payload,
                               status, attempts, next_retry_at, acked_at, last_error, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?)`,
          'forced-second-id',
          d.runId,
          KIND,
          '0'.repeat(64),
          'synthetic-token-02',
          futureOccurrence(),
        );
      }),
    ).rejects.toThrow();

    // The TOTAL-rows assertion still holds: the UNIQUE constraint kept it at exactly one.
    expect((await readDurable(stub)).outboxRows).toBe(1);
  });

  it('the class-state assertion catches a durable double-increment (a resume that re-ran the gate)', async () => {
    const stub = freshStub();

    await schedule(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await readDurable(stub)).classCount).toBe(1);

    // Simulate a buggy resume that re-runs the gate's class-state increment. The count === 1 assertion
    // must then FAIL (reads 2), proving it catches durable double-processing, not just sink dupes.
    await runInDurableObject(stub, (_i, state) => {
      const run = state.storage.sql
        .exec<{ occurrence_at: number }>('SELECT occurrence_at FROM journal LIMIT 1')
        .one();
      state.storage.sql.exec(
        `INSERT INTO class_state (user_id, local_date, push_class, count, last_sent_at)
           VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(user_id, local_date, push_class)
           DO UPDATE SET count = count + 1`,
        USER,
        utcLocalDate(run.occurrence_at),
        KIND,
        run.occurrence_at,
      );
    });

    expect((await readDurable(stub)).classCount).toBe(2);
  });

  it('a state that skipped the gate cannot deliver: resume from a forged GATED has no outbox row', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub); // state RUN_OPENED, no gate side effects yet

    // Forge the journal straight to GATED, skipping GOVERNOR_ADMITTED and the gate transaction that
    // is the sole writer of the outbox row / class-state / telemetry. A resume then hits the GATED
    // branch and tries to flush an outbox row that was never inserted.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE journal SET state = 'GATED', verdict = 'send'");
    });

    // flushOutbox throws because the skipped gate left no outbox row: the run cannot reach DONE, and
    // the sink never fires. This proves the ordered FSM + gate-as-sole-writer are load-bearing —
    // a skipped step does not silently deliver.
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('no outbox row');

    const d = await readDurable(stub);
    expect(d.state).toBe('GATED');
    expect(d.outboxRows).toBe(0);
    expect(sink.observedDeliveries()).toBe(0);
  });

  it('a corrupt journal state fails loudly at the read seam instead of silently stalling the run', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);

    // Corrupt the durable state to a value outside the FSM enum. Without validation at the read
    // seam the alarm would match no step branch and return cleanly — a stuck run, no error signal.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE journal SET state = 'CORRUPT_STATE'");
    });

    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(/invalid option/i);
    expect(sink.observedDeliveries()).toBe(0);
  });
});
