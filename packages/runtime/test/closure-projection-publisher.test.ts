import {
  canonicalizeProtocolJson,
  closureProjectionPageV06Schema,
  evidenceV06Schema,
} from '@waldo/contracts';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ClosurePersistenceModule } from '../src/coordinator/closure-persistence-module';
import { ClosureProjectionPublisher } from '../src/coordinator/closure-projection-publisher';
import { provisionDoSchema } from '../src/do-schema';
import type { RuntimeProbeDO } from '../src/index';

let sequence = 0;
const at = '2026-09-07T08:30:00.000Z';
const digest = (char: string) => `sha256:${char.repeat(64)}` as const;

function freshStub(): DurableObjectStub<RuntimeProbeDO> {
  sequence += 1;
  return env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName(`closure-projection-${sequence}`));
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function evidence() {
  return evidenceV06Schema.parse({
    protocolVersion: '0.6',
    id: 'evidence_projection_01',
    ownerId: 'owner_projection_01',
    revision: 1,
    subject: {
      outcome: { id: 'outcome_01', revision: 1, digest: digest('1') },
      workUnit: { id: 'work_unit_01', revision: 1, digest: digest('2') },
    },
    acceptanceCheck: { id: 'check_01', revision: 1, digest: digest('3') },
    observation: {
      kind: 'execution_observation',
      id: 'observation_01',
      revision: 1,
      digest: digest('4'),
    },
    provenance: {
      producer: { kind: 'execution_environment', id: 'executor_01', version: '1.0.0' },
      admittedBy: { kind: 'service', id: 'evidence_verifier' },
    },
    state: 'admitted',
    observedAt: '2026-09-07T08:29:00.000Z',
    admittedAt: at,
  });
}

describe('ClosureProjectionPublisher', () => {
  it('rebuilds the closure projection from canonical v0.6 owner events without using closure tables as event truth', async () => {
    const stub = freshStub();
    const record = evidence();
    const recordDigest = `sha256:${await sha256Hex(canonicalizeProtocolJson(record))}` as const;

    const observed = await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      state.storage.sql.exec(
        'INSERT INTO owner_roots (root_key, owner_id, created_at) VALUES (1, ?, ?)',
        record.ownerId,
        at,
      );
      let eventSequence = 0;
      const persistence = new ClosurePersistenceModule(
        state.storage,
        (kind) => `${kind}_${++eventSequence}`,
      );
      state.storage.transactionSync(() =>
        persistence.persistEvidenceInCurrentTransaction({
          evidence: record,
          evidenceDigest: recordDigest,
          requestId: 'request_projection_01',
          requestDigest: digest('a'),
          requestJson: '{}',
          correlationId: 'correlation_projection_01',
          recordedAt: at,
        }),
      );

      state.storage.sql.exec('DELETE FROM closure_projection');
      state.storage.sql.exec('DELETE FROM closure_projection_state');

      let snapshotSequence = 0;
      const projections = new ClosureProjectionPublisher(
        state.storage,
        () => `closure_snapshot_${++snapshotSequence}`,
        sha256Hex,
      );
      const rebuilt = state.storage.transactionSync(() =>
        projections.rebuildInCurrentTransaction(record.ownerId, '2026-09-07T08:31:00.000Z'),
      );
      const page = await projections.read({
        ownerId: record.ownerId,
        fromExclusiveCursor: 0,
        limit: 32,
        snapshotId: rebuilt.snapshotId,
        generatedAt: '2026-09-07T08:32:00.000Z',
      });
      return {
        rebuilt,
        page,
        persistedRecordStillPresent: state.storage.sql.exec<{ n: number }>(
          'SELECT count(*) AS n FROM closure_evidence WHERE owner_id = ?',
          record.ownerId,
        ).one().n,
      };
    });

    expect(observed.rebuilt).toEqual({
      snapshotId: 'closure_snapshot_1',
      highWaterCursor: 1,
      itemCount: 1,
    });
    const page = closureProjectionPageV06Schema.parse(observed.page);
    expect(page).toMatchObject({
      protocolVersion: '0.6',
      ownerId: record.ownerId,
      projectionName: 'responsibility.closure',
      snapshotId: 'closure_snapshot_1',
      fromExclusiveCursor: 0,
      highWaterCursor: 1,
      nextCursor: 1,
      hasMore: false,
      items: [{ cursor: 1, itemType: 'evidence', record, recordDigest }],
    });
    expect(observed.persistedRecordStillPresent).toBe(1);
  });

  it('rejects a replaced snapshot cursor rather than silently switching projection generations', async () => {
    const stub = freshStub();
    const record = evidence();
    const recordDigest = `sha256:${await sha256Hex(canonicalizeProtocolJson(record))}` as const;
    const rejected = await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      state.storage.sql.exec(
        'INSERT INTO owner_roots (root_key, owner_id, created_at) VALUES (1, ?, ?)',
        record.ownerId,
        at,
      );
      const persistence = new ClosurePersistenceModule(
        state.storage,
        (kind) => `${kind}_projection`,
      );
      state.storage.transactionSync(() =>
        persistence.persistEvidenceInCurrentTransaction({
          evidence: record,
          evidenceDigest: recordDigest,
          requestId: 'request_projection_02',
          requestDigest: digest('b'),
          requestJson: '{}',
          correlationId: 'correlation_projection_02',
          recordedAt: at,
        }),
      );
      const projections = new ClosureProjectionPublisher(
        state.storage,
        () => 'closure_snapshot_rebuilt',
        sha256Hex,
      );
      state.storage.transactionSync(() => {
        state.storage.sql.exec('DELETE FROM closure_projection_state');
        projections.rebuildInCurrentTransaction(record.ownerId, at);
      });
      try {
        await projections.read({
          ownerId: record.ownerId,
          fromExclusiveCursor: 0,
          limit: 32,
          snapshotId: 'stale_snapshot_id',
          generatedAt: at,
        });
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toBe(true);
  });
});