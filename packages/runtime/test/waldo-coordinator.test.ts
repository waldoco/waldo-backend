import {
  canonicalizeSurfaceCommandRequestForDigest,
  responsibilityCaptureRequestSchema,
  responsibilityCaptureTrustedEnvelopeSchema,
  responsibilityProjectionPageSchema,
  type ResponsibilityCaptureRequest,
} from '@waldo/contracts';
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { WaldoCoordinator } from '../src/coordinator/waldo-coordinator';
import { OutcomeModule } from '../src/coordinator/outcome-module';
import {
  DO_PRODUCT_TABLES,
  DO_RUNTIME_SUBSTRATE_TABLES,
  DO_SCHEMA_METADATA_TABLE,
} from '../src/do-schema';
import type { RunLoopDO } from '../src/run-loop/do';

let sequence = 0;

function freshStub(ownerId: string): DurableObjectStub<RunLoopDO> {
  sequence += 1;
  return env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName(`${ownerId}-${sequence}`));
}

async function digestRequest(request: ResponsibilityCaptureRequest): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(
    canonicalizeSurfaceCommandRequestForDigest(request),
  );
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function captureInput(
  ownerId: string,
  userStatement: string,
  requestId = `request_${sequence}`,
  planning: Pick<ResponsibilityCaptureRequest['payload'], 'mission' | 'workUnits'> = {},
) {
  const request = responsibilityCaptureRequestSchema.parse({
    protocolVersion: '0.1',
    requestId,
    commandType: 'responsibility.capture',
    presenceRegistrationId: 'presence_registration_01',
    clientIssuedAt: '2026-08-06T06:00:00.000Z',
    payload: { userStatement, ...planning },
  });
  const trustedEnvelope = responsibilityCaptureTrustedEnvelopeSchema.parse({
    protocolVersion: '0.1',
    commandId: `command_${sequence}`,
    commandType: 'responsibility.capture',
    ownerId,
    actor: { kind: 'presence', id: 'presence_01' },
    presenceId: 'presence_01',
    authenticatedSessionId: 'authenticated_session_01',
    ownerPolicyRevision: 1,
    authAssurance: 'verified_session',
    ownerRootRoutingVersion: 1,
    requestDigest: await digestRequest(request),
    correlationId: `correlation_${sequence}`,
    receivedAt: '2026-08-06T06:00:01.000Z',
    payload: request.payload,
  });
  return { routedOwnerId: ownerId, request, trustedEnvelope };
}

describe('WaldoCoordinator responsibility capture', () => {
  it('runs inside the explicitly manifested RunLoop Durable Object substrate', async () => {
    const stub = freshStub('owner_manifest_01');
    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).toArray().map((row) => row.name),
    );
    expect(tables.filter((table) => !table.startsWith('_cf_'))).toEqual(
      [
        ...DO_PRODUCT_TABLES,
        ...DO_RUNTIME_SUBSTRATE_TABLES,
        DO_SCHEMA_METADATA_TABLE,
      ].sort(),
    );
  });

  it('admits a simple capture as a canonical Outcome and preserves the exact statement', async () => {
    const ownerId = 'owner_capture_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(ownerId, '  Make sure this exact wording is handled.  ');

    const result = await runInDurableObject(stub, (instance) =>
      instance.__waldoCaptureResponsibilityForTest(input),
    );

    expect(result).toMatchObject({
      duplicate: false,
      ownerId,
      requestId: input.request.requestId,
      outcome: {
        ownerId,
        revision: 1,
        state: 'captured',
        userStatement: input.request.payload.userStatement,
      },
      mission: null,
      workUnits: [],
      projectionCursor: 1,
    });
    expect(result.outcome.id).toMatch(/^outcome_[A-Za-z0-9-]+$/);
  });

  it('returns the exact persisted result for a duplicate request identity and digest', async () => {
    const ownerId = 'owner_duplicate_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(ownerId, 'Handle this once.');

    const [first, duplicate, counts] = await runInDurableObject(stub, async (instance, state) => {
      const initial = await instance.__waldoCaptureResponsibilityForTest(input);
      const replayed = await instance.__waldoCaptureResponsibilityForTest(input);
      return [initial, replayed, {
        outcomes: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM outcomes').one().n,
        events: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM outcome_domain_events').one().n,
        projections: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM responsibility_projection').one().n,
        commands: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM responsibility_commands').one().n,
      }] as const;
    });

    expect(duplicate).toEqual(first);
    expect(counts).toEqual({ outcomes: 1, events: 1, projections: 1, commands: 1 });
  });

  it('rejects reuse of a request identity with a different admitted digest', async () => {
    const ownerId = 'owner_digest_conflict_01';
    const stub = freshStub(ownerId);
    const original = await captureInput(ownerId, 'Handle the original responsibility.');
    const conflicting = await captureInput(
      ownerId,
      'Handle a different responsibility.',
      original.request.requestId,
    );

    await runInDurableObject(stub, async (instance) => {
      const first = await instance.__waldoCaptureResponsibilityForTest(original);
      await expect(
        instance.__waldoCaptureResponsibilityForTest(conflicting),
      ).rejects.toThrow('responsibility capture digest conflict');
      await expect(
        instance.__waldoCaptureResponsibilityForTest(original),
      ).resolves.toEqual(first);
    });
  });

  it('fails closed when a persisted idempotency result is schema-valid but content-corrupt', async () => {
    const ownerId = 'owner_result_corruption_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(ownerId, 'Reject a corrupt prior result.', 'request_result_corrupt_01');
    await runInDurableObject(stub, async (instance, state) => {
      await instance.__waldoCaptureResponsibilityForTest(input);
      const stored = state.storage.sql.exec<{ result_json: string }>(
        'SELECT result_json FROM responsibility_commands WHERE request_id = ?',
        input.request.requestId,
      ).one();
      const result = JSON.parse(stored.result_json) as Record<string, unknown>;
      const outcome = result.outcome as Record<string, unknown>;
      outcome.userStatement = 'A schema-valid but false persisted statement.';
      state.storage.sql.exec(
        'UPDATE responsibility_commands SET result_json = ? WHERE request_id = ?',
        JSON.stringify(result),
        input.request.requestId,
      );
      await expect(instance.__waldoCaptureResponsibilityForTest(input)).rejects.toThrow(
        'persisted result mismatch',
      );
      outcome.userStatement = input.request.payload.userStatement;
      result.projectionCursor = 2;
      state.storage.sql.exec(
        'UPDATE responsibility_commands SET result_json = ? WHERE request_id = ?',
        JSON.stringify(result),
        input.request.requestId,
      );
      await expect(instance.__waldoCaptureResponsibilityForTest(input)).rejects.toThrow(
        'persisted result mismatch',
      );
    });
  });

  it('rejects an exact duplicate when its original domain event is missing', async () => {
    const ownerId = 'owner_duplicate_event_missing_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(ownerId, 'A duplicate requires reconstructable history.', 'request_event_missing_01');
    await runInDurableObject(stub, async (instance, state) => {
      await instance.__waldoCaptureResponsibilityForTest(input);
      state.storage.sql.exec('DELETE FROM outcome_domain_events');
      await expect(instance.__waldoCaptureResponsibilityForTest(input)).rejects.toThrow(
        'materialization mismatch',
      );
    });
  });

  it('atomically creates an optional Mission and bounded WorkUnits under the admitted Outcome', async () => {
    const ownerId = 'owner_planned_capture_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(
      ownerId,
      'Prepare and review the release.',
      `request_${sequence}`,
      {
        mission: { brief: 'Prepare a reviewable release.' },
        workUnits: [
          { responsibility: 'Prepare the release artifact.' },
          { responsibility: 'Review the release artifact.' },
        ],
      },
    );

    const result = await runInDurableObject(stub, (instance) =>
      instance.__waldoCaptureResponsibilityForTest(input),
    );

    expect(result.mission).toMatchObject({
      ownerId,
      outcomeId: result.outcome.id,
      revision: 1,
      brief: input.request.payload.mission?.brief,
      state: 'proposed',
    });
    expect(result.workUnits).toHaveLength(2);
    expect(result.workUnits).toEqual([
      expect.objectContaining({
        ownerId,
        outcomeId: result.outcome.id,
        missionId: result.mission?.id,
        position: 0,
        responsibility: input.request.payload.workUnits?.[0]?.responsibility,
        state: 'proposed',
      }),
      expect.objectContaining({
        ownerId,
        outcomeId: result.outcome.id,
        missionId: result.mission?.id,
        position: 1,
        responsibility: input.request.payload.workUnits?.[1]?.responsibility,
        state: 'proposed',
      }),
    ]);
    expect(result.projectionCursor).toBe(4);
  });

  it('binds one owner authority root and rejects cross-owner admission without partial state', async () => {
    const stub = freshStub('owner_root_a');
    const ownerA = await captureInput(
      'owner_root_a',
      'Owner A responsibility.',
      'request_owner_root_a',
    );
    const ownerB = await captureInput(
      'owner_root_b',
      'Owner B responsibility.',
      'request_owner_root_b',
    );

    const persisted = await runInDurableObject(stub, async (instance, state) => {
      await instance.__waldoCaptureResponsibilityForTest(ownerA);
      await expect(
        instance.__waldoCaptureResponsibilityForTest(ownerB),
      ).rejects.toThrow('owner authority root mismatch');
      const sql = state.storage.sql;
      return {
        roots: sql.exec<{ count: number }>('SELECT count(*) AS count FROM owner_roots').one()
          .count,
        outcomesA: sql
          .exec<{ count: number }>(
            'SELECT count(*) AS count FROM outcomes WHERE owner_id = ?',
            'owner_root_a',
          )
          .one().count,
        outcomesB: sql
          .exec<{ count: number }>(
            'SELECT count(*) AS count FROM outcomes WHERE owner_id = ?',
            'owner_root_b',
          )
          .one().count,
      };
    });

    expect(persisted).toEqual({ roots: 1, outcomesA: 1, outcomesB: 0 });
  });

  it('rolls back state, events, idempotency, and projections after an injected transaction failure', async () => {
    const ownerId = 'owner_atomic_failure_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(
      ownerId,
      'This transaction must be all or nothing.',
      'request_atomic_failure_01',
      {
        mission: { brief: 'Rollback the whole Mission.' },
        workUnits: [
          { responsibility: 'Rollback WorkUnit one.' },
          { responsibility: 'Rollback WorkUnit two.' },
        ],
      },
    );

    const counts = await runInDurableObject(stub, async (_instance, state) => {
      let id = 0;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-06T06:30:00.000Z',
        newId: (kind) => `${kind}_failure_${++id}`,
        sha256Hex,
        afterWrite(stage) {
          if (stage === 'idempotency') throw new Error('injected transaction failure');
        },
      });

      await expect(coordinator.captureResponsibility(input)).rejects.toThrow(
        'injected transaction failure',
      );
      const sql = state.storage.sql;
      return Object.fromEntries(
        [
          'owner_roots',
          'outcomes',
          'missions',
          'work_units',
          'outcome_domain_events',
          'responsibility_commands',
          'responsibility_projection',
          'responsibility_projection_state',
        ].map((table) => [
          table,
          sql.exec<{ count: number }>(`SELECT count(*) AS count FROM ${table}`).one().count,
        ]),
      );
    });

    expect(counts).toEqual({
      owner_roots: 0,
      outcomes: 0,
      missions: 0,
      work_units: 0,
      outcome_domain_events: 0,
      responsibility_commands: 0,
      responsibility_projection: 0,
      responsibility_projection_state: 0,
    });
  });

  it('publishes stable ordered pages and rejects stale or impossible client cursors', async () => {
    const ownerId = 'owner_projection_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(ownerId, 'Plan this bounded outcome.', 'request_page_01', {
      mission: { brief: 'Bound the work.' },
      workUnits: [
        { responsibility: 'First bounded unit.' },
        { responsibility: 'Second bounded unit.' },
      ],
    });

    await runInDurableObject(stub, async (instance) => {
      await instance.__waldoCaptureResponsibilityForTest(input);
      const first = instance.__waldoReadResponsibilityProjectionForTest({
        routedOwnerId: ownerId,
        fromExclusiveCursor: 0,
        limit: 2,
      });
      expect(responsibilityProjectionPageSchema.parse(first)).toEqual(first);
      expect(first.items.map((item) => item.cursor)).toEqual([1, 2]);
      expect(first.hasMore).toBe(true);

      const second = instance.__waldoReadResponsibilityProjectionForTest({
        routedOwnerId: ownerId,
        snapshotId: first.snapshotId,
        fromExclusiveCursor: first.nextCursor,
        limit: 2,
      });
      expect(second.items.map((item) => item.cursor)).toEqual([3, 4]);
      expect(second.hasMore).toBe(false);
      expect(new Set([...first.items, ...second.items].map((item) => item.cursor)).size).toBe(4);

      expect(() => instance.__waldoReadResponsibilityProjectionForTest({
        routedOwnerId: ownerId,
        fromExclusiveCursor: first.nextCursor,
        limit: 1,
      })).toThrow('snapshot_replaced');

      expect(() => instance.__waldoReadResponsibilityProjectionForTest({
        routedOwnerId: ownerId,
        snapshotId: 'snapshot_stale_01',
        fromExclusiveCursor: second.nextCursor,
        limit: 1,
      })).toThrow('snapshot_replaced');
      expect(() => instance.__waldoReadResponsibilityProjectionForTest({
        routedOwnerId: ownerId,
        snapshotId: first.snapshotId,
        fromExclusiveCursor: second.highWaterCursor + 1,
        limit: 1,
      })).toThrow('cursor_ahead');
    });
  });

  it('fails closed when a stored projection cursor column diverges from its typed item', async () => {
    const ownerId = 'owner_projection_cursor_corrupt_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(ownerId, 'Detect a projection cursor gap.', 'request_cursor_corrupt_01');
    await runInDurableObject(stub, async (instance, state) => {
      await instance.__waldoCaptureResponsibilityForTest(input);
      state.storage.sql.exec(
        'UPDATE responsibility_projection SET owner_cursor = 2 WHERE owner_cursor = 1',
      );
      expect(() => instance.__waldoReadResponsibilityProjectionForTest({
        routedOwnerId: ownerId,
        fromExclusiveCursor: 0,
        limit: 10,
      })).toThrow('cursor_gap');
      expect(() => instance.__waldoReplayResponsibilityForTest(ownerId)).toThrow(
        'materialization mismatch',
      );
    });
  });

  it('shortens a valid large projection page before the protocol byte ceiling', async () => {
    const ownerId = 'owner_projection_bytes_01';
    const stub = freshStub(ownerId);
    const inputs = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        captureInput(ownerId, `Capture ${index}: ${'x'.repeat(8_100)}`, `request_bytes_${index}`),
      ),
    );
    const page = await runInDurableObject(stub, async (instance) => {
      for (const input of inputs) await instance.__waldoCaptureResponsibilityForTest(input);
      return instance.__waldoReadResponsibilityProjectionForTest({
        routedOwnerId: ownerId,
        fromExclusiveCursor: 0,
        limit: 256,
      });
    });
    expect(responsibilityProjectionPageSchema.parse(page)).toEqual(page);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThan(32);
    expect(page.hasMore).toBe(true);
  });

  it('replays events deterministically through a reconstructed coordinator', async () => {
    const ownerId = 'owner_replay_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(ownerId, 'Reconstruct this responsibility.', 'request_replay_01', {
      workUnits: [{ responsibility: 'A direct bounded WorkUnit.' }],
    });

    const result = await runInDurableObject(stub, async (instance, state) => {
      const captured = await instance.__waldoCaptureResponsibilityForTest(input);
      const first = instance.__waldoReplayResponsibilityForTest(ownerId);
      const reconstructed = new WaldoCoordinator(state.storage, {
        now: () => '2026-08-06T07:00:00.000Z',
        newId: (kind) => `${kind}_unused`,
        sha256Hex,
      });
      const second = reconstructed.replayResponsibility(ownerId);
      return { captured, first, second };
    });

    expect(result.second).toEqual(result.first);
    expect(result.second.outcomes).toEqual([result.captured.outcome]);
    expect(result.second.missions).toEqual([]);
    expect(result.second.workUnits).toEqual(result.captured.workUnits);
    expect(result.second.items.map((item) => item.cursor)).toEqual([1, 2]);
  });

  it('fails closed on stale revisions and impossible replay relationships', async () => {
    const ownerId = 'owner_corrupt_replay_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(ownerId, 'Reject corrupt history.', 'request_corrupt_01', {
      workUnits: [{ responsibility: 'Remain attached to the Outcome.' }],
    });

    await runInDurableObject(stub, async (instance, state) => {
      await instance.__waldoCaptureResponsibilityForTest(input);
      state.storage.sql.exec('PRAGMA ignore_check_constraints = ON');
      state.storage.sql.exec(
        "UPDATE outcome_domain_events SET schema_version = '0.2' WHERE aggregate_kind = 'work_unit'",
      );
      state.storage.sql.exec('PRAGMA ignore_check_constraints = OFF');
      expect(() => instance.__waldoReplayResponsibilityForTest(ownerId)).toThrow(
        'invalid responsibility event schema version',
      );
      state.storage.sql.exec(
        "UPDATE outcome_domain_events SET schema_version = '0.1' WHERE aggregate_kind = 'work_unit'",
      );
      const row = state.storage.sql.exec<{ payload_json: string }>(
        "SELECT payload_json FROM outcome_domain_events WHERE aggregate_kind = 'work_unit'",
      ).one();
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const originalUpdatedAt = payload.updatedAt;
      payload.unexpected = true;
      state.storage.sql.exec(
        "UPDATE outcome_domain_events SET payload_json = ? WHERE aggregate_kind = 'work_unit'",
        JSON.stringify(payload),
      );
      expect(() => instance.__waldoReplayResponsibilityForTest(ownerId)).toThrow(
        'invalid WorkUnit event payload',
      );
      delete payload.unexpected;
      payload.updatedAt = 'not-a-server-timestamp';
      state.storage.sql.exec(
        "UPDATE outcome_domain_events SET payload_json = ? WHERE aggregate_kind = 'work_unit'",
        JSON.stringify(payload),
      );
      expect(() => instance.__waldoReplayResponsibilityForTest(ownerId)).toThrow(
        'invalid responsibility event payload',
      );
      payload.updatedAt = originalUpdatedAt;
      payload.outcomeId = 'outcome_cross_aggregate';
      state.storage.sql.exec(
        "UPDATE outcome_domain_events SET payload_json = ? WHERE aggregate_kind = 'work_unit'",
        JSON.stringify(payload),
      );
      expect(() => instance.__waldoReplayResponsibilityForTest(ownerId)).toThrow(
        'invalid WorkUnit relationship',
      );
      state.storage.sql.exec(
        "UPDATE outcome_domain_events SET revision = 2 WHERE aggregate_kind = 'work_unit'",
      );
      expect(() => instance.__waldoReplayResponsibilityForTest(ownerId)).toThrow(
        'invalid responsibility event revision',
      );
    });
  });

  it('detects replay divergence from current state, projections, and high-water state', async () => {
    const ownerId = 'owner_materialization_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(ownerId, 'Keep every materialization consistent.', 'request_materialization_01');
    await runInDurableObject(stub, async (instance, state) => {
      await instance.__waldoCaptureResponsibilityForTest(input);
      state.storage.sql.exec(
        'UPDATE outcomes SET user_statement = ? WHERE owner_id = ?',
        'A divergent current statement.', ownerId,
      );
      expect(() => instance.__waldoReplayResponsibilityForTest(ownerId)).toThrow(
        'materialization mismatch',
      );
      state.storage.sql.exec(
        'UPDATE outcomes SET user_statement = ? WHERE owner_id = ?',
        input.request.payload.userStatement, ownerId,
      );
      state.storage.sql.exec(
        'UPDATE responsibility_projection_state SET high_water_cursor = 2 WHERE owner_id = ?',
        ownerId,
      );
      expect(() => instance.__waldoReplayResponsibilityForTest(ownerId)).toThrow(
        'materialization mismatch',
      );
    });
  });

  it('enforces an explicit bounded replay ceiling', async () => {
    const ownerId = 'owner_replay_limit_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(ownerId, 'Bound replay work.', 'request_replay_limit_01', {
      workUnits: [{ responsibility: 'Second event.' }],
    });
    await runInDurableObject(stub, async (instance, state) => {
      await instance.__waldoCaptureResponsibilityForTest(input);
      const module = new OutcomeModule(state.storage, (kind) => `${kind}_unused`, 1);
      expect(() => module.replay(ownerId)).toThrow('replay event limit exceeded');
      const byteBounded = new OutcomeModule(
        state.storage,
        (kind) => `${kind}_unused`,
        10,
        100,
      );
      expect(() => byteBounded.replay(ownerId)).toThrow('replay byte limit exceeded');
    });
  });

  it('rejects capture atomically before admitting state that exceeds replay capacity', async () => {
    const ownerId = 'owner_capture_capacity_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(ownerId, 'Capacity must preserve reconstruction.', 'request_capacity_01', {
      workUnits: [{ responsibility: 'This would require a second event.' }],
    });
    const counts = await runInDurableObject(stub, (_instance, state) => {
      let id = 0;
      const eventBounded = new OutcomeModule(
        state.storage,
        (kind) => `${kind}_capacity_${++id}`,
        1,
        100_000,
      );
      expect(() => eventBounded.captureInCurrentTransaction({
        ownerId,
        payload: input.request.payload,
        at: '2026-08-06T08:00:00.000Z',
        firstCursor: 1,
        commandId: 'command_capacity_01',
        correlationId: 'correlation_capacity_01',
      })).toThrow('event_limit');
      const byteBounded = new OutcomeModule(
        state.storage,
        (kind) => `${kind}_capacity_${++id}`,
        10,
        100,
      );
      expect(() => byteBounded.captureInCurrentTransaction({
        ownerId,
        payload: { userStatement: 'x'.repeat(1_000) },
        at: '2026-08-06T08:00:00.000Z',
        firstCursor: 1,
        commandId: 'command_capacity_02',
        correlationId: 'correlation_capacity_02',
      })).toThrow('decoded_byte_limit');
      return {
        outcomes: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM outcomes').one().n,
        events: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM outcome_domain_events').one().n,
        projections: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM responsibility_projection').one().n,
      };
    });
    expect(counts).toEqual({ outcomes: 0, events: 0, projections: 0 });
  });

  it('rejects hostile server-owned fields and WorkUnit overflow before any durable write', async () => {
    const ownerId = 'owner_hostile_01';
    const stub = freshStub(ownerId);
    const valid = await captureInput(ownerId, 'Reject smuggled authority.', 'request_hostile_01');
    const smuggled = {
      ...valid,
      request: { ...valid.request, ownerId },
    };
    const overflow = {
      ...valid,
      request: {
        ...valid.request,
        requestId: 'request_overflow_01',
        payload: {
          ...valid.request.payload,
          workUnits: Array.from({ length: 33 }, (_, index) => ({
            responsibility: `Bounded unit ${index}`,
          })),
        },
      },
    };

    const counts = await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.__waldoCaptureResponsibilityForTest(smuggled)).rejects.toThrow();
      await expect(instance.__waldoCaptureResponsibilityForTest(overflow)).rejects.toThrow();
      return {
        roots: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM owner_roots').one().n,
        outcomes: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM outcomes').one().n,
        commands: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM responsibility_commands').one().n,
      };
    });
    expect(counts).toEqual({ roots: 0, outcomes: 0, commands: 0 });
  });

  it('rejects payload, digest, and stale-revision trust conflicts before binding an owner root', async () => {
    const ownerId = 'owner_trust_conflict_01';
    const stub = freshStub(ownerId);
    const valid = await captureInput(ownerId, 'Trust only the admitted statement.', 'request_trust_01');
    const payloadMismatch = {
      ...valid,
      trustedEnvelope: {
        ...valid.trustedEnvelope,
        payload: { userStatement: 'A different trusted payload.' },
      },
    };
    const digestMismatch = {
      ...valid,
      trustedEnvelope: {
        ...valid.trustedEnvelope,
        requestDigest: `sha256:${'0'.repeat(64)}`,
      },
    };
    const staleRevision = {
      ...valid,
      trustedEnvelope: { ...valid.trustedEnvelope, expectedRevision: 1 },
    };
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.__waldoCaptureResponsibilityForTest(payloadMismatch)).rejects.toThrow(
        'payload mismatch',
      );
      await expect(instance.__waldoCaptureResponsibilityForTest(digestMismatch)).rejects.toThrow(
        'digest conflict',
      );
      await expect(instance.__waldoCaptureResponsibilityForTest(staleRevision)).rejects.toThrow(
        'revision must be server-owned',
      );
      expect(state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM owner_roots').one().n).toBe(0);
    });
  });

  it('does not let a terminal provider session mutate Outcome completion state', async () => {
    const ownerId = 'owner_session_boundary_01';
    const stub = freshStub(ownerId);
    const input = await captureInput(ownerId, 'Remain captured after session activity.', 'request_session_01');
    const dueAt = Date.now() + 500;
    const before = await runInDurableObject(stub, async (instance, state) => {
      await instance.__waldoCaptureResponsibilityForTest(input);
      return {
        events: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM outcome_domain_events').one().n,
        projections: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM responsibility_projection').one().n,
        cursor: state.storage.sql.exec<{ cursor: number }>(
          'SELECT high_water_cursor AS cursor FROM responsibility_projection_state',
        ).one().cursor,
      };
    });
    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:outcome-boundary',
      userId: ownerId,
      dueAt,
      occurrenceAt: dueAt,
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const proof = await (stub as unknown as {
      readRunProof(id: string): Promise<{ current: { state: string } }>;
    }).readRunProof(runId);
    expect(proof.current.state).toBe('DONE');

    const after = await runInDurableObject(stub, (_instance, state) => ({
      outcome: state.storage.sql.exec<{ state: string; revision: number; user_statement: string }>(
        'SELECT state, revision, user_statement FROM outcomes',
      ).one(),
      events: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM outcome_domain_events').one().n,
      projections: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM responsibility_projection').one().n,
      cursor: state.storage.sql.exec<{ cursor: number }>(
        'SELECT high_water_cursor AS cursor FROM responsibility_projection_state',
      ).one().cursor,
    }));
    expect(after).toEqual({
      ...before,
      outcome: {
        state: 'captured',
        revision: 1,
        user_statement: input.request.payload.userStatement,
      },
    });
  });
});
