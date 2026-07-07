import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeSink } from '../src/tracer/sink';
import type { TracerDO } from '../src/tracer/tracer-do';

// ADR-0054: the promoted runtime interface resumes from committed DO SQLite and sends only through idempotent outbox rows.
const KIND = 'fetch_alert';
const USER = 'user-runtime-interface-01';
const CALLER_SUPPLIED_KEY = 'd'.repeat(64);

type RuntimeInterfaceStub = DurableObjectStub<TracerDO> & {
  startRun(input: StartRunInput): Promise<string>;
  resumeRun(runId: string): Promise<unknown>;
  tickRun(runId: string): Promise<void>;
};

type StartRunInput = {
  userId: string;
  trigger: typeof KIND;
  occurrenceAt: number;
};
type CrashPoint = 'post_attempt_pre_send' | 'post_sink_pre_ack';

function futureOccurrence(): number {
  return Date.now() + 3_600_000;
}

beforeEach(() => {
  new FakeSink().reset();
});

let seq = 0;
function freshRuntimeStub(): RuntimeInterfaceStub {
  seq += 1;
  const id = env.TRACER_DO.idFromName(`run-journal-interface-${seq}`);
  return env.TRACER_DO.get(id) as RuntimeInterfaceStub;
}

async function poke(stub: RuntimeInterfaceStub, point: CrashPoint) {
  await runInDurableObject(stub, (instance) => {
    (instance as TracerDO).__crashAfter = point;
  });
}

type DurableOutbox = {
  journalState: string;
  status: string;
  attempts: number;
  next_retry_at: number | null;
  acked_at: number | null;
  idempotency_key: string;
  outboxRows: number;
};

async function readOutbox(stub: RuntimeInterfaceStub, runId: string): Promise<DurableOutbox> {
  return runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql
      .exec<{
        journal_state: string;
        status: string;
        attempts: number;
        next_retry_at: number | null;
        acked_at: number | null;
        idempotency_key: string;
      }>(
        `SELECT j.state AS journal_state,
                o.status,
                o.attempts,
                o.next_retry_at,
                o.acked_at,
                o.idempotency_key
           FROM journal j
           JOIN outbox o ON o.run_id = j.run_id
          WHERE j.run_id = ? AND o.kind = ?`,
        runId,
        KIND,
      )
      .one();
    const outboxRows = state.storage.sql
      .exec<{ n: number }>(
        'SELECT count(*) AS n FROM outbox WHERE run_id = ? AND kind = ?',
        runId,
        KIND,
      )
      .one().n;
    return {
      journalState: row.journal_state,
      status: row.status,
      attempts: row.attempts,
      next_retry_at: row.next_retry_at,
      acked_at: row.acked_at,
      idempotency_key: row.idempotency_key,
      outboxRows,
    };
  });
}

async function tick(stub: RuntimeInterfaceStub, runId: string): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await (instance as TracerDO).tickRun(runId);
  });
}

async function resume(stub: RuntimeInterfaceStub, runId: string): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await (instance as TracerDO).resumeRun(runId);
  });
}

async function start(stub: RuntimeInterfaceStub, input: StartRunInput): Promise<string> {
  return runInDurableObject(stub, async (instance) =>
    (instance as TracerDO).startRun(input),
  );
}

async function enqueueWithCallerPayload(
  stub: RuntimeInterfaceStub,
  input: {
    run_id: string;
    kind: typeof KIND;
    created_at: number;
    verdict: 'send';
  },
): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await (instance as TracerDO).enqueueOutbox({
      ...input,
      idempotency_key: CALLER_SUPPLIED_KEY,
      payload: 'caller free text',
    } as never);
  });
}

async function flush(stub: RuntimeInterfaceStub, runId: string): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    (instance as TracerDO).flushOutbox(runId, KIND);
  });
}

describe('promoted run journal/outbox runtime interface', () => {
  it('rejects malformed start input before opening a journal row', async () => {
    const runtime = freshRuntimeStub();

    await expect(
      start(runtime, { userId: '', trigger: KIND, occurrenceAt: futureOccurrence() }),
    ).rejects.toThrow(/userId/);
    await expect(
      start(runtime, { userId: USER, trigger: '', occurrenceAt: futureOccurrence() } as never),
    ).rejects.toThrow(/trigger/);
    await expect(
      start(runtime, {
        userId: USER,
        trigger: 'user said HRV 42',
        occurrenceAt: futureOccurrence(),
      } as never),
    ).rejects.toThrow(/trigger/);
    await expect(
      start(runtime, { userId: USER, trigger: KIND, occurrenceAt: -1 }),
    ).rejects.toThrow(/occurrenceAt/);

    const journalRows = await runInDurableObject(runtime, (_instance, state) =>
      state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM journal').one().n,
    );
    expect(journalRows).toBe(0);
  });

  it('resumes the promoted journal/outbox interface across eviction without re-sending', async () => {
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();

    const runId = await runtime.startRun({
      userId: USER,
      trigger: KIND,
      occurrenceAt: futureOccurrence(),
    });
    await poke(runtime, 'post_sink_pre_ack');

    await expect(tick(runtime, runId)).rejects.toThrow('post_sink_pre_ack');

    const inDoubt = await readOutbox(runtime, runId);
    expect(inDoubt.journalState).toBe('SINK_SENT');
    expect(inDoubt.status).toBe('sent_unacked');
    expect(inDoubt.attempts).toBe(1);
    expect(inDoubt.next_retry_at).not.toBeNull();
    expect(inDoubt.acked_at).toBeNull();
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);

    await evictDurableObject(runtime);

    await resume(runtime, runId);
    await tick(runtime, runId);

    expect(sink.observedSendAttempts()).toBe(2);
    expect(new Set(sink.observedKeys()).size).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);

    const acked = await readOutbox(runtime, runId);
    expect(acked.journalState).toBe('DONE');
    expect(acked.status).toBe('acked');
    expect(acked.attempts).toBe(2);
    expect(acked.acked_at).not.toBeNull();
    expect(acked.next_retry_at).toBeNull();
    expect(acked.outboxRows).toBe(1);

    await tick(runtime, runId);
    expect(sink.observedSendAttempts()).toBe(2);
    expect(sink.observedDeliveries()).toBe(1);
  });

  it('fails closed without outbox when the gate verdict is not send', async () => {
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();

    const sentRun = await runtime.startRun({
      userId: USER,
      trigger: KIND,
      occurrenceAt: futureOccurrence(),
    });
    await tick(runtime, sentRun);
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);

    const heldRun = await runtime.startRun({
      userId: USER,
      trigger: KIND,
      occurrenceAt: futureOccurrence(),
    });
    await tick(runtime, heldRun);

    const heldState = await runInDurableObject(runtime, (_instance, state) => {
      const journalState = state.storage.sql
        .exec<{ state: string }>('SELECT state FROM journal WHERE run_id = ?', heldRun)
        .one().state;
      const outboxRows = state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE run_id = ?', heldRun)
        .one().n;
      const classState = state.storage.sql
        .exec<{ count: number }>(
          "SELECT count FROM class_state WHERE user_id = ? AND push_class = 'fetch_alert'",
          USER,
        )
        .one().count;
      const exemptSends = state.storage.sql
        .exec<{ exempt_sends: number }>(
          "SELECT exempt_sends FROM exempt_telemetry WHERE user_id = ? AND push_class = 'fetch_alert'",
          USER,
        )
        .one().exempt_sends;
      return { journalState, outboxRows, classState, exemptSends };
    });

    expect(heldState).toEqual({
      journalState: 'FAILED',
      outboxRows: 0,
      classState: 1,
      exemptSends: 1,
    });
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);

    await tick(runtime, heldRun);
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);
  });

  it('rejects malformed committed journal and outbox rows at the promoted read seam', async () => {
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();

    const corruptJournalRun = await runtime.startRun({
      userId: USER,
      trigger: KIND,
      occurrenceAt: futureOccurrence(),
    });
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE journal SET state = 'CORRUPT_STATE' WHERE run_id = ?",
        corruptJournalRun,
      );
    });

    await expect(resume(runtime, corruptJournalRun)).rejects.toThrow(/invalid option/i);

    const wrongTriggerRun = await runtime.startRun({
      userId: USER,
      trigger: KIND,
      occurrenceAt: futureOccurrence(),
    });
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE journal SET trigger = 'brief' WHERE run_id = ?",
        wrongTriggerRun,
      );
    });

    await expect(tick(runtime, wrongTriggerRun)).rejects.toThrow(/Invalid input|fetch_alert/i);

    const corruptOutboxRun = await runtime.startRun({
      userId: USER,
      trigger: KIND,
      occurrenceAt: futureOccurrence(),
    });
    await poke(runtime, 'post_attempt_pre_send');
    await expect(tick(runtime, corruptOutboxRun)).rejects.toThrow('post_attempt_pre_send');
    await evictDurableObject(runtime);

    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE outbox SET status = 'pending', attempts = 1 WHERE run_id = ? AND kind = ?",
        corruptOutboxRun,
        KIND,
      );
    });

    await expect(tick(runtime, corruptOutboxRun)).rejects.toThrow(/attempts|zero/i);

    const mismatchedRuntime = freshRuntimeStub();
    const mismatchedRun = await mismatchedRuntime.startRun({
      userId: USER,
      trigger: KIND,
      occurrenceAt: futureOccurrence(),
    });
    await poke(mismatchedRuntime, 'post_attempt_pre_send');
    await expect(tick(mismatchedRuntime, mismatchedRun)).rejects.toThrow(
      'post_attempt_pre_send',
    );
    await evictDurableObject(mismatchedRuntime);

    await runInDurableObject(mismatchedRuntime, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE outbox
            SET status = 'pending', attempts = 0, next_retry_at = NULL
          WHERE run_id = ? AND kind = ?`,
        mismatchedRun,
        KIND,
      );
    });

    await expect(tick(mismatchedRuntime, mismatchedRun)).rejects.toThrow(
      /journal\/outbox delivery state mismatch/,
    );
    expect(sink.observedSendAttempts()).toBe(0);

    const corruptLastErrorRuntime = freshRuntimeStub();
    const corruptLastErrorRun = await corruptLastErrorRuntime.startRun({
      userId: USER,
      trigger: KIND,
      occurrenceAt: futureOccurrence(),
    });
    await poke(corruptLastErrorRuntime, 'post_attempt_pre_send');
    await expect(tick(corruptLastErrorRuntime, corruptLastErrorRun)).rejects.toThrow(
      'post_attempt_pre_send',
    );
    await evictDurableObject(corruptLastErrorRuntime);

    await runInDurableObject(corruptLastErrorRuntime, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE outbox SET last_error = 'provider said HRV 42' WHERE run_id = ? AND kind = ?",
        corruptLastErrorRun,
        KIND,
      );
    });

    await expect(tick(corruptLastErrorRuntime, corruptLastErrorRun)).rejects.toThrow(
      /Invalid input|send_failed/i,
    );
  });

  it('requires a gate-owned journal state before enqueueing an outbox row', async () => {
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: KIND,
      occurrenceAt: futureOccurrence(),
    });
    const intent = {
      run_id: runId,
      kind: KIND as typeof KIND,
      created_at: futureOccurrence(),
      verdict: 'send' as const,
    };

    await expect(enqueueWithCallerPayload(runtime, intent)).rejects.toThrow(
      /GOVERNOR_ADMITTED/,
    );

    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE journal SET state = 'GOVERNOR_ADMITTED' WHERE run_id = ?",
        runId,
      );
    });
    await expect(
      runInDurableObject(runtime, async (instance) =>
        (instance as TracerDO).enqueueOutbox({
          ...intent,
          idempotency_key: CALLER_SUPPLIED_KEY,
          verdict: 'bogus',
        } as never),
      ),
    ).rejects.toThrow(/Invalid option/i);
    const afterBadVerdict = await runInDurableObject(runtime, (_instance, state) => {
      const journalState = state.storage.sql
        .exec<{ state: string }>('SELECT state FROM journal WHERE run_id = ?', runId)
        .one().state;
      const outboxRows = state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE run_id = ?', runId)
        .one().n;
      return { journalState, outboxRows };
    });
    expect(afterBadVerdict.journalState).toBe('GOVERNOR_ADMITTED');
    expect(afterBadVerdict.outboxRows).toBe(0);

    await expect(
      runInDurableObject(runtime, async (instance) =>
        (instance as TracerDO).enqueueOutbox({ ...intent, verdict: 'hold' } as never),
      ),
    ).rejects.toThrow(/send verdict/i);
    const afterHeldVerdict = await runInDurableObject(runtime, (_instance, state) => {
      const journalState = state.storage.sql
        .exec<{ state: string }>('SELECT state FROM journal WHERE run_id = ?', runId)
        .one().state;
      const outboxRows = state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE run_id = ?', runId)
        .one().n;
      const classStateRows = state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM class_state WHERE user_id = ?', USER)
        .one().n;
      const exemptRows = state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM exempt_telemetry WHERE user_id = ?', USER)
        .one().n;
      return { journalState, outboxRows, classStateRows, exemptRows };
    });
    expect(afterHeldVerdict).toEqual({
      journalState: 'GOVERNOR_ADMITTED',
      outboxRows: 0,
      classStateRows: 0,
      exemptRows: 0,
    });

    await enqueueWithCallerPayload(runtime, intent);

    const row = await readOutbox(runtime, runId);
    expect(row.journalState).toBe('GATED');
    expect(row.status).toBe('pending');
    expect(row.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
    expect(row.idempotency_key).not.toBe(CALLER_SUPPLIED_KEY);
    await runInDurableObject(runtime, (_instance, state) => {
      const payload = state.storage.sql
        .exec<{ payload: string }>('SELECT payload FROM outbox WHERE run_id = ?', runId)
        .one().payload;
      expect(payload).toBe('synthetic-token-01');
    });

    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE journal SET state = 'DONE', verdict = 'send' WHERE run_id = ?",
        runId,
      );
    });
    await expect(
      enqueueWithCallerPayload(runtime, intent),
    ).rejects.toThrow(/GOVERNOR_ADMITTED/);
  });

  it('fails before the sink when flush lacks a send-bearing journal row', async () => {
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: KIND,
      occurrenceAt: futureOccurrence(),
    });

    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO outbox (outbox_id, run_id, kind, idempotency_key, payload,
                             status, attempts, next_retry_at, acked_at, last_error, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?)`,
        'premature-row',
        runId,
        KIND,
        'f'.repeat(64),
        'synthetic-token-01',
        futureOccurrence(),
      );
    });

    await expect(flush(runtime, runId)).rejects.toThrow(/GATED or SINK_SENT/);
    expect(sink.observedSendAttempts()).toBe(0);

    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE journal SET state = 'GATED', verdict = NULL WHERE run_id = ?",
        runId,
      );
    });

    await expect(flush(runtime, runId)).rejects.toThrow(/verdict/i);
    expect(sink.observedSendAttempts()).toBe(0);
  });

  it('rejects invalid or mismatched sink acks before ack mutation', async () => {
    const invalidAckRuntime = freshRuntimeStub();
    const invalidAckRun = await invalidAckRuntime.startRun({
      userId: USER,
      trigger: KIND,
      occurrenceAt: futureOccurrence(),
    });

    FakeSink.returnInvalidAckOnce();
    await expect(tick(invalidAckRuntime, invalidAckRun)).rejects.toThrow(/Invalid input/i);
    const invalidAckRow = await readOutbox(invalidAckRuntime, invalidAckRun);
    expect(invalidAckRow.journalState).toBe('SINK_SENT');
    expect(invalidAckRow.status).toBe('sent_unacked');
    expect(invalidAckRow.acked_at).toBeNull();

    const wrongKeyRuntime = freshRuntimeStub();
    const wrongKeyRun = await wrongKeyRuntime.startRun({
      userId: USER,
      trigger: KIND,
      occurrenceAt: futureOccurrence(),
    });

    FakeSink.returnWrongAckKeyOnce('c'.repeat(64));
    await expect(tick(wrongKeyRuntime, wrongKeyRun)).rejects.toThrow(/idempotency key mismatch/);
    const wrongKeyRow = await readOutbox(wrongKeyRuntime, wrongKeyRun);
    expect(wrongKeyRow.journalState).toBe('SINK_SENT');
    expect(wrongKeyRow.status).toBe('sent_unacked');
    expect(wrongKeyRow.acked_at).toBeNull();
    expect(wrongKeyRow.attempts).toBe(1);
  });
});
