import { createRuntimeTemporalRecallGateway } from '../../src/recall/gateway';
import type {
  ContextRecallGateway,
  ContextRecallRequest,
  ContextRecallSnapshot,
} from '../../src/context-composer';

// This fixture adapter exists only under test/. It models a separately retained taint proof for
// synthetic SQLite rows so the public composer seam can exercise a positive local SQL path. It
// is deliberately not exported or constructible from packages/runtime/src: production legacy
// rows remain unproven and must use SqliteTemporalRecallGateway.create().
const REVISION_REF = /^rev_[a-f0-9]{32}$/;

type FixtureMemoryRow = Readonly<{
  id: string;
  hall_type: string;
  content: string;
  confidence: number;
  created_at: string;
  valid_from: string;
  source_trust: string;
}>;

export function createTestOnlyTrustedLocalRecallGateway(
  sql: SqlStorage,
  revisionSeedRef: string,
): ContextRecallGateway {
  if (!REVISION_REF.test(revisionSeedRef)) throw new Error('invalid test-only recall revision seed');
  return Object.freeze({
    async recall(request: ContextRecallRequest): Promise<ContextRecallSnapshot> {
      let revisionRef: string | undefined;
      const temporal = createRuntimeTemporalRecallGateway({
        reads: {
          retrieveTemporal: async (args) => {
            const rows = readFixtureMemory(sql, request, args.halls, args.as_of, args.limit);
            revisionRef = await contentRevision(revisionSeedRef, request, rows);
            return rows.map((row) => ({
              hit: {
                hall_type: row.hall_type,
                content: row.content,
                confidence: row.confidence,
                valid_from: row.valid_from,
                source_trust: row.source_trust,
              },
              // This is the test-only retained-taint fixture capability. Production has no
              // equivalent adapter or public factory.
              source_taint: null,
            }));
          },
        },
        now: () => request.snapshot_at,
      });
      const outcome = await temporal({
        recallKey: request.recall_key,
        zone: request.zone,
        canaryTokens: request.canary_tokens,
      }, request.hint);
      const resolvedRevision = revisionRef ?? await contentRevision(revisionSeedRef, request, {
        status: outcome.status,
        recall_key: request.recall_key,
        hint: request.hint ?? null,
      });
      const snapshot = Object.freeze({
        snapshot_ref: request.snapshot_ref,
        snapshot_at: request.snapshot_at,
        revision_ref: resolvedRevision,
      });
      if (outcome.status !== 'partial') {
        return Object.freeze({
          principal_ref: request.owner.principal_ref,
          tenant_ref: request.owner.tenant_ref,
          snapshot,
          status: outcome.status,
          result: outcome.result,
          source: null,
          capability: 'owner_bound_local_temporal_snapshot',
        });
      }
      return Object.freeze({
        principal_ref: request.owner.principal_ref,
        tenant_ref: request.owner.tenant_ref,
        snapshot,
        status: 'partial' as const,
        result: outcome.result,
        source: Object.freeze({
          source_key: `test-only-trusted-local-recall:${request.snapshot_ref}`,
          source_kind: 'recall' as const,
          scope: 'principal' as const,
          source_taint: null,
          produced_at: request.snapshot_at,
        }),
        capability: 'owner_bound_local_temporal_snapshot',
      });
    },
  });
}

function readFixtureMemory(
  sql: SqlStorage,
  request: ContextRecallRequest,
  halls: readonly string[],
  asOf: string,
  limit: number,
): readonly FixtureMemoryRow[] {
  const hallPlaceholders = halls.map(() => '?').join(', ');
  return sql.exec<FixtureMemoryRow>(
    `SELECT id, hall_type, content, confidence, created_at, valid_from, source_trust
       FROM memory_blocks
      WHERE user_id = ?
        AND hall_type IN (${hallPlaceholders})
        AND unixepoch(created_at) <= unixepoch(?)
        AND unixepoch(valid_from) <= unixepoch(?)
        AND (valid_to IS NULL OR unixepoch(valid_to) > unixepoch(?))
        AND source_trust IN ('user_stated', 'memory_committed')
      ORDER BY unixepoch(valid_from) DESC, id ASC
      LIMIT ?`,
    request.owner.local_user_ref,
    ...halls,
    asOf,
    asOf,
    asOf,
    limit,
  ).toArray();
}

async function contentRevision(
  seed: string,
  request: ContextRecallRequest,
  payload: unknown,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ seed, request: snapshotIdentity(request), payload })),
  );
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  return `rev_${hex.slice(0, 32)}`;
}

function snapshotIdentity(request: ContextRecallRequest): readonly unknown[] {
  return [
    request.snapshot_ref,
    request.snapshot_at,
    request.owner.tenant_ref,
    request.owner.principal_ref,
    request.owner.local_user_ref,
    request.recall_key ?? null,
    request.zone ?? null,
    request.hint ?? null,
  ];
}
