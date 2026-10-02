import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimStore } from '../src/memory/claims';
import { FakeSink } from '../src/tracer/sink';
import type { TracerDO } from '../src/tracer/tracer-do';

// Forget purge against REAL runs started through the tracer, then the real resume path
// (TracerDO.tickRun -> assertDurableGateEvidence -> flushOutbox). The only free-text slot in a
// delivery candidate is its event_id, so that is where the forgotten text is planted.
const MARKER = 'zephyr-quinoa-anchor';
const CLAIM_TEXT = `Owner uses the ${MARKER} code word`;
const EVENT = `evt-${CLAIM_TEXT}`;
const USER = 'user-forget-resume-01';
const AT = '2026-10-02T00:00:00Z';
let seq = 0;

type Stub = DurableObjectStub<TracerDO> & {
  startRun(input: { userId: string; trigger: string; occurrenceAt: number; candidate?: { push_class: string; trigger: string; event_id: string } }): Promise<string>;
};
const fresh = (): Stub => env.TRACER_DO.get(env.TRACER_DO.idFromName(`forget-resume-${seq++}`)) as Stub;
const later = () => Date.now() + 3_600_000;
const candidate = { push_class: 'fetch_alert', trigger: 'fetch_alert', event_id: EVENT };
const tick = (stub: Stub, runId: string) => runInDurableObject(stub, async (i) => { await (i as TracerDO).tickRun(runId); });
const crashBeforeFlush = (stub: Stub) => runInDurableObject(stub, (i) => { (i as TracerDO).__crashAfter = 'post_gate_pre_flush' as never; });

const clearCrash = (stub: Stub) => runInDurableObject(stub, (i) => { (i as TracerDO).__crashAfter = undefined as never; });

const purge = (stub: Stub) => runInDurableObject(stub, (_i, state) => {
  const sql = state.storage.sql;
  const store = claimStore(sql);
  const id = Number(sql.exec<{ id: number }>(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`, CLAIM_TEXT, AT, AT).one().id);
  const result = store.purge([id], AT);
  const left = (table: string, col: string) => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${col} LIKE ?`, `%${MARKER}%`).one().n;
  return { ready: result.ready, receipt: result.receipt, left: left('run_candidates', 'candidate_json') + left('outbox', 'payload') + left('held_candidates', 'candidate_json') };
});

const journalState = (stub: Stub, runId: string) => runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ state: string }>('SELECT state FROM journal WHERE run_id = ?', runId).one().state);

beforeEach(() => { new FakeSink().reset(); });

describe('forget purge then the real resume path', () => {
  it('GATED run with a pending outbox row: candidate redacted, tickRun does not throw', async () => {
    const sink = new FakeSink();
    const stub = fresh();
    const runId = await stub.startRun({ userId: USER, trigger: 'fetch_alert', occurrenceAt: later(), candidate });
    await crashBeforeFlush(stub);
    await expect(tick(stub, runId)).rejects.toThrow('post_gate_pre_flush');
    expect(await journalState(stub, runId)).toBe('GATED');

    const out = await purge(stub);
    expect(out.ready).toBe(true);
    expect(out.left).toBe(0);
    // Outbox payloads are opaque synthetic tokens by contract, so no run needs terminalising here.
    expect(out.receipt.terminalised.outbox_pending ?? 0).toBe(0);
    await clearCrash(stub);
    await expect(tick(stub, runId)).resolves.toBeUndefined();
    // The outbox row carries only an opaque token, so a resume that still delivers it leaks no
    // forgotten text and sends no placeholder; the point here is that the resume path does not throw.
    expect(sink.observedSendAttempts()).toBeLessThanOrEqual(1);
  });

  it('SINK_SENT run with a sent_unacked row: candidate redacted, tickRun does not throw', async () => {
    const sink = new FakeSink();
    const stub = fresh();
    const runId = await stub.startRun({ userId: USER, trigger: 'fetch_alert', occurrenceAt: later(), candidate });
    await crashBeforeFlush(stub);
    await expect(tick(stub, runId)).rejects.toThrow('post_gate_pre_flush');
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE journal SET state = 'SINK_SENT' WHERE run_id = ?`, runId);
      state.storage.sql.exec(`UPDATE outbox SET status = 'sent_unacked', attempts = 1, next_retry_at = ?, acked_at = NULL WHERE run_id = ?`, later(), runId);
    });

    const out = await purge(stub);
    expect(out.ready).toBe(true);
    expect(out.left).toBe(0);
    expect(out.receipt.terminalised.outbox_sent_unacked ?? 0).toBe(0);
    await clearCrash(stub);
    await expect(tick(stub, runId)).resolves.toBeUndefined();
    // The outbox row carries only an opaque token, so a resume that still delivers it leaks no
    // forgotten text and sends no placeholder; the point here is that the resume path does not throw.
    expect(sink.observedSendAttempts()).toBeLessThanOrEqual(1);
  });

  it('held run: the held row is redacted in place, still pairs with its candidate, tickRun does not throw or send', async () => {
    const sink = new FakeSink();
    const stub = fresh();
    const first = await stub.startRun({ userId: USER, trigger: 'fetch_alert', occurrenceAt: later() });
    await tick(stub, first);
    const sent = sink.observedSendAttempts();
    const heldRun = await stub.startRun({ userId: USER, trigger: 'fetch_alert', occurrenceAt: later() + 60_000, candidate });
    await tick(stub, heldRun);
    const heldRows = () => runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ event_id: string }>('SELECT event_id FROM held_candidates').toArray().map((r) => r.event_id));
    expect(await heldRows()).toContain(EVENT);

    const out = await purge(stub);
    expect(out.ready).toBe(true);
    expect(out.left).toBe(0);
    expect(out.receipt.redacted.held_candidates).toBe(1);
    expect((await heldRows()).some((id) => id.includes(MARKER))).toBe(false);
    expect((await heldRows()).length).toBe(1);
    await expect(tick(stub, heldRun)).resolves.toBeUndefined();
    expect(sink.observedSendAttempts()).toBe(sent);
  });

  it('acked run: only redacted, resume still finalises without a second send', async () => {
    const sink = new FakeSink();
    const stub = fresh();
    const runId = await stub.startRun({ userId: USER, trigger: 'fetch_alert', occurrenceAt: later(), candidate });
    await tick(stub, runId);
    expect(sink.observedSendAttempts()).toBe(1);
    const out = await purge(stub);
    expect(out.ready).toBe(true);
    expect(out.receipt.terminalised.outbox_pending ?? 0).toBe(0);
    await expect(tick(stub, runId)).resolves.toBeUndefined();
    expect(sink.observedSendAttempts()).toBe(1);
  });
});
