import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeSink } from '../src/tracer/sink';
import type { TracerDO } from '../src/tracer/tracer-do';

const KIND = 'fetch_alert';
const USER = 'user-outbox-01';

// Future occurrence so the manual runDurableObjectAlarm is the sole, deterministic fire
// (see tracer.test.ts for the full rationale).
function futureOccurrence(): number {
  return Date.now() + 3_600_000;
}

beforeEach(() => {
  new FakeSink().reset();
});

let seq = 0;
function freshStub() {
  seq += 1;
  const id = env.TRACER_DO.idFromName(`outbox-delivery-${seq}`);
  return env.TRACER_DO.get(id);
}

type CrashPoint =
  | 'pre_gate_commit'
  | 'post_attempt_pre_send'
  | 'post_sink_pre_ack'
  | 'post_ack_pre_return';

async function poke(stub: DurableObjectStub<TracerDO>, point: CrashPoint) {
  await runInDurableObject(stub, (instance) => {
    instance.__crashAfter = point;
  });
}

// The durable delivery state this slice introduces. Every assertion in this file reads it
// straight from the reconstructed DO's SQLite — the sink counters only corroborate.
type OutboxDurable = {
  status: string;
  attempts: number;
  next_retry_at: number | null;
  acked_at: number | null;
  last_error: string | null;
  idempotency_key: string;
  journalState: string;
  outboxRows: number;
};

async function readOutbox(stub: DurableObjectStub<TracerDO>): Promise<OutboxDurable> {
  return runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const run = sql
      .exec<{ run_id: string; state: string }>('SELECT run_id, state FROM journal LIMIT 1')
      .toArray()[0];
    if (run === undefined) throw new Error('readOutbox: no journal row');
    const row = sql
      .exec<{
        status: string;
        attempts: number;
        next_retry_at: number | null;
        acked_at: number | null;
        last_error: string | null;
        idempotency_key: string;
      }>(
        `SELECT status, attempts, next_retry_at, acked_at, last_error, idempotency_key
           FROM outbox WHERE run_id = ? AND kind = ?`,
        run.run_id,
        KIND,
      )
      .toArray()[0];
    if (row === undefined) throw new Error('readOutbox: no outbox row');
    const outboxRows = sql
      .exec<{ n: number }>(
        'SELECT count(*) AS n FROM outbox WHERE run_id = ? AND kind = ?',
        run.run_id,
        KIND,
      )
      .one().n;
    return { ...row, journalState: run.state, outboxRows };
  });
}

async function schedule(stub: DurableObjectStub<TracerDO>) {
  return stub.schedule({ userId: USER, trigger: KIND, occurrenceAt: futureOccurrence() });
}

// The next wake after a crash consumed the alarm slot: re-enter alarm() directly on the
// reconstructed instance, resuming purely from committed DO SQLite (see tracer.test.ts).
async function resume(stub: DurableObjectStub<TracerDO>) {
  await runInDurableObject(stub, async (instance) => {
    await instance.alarm();
  });
}

describe('SLICE-3a golden proof: exactly-once delivery at the durable layer', () => {
  it('resumes after post-send/pre-ack eviction without a second physical delivery', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    await poke(stub, 'post_sink_pre_ack');
    // First alarm: GATED commits, the send attempt is durably marked, the sink physically
    // delivers once, then the handler dies before the ack transaction.
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('post_sink_pre_ack');

    // The in-doubt state was committed BEFORE the send, so it survives the crash: the row
    // says "attempted, unacked, retry due" while the ack is absent.
    const inDoubt = await readOutbox(stub);
    expect(inDoubt.status).toBe('sent_unacked');
    expect(inDoubt.attempts).toBe(1);
    expect(inDoubt.next_retry_at).not.toBeNull();
    expect(inDoubt.acked_at).toBeNull();
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);

    // Real reconstruction: every in-memory field dies, including any process-local dedupe
    // the DO instance held. Only DO SQLite plus the external world (the sink fake's
    // module-scoped receipt store) survive.
    await evictDurableObject(stub);
    await resume(stub);

    // The resume re-sent the in-doubt row with the SAME idempotency key — the runtime is
    // at-least-once; the sink's declared idempotency collapses the repeat to one physical
    // delivery. Both halves asserted separately so the fake cannot hide a re-key bug.
    expect(sink.observedSendAttempts()).toBe(2);
    expect(new Set(sink.observedKeys()).size).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);

    // Durable ack/retry outcome recorded: acked, retry cleared, second attempt counted.
    const acked = await readOutbox(stub);
    expect(acked.status).toBe('acked');
    expect(acked.attempts).toBe(2);
    expect(acked.acked_at).not.toBeNull();
    expect(acked.next_retry_at).toBeNull();
    expect(acked.outboxRows).toBe(1);
    expect(acked.journalState).toBe('DONE');

    // A repeated alarm against the terminal run is a no-op.
    await resume(stub);
    expect(sink.observedSendAttempts()).toBe(2);
    expect(sink.observedDeliveries()).toBe(1);
  });

  it('never re-sends after the ack is durable: post-ack crash resumes without touching the sink', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    await poke(stub, 'post_ack_pre_return');
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('post_ack_pre_return');
    expect(sink.observedSendAttempts()).toBe(1);

    const atAck = await readOutbox(stub);
    expect(atAck.status).toBe('acked');
    expect(atAck.journalState).toBe('ACK_RECORDED');

    await evictDurableObject(stub);
    await resume(stub);

    // Send-attempt count unchanged: the runtime alone guarantees at-most-once after a
    // durable ack, independent of any sink-side dedupe.
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);
    expect((await readOutbox(stub)).journalState).toBe('DONE');
  });

  it('crash after the attempt marker but before the send: no delivery yet, resume delivers once', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    await poke(stub, 'post_attempt_pre_send');
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('post_attempt_pre_send');

    // The attempt is durably marked but the sink was never reached: the row is in-doubt
    // with zero physical deliveries — the marker commits strictly before the side effect.
    const marked = await readOutbox(stub);
    expect(marked.status).toBe('sent_unacked');
    expect(marked.attempts).toBe(1);
    expect(sink.observedSendAttempts()).toBe(0);
    expect(sink.observedDeliveries()).toBe(0);

    await evictDurableObject(stub);
    await resume(stub);

    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);
    const acked = await readOutbox(stub);
    expect(acked.status).toBe('acked');
    expect(acked.attempts).toBe(2);
    expect(acked.journalState).toBe('DONE');
  });

  it('degraded: the sink throws on the first attempt — the error is durably recorded and the retry acks', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    FakeSink.failNextSend('sink unavailable');
    // The send throw propagates (re-raise, not swallow) after the failure is recorded, so
    // the runtime's at-least-once retry re-drives the in-doubt row.
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('sink unavailable');

    const failed = await readOutbox(stub);
    expect(failed.status).toBe('sent_unacked');
    expect(failed.attempts).toBe(1);
    expect(failed.last_error).toBe('send_failed');
    expect(sink.observedDeliveries()).toBe(0);

    await evictDurableObject(stub);
    await resume(stub);

    expect(sink.observedDeliveries()).toBe(1);
    const acked = await readOutbox(stub);
    expect(acked.status).toBe('acked');
    expect(acked.attempts).toBe(2);
    expect(acked.journalState).toBe('DONE');
  });
});

describe('SLICE-3a red proofs: the guard and the durable marker are load-bearing', () => {
  it('a durably acked row is never re-sent, even from a forged in-doubt journal state', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(sink.observedSendAttempts()).toBe(1);

    // Forge the journal back to SINK_SENT while the outbox row stays acked — the state a
    // buggy resume or a partial-write bug would produce. The ack guard must refuse the
    // re-send; without it the sink would observe a second attempt.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE journal SET state = 'SINK_SENT'");
    });
    await evictDurableObject(stub);
    await resume(stub);

    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);
    expect((await readOutbox(stub)).journalState).toBe('DONE');
  });

  it('a corrupt outbox status fails loudly at the read seam instead of silently re-sending', async () => {
    const sink = new FakeSink();
    const stub = freshStub();

    await schedule(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE outbox SET status = 'CORRUPT_STATUS'");
      state.storage.sql.exec("UPDATE journal SET state = 'SINK_SENT'");
    });

    await expect(resume(stub)).rejects.toThrow(/invalid option/i);
    expect(sink.observedSendAttempts()).toBe(1);
  });
});
