import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import type { PushClass, TriggerType } from '@waldo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSink } from '../src/tracer/sink';
import type { TracerDO } from '../src/tracer/tracer-do';

const FETCH_ALERT = 'fetch_alert';
const PRE_ACTIVITY_SPOT = 'pre_activity_spot';
const BRIEF = 'brief';
const INTERVENTION_KNOCK = 'intervention_knock';
const CONSTELLATION_FIRST = 'constellation_first';
const CONSTELLATION_UPDATE = 'constellation_update';
const ADJUSTMENT = 'adjustment';
const USER = 'user-delivery-gate-01';

type RuntimeStub = DurableObjectStub<TracerDO> & {
  startRun(input: StartRunInput): Promise<string>;
  resumeRun(runId: string): Promise<unknown>;
  tickRun(runId: string): Promise<void>;
  releaseHeld(input: ReleaseHeldInput): Promise<string | null>;
};

type StartRunInput = {
  userId: string;
  trigger: TriggerType;
  occurrenceAt: number;
  occurrenceId?: string;
  candidate?: {
    push_class: PushClass;
    trigger: TriggerType;
    event_id: string;
    expires_at?: number | null;
    sub_kind?: 'proposed' | 'executed';
  };
};

type ReleaseHeldInput = {
  userId: string;
  eventId: string;
  occurrenceAt: number;
};

type CrashPoint = 'post_gate_pre_flush';

type GateState = {
  journalState: string;
  verdict: string | null;
  gateReason: string | null;
  outboxRows: number;
  outboxStatus: string | null;
  idempotencyKey: string | null;
  classCount: number;
  lastSentAt: number | null;
  exemptSends: number;
  dailyExemptSends: number;
  countedSends: number;
  heldRows: number;
};

afterEach(() => {
  FakeSink.resetAll();
});

let seq = 0;
function freshRuntimeStub(): RuntimeStub {
  seq += 1;
  const id = env.TRACER_DO.idFromName(`delivery-gate-${seq}`);
  return env.TRACER_DO.get(id) as RuntimeStub;
}

function futureOccurrence(): number {
  return Date.now() + 3_600_000;
}

function utcOccurrence(day: string): number {
  return Date.parse(`${day}T12:00:00.000Z`);
}

function utcLocalDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

async function poke(stub: RuntimeStub, point: CrashPoint): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    (instance as TracerDO).__crashAfter = point as never;
  });
}

async function tick(stub: RuntimeStub, runId: string): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await (instance as TracerDO).tickRun(runId);
  });
}

async function releaseHeld(stub: RuntimeStub, input: ReleaseHeldInput): Promise<string | null> {
  return runInDurableObject(stub, async (instance) => {
    const runtime = instance as TracerDO & {
      releaseHeld(input: ReleaseHeldInput): Promise<string | null>;
    };
    return runtime.releaseHeld(input);
  });
}

async function heldCount(stub: RuntimeStub, eventId: string): Promise<number> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ n: number }>(
        'SELECT count(*) AS n FROM held_candidates WHERE user_id = ? AND event_id = ?',
        USER,
        eventId,
      )
      .one().n,
  );
}

async function readHeldRow(
  stub: RuntimeStub,
  eventId: string,
): Promise<{ hold_until: number; expires_at: number | null } | null> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ hold_until: number; expires_at: number | null }>(
        `SELECT hold_until, expires_at
           FROM held_candidates
          WHERE user_id = ? AND event_id = ?`,
        USER,
        eventId,
      )
      .toArray()[0] ?? null,
  );
}

async function budgetForDate(stub: RuntimeStub, localDate: string): Promise<number> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ sends_total: number }>(
        `SELECT COALESCE(sum(sends_total), 0) AS sends_total
           FROM daily_push_budget
          WHERE user_id = ? AND local_date = ?`,
        USER,
        localDate,
      )
      .one().sends_total,
  );
}

async function classCountForDate(
  stub: RuntimeStub,
  kind: PushClass,
  localDate: string,
): Promise<number> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ count: number }>(
        `SELECT count
           FROM class_state
          WHERE user_id = ? AND local_date = ? AND push_class = ?`,
        USER,
        localDate,
        kind,
      )
      .toArray()[0]?.count ?? 0,
  );
}

async function readGateState(
  stub: RuntimeStub,
  runId: string,
  kind: PushClass = FETCH_ALERT,
): Promise<GateState> {
  return runInDurableObject(stub, (_instance, state) => {
    const outbox = state.storage.sql
      .exec<{
        journal_state: string;
        verdict: string | null;
        gate_reason: string | null;
        status: string;
        idempotency_key: string;
      }>(
        `SELECT j.state AS journal_state,
                j.verdict,
                j.gate_reason,
                o.status,
                o.idempotency_key
           FROM journal j
           JOIN outbox o ON o.run_id = j.run_id
          WHERE j.run_id = ? AND o.kind = ?`,
        runId,
        kind,
      )
      .toArray()[0];
    const journal = state.storage.sql
      .exec<{
        state: string;
        verdict: string | null;
        gate_reason: string | null;
        occurrence_at: number;
      }>(
        'SELECT state, verdict, gate_reason, occurrence_at FROM journal WHERE run_id = ?',
        runId,
      )
      .one();
    const localDate = utcLocalDate(journal.occurrence_at);
    const outboxRows = state.storage.sql
      .exec<{ n: number }>(
        'SELECT count(*) AS n FROM outbox WHERE run_id = ? AND kind = ?',
        runId,
        kind,
      )
      .one().n;
    const classState = state.storage.sql
      .exec<{ count: number; last_sent_at: number | null }>(
        `SELECT count, last_sent_at
           FROM class_state
          WHERE user_id = ? AND local_date = ? AND push_class = ?`,
        USER,
        localDate,
        kind,
      )
      .toArray()[0];
    const exempt = state.storage.sql
      .exec<{ exempt_sends: number }>(
        'SELECT exempt_sends FROM exempt_telemetry WHERE user_id = ? AND push_class = ?',
        USER,
        kind,
      )
      .toArray()[0];
    const counted = state.storage.sql
      .exec<{ sends_total: number }>(
        `SELECT COALESCE(sum(sends_total), 0) AS sends_total
           FROM daily_push_budget
          WHERE user_id = ? AND local_date = ?`,
        USER,
        localDate,
      )
      .one();
    const dailyBudget = state.storage.sql
      .exec<{ exempt_sends: number }>(
        `SELECT COALESCE(sum(exempt_sends), 0) AS exempt_sends
           FROM daily_push_budget
          WHERE user_id = ? AND local_date = ?`,
        USER,
        localDate,
      )
      .one();
    const heldRows = state.storage.sql
      .exec<{ n: number }>(
        'SELECT count(*) AS n FROM held_candidates WHERE user_id = ? AND push_class = ?',
        USER,
        kind,
      )
      .one().n;

    return {
      journalState: outbox?.journal_state ?? journal.state,
      verdict: outbox?.verdict ?? journal.verdict,
      gateReason: outbox?.gate_reason ?? journal.gate_reason,
      outboxRows,
      outboxStatus: outbox?.status ?? null,
      idempotencyKey: outbox?.idempotency_key ?? null,
      classCount: classState?.count ?? 0,
      lastSentAt: classState?.last_sent_at ?? null,
      exemptSends: exempt?.exempt_sends ?? 0,
      dailyExemptSends: dailyBudget.exempt_sends,
      countedSends: counted.sends_total,
      heldRows,
    };
  });
}

describe('DeliveryGate runtime policy state', () => {
  it('rejects a forbidden user identity before opening durable run state', async () => {
    const runtime = freshRuntimeStub();

    await expect(
      runInDurableObject(runtime, (instance) =>
        (instance as TracerDO).startRun({
          userId: 'user:hrv:58',
          trigger: FETCH_ALERT,
          occurrenceAt: futureOccurrence(),
        }),
      ),
    ).rejects.toThrow('scribe:health_value_leak');

    const durableRows = await runInDurableObject(runtime, (_instance, state) => ({
      journal: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM journal').one().n,
      governor: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM loop_governor_runs')
        .one().n,
      candidates: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM run_candidates')
        .one().n,
    }));
    expect(durableRows).toEqual({ journal: 0, governor: 0, candidates: 0 });
  });

  it('rejects a secret occurrence identity before opening durable run state', async () => {
    const runtime = freshRuntimeStub();

    await expect(
      runInDurableObject(runtime, (instance) =>
        (instance as TracerDO).startRun({
          userId: USER,
          trigger: FETCH_ALERT,
          occurrenceAt: futureOccurrence(),
          occurrenceId: 'sb_secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        }),
      ),
    ).rejects.toThrow('scribe:secret_leak');

    const durableRows = await runInDurableObject(runtime, (_instance, state) => ({
      journal: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM journal').one().n,
      governor: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM loop_governor_runs')
        .one().n,
      candidates: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM run_candidates')
        .one().n,
    }));
    expect(durableRows).toEqual({ journal: 0, governor: 0, candidates: 0 });
  });

  it('rejects forbidden candidate content before opening durable run state', async () => {
    const runtime = freshRuntimeStub();

    await expect(
      runInDurableObject(runtime, (instance) =>
        (instance as TracerDO).startRun({
          userId: USER,
          trigger: FETCH_ALERT,
          occurrenceAt: futureOccurrence(),
          candidate: {
            push_class: FETCH_ALERT,
            trigger: FETCH_ALERT,
            event_id: 'HRV: 58 ms',
            expires_at: null,
          },
        }),
      ),
    ).rejects.toThrow('scribe:health_value_leak');

    const durableRows = await runInDurableObject(runtime, (_instance, state) => ({
      journal: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM journal').one().n,
      governor: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM loop_governor_runs')
        .one().n,
      candidates: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM run_candidates')
        .one().n,
    }));
    expect(durableRows).toEqual({ journal: 0, governor: 0, candidates: 0 });
  });

  it('rejects a candidate identity that Scribe would redact before persistence', async () => {
    const runtime = freshRuntimeStub();

    await expect(
      runInDurableObject(runtime, (instance) =>
        (instance as TracerDO).startRun({
          userId: USER,
          trigger: FETCH_ALERT,
          occurrenceAt: futureOccurrence(),
          candidate: {
            push_class: FETCH_ALERT,
            trigger: FETCH_ALERT,
            event_id: 'alice@example.com',
            expires_at: null,
          },
        }),
      ),
    ).rejects.toThrow('scribe:invalid_payload');

    const durableRows = await runInDurableObject(runtime, (_instance, state) => ({
      journal: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM journal').one().n,
      governor: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM loop_governor_runs')
        .one().n,
      candidates: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM run_candidates')
        .one().n,
    }));
    expect(durableRows).toEqual({ journal: 0, governor: 0, candidates: 0 });
  });

  it.each([
    ['canary', 'leaked 1111111111111111', 'canary_leak'],
    ['secret', 'sb_secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'secret_leak'],
  ] as const)('rejects a candidate containing a %s before persistence', async (_case, eventId, reason) => {
    const runtime = freshRuntimeStub();
    await expect(
      runInDurableObject(runtime, (instance) =>
        (instance as TracerDO).startRun({
          userId: USER,
          trigger: FETCH_ALERT,
          occurrenceAt: futureOccurrence(),
          candidate: {
            push_class: FETCH_ALERT,
            trigger: FETCH_ALERT,
            event_id: eventId,
            expires_at: null,
          },
        }),
      ),
    ).rejects.toThrow(`scribe:${reason}`);
    expect(await runInDurableObject(runtime, (_instance, state) =>
      state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM run_candidates').one().n,
    )).toBe(0);
  });

  it('scrubs a forbidden held candidate instead of reopening it', async () => {
    const runtime = freshRuntimeStub();
    const eventId = 'HRV: 58 ms';
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO held_candidates
           (user_id, event_id, push_class, candidate_json, hold_until, expires_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        USER,
        eventId,
        FETCH_ALERT,
        JSON.stringify({
          push_class: FETCH_ALERT,
          trigger: FETCH_ALERT,
          event_id: eventId,
          expires_at: null,
        }),
        futureOccurrence(),
      );
    });

    await expect(
      releaseHeld(runtime, { userId: USER, eventId, occurrenceAt: futureOccurrence() }),
    ).rejects.toThrow('scribe:health_value_leak');

    expect(await heldCount(runtime, eventId)).toBe(0);
    const reopened = await runInDurableObject(runtime, (_instance, state) => ({
      journal: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM journal').one().n,
      candidates: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM run_candidates')
        .one().n,
    }));
    expect(reopened).toEqual({ journal: 0, candidates: 0 });
  });

  it('scrubs a held row addressed by a non-opaque user instead of reopening it', async () => {
    const runtime = freshRuntimeStub();
    const userId = 'person@example.com';
    const eventId = 'safe-held-event';
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO held_candidates
           (user_id, event_id, push_class, candidate_json, hold_until, expires_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        userId,
        eventId,
        FETCH_ALERT,
        JSON.stringify({
          push_class: FETCH_ALERT,
          trigger: FETCH_ALERT,
          event_id: eventId,
          expires_at: null,
        }),
        futureOccurrence(),
      );
    });

    await expect(
      releaseHeld(runtime, { userId, eventId, occurrenceAt: futureOccurrence() }),
    ).rejects.toThrow('releaseHeld userId must be an opaque operational reference');

    expect(await heldCount(runtime, eventId)).toBe(0);
    expect(
      await runInDurableObject(runtime, (_instance, state) =>
        state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM journal').one().n,
      ),
    ).toBe(0);
  });

  it.each([
    ['malformed JSON', '{'],
    ['schema-invalid JSON', JSON.stringify({ unexpected: 'field' })],
  ])('scrubs a held row containing %s', async (_case, candidateJson) => {
    const runtime = freshRuntimeStub();
    const eventId = 'legacy-malformed-held-event';
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO held_candidates
           (user_id, event_id, push_class, candidate_json, hold_until, expires_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        USER,
        eventId,
        FETCH_ALERT,
        candidateJson,
        futureOccurrence(),
      );
    });

    await expect(
      releaseHeld(runtime, { userId: USER, eventId, occurrenceAt: futureOccurrence() }),
    ).rejects.toThrow('scribe:invalid_payload');
    expect(await heldCount(runtime, eventId)).toBe(0);
  });

  it('scrubs an unsafe legacy candidate before direct governor admission', async () => {
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: FETCH_ALERT,
      occurrenceAt: futureOccurrence(),
    });
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE run_candidates SET candidate_json = ? WHERE run_id = ?',
        JSON.stringify({
          push_class: FETCH_ALERT,
          trigger: FETCH_ALERT,
          event_id: 'HRV: 58 ms',
          expires_at: null,
        }),
        runId,
      );
    });

    await expect(
      runInDurableObject(runtime, (instance) => (instance as TracerDO).admitRun(runId)),
    ).rejects.toThrow('scribe:health_value_leak');
    const persisted = await runInDurableObject(runtime, (_instance, state) => ({
      journalState: state.storage.sql
        .exec<{ state: string }>('SELECT state FROM journal WHERE run_id = ?', runId)
        .one().state,
      candidateCount: state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM run_candidates WHERE run_id = ?', runId)
        .one().n,
      verdict: state.storage.sql
        .exec<{ verdict: string | null }>(
          'SELECT verdict FROM loop_governor_runs WHERE run_id = ?',
          runId,
        )
        .one().verdict,
    }));
    expect(persisted).toEqual({ journalState: 'FAILED', candidateCount: 0, verdict: null });
  });

  it('scrubs and closes an unsafe legacy candidate when resuming after eviction', async () => {
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: FETCH_ALERT,
      occurrenceAt: futureOccurrence(),
    });
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE run_candidates SET candidate_json = ? WHERE run_id = ?',
        JSON.stringify({
          push_class: FETCH_ALERT,
          trigger: FETCH_ALERT,
          event_id: 'HRV: 58 ms',
          expires_at: null,
        }),
        runId,
      );
    });
    await evictDurableObject(runtime);

    await expect(
      runInDurableObject(runtime, (instance) => (instance as TracerDO).resumeRun(runId)),
    ).rejects.toThrow('scribe:health_value_leak');

    const durableRows = await runInDurableObject(runtime, (_instance, state) => ({
      journalState: state.storage.sql
        .exec<{ state: string }>('SELECT state FROM journal WHERE run_id = ?', runId)
        .one().state,
      candidates: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM run_candidates WHERE run_id = ?', runId)
        .one().n,
      held: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM held_candidates')
        .one().n,
      outbox: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE run_id = ?', runId)
        .one().n,
      classState: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM class_state')
        .one().n,
    }));
    expect(durableRows).toEqual({
      journalState: 'FAILED',
      candidates: 0,
      held: 0,
      outbox: 0,
      classState: 0,
    });

    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO run_candidates (run_id, candidate_json) VALUES (?, ?)',
        runId,
        JSON.stringify({
          push_class: FETCH_ALERT,
          trigger: FETCH_ALERT,
          event_id: 'HRV: 58 ms',
          expires_at: null,
        }),
      );
    });
    await expect(
      runInDurableObject(runtime, (instance) => (instance as TracerDO).resumeRun(runId)),
    ).rejects.toThrow('scribe:health_value_leak');
    const terminalRepair = await runInDurableObject(runtime, (_instance, state) => ({
      journalState: state.storage.sql
        .exec<{ state: string }>('SELECT state FROM journal WHERE run_id = ?', runId)
        .one().state,
      candidates: state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM run_candidates WHERE run_id = ?', runId)
        .one().n,
    }));
    expect(terminalRepair).toEqual({ journalState: 'FAILED', candidates: 0 });
  });

  it.each([
    ['malformed JSON', '{'],
    [
      'schema-invalid JSON',
      JSON.stringify({
        push_class: FETCH_ALERT,
        trigger: FETCH_ALERT,
        event_id: 'safe-event-id',
        expires_at: null,
        unexpected: 'field',
      }),
    ],
  ])('scrubs and closes a legacy candidate containing %s', async (_case, candidateJson) => {
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: FETCH_ALERT,
      occurrenceAt: futureOccurrence(),
    });
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE run_candidates SET candidate_json = ? WHERE run_id = ?',
        candidateJson,
        runId,
      );
    });

    await expect(
      runInDurableObject(runtime, (instance) => (instance as TracerDO).resumeRun(runId)),
    ).rejects.toThrow('scribe:invalid_payload');

    const repaired = await runInDurableObject(runtime, (_instance, state) => ({
      journalState: state.storage.sql
        .exec<{ state: string }>('SELECT state FROM journal WHERE run_id = ?', runId)
        .one().state,
      candidates: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM run_candidates WHERE run_id = ?', runId)
        .one().n,
      held: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM held_candidates')
        .one().n,
      outbox: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE run_id = ?', runId)
        .one().n,
    }));
    expect(repaired).toEqual({ journalState: 'FAILED', candidates: 0, held: 0, outbox: 0 });
  });

  it('scrubs a redaction-colliding legacy candidate before gate effects', async () => {
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: FETCH_ALERT,
      occurrenceAt: futureOccurrence(),
    });
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE run_candidates SET candidate_json = ? WHERE run_id = ?',
        JSON.stringify({
          push_class: FETCH_ALERT,
          trigger: FETCH_ALERT,
          event_id: 'bob@example.com',
          expires_at: null,
        }),
        runId,
      );
    });

    await expect(tick(runtime, runId)).rejects.toThrow('scribe:invalid_payload');

    const repaired = await runInDurableObject(runtime, (_instance, state) => ({
      journalState: state.storage.sql
        .exec<{ state: string }>('SELECT state FROM journal WHERE run_id = ?', runId)
        .one().state,
      candidates: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM run_candidates WHERE run_id = ?', runId)
        .one().n,
      held: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM held_candidates')
        .one().n,
      outbox: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE run_id = ?', runId)
        .one().n,
      classState: state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM class_state')
        .one().n,
    }));
    expect(repaired).toEqual({
      journalState: 'FAILED',
      candidates: 0,
      held: 0,
      outbox: 0,
      classState: 0,
    });
  });

  it('commits fetch_alert gate state and outbox intent atomically, then resumes without re-stamping', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    const runId = await runtime.startRun({
      userId: USER,
      trigger: FETCH_ALERT,
      occurrenceAt: futureOccurrence(),
    });

    await poke(runtime, 'post_gate_pre_flush');
    await expect(tick(runtime, runId)).rejects.toThrow('post_gate_pre_flush');

    const gated = await readGateState(runtime, runId, FETCH_ALERT);
    expect(gated).toMatchObject({
      journalState: 'GATED',
      verdict: 'send',
      gateReason: null,
      outboxRows: 1,
      outboxStatus: 'pending',
      classCount: 1,
      exemptSends: 1,
      dailyExemptSends: 1,
      countedSends: 0,
    });
    expect(gated.lastSentAt).not.toBeNull();
    expect(sink.observedSendAttempts()).toBe(0);

    await evictDurableObject(runtime);
    await tick(runtime, runId);

    const resumed = await readGateState(runtime, runId, FETCH_ALERT);
    expect(resumed).toMatchObject({
      journalState: 'DONE',
      verdict: 'send',
      gateReason: null,
      outboxRows: 1,
      outboxStatus: 'acked',
      classCount: 1,
      exemptSends: 1,
      dailyExemptSends: 1,
      countedSends: 0,
    });
    expect(resumed.idempotencyKey).toBe(gated.idempotencyKey);
    expect(resumed.lastSentAt).toBe(gated.lastSentAt);
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);
  });

  it('revalidates the committed candidate before a direct outbox flush', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    const runId = await runtime.startRun({
      userId: USER,
      trigger: FETCH_ALERT,
      occurrenceAt: futureOccurrence(),
    });
    await poke(runtime, 'post_gate_pre_flush');
    await expect(tick(runtime, runId)).rejects.toThrow('post_gate_pre_flush');
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE run_candidates SET candidate_json = ? WHERE run_id = ?',
        JSON.stringify({
          push_class: FETCH_ALERT,
          trigger: FETCH_ALERT,
          event_id: 'HRV: 58 ms',
          expires_at: null,
        }),
        runId,
      );
    });

    await expect(
      runInDurableObject(runtime, (instance) => (instance as TracerDO).flushOutbox(runId)),
    ).rejects.toThrow('scribe:health_value_leak');
    expect(sink.observedSendAttempts()).toBe(0);
    const durable = await runInDurableObject(runtime, (_instance, state) => ({
      journalState: state.storage.sql
        .exec<{ state: string }>('SELECT state FROM journal WHERE run_id = ?', runId)
        .one().state,
      candidates: state.storage.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM run_candidates WHERE run_id = ?', runId)
        .one().n,
    }));
    expect(durable).toEqual({ journalState: 'FAILED', candidates: 0 });
  });

  it('freezes held fetch_alert candidates without outbox or counter mutation', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    const firstAt = futureOccurrence();
    const firstRun = await runtime.startRun({
      userId: USER,
      trigger: FETCH_ALERT,
      occurrenceAt: firstAt,
    });
    await tick(runtime, firstRun);
    expect(sink.observedSendAttempts()).toBe(1);

    const heldAt = firstAt + 60_000;
    const heldRun = await runtime.startRun({
      userId: USER,
      trigger: FETCH_ALERT,
      occurrenceAt: heldAt,
    });
    await tick(runtime, heldRun);

    const held = await readGateState(runtime, heldRun, FETCH_ALERT);
    expect(held).toMatchObject({
      journalState: 'FAILED',
      verdict: 'hold',
      gateReason: 'cooldown_active',
      outboxRows: 0,
      outboxStatus: null,
      classCount: 1,
      exemptSends: 1,
      dailyExemptSends: 1,
      countedSends: 0,
      heldRows: 1,
    });
    expect(await readHeldRow(runtime, heldRun)).toEqual({
      hold_until: firstAt + 120 * 60_000,
      expires_at: null,
    });
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);
  });

  it('drops expired candidates before counters or outbox mutate', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    const occurrenceAt = futureOccurrence();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: PRE_ACTIVITY_SPOT,
      occurrenceAt,
      candidate: {
        push_class: PRE_ACTIVITY_SPOT,
        trigger: PRE_ACTIVITY_SPOT,
        event_id: 'meeting-expired',
        expires_at: occurrenceAt - 1,
      },
    });

    await tick(runtime, runId);

    const state = await readGateState(runtime, runId, PRE_ACTIVITY_SPOT);
    expect(state).toMatchObject({
      journalState: 'FAILED',
      verdict: 'drop',
      gateReason: 'candidate_expired',
      outboxRows: 0,
      classCount: 0,
      exemptSends: 0,
      dailyExemptSends: 0,
      countedSends: 0,
      heldRows: 0,
    });
    expect(sink.observedSendAttempts()).toBe(0);
    expect(sink.observedDeliveries()).toBe(0);
  });

  it('releases a held candidate through a fresh GATED step', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    const firstRun = await runtime.startRun({
      userId: USER,
      trigger: FETCH_ALERT,
      occurrenceAt: futureOccurrence(),
    });
    await tick(runtime, firstRun);

    const heldRun = await runtime.startRun({
      userId: USER,
      trigger: FETCH_ALERT,
      occurrenceAt: futureOccurrence(),
    });
    await tick(runtime, heldRun);
    expect(await heldCount(runtime, heldRun)).toBe(1);

    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE class_state SET last_sent_at = 0 WHERE user_id = ? AND push_class = ?',
        USER,
        FETCH_ALERT,
      );
    });

    const releasedRun = await releaseHeld(runtime, {
      userId: USER,
      eventId: heldRun,
      occurrenceAt: futureOccurrence(),
    });
    expect(releasedRun).not.toBeNull();
    expect(await heldCount(runtime, heldRun)).toBe(0);

    await tick(runtime, releasedRun as string);

    const released = await readGateState(runtime, releasedRun as string, FETCH_ALERT);
    expect(released).toMatchObject({
      journalState: 'DONE',
      verdict: 'send',
      gateReason: null,
      outboxRows: 1,
      outboxStatus: 'acked',
      classCount: 2,
      exemptSends: 2,
      dailyExemptSends: 2,
      countedSends: 0,
    });
    expect(sink.observedSendAttempts()).toBe(2);
    expect(sink.observedDeliveries()).toBe(2);
  });

  it('deletes an expired held candidate without opening a release run', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    const firstAt = futureOccurrence();
    const firstRun = await runtime.startRun({
      userId: USER,
      trigger: FETCH_ALERT,
      occurrenceAt: firstAt,
    });
    await tick(runtime, firstRun);

    const heldEventId = 'fetch-expiring-held';
    const heldAt = firstAt + 60_000;
    const expiresAt = heldAt + 30 * 60_000;
    const heldRun = await runtime.startRun({
      userId: USER,
      trigger: FETCH_ALERT,
      occurrenceAt: heldAt,
      candidate: {
        push_class: FETCH_ALERT,
        trigger: FETCH_ALERT,
        event_id: heldEventId,
        expires_at: expiresAt,
      },
    });
    await tick(runtime, heldRun);
    expect(await readHeldRow(runtime, heldEventId)).toMatchObject({
      expires_at: expiresAt,
    });
    const journalRowsBeforeRelease = await runInDurableObject(runtime, (_instance, state) =>
      state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM journal').one().n,
    );

    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE held_candidates SET expires_at = 1 WHERE user_id = ? AND event_id = ?',
        USER,
        heldEventId,
      );
    });
    const releasedRun = await releaseHeld(runtime, {
      userId: USER,
      eventId: heldEventId,
      occurrenceAt: expiresAt + 60_000,
    });

    expect(releasedRun).toBeNull();
    expect(await heldCount(runtime, heldEventId)).toBe(0);
    const journalRowsAfterRelease = await runInDurableObject(runtime, (_instance, state) =>
      state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM journal').one().n,
    );
    expect(journalRowsAfterRelease).toBe(journalRowsBeforeRelease);
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);
  });

  it('charges counted budget for pre_activity_spot without exempt telemetry', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    const occurrenceAt = futureOccurrence();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: PRE_ACTIVITY_SPOT,
      occurrenceAt,
      candidate: {
        push_class: PRE_ACTIVITY_SPOT,
        trigger: PRE_ACTIVITY_SPOT,
        event_id: 'meeting-01',
        expires_at: occurrenceAt + 30 * 60_000,
      },
    });

    await tick(runtime, runId);

    const state = await readGateState(runtime, runId, PRE_ACTIVITY_SPOT);
    expect(state).toMatchObject({
      journalState: 'DONE',
      verdict: 'send',
      gateReason: null,
      outboxRows: 1,
      outboxStatus: 'acked',
      classCount: 1,
      exemptSends: 0,
      dailyExemptSends: 0,
      countedSends: 1,
    });
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);
  });

  it('scopes pre_activity_spot cooldown by event id while class count still accumulates', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    const occurrenceAt = futureOccurrence();

    const firstRun = await runtime.startRun({
      userId: USER,
      trigger: PRE_ACTIVITY_SPOT,
      occurrenceAt,
      candidate: {
        push_class: PRE_ACTIVITY_SPOT,
        trigger: PRE_ACTIVITY_SPOT,
        event_id: 'meeting-a',
        expires_at: occurrenceAt + 30 * 60_000,
      },
    });
    await tick(runtime, firstRun);

    const secondRun = await runtime.startRun({
      userId: USER,
      trigger: PRE_ACTIVITY_SPOT,
      occurrenceAt,
      candidate: {
        push_class: PRE_ACTIVITY_SPOT,
        trigger: PRE_ACTIVITY_SPOT,
        event_id: 'meeting-b',
        expires_at: occurrenceAt + 30 * 60_000,
      },
    });
    await tick(runtime, secondRun);

    const state = await readGateState(runtime, secondRun, PRE_ACTIVITY_SPOT);
    expect(state).toMatchObject({
      journalState: 'DONE',
      verdict: 'send',
      gateReason: null,
      outboxRows: 1,
      outboxStatus: 'acked',
      classCount: 2,
      exemptSends: 0,
      dailyExemptSends: 0,
      countedSends: 2,
    });
    expect(sink.observedSendAttempts()).toBe(2);
    expect(sink.observedDeliveries()).toBe(2);
  });

  it('sends brief without charging APNs budget or exempt telemetry', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    const runId = await runtime.startRun({
      userId: USER,
      trigger: BRIEF,
      occurrenceAt: futureOccurrence(),
      candidate: {
        push_class: BRIEF,
        trigger: BRIEF,
        event_id: 'brief-morning',
        expires_at: null,
      },
    });

    await tick(runtime, runId);

    const state = await readGateState(runtime, runId, BRIEF);
    expect(state).toMatchObject({
      journalState: 'DONE',
      verdict: 'send',
      gateReason: null,
      outboxRows: 1,
      outboxStatus: 'acked',
      classCount: 1,
      exemptSends: 0,
      dailyExemptSends: 0,
      countedSends: 0,
    });
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);
  });

  it('keeps intervention_knock exempt and capped at two sends', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    for (const eventId of ['intervention-01', 'intervention-02']) {
      const runId = await runtime.startRun({
        userId: USER,
        trigger: 'intervention',
        occurrenceAt: futureOccurrence(),
        candidate: {
          push_class: INTERVENTION_KNOCK,
          trigger: 'intervention',
          event_id: eventId,
          expires_at: null,
        },
      });
      await tick(runtime, runId);
    }

    const thirdRun = await runtime.startRun({
      userId: USER,
      trigger: 'intervention',
      occurrenceAt: futureOccurrence(),
      candidate: {
        push_class: INTERVENTION_KNOCK,
        trigger: 'intervention',
        event_id: 'intervention-03',
        expires_at: null,
      },
    });
    await tick(runtime, thirdRun);

    const third = await readGateState(runtime, thirdRun, INTERVENTION_KNOCK);
    expect(third).toMatchObject({
      journalState: 'FAILED',
      verdict: 'hold',
      gateReason: 'class_cap_exhausted',
      outboxRows: 0,
      classCount: 2,
      exemptSends: 2,
      dailyExemptSends: 2,
      countedSends: 0,
      heldRows: 1,
    });
    expect(sink.observedSendAttempts()).toBe(2);
    expect(sink.observedDeliveries()).toBe(2);
  });

  it('drops repeated constellation_first instead of holding a once-ever milestone', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    for (const eventId of ['constellation-01', 'constellation-02']) {
      const runId = await runtime.startRun({
        userId: USER,
        trigger: 'dreaming_mode',
        occurrenceAt: futureOccurrence(),
        candidate: {
          push_class: CONSTELLATION_FIRST,
          trigger: 'dreaming_mode',
          event_id: eventId,
          expires_at: null,
        },
      });
      await tick(runtime, runId);
    }

    const secondRows = await runInDurableObject(runtime, (_instance, state) => {
      const latest = state.storage.sql
        .exec<{ run_id: string }>('SELECT run_id FROM journal ORDER BY created_at DESC LIMIT 1')
        .one().run_id;
      const journal = state.storage.sql
        .exec<{ state: string; verdict: string | null; gate_reason: string | null }>(
          'SELECT state, verdict, gate_reason FROM journal WHERE run_id = ?',
          latest,
        )
        .one();
      const heldRows = state.storage.sql
        .exec<{ n: number }>(
          'SELECT count(*) AS n FROM held_candidates WHERE user_id = ? AND push_class = ?',
          USER,
          CONSTELLATION_FIRST,
        )
        .one().n;
      const outboxRows = state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE kind = ?', CONSTELLATION_FIRST)
        .one().n;
      return { ...journal, heldRows, outboxRows };
    });

    expect(secondRows).toEqual({
      state: 'FAILED',
      verdict: 'drop',
      gate_reason: 'once_ever_already_sent',
      heldRows: 0,
      outboxRows: 1,
    });
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);
  });

  it('applies adjustment proposed sub-cap without capping executed adjustments', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    const proposedRun = await runtime.startRun({
      userId: USER,
      trigger: 'handoff_act',
      occurrenceAt: futureOccurrence(),
      candidate: {
        push_class: ADJUSTMENT,
        trigger: 'handoff_act',
        event_id: 'adjustment-proposed-01',
        sub_kind: 'proposed',
        expires_at: null,
      },
    });
    await tick(runtime, proposedRun);

    const heldProposedRun = await runtime.startRun({
      userId: USER,
      trigger: 'handoff_act',
      occurrenceAt: futureOccurrence(),
      candidate: {
        push_class: ADJUSTMENT,
        trigger: 'handoff_act',
        event_id: 'adjustment-proposed-02',
        sub_kind: 'proposed',
        expires_at: null,
      },
    });
    await tick(runtime, heldProposedRun);

    const executedRun = await runtime.startRun({
      userId: USER,
      trigger: 'handoff_act',
      occurrenceAt: futureOccurrence(),
      candidate: {
        push_class: ADJUSTMENT,
        trigger: 'handoff_act',
        event_id: 'adjustment-executed-01',
        sub_kind: 'executed',
        expires_at: null,
      },
    });
    await tick(runtime, executedRun);

    const heldProposed = await readGateState(runtime, heldProposedRun, ADJUSTMENT);
    expect(heldProposed).toMatchObject({
      journalState: 'FAILED',
      verdict: 'hold',
      gateReason: 'cooldown_active',
      outboxRows: 0,
      classCount: 2,
      countedSends: 2,
      dailyExemptSends: 0,
    });
    const executed = await readGateState(runtime, executedRun, ADJUSTMENT);
    expect(executed).toMatchObject({
      journalState: 'DONE',
      verdict: 'send',
      gateReason: null,
      outboxRows: 1,
      outboxStatus: 'acked',
      classCount: 2,
      countedSends: 2,
      dailyExemptSends: 0,
    });
    expect(sink.observedSendAttempts()).toBe(2);
    expect(sink.observedDeliveries()).toBe(2);
  });

  it('degrades counted classes without charging budget when the Pro cap is full', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    const occurrenceAt = futureOccurrence();
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO daily_push_budget (user_id, local_date, sends_total) VALUES (?, ?, 3)',
        USER,
        utcLocalDate(occurrenceAt),
      );
    });
    const runId = await runtime.startRun({
      userId: USER,
      trigger: PRE_ACTIVITY_SPOT,
      occurrenceAt,
      candidate: {
        push_class: PRE_ACTIVITY_SPOT,
        trigger: PRE_ACTIVITY_SPOT,
        event_id: 'meeting-budget-full',
        expires_at: occurrenceAt + 30 * 60_000,
      },
    });

    await tick(runtime, runId);

    const state = await readGateState(runtime, runId, PRE_ACTIVITY_SPOT);
    expect(state).toMatchObject({
      journalState: 'DONE',
      verdict: 'degrade',
      gateReason: 'budget_cap_exhausted',
      outboxRows: 1,
      outboxStatus: 'acked',
      classCount: 1,
      exemptSends: 0,
      dailyExemptSends: 0,
      countedSends: 3,
    });
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);
  });

  it('scopes counted budget by UTC local date fallback', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO daily_push_budget (user_id, local_date, sends_total)
           VALUES (?, '2026-01-01', 3)`,
        USER,
      );
    });
    const occurrenceAt = utcOccurrence('2026-01-02');
    const runId = await runtime.startRun({
      userId: USER,
      trigger: PRE_ACTIVITY_SPOT,
      occurrenceAt,
      candidate: {
        push_class: PRE_ACTIVITY_SPOT,
        trigger: PRE_ACTIVITY_SPOT,
        event_id: 'meeting-next-day',
        expires_at: occurrenceAt + 30 * 60_000,
      },
    });

    await tick(runtime, runId);

    const state = await readGateState(runtime, runId, PRE_ACTIVITY_SPOT);
    expect(state).toMatchObject({
      journalState: 'DONE',
      verdict: 'send',
      gateReason: null,
      dailyExemptSends: 0,
      countedSends: 1,
    });
    expect(await budgetForDate(runtime, '2026-01-01')).toBe(3);
    expect(await budgetForDate(runtime, '2026-01-02')).toBe(1);
    expect(sink.observedSendAttempts()).toBe(1);
  });

  it('scopes class daily caps by UTC local date fallback while preserving class identity', async () => {
    const runtime = freshRuntimeStub();
    const sink = FakeSink.forDO(runtime.id.toString());
    for (const [day, eventId] of [
      ['2026-01-01', 'constellation-update-a'],
      ['2026-01-02', 'constellation-update-b'],
    ] as const) {
      const occurrenceAt = utcOccurrence(day);
      const runId = await runtime.startRun({
        userId: USER,
        trigger: 'dreaming_mode',
        occurrenceAt,
        candidate: {
          push_class: CONSTELLATION_UPDATE,
          trigger: 'dreaming_mode',
          event_id: eventId,
          expires_at: null,
        },
      });
      await tick(runtime, runId);
    }

    const latest = await runInDurableObject(runtime, (_instance, state) =>
      state.storage.sql
        .exec<{ state: string; verdict: string | null; gate_reason: string | null }>(
          `SELECT state, verdict, gate_reason
             FROM journal
            ORDER BY created_at DESC
            LIMIT 1`,
        )
        .one(),
    );
    expect(latest).toEqual({ state: 'DONE', verdict: 'send', gate_reason: null });
    expect(await classCountForDate(runtime, CONSTELLATION_UPDATE, '2026-01-01')).toBe(1);
    expect(await classCountForDate(runtime, CONSTELLATION_UPDATE, '2026-01-02')).toBe(1);
    expect(sink.observedSendAttempts()).toBe(2);
    expect(sink.observedDeliveries()).toBe(2);
  });
});
