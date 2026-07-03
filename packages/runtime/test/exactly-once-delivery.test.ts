import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TracerDO } from '../src/tracer/tracer-do';
import type { NotificationReceiverDO, ReceiverFault } from '../src/tracer/receiver-do';

// Cross-eviction exactly-once DELIVERY substrate (FOUNDATION-HANDOVER §6.3). The proof point is the
// durable receiver ledger in NotificationReceiverDO — a separate DO that survives the tracer's eviction
// — NOT an in-process sink counter. The receiver is the test stand-in for Supabase notification_log's
// `idempotency_key UNIQUE` write-once mirror (ADR-0054): exactly-once delivery = at-least-once send with
// a stable idempotency_key (TracerDO) + write-once dedup at the receiver. Scenarios proven here: normal,
// retry-after-transient-failure, crash-after-reservation-before-ack, crash-after-send-before-ack, and
// duplicate-replay-of-the-same-key — each read at the durable layer, plus break-proofs that keep the
// delivery-once assertion non-vacuous.

const KIND = 'fetch_alert';

let seq = 0;
type Fixture = {
  user: string;
  stub: DurableObjectStub<TracerDO>;
  receiver: DurableObjectStub<NotificationReceiverDO>;
};
function fresh(): Fixture {
  seq += 1;
  const user = `user-delivery-${seq}`;
  const stub = env.TRACER_DO.get(env.TRACER_DO.idFromName(`delivery-${seq}`));
  const receiver = env.NOTIFICATION_RECEIVER_DO.get(
    env.NOTIFICATION_RECEIVER_DO.idFromName(`notif:${user}`),
  );
  return { user, stub, receiver };
}

function futureOccurrence(): number {
  return Date.now() + 3_600_000;
}

async function schedule(f: Fixture): Promise<string> {
  return f.stub.schedule({ userId: f.user, trigger: KIND, occurrenceAt: futureOccurrence() });
}

async function resume(f: Fixture): Promise<void> {
  await runInDurableObject(f.stub, async (instance) => {
    await instance.alarm();
  });
}

// Total accepted deliveries in the reconstructed RECEIVER DO's SQLite — the durable delivery-once proof.
async function deliveredTotal(f: Fixture): Promise<number> {
  return runInDurableObject(f.receiver, (_i, state) =>
    state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM delivered').one().n,
  );
}

// Deliveries recorded under one idempotency key — 1 under the write-once contract, 2 if dedup is broken.
async function deliveredForKey(f: Fixture, key: string): Promise<number> {
  return runInDurableObject(f.receiver, (_i, state) =>
    state.storage.sql
      .exec<{ n: number }>('SELECT count(*) AS n FROM delivered WHERE idempotency_key = ?', key)
      .one().n,
  );
}

// The stable idempotency key the sender committed to the outbox row (never recomputed on re-send).
async function committedKey(f: Fixture): Promise<string | null> {
  return runInDurableObject(f.stub, (_i, state) => {
    const row = state.storage.sql
      .exec<{ idempotency_key: string }>('SELECT idempotency_key FROM outbox LIMIT 1')
      .toArray()[0];
    return row?.idempotency_key ?? null;
  });
}

async function runState(f: Fixture): Promise<string> {
  return runInDurableObject(f.stub, (_i, state) => {
    const row = state.storage.sql
      .exec<{ state: string }>('SELECT state FROM journal LIMIT 1')
      .toArray()[0];
    return row?.state ?? 'NONE';
  });
}

async function setReceiverFault(f: Fixture, fault: ReceiverFault): Promise<void> {
  await runInDurableObject(f.receiver, (instance) => {
    instance.__fault = fault;
  });
}

describe('exactly-once DELIVERY across cross-eviction (durable receiver ledger)', () => {
  it('scenario 1 — normal delivery: one send, one durable ledger row, surviving receiver eviction', async () => {
    const f = fresh();

    await schedule(f);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect(await runState(f)).toBe('DONE');
    expect(await deliveredTotal(f)).toBe(1);

    // The proof is durable: evict the receiver DO (tear down its in-memory instance) and the ledger,
    // read from reconstructed SQLite, still shows exactly one delivery.
    await evictDurableObject(f.receiver);
    expect(await deliveredTotal(f)).toBe(1);
  });

  it('scenario 2 — retry after a transient receiver failure: the send fails, nothing recorded, the retry delivers once', async () => {
    const f = fresh();

    await schedule(f);
    // The next deliver() rejects once (connection-refused analog): the gate has committed, but the
    // provider send throws, so the flush throws with the run parked at GATED and no delivery recorded.
    await setReceiverFault(f, 'transient_once');
    await expect(runDurableObjectAlarm(f.stub)).rejects.toThrow(/transient|receiver-fault/i);

    expect(await runState(f)).toBe('GATED');
    expect(await deliveredTotal(f)).toBe(0);

    await evictDurableObject(f.stub);
    await resume(f); // fault has cleared itself; the re-drive delivers

    expect(await runState(f)).toBe('DONE');
    expect(await deliveredTotal(f)).toBe(1);
  });

  it('scenario 3 — crash after reservation (GATED) but before the send: resume delivers exactly once', async () => {
    const f = fresh();

    await schedule(f);
    await runInDurableObject(f.stub, (instance) => {
      instance.__crashAfter = 'post_gate_pre_sink';
    });
    await expect(runDurableObjectAlarm(f.stub)).rejects.toThrow('post_gate_pre_sink');

    // Reserved: the outbox row is committed, but nothing was delivered — the receiver ledger is empty.
    expect(await runState(f)).toBe('GATED');
    expect(await deliveredTotal(f)).toBe(0);

    await evictDurableObject(f.stub);
    await resume(f);

    expect(await runState(f)).toBe('DONE');
    expect(await deliveredTotal(f)).toBe(1);
  });

  it('scenario 4 — crash after provider send before local ack: the durable receiver dedups the re-send', async () => {
    const f = fresh();

    await schedule(f);
    await runInDurableObject(f.stub, (instance) => {
      instance.__crashAfter = 'post_sink_pre_ack';
    });
    // Send happens (durable in the receiver), then the handler throws before recording the ack.
    await expect(runDurableObjectAlarm(f.stub)).rejects.toThrow('post_sink_pre_ack');
    const key = await committedKey(f);
    expect(key).not.toBeNull();
    expect(await deliveredForKey(f, key as string)).toBe(1);

    // Evict BOTH DOs: the tracer loses the un-acked run (resumes from SQLite), and the receiver loses
    // its in-memory instance (its ledger must survive purely in SQLite). This is the cross-eviction the
    // in-process sink could never prove.
    await evictDurableObject(f.receiver);
    await evictDurableObject(f.stub);
    expect(await deliveredForKey(f, key as string)).toBe(1); // durable across receiver eviction

    await resume(f);

    // The re-send presents the SAME committed key; the receiver's write-once dedup collapses it.
    // deliveredTotal===1 (not 2) IS the no-drift proof: a re-send under a drifted key would land as a
    // second distinct ledger row (see break-proof B1), so a single total can only mean one stable key.
    expect(await runState(f)).toBe('DONE');
    expect(await deliveredForKey(f, key as string)).toBe(1);
    expect(await deliveredTotal(f)).toBe(1);
  });

  it('scenario 5 — duplicate replay of the same idempotency key is a no-op at the receiver', async () => {
    const f = fresh();

    await schedule(f);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    const key = (await committedKey(f)) as string;
    expect(await deliveredForKey(f, key)).toBe(1);

    // Replay the identical delivery straight at the receiver (an at-least-once transport re-presenting
    // the same key). Write-once dedup makes it a no-op: fresh === false, ledger unchanged.
    const replay = await f.receiver.deliver({ idempotency_key: key, payload: 'synthetic-token-01', at: futureOccurrence() });
    expect(replay.fresh).toBe(false);
    expect(await deliveredForKey(f, key)).toBe(1);
    expect(await deliveredTotal(f)).toBe(1);
  });
});

describe('exactly-once DELIVERY red proofs: the receiver dedup + stable key are load-bearing', () => {
  it('B1 — the receiver does NOT collapse distinct keys: a drifting key would double-deliver', async () => {
    const f = fresh();

    // Two DIFFERENT keys => two ledger rows. This is why the sender MUST re-send the SAME committed key
    // (proven stable in scenario 4): were the key recomputed/randomised on resume, delivery would double.
    const a = await f.receiver.deliver({ idempotency_key: 'a'.repeat(64), payload: 'synthetic-token-01', at: 1 });
    const b = await f.receiver.deliver({ idempotency_key: 'b'.repeat(64), payload: 'synthetic-token-01', at: 2 });
    expect(a.fresh).toBe(true);
    expect(b.fresh).toBe(true);
    expect(await deliveredTotal(f)).toBe(2);
  });

  it('B2 — a broken (non-idempotent) receiver double-records a replayed key: dedup is what gives once', async () => {
    const f = fresh();
    const key = 'c'.repeat(64);

    await setReceiverFault(f, 'non_idempotent');
    await f.receiver.deliver({ idempotency_key: key, payload: 'synthetic-token-01', at: 1 });
    await f.receiver.deliver({ idempotency_key: key, payload: 'synthetic-token-01', at: 2 });

    // With dedup disabled the same key records twice — the exact double-delivery the write-once ledger
    // prevents. This proves the correct-mode `deliveredForKey === 1` in the scenarios is non-vacuous.
    expect(await deliveredForKey(f, key)).toBe(2);
  });

  it('B3 — the ledger is durable SQLite, not in-process: a replay after receiver eviction still dedups', async () => {
    const f = fresh();
    const key = 'd'.repeat(64);

    const first = await f.receiver.deliver({ idempotency_key: key, payload: 'synthetic-token-01', at: 1 });
    expect(first.fresh).toBe(true);

    // Tear the receiver instance down. If dedup lived in memory (the §6.3 module-Map weakness) the
    // replay below would look fresh and double-record. Because it lives in the receiver's SQLite, the
    // reconstructed instance still sees the prior key and suppresses the duplicate.
    await evictDurableObject(f.receiver);

    const replay = await f.receiver.deliver({ idempotency_key: key, payload: 'synthetic-token-01', at: 2 });
    expect(replay.fresh).toBe(false);
    expect(await deliveredForKey(f, key)).toBe(1);
  });
});
