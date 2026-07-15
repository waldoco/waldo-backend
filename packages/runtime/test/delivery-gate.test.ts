import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import type { PushClass, TriggerType } from '@waldo/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { RunJournalOutbox } from '../src/run-journal/outbox-runtime';
import type { Deps } from '../src/seams/deps';
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => {
      resolve = next;
    }),
    resolve,
  };
}

beforeEach(() => {
  new FakeSink().reset();
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

type DurableDeliveryFixture = {
  journalState: 'GATED' | 'SINK_SENT' | 'ACK_RECORDED' | 'DONE' | 'FAILED';
  outboxStatus: 'pending' | 'sent_unacked' | 'acked' | null;
  verdict?: 'send' | 'degrade';
  deleteCandidate?: boolean;
};

async function createCompletedDeliveryFixture(stub: RuntimeStub, suffix: string): Promise<string> {
  const occurrenceAt = futureOccurrence();
  const runId = await stub.startRun({
    userId: `${USER}-${suffix}`,
    trigger: FETCH_ALERT,
    occurrenceAt,
    candidate: {
      push_class: FETCH_ALERT,
      trigger: FETCH_ALERT,
      event_id: `durable-evidence-${suffix}`,
      expires_at: null,
    },
  });
  await tick(stub, runId);
  return runId;
}

async function stageDurableDeliveryFixture(
  stub: RuntimeStub,
  runId: string,
  fixture: DurableDeliveryFixture,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const verdict = fixture.verdict ?? 'send';
    state.storage.sql.exec(
      `UPDATE journal
          SET state = ?, verdict = ?, gate_reason = ?
        WHERE run_id = ?`,
      fixture.journalState,
      verdict,
      verdict === 'degrade' ? 'budget_cap_exhausted' : null,
      runId,
    );
    if (fixture.outboxStatus === null) {
      state.storage.sql.exec('DELETE FROM outbox WHERE run_id = ?', runId);
    } else {
      const attempts = fixture.outboxStatus === 'pending' ? 0 : 1;
      const nextRetryAt = fixture.outboxStatus === 'sent_unacked' ? futureOccurrence() : null;
      const ackedAt = fixture.outboxStatus === 'acked' ? futureOccurrence() : null;
      state.storage.sql.exec(
        `UPDATE outbox
            SET status = ?, attempts = ?, next_retry_at = ?, acked_at = ?, last_error = NULL
          WHERE run_id = ?`,
        fixture.outboxStatus,
        attempts,
        nextRetryAt,
        ackedAt,
        runId,
      );
    }
    if (fixture.deleteCandidate === true) {
      state.storage.sql.exec('DELETE FROM run_candidates WHERE run_id = ?', runId);
    }
  });
}

async function readDurableDeliveryFixture(
  stub: RuntimeStub,
  runId: string,
): Promise<{ state: string; verdict: string | null; outboxStatus: string | null }> {
  return runInDurableObject(stub, (_instance, state) => {
    const journal = state.storage.sql
      .exec<{ state: string; verdict: string | null }>(
        'SELECT state, verdict FROM journal WHERE run_id = ?',
        runId,
      )
      .one();
    const outbox = state.storage.sql
      .exec<{ status: string }>('SELECT status FROM outbox WHERE run_id = ?', runId)
      .toArray()[0];
    return { ...journal, outboxStatus: outbox?.status ?? null };
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
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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

  it('does not resurrect constellation_first on a new UTC local date', async () => {
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();

    const firstRun = await runtime.startRun({
      userId: USER,
      trigger: 'dreaming_mode',
      occurrenceAt: utcOccurrence('2026-01-01'),
      candidate: {
        push_class: CONSTELLATION_FIRST,
        trigger: 'dreaming_mode',
        event_id: 'constellation-first-2026-01-01',
        expires_at: null,
      },
    });
    await tick(runtime, firstRun);

    const nextDayRun = await runtime.startRun({
      userId: USER,
      trigger: 'dreaming_mode',
      occurrenceAt: utcOccurrence('2026-01-02'),
      candidate: {
        push_class: CONSTELLATION_FIRST,
        trigger: 'dreaming_mode',
        event_id: 'constellation-first-2026-01-02',
        expires_at: null,
      },
    });
    await tick(runtime, nextDayRun);

    expect(await readGateState(runtime, nextDayRun, CONSTELLATION_FIRST)).toMatchObject({
      journalState: 'FAILED',
      verdict: 'drop',
      gateReason: 'once_ever_already_sent',
      outboxRows: 0,
    });
    expect(await classCountForDate(runtime, CONSTELLATION_FIRST, '2026-01-01')).toBe(1);
    expect(await classCountForDate(runtime, CONSTELLATION_FIRST, '2026-01-02')).toBe(0);
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);
  });

  it('applies adjustment proposed sub-cap without capping executed adjustments', async () => {
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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

  it('serializes two final-slot candidates across async hashing', async () => {
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
    const admissionAt = utcOccurrence('2026-01-01');
    const hashes = [deferred<string>(), deferred<string>()] as const;
    let hashCalls = 0;
    let runSequence = 0;
    let outboxSequence = 0;

    const result = await runInDurableObject(runtime, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO daily_push_budget (user_id, local_date, sends_total) VALUES (?, ?, 2)',
        USER,
        utcLocalDate(admissionAt),
      );
      const deps: Deps = {
        now: () => admissionAt,
        newRunId: () => `delivery-race-run-${++runSequence}`,
        newOutboxId: () => `delivery-race-outbox-${++outboxSequence}`,
        sha256Hex: () => {
          const hash = hashCalls === 0 ? hashes[0] : hashCalls === 1 ? hashes[1] : undefined;
          hashCalls += 1;
          if (hash === undefined) throw new Error('unexpected additional hash');
          return hash.promise;
        },
      };
      const journalOutbox = new RunJournalOutbox(state.storage, deps, sink);
      const firstRunId = journalOutbox.startRun({
        userId: USER,
        trigger: PRE_ACTIVITY_SPOT,
        occurrenceAt: admissionAt,
        candidate: {
          push_class: PRE_ACTIVITY_SPOT,
          trigger: PRE_ACTIVITY_SPOT,
          event_id: 'final-slot-a',
          expires_at: null,
        },
      });
      const secondRunId = journalOutbox.startRun({
        userId: USER,
        trigger: PRE_ACTIVITY_SPOT,
        occurrenceAt: admissionAt,
        candidate: {
          push_class: PRE_ACTIVITY_SPOT,
          trigger: PRE_ACTIVITY_SPOT,
          event_id: 'final-slot-b',
          expires_at: null,
        },
      });

      const first = journalOutbox.tickRun(firstRunId);
      const second = journalOutbox.tickRun(secondRunId);
      expect(hashCalls).toBe(2);
      hashes[0].resolve('a'.repeat(64));
      hashes[1].resolve('b'.repeat(64));
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

      return {
        budget: state.storage.sql
          .exec<{ sends_total: number }>(
            'SELECT sends_total FROM daily_push_budget WHERE user_id = ? AND local_date = ?',
            USER,
            utcLocalDate(admissionAt),
          )
          .one().sends_total,
        journal: state.storage.sql
          .exec<{ state: string; verdict: string | null; gate_reason: string | null }>(
            `SELECT state, verdict, gate_reason
               FROM journal
              WHERE run_id IN (?, ?)
              ORDER BY verdict`,
            firstRunId,
            secondRunId,
          )
          .toArray(),
        outboxRows: state.storage.sql
          .exec<{ n: number }>('SELECT count(*) AS n FROM outbox')
          .one().n,
      };
    });

    expect(result).toEqual({
      budget: 3,
      journal: [
        { state: 'DONE', verdict: 'degrade', gate_reason: 'budget_cap_exhausted' },
        { state: 'DONE', verdict: 'send', gate_reason: null },
      ],
      outboxRows: 2,
    });
    expect(sink.observedSendAttempts()).toBe(2);
    expect(sink.observedDeliveries()).toBe(2);
  });

  it('treats a duplicate tick that overlaps hashing as a durable no-op', async () => {
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
    const admissionAt = utcOccurrence('2026-01-01');
    const hashes = [deferred<string>(), deferred<string>()] as const;
    let hashCalls = 0;
    let outboxSequence = 0;

    const result = await runInDurableObject(runtime, async (_instance, state) => {
      const deps: Deps = {
        now: () => admissionAt,
        newRunId: () => 'delivery-duplicate-tick-run',
        newOutboxId: () => `delivery-duplicate-tick-outbox-${++outboxSequence}`,
        sha256Hex: () => {
          const hash = hashCalls === 0 ? hashes[0] : hashCalls === 1 ? hashes[1] : undefined;
          hashCalls += 1;
          if (hash === undefined) throw new Error('unexpected additional hash');
          return hash.promise;
        },
      };
      const journalOutbox = new RunJournalOutbox(state.storage, deps, sink);
      const runId = journalOutbox.startRun({
        userId: USER,
        trigger: PRE_ACTIVITY_SPOT,
        occurrenceAt: admissionAt,
        candidate: {
          push_class: PRE_ACTIVITY_SPOT,
          trigger: PRE_ACTIVITY_SPOT,
          event_id: 'duplicate-tick-event',
          expires_at: null,
        },
      });

      const first = journalOutbox.tickRun(runId);
      const second = journalOutbox.tickRun(runId);
      expect(hashCalls).toBe(2);
      hashes[0].resolve('c'.repeat(64));
      hashes[1].resolve('c'.repeat(64));
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

      return {
        budget: state.storage.sql
          .exec<{ sends_total: number }>(
            'SELECT sends_total FROM daily_push_budget WHERE user_id = ? AND local_date = ?',
            USER,
            utcLocalDate(admissionAt),
          )
          .one().sends_total,
        classCount: state.storage.sql
          .exec<{ count: number }>(
            `SELECT count
               FROM class_state
              WHERE user_id = ? AND local_date = ? AND push_class = ?`,
            USER,
            utcLocalDate(admissionAt),
            PRE_ACTIVITY_SPOT,
          )
          .one().count,
        journal: state.storage.sql
          .exec<{ state: string; verdict: string | null }>(
            'SELECT state, verdict FROM journal WHERE run_id = ?',
            runId,
          )
          .one(),
        outboxRows: state.storage.sql
          .exec<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE run_id = ?', runId)
          .one().n,
      };
    });

    expect(result).toEqual({
      budget: 1,
      classCount: 1,
      journal: { state: 'DONE', verdict: 'send' },
      outboxRows: 1,
    });
    expect(sink.observedSendAttempts()).toBe(1);
    expect(sink.observedDeliveries()).toBe(1);
  });

  it('re-drives every valid durable delivery state once and leaves its duplicate tick inert', async () => {
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
    const fixtures = [
      { name: 'gated', journalState: 'GATED', outboxStatus: 'pending' },
      { name: 'sink-sent', journalState: 'SINK_SENT', outboxStatus: 'sent_unacked' },
      { name: 'sink-sent-acked', journalState: 'SINK_SENT', outboxStatus: 'acked' },
      { name: 'ack-recorded', journalState: 'ACK_RECORDED', outboxStatus: 'acked' },
      { name: 'done', journalState: 'DONE', outboxStatus: 'acked' },
      {
        name: 'failed-post-gate-intact',
        journalState: 'FAILED',
        outboxStatus: 'pending',
      },
      {
        name: 'failed-post-gate-intact-degrade',
        journalState: 'FAILED',
        outboxStatus: 'pending',
        verdict: 'degrade',
      },
      {
        name: 'failed-post-gate-scrubbed',
        journalState: 'FAILED',
        outboxStatus: 'pending',
        deleteCandidate: true,
      },
    ] as const satisfies readonly (DurableDeliveryFixture & { name: string })[];
    const runIds = new Map<string, string>();

    for (const fixture of fixtures) {
      const runId = await createCompletedDeliveryFixture(runtime, fixture.name);
      await stageDurableDeliveryFixture(runtime, runId, fixture);
      runIds.set(fixture.name, runId);
    }
    sink.reset();

    for (const fixture of fixtures) {
      const runId = runIds.get(fixture.name);
      if (runId === undefined) throw new Error(`missing fixture ${fixture.name}`);
      await tick(runtime, runId);
      await tick(runtime, runId);
    }

    await expect(readDurableDeliveryFixture(runtime, runIds.get('gated')!)).resolves.toEqual({
      state: 'DONE',
      verdict: 'send',
      outboxStatus: 'acked',
    });
    await expect(readDurableDeliveryFixture(runtime, runIds.get('sink-sent')!)).resolves.toEqual({
      state: 'DONE',
      verdict: 'send',
      outboxStatus: 'acked',
    });
    await expect(
      readDurableDeliveryFixture(runtime, runIds.get('sink-sent-acked')!),
    ).resolves.toEqual({
      state: 'DONE',
      verdict: 'send',
      outboxStatus: 'acked',
    });
    await expect(readDurableDeliveryFixture(runtime, runIds.get('ack-recorded')!)).resolves.toEqual({
      state: 'DONE',
      verdict: 'send',
      outboxStatus: 'acked',
    });
    await expect(readDurableDeliveryFixture(runtime, runIds.get('done')!)).resolves.toEqual({
      state: 'DONE',
      verdict: 'send',
      outboxStatus: 'acked',
    });
    await expect(
      readDurableDeliveryFixture(runtime, runIds.get('failed-post-gate-intact')!),
    ).resolves.toEqual({ state: 'FAILED', verdict: 'send', outboxStatus: 'pending' });
    await expect(
      readDurableDeliveryFixture(runtime, runIds.get('failed-post-gate-intact-degrade')!),
    ).resolves.toEqual({ state: 'FAILED', verdict: 'degrade', outboxStatus: 'pending' });
    await expect(
      readDurableDeliveryFixture(runtime, runIds.get('failed-post-gate-scrubbed')!),
    ).resolves.toEqual({ state: 'FAILED', verdict: 'send', outboxStatus: 'pending' });
    expect(sink.observedSendAttempts()).toBe(2);
    expect(sink.observedDeliveries()).toBe(2);
  });

  it('rejects inconsistent journal/outbox evidence before a duplicate tick can advance it', async () => {
    const cases = [
      { name: 'gated-acked', journalState: 'GATED', outboxStatus: 'acked' },
      { name: 'gated-sent-unacked', journalState: 'GATED', outboxStatus: 'sent_unacked' },
      { name: 'sink-sent-pending', journalState: 'SINK_SENT', outboxStatus: 'pending' },
      { name: 'ack-recorded-pending', journalState: 'ACK_RECORDED', outboxStatus: 'pending' },
      { name: 'done-sent', journalState: 'DONE', outboxStatus: 'sent_unacked' },
      {
        name: 'failed-send-acked',
        journalState: 'FAILED',
        outboxStatus: 'acked',
        deleteCandidate: true,
      },
      {
        name: 'failed-send-without-outbox',
        journalState: 'FAILED',
        outboxStatus: null,
        deleteCandidate: true,
      },
    ] as const satisfies readonly (DurableDeliveryFixture & { name: string })[];

    for (const fixture of cases) {
      const runtime = freshRuntimeStub();
      const runId = await createCompletedDeliveryFixture(runtime, fixture.name);
      await stageDurableDeliveryFixture(runtime, runId, fixture);
      await expect(tick(runtime, runId)).rejects.toThrow('journal/outbox delivery state mismatch');
    }
  });

  it.each(['send', 'degrade'] as const)(
    'rejects a failed %s whose outbox kind contradicts its intact candidate',
    async (verdict) => {
      const runtime = freshRuntimeStub();
      const runId = await createCompletedDeliveryFixture(runtime, `failed-${verdict}-wrong-kind`);
      await stageDurableDeliveryFixture(runtime, runId, {
        journalState: 'FAILED',
        outboxStatus: 'pending',
        verdict,
      });
      await runInDurableObject(runtime, (_instance, state) => {
        state.storage.sql.exec('UPDATE outbox SET kind = ? WHERE run_id = ?', BRIEF, runId);
      });

      await expect(tick(runtime, runId)).rejects.toThrow('journal/outbox delivery state mismatch');
    },
  );

  it('rejects active delivery evidence with a wrong kind or an additional kind', async () => {
    const corruptions = [
      {
        name: 'wrong-kind',
        apply(runId: string, state: DurableObjectState): void {
          state.storage.sql.exec('UPDATE outbox SET kind = ? WHERE run_id = ?', BRIEF, runId);
        },
      },
      {
        name: 'additional-kind',
        apply(runId: string, state: DurableObjectState): void {
          state.storage.sql.exec(
            `INSERT INTO outbox
               (outbox_id, run_id, kind, idempotency_key, payload,
                status, attempts, next_retry_at, acked_at, last_error, created_at)
             VALUES (?, ?, ?, ?, 'synthetic-token-01', 'pending', 0, NULL, NULL, NULL, ?)`,
            `forged-${runId}`,
            runId,
            BRIEF,
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            futureOccurrence(),
          );
        },
      },
    ] as const;

    for (const corruption of corruptions) {
      const runtime = freshRuntimeStub();
      const runId = await createCompletedDeliveryFixture(runtime, `gated-${corruption.name}`);
      await stageDurableDeliveryFixture(runtime, runId, {
        journalState: 'GATED',
        outboxStatus: 'pending',
      });
      await runInDurableObject(runtime, (_instance, state) => {
        corruption.apply(runId, state);
      });

      await expect(tick(runtime, runId)).rejects.toThrow('journal/outbox delivery state mismatch');
    }
  });

  it('scopes counted budget by UTC local date fallback', async () => {
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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
    const sink = new FakeSink();
    const runtime = freshRuntimeStub();
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
