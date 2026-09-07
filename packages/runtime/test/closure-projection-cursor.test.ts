import {
  canonicalizeProtocolJson,
  evidenceV06Schema,
} from '@waldo/contracts';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ClosurePersistenceModule } from '../src/coordinator/closure-persistence-module';
import { ClosureProjectionPublisher } from '../src/coordinator/closure-projection-publisher';
import { OwnerEventLog } from '../src/coordinator/owner-event-log';
import { provisionDoSchema } from '../src/do-schema';
import type { RuntimeProbeDO } from '../src/index';

let sequence = 0;
const at = '2026-09-07T09:00:00.000Z';
const digest = (char: string) => `sha256:${char.repeat(64)}` as const;

function freshStub(): DurableObjectStub<RuntimeProbeDO> {
  sequence += 1;
  return env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName(`closure-cursor-${sequence}`));
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function record() {
  return evidenceV06Schema.parse({
    protocolVersion: '0.6',
    id: 'evidence_cursor_01',
    ownerId: 'owner_cursor_01',
    revision: 1,
    subject: {
      outcome: { id: 'outcome_01', revision: 1, digest: digest('1') },
      workUnit: null,
    },
    acceptanceCheck: { id: 'check_01', revision: 1, digest: digest('2') },
    observation: {
      kind: 'person_statement',
      id: 'statement_01',
      revision: 1,
      digest: digest('3'),
    },
    provenance: {
      producer: { kind: 'person', id: 'owner_cursor_01', version: '1.0.0' },
      admittedBy: { kind: 'service', id: 'evidence_verifier' },
    },
    state: 'admitted',
    observedAt: at,
    admittedAt: at,
  });
}

describe('closure projection cursor isolation', () => {
  it('uses the last closure event as high water even when later owner events are unrelated', async () => {
    const stub = freshStub();
    const evidence = record();
    const recordDigest = `sha256:${await sha256Hex(canonicalizeProtocolJson(evidence))}` as const;
    const page = await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      state.storage.sql.exec(
        'INSERT INTO owner_roots (root_key, owner_id, created_at) VALUES (1, ?, ?)',
        evidence.ownerId,
        at,
      );
      let ids = 0;
      const persistence = new ClosurePersistenceModule(
        state.storage,
        (kind) => `${kind}_${++ids}`,
      );
      state.storage.transactionSync(() =>
        persistence.persistEvidenceInCurrentTransaction({
          evidence,
          evidenceDigest: recordDigest,
          requestId: 'request_cursor_01',
          requestDigest: digest('a'),
          requestJson: '{}',
          correlationId: 'correlation_cursor_01',
          recordedAt: at,
        }),
      );

      const events = new OwnerEventLog(state.storage);
      state.storage.transactionSync(() => {
        events.appendInCurrentTransaction({
          schemaVersion: '0.2',
          eventId: 'event_unrelated_01',
          ownerId: evidence.ownerId,
          aggregateKind: 'outcome',
          aggregateId: 'outcome_unrelated_01',
          revision: 1,
          eventType: 'outcome.captured',
          causationId: 'request_unrelated_01',
          correlationId: 'correlation_unrelated_01',
          occurredAt: at,
          payloadJson: JSON.stringify({ id: 'outcome_unrelated_01' }),
        });
      });

      const projection = new ClosureProjectionPublisher(
        state.storage,
        () => 'closure_snapshot_cursor_01',
        sha256Hex,
      );
      return projection.read({
        ownerId: evidence.ownerId,
        fromExclusiveCursor: 0,
        limit: 32,
        generatedAt: at,
      });
    });

    expect(page.highWaterCursor).toBe(1);
    expect(page.nextCursor).toBe(1);
    expect(page.hasMore).toBe(false);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.itemType).toBe('evidence');
  });
});