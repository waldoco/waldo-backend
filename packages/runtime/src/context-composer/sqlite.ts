import { createRuntimeTemporalRecallGateway, RecallSecurityHalt } from '../recall/gateway';
import type {
  ContextSnapshotAttestation,
  ContextRecallGateway,
  ContextRecallRequest,
  ContextRecallSnapshot,
  LocalOwnerBinding,
  LocalOwnerBindingResolver,
  SystemSkillRepository,
  SystemSkillSnapshot,
} from './index';

const MAX_BINDINGS = 64;
// One extra row is an overflow sentinel. Silently dropping a 25th eligible system skill before
// canonical selection would make lexical SQL order part of the policy, so overflow fails safe.
const SQLITE_SYSTEM_SKILL_LIMIT = 25;
const MAX_SQLITE_SKILL_NAME_CHARS = 100;
const MAX_SQLITE_SKILL_TRIGGER_CHARS = 800;
const MAX_SQLITE_SKILL_BODY_CHARS = 2_400;
const MAX_SQLITE_SKILL_JSON_CHARS = 4_096;
const MAX_SQLITE_METADATA_CHARS = 256;
const MAX_SQLITE_TIMESTAMP_CHARS = 64;
const MAX_SQLITE_MEMORY_ID_CHARS = 256;
const MAX_SQLITE_MEMORY_CONTENT_CHARS = 2_000;
const MAX_FROZEN_SQLITE_SNAPSHOTS = 64;
const MAX_UTF8_BYTES_PER_CHAR = 4;
const REVISION_REF = /^rev_[a-f0-9]{32}$/;

type LocalSourceTaint = 'external' | null;

type StoredSkillRow = Readonly<{
  name: string;
  version: number;
  provenance: string;
  identity_locked: number;
  provisional: number;
  trigger_types_json: string;
  trigger_condition: string;
  required_tools_json: string;
  required_connectors_json: string;
  effectiveness: number;
  invocations: number;
  last_used: string | null;
  body_markdown: string;
  created_at: string;
  created_by: string;
  status: string;
  pinned: number;
  last_curated_at: string | null;
  archived_at: string | null;
}>;

type StoredMemoryRow = Readonly<{
  id: string;
  hall_type: string;
  content: string;
  confidence: number;
  created_at: string;
  valid_from: string;
  source_trust: string;
}>;

export type HeadlessLocalOwnerBinding = Readonly<{
  principal_ref: string;
  tenant_ref: string;
  local_user_ref: string;
}>;

// Current rows carry no source_taint. This proof type is accepted only by the explicitly named
// headless-test factory below; the normal runtime factory always excludes unproven legacy rows.
export type HeadlessLegacyMemoryTaintProof = Readonly<{
  taintForMemoryRow(row: Readonly<{
    principal_ref: string;
    tenant_ref: string;
    local_user_ref: string;
    id: string;
    source_trust: string;
  }>): LocalSourceTaint;
}>;

// The current DO schema has only legacy `user_id` rows. This intentionally bounded resolver is
// a local/headless test adapter, not a production identity directory: it proves the exact
// principal+tenant mapping before SQLite ever receives a local user id.
export class HeadlessLocalOwnerBindingResolver implements LocalOwnerBindingResolver {
  readonly #bindings = new Map<string, HeadlessLocalOwnerBinding>();
  readonly #localUserRefs = new Set<string>();

  constructor(
    bindings: readonly HeadlessLocalOwnerBinding[],
    private readonly revisionRef: string,
  ) {
    if (bindings.length === 0 || bindings.length > MAX_BINDINGS) {
      throw new Error('invalid headless owner binding set');
    }
    if (!REVISION_REF.test(revisionRef)) throw new Error('invalid headless owner binding revision');
    for (const binding of bindings) {
      if (
        typeof binding.principal_ref !== 'string' ||
        typeof binding.tenant_ref !== 'string' ||
        typeof binding.local_user_ref !== 'string' ||
        binding.local_user_ref.length === 0 ||
        binding.local_user_ref.length > 256
      ) {
        throw new Error('invalid headless owner binding');
      }
      const key = bindingKey(binding.principal_ref, binding.tenant_ref);
      if (this.#bindings.has(key) || this.#localUserRefs.has(binding.local_user_ref)) {
        throw new Error('non-unique headless owner binding');
      }
      this.#bindings.set(key, Object.freeze({ ...binding }));
      this.#localUserRefs.add(binding.local_user_ref);
    }
  }

  async bind(request: Readonly<{
    principal_ref: string;
    tenant_ref: string;
    snapshot_ref: string;
    snapshot_at: number;
  }>): Promise<LocalOwnerBinding> {
    const binding = this.#bindings.get(bindingKey(request.principal_ref, request.tenant_ref));
    if (binding === undefined) throw new Error('headless owner binding unavailable');
    return Object.freeze({
      principal_ref: binding.principal_ref,
      tenant_ref: binding.tenant_ref,
      local_user_ref: binding.local_user_ref,
      snapshot: attestationFor(request, this.revisionRef),
      source: {
        source_key: 'headless-owner-binding-v1',
        source_kind: 'runtime_metadata' as const,
        scope: 'principal' as const,
        source_taint: null,
        produced_at: request.snapshot_at,
      },
    });
  }
}

// This repository touches only active, identity-locked system rows. It never reads, counts, or
// reports other provenance from the global legacy table: ownership cannot be proved there.
export class SqliteSystemSkillRepository implements SystemSkillRepository {
  // Cache the in-flight capture so two concurrent compositions cannot observe two live reads
  // for one frozen snapshot. Capacity exhaustion fails safe rather than evicting a snapshot.
  readonly #snapshots = new Map<string, Promise<SystemSkillSnapshot>>();

  constructor(
    private readonly sql: SqlStorage,
    private readonly revisionSeedRef: string,
  ) {
    if (!REVISION_REF.test(revisionSeedRef)) throw new Error('invalid SQLite skill revision seed');
  }

  async list(request: Readonly<{ snapshot_ref: string; snapshot_at: number }>): Promise<SystemSkillSnapshot> {
    const cacheKey = snapshotKey(request);
    const cached = this.#snapshots.get(cacheKey);
    if (cached !== undefined) return cached;
    if (this.#snapshots.size >= MAX_FROZEN_SQLITE_SNAPSHOTS) {
      throw new Error('SQLite frozen snapshot capacity exhausted');
    }
    const captured = this.capture(request);
    this.#snapshots.set(cacheKey, captured);
    // A rejected capture is also frozen. Retrying a repaired live row under the same snapshot
    // ref would otherwise turn one claimed snapshot from fail-closed into successful output.
    return captured;
  }

  private async capture(
    request: Readonly<{ snapshot_ref: string; snapshot_at: number }>,
  ): Promise<SystemSkillSnapshot> {
    // Do not read or report any other provenance class, but an active system row with an
    // unlocked identity is internally contradictory and must not be silently omitted.
    const invalidSystemOwnership = this.sql
      .exec<{ unsafe: number }>(
        `SELECT 1 AS unsafe
           FROM skills
          WHERE status = 'active' AND provenance = 'system' AND identity_locked != 1
          LIMIT 1`,
      )
      .toArray();
    if (invalidSystemOwnership.length > 0) {
      throw new Error('invalid SQLite system skill ownership');
    }
    const oversized = this.sql
      .exec<{ unsafe: number }>(
        `SELECT 1 AS unsafe
           FROM skills
          WHERE status = 'active' AND provenance = 'system' AND identity_locked = 1
            AND (
              ${unsafeText('name', MAX_SQLITE_SKILL_NAME_CHARS)}
              OR ${unsafeText('trigger_types_json', MAX_SQLITE_SKILL_JSON_CHARS)}
              OR ${unsafeText('trigger_condition', MAX_SQLITE_SKILL_TRIGGER_CHARS)}
              OR ${unsafeText('required_tools_json', MAX_SQLITE_SKILL_JSON_CHARS)}
              OR ${unsafeText('required_connectors_json', MAX_SQLITE_SKILL_JSON_CHARS)}
              OR ${unsafeText('body_markdown', MAX_SQLITE_SKILL_BODY_CHARS)}
              OR ${unsafeText('created_by', MAX_SQLITE_METADATA_CHARS)}
              OR (last_used IS NOT NULL AND ${unsafeText('last_used', MAX_SQLITE_TIMESTAMP_CHARS)})
              OR ${unsafeText('created_at', MAX_SQLITE_TIMESTAMP_CHARS)}
              OR (last_curated_at IS NOT NULL AND ${unsafeText('last_curated_at', MAX_SQLITE_TIMESTAMP_CHARS)})
              OR (archived_at IS NOT NULL AND ${unsafeText('archived_at', MAX_SQLITE_TIMESTAMP_CHARS)})
            )
          LIMIT 1`,
      )
      .toArray();
    if (oversized.length > 0) throw new Error('oversized SQLite system skill row');
    const systemRows = this.sql
      .exec<StoredSkillRow>(
        `SELECT name, version, provenance, identity_locked, provisional, trigger_types_json,
                trigger_condition, required_tools_json, required_connectors_json, effectiveness,
                invocations, last_used, body_markdown, created_at, created_by, status, pinned,
                last_curated_at, archived_at
           FROM skills
          WHERE status = 'active' AND provenance = 'system' AND identity_locked = 1
          ORDER BY name
          LIMIT ?`,
        SQLITE_SYSTEM_SKILL_LIMIT,
      )
      .toArray();

    const result = Object.freeze({
      rows: Object.freeze(systemRows.map(toSkillRow)),
      snapshot: attestationFor(
        request,
        await contentRevision(this.revisionSeedRef, 'sqlite-system-skills', request, systemRows),
      ),
      source: Object.freeze({
        source_key: `sqlite-system-skills:${request.snapshot_ref}`,
        source_kind: 'runtime_metadata',
        scope: 'system',
        source_taint: null,
        produced_at: request.snapshot_at,
      }),
    });
    return result;
  }
}

// Current SQLite has no FTS/BM25/RRF, episode FTS, evolution, union-read, or retained row taint.
// It delegates key/config/query/hint/Scribe admission to an explicit temporal partial gateway.
// Legacy rows are conservatively stamped external; elevated-trust rows consequently stay out of
// the prompt until a retained source-taint proof lands, rather than being laundered.
export class SqliteTemporalRecallGateway implements ContextRecallGateway {
  readonly #snapshots = new Map<string, Promise<ContextRecallSnapshot>>();

  static create(
    sql: SqlStorage,
    revisionSeedRef: string,
  ): ContextRecallGateway {
    return new SqliteTemporalRecallGateway(sql, revisionSeedRef, undefined);
  }

  // Deliberately not a production constructor: this lets the hermetic DO test prove the
  // composition path only after an explicit local source-taint assertion. Production callers
  // must use create() until a real retained-taint source exists.
  static forHeadlessTest(
    sql: SqlStorage,
    revisionSeedRef: string,
    taintProof: HeadlessLegacyMemoryTaintProof,
  ): ContextRecallGateway {
    return new SqliteTemporalRecallGateway(sql, revisionSeedRef, taintProof);
  }

  private constructor(
    private readonly sql: SqlStorage,
    private readonly revisionSeedRef: string,
    private readonly taintProof?: HeadlessLegacyMemoryTaintProof,
  ) {
    if (!REVISION_REF.test(revisionSeedRef)) throw new Error('invalid SQLite recall revision seed');
  }

  async recall(request: ContextRecallRequest): Promise<ContextRecallSnapshot> {
    const cacheKey = stableSnapshotKey(request);
    const cached = this.#snapshots.get(cacheKey);
    if (cached !== undefined) return cached;
    if (this.#snapshots.size >= MAX_FROZEN_SQLITE_SNAPSHOTS) {
      throw new Error('SQLite frozen snapshot capacity exhausted');
    }
    const captured = this.capture(request);
    this.#snapshots.set(cacheKey, captured);
    return captured;
  }

  private async capture(request: ContextRecallRequest): Promise<ContextRecallSnapshot> {
    let aggregateTaint: LocalSourceTaint = null;
    let sourceRevision: string | undefined;
    const temporal = createRuntimeTemporalRecallGateway({
      reads: {
        retrieveTemporal: async (args) => {
          const memory = await this.readMemory(request, args.halls, args.as_of, args.limit);
          aggregateTaint = memory.source_taint;
          sourceRevision = memory.revision_ref;
          return memory.rows;
        },
      },
      now: () => request.snapshot_at,
    });
    const outcome = await temporal(
      {
        recallKey: request.recall_key,
        zone: request.zone,
        canaryTokens: request.canary_tokens,
      },
      request.hint,
    );
    const snapshot = attestationFor(
      request,
      sourceRevision ?? await contentRevision(this.revisionSeedRef, 'sqlite-temporal-empty', request, {
        status: outcome.status,
        recall_key: request.recall_key,
        hint: request.hint ?? null,
      }),
    );
    if (outcome.status === 'failed' || outcome.status === 'skipped') {
      const result = Object.freeze({
        principal_ref: request.owner.principal_ref,
        tenant_ref: request.owner.tenant_ref,
        snapshot,
        status: outcome.status,
        result: outcome.result,
        source: null,
        capability: 'owner_bound_local_temporal_snapshot',
      });
      return result;
    }
    const result = Object.freeze({
      principal_ref: request.owner.principal_ref,
      tenant_ref: request.owner.tenant_ref,
      snapshot,
      status: 'partial',
      result: outcome.result,
      source: Object.freeze({
        source_key: `sqlite-temporal-recall:${request.snapshot_ref}`,
        source_kind: 'recall',
        scope: 'principal',
        source_taint: aggregateTaint,
        produced_at: request.snapshot_at,
      }),
      capability: 'owner_bound_local_temporal_snapshot',
    });
    return result;
  }

  private async readMemory(
    request: ContextRecallRequest,
    halls: readonly string[],
    asOf: string,
    limit: number,
  ): Promise<Readonly<{ rows: readonly unknown[]; source_taint: LocalSourceTaint; revision_ref: string }>> {
    const hallPlaceholders = halls.map(() => '?').join(', ');
    const temporalArguments = [
      request.owner.local_user_ref,
      ...halls,
      asOf,
      asOf,
      asOf,
    ];
    const oversized = this.sql
      .exec<{ unsafe: number }>(
        `SELECT 1 AS unsafe
           FROM memory_blocks
          WHERE user_id = ?
            AND hall_type IN (${hallPlaceholders})
            AND unixepoch(created_at) <= unixepoch(?)
            AND unixepoch(valid_from) <= unixepoch(?)
            AND (valid_to IS NULL OR unixepoch(valid_to) > unixepoch(?))
            AND source_trust IN ('user_stated', 'memory_committed')
            AND (
              ${unsafeText('id', MAX_SQLITE_MEMORY_ID_CHARS)}
              OR ${unsafeText('hall_type', MAX_SQLITE_METADATA_CHARS)}
              OR ${unsafeText('content', MAX_SQLITE_MEMORY_CONTENT_CHARS)}
              OR ${unsafeText('created_at', MAX_SQLITE_TIMESTAMP_CHARS)}
              OR ${unsafeText('valid_from', MAX_SQLITE_TIMESTAMP_CHARS)}
              OR (valid_to IS NOT NULL AND ${unsafeText('valid_to', MAX_SQLITE_TIMESTAMP_CHARS)})
              OR ${unsafeText('source_trust', MAX_SQLITE_METADATA_CHARS)}
            )
          LIMIT 1`,
        ...temporalArguments,
      )
      .toArray();
    if (oversized.length > 0) throw new RecallSecurityHalt('memory');
    const rows = this.sql
      .exec<StoredMemoryRow>(
        `SELECT id, hall_type, content, confidence, created_at, valid_from, source_trust
           FROM memory_blocks
          WHERE user_id = ?
            AND hall_type IN (${hallPlaceholders})
            -- ISO-8601 text permits offsets, so temporal eligibility must use instants rather
            -- than lexical string order. Malformed timestamps yield NULL and fail closed.
            AND unixepoch(created_at) <= unixepoch(?)
            AND unixepoch(valid_from) <= unixepoch(?)
            AND (valid_to IS NULL OR unixepoch(valid_to) > unixepoch(?))
            AND source_trust IN ('user_stated', 'memory_committed')
          ORDER BY unixepoch(valid_from) DESC, id ASC
          LIMIT ?`,
        ...temporalArguments,
        limit,
      )
      .toArray();
    const envelopes: unknown[] = [];
    for (const row of rows) {
      let taint: LocalSourceTaint;
      try {
        const proved = this.taintProof?.taintForMemoryRow({
          principal_ref: request.owner.principal_ref,
          tenant_ref: request.owner.tenant_ref,
          local_user_ref: request.owner.local_user_ref,
          id: row.id,
          source_trust: row.source_trust,
        });
        taint = proved === undefined ? 'external' : proved;
      } catch {
        throw new RecallSecurityHalt('memory');
      }
      if (taint !== null && taint !== 'external') throw new RecallSecurityHalt('memory');
      // No retained legacy taint proof means this row is not an eligible temporal-recall
      // source at all. Do not turn an already-excluded row into aggregate prompt provenance.
      if (taint === 'external') continue;
      envelopes.push(Object.freeze({
        hit: Object.freeze({
          hall_type: row.hall_type,
          content: row.content,
          confidence: row.confidence,
          valid_from: row.valid_from,
          source_trust: row.source_trust,
        }),
        source_taint: taint,
      }));
    }
    return Object.freeze({
      rows: Object.freeze(envelopes),
      source_taint: null,
      revision_ref: await contentRevision(this.revisionSeedRef, 'sqlite-temporal-memory', request, {
        rows,
        admitted: envelopes,
      }),
    });
  }
}

function toSkillRow(row: StoredSkillRow): unknown {
  return {
    name: row.name,
    version: row.version,
    provenance: row.provenance,
    identity_locked: sqliteBoolean(row.identity_locked),
    provisional: sqliteBoolean(row.provisional),
    trigger_types: parseJson(row.trigger_types_json),
    trigger_condition: row.trigger_condition,
    required_tools: parseJson(row.required_tools_json),
    required_connectors: parseJson(row.required_connectors_json),
    effectiveness: row.effectiveness,
    invocations: row.invocations,
    last_used: row.last_used,
    body_markdown: row.body_markdown,
    created_at: row.created_at,
    created_by: row.created_by,
    status: row.status,
    pinned: sqliteBoolean(row.pinned),
    last_curated_at: row.last_curated_at,
    archived_at: row.archived_at,
  };
}

function sqliteBoolean(value: number): boolean | number {
  if (value === 1) return true;
  if (value === 0) return false;
  return value;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function bindingKey(principalRef: string, tenantRef: string): string {
  return `${tenantRef}:${principalRef}`;
}

// SQLite's length(TEXT) stops at the first NUL. All hostile-row bounds therefore inspect the
// complete byte representation and reject NUL outright before raw text is selected or parsed.
function unsafeText(column: string, maxChars: number): string {
  return [
    `(instr(${column}, char(0)) > 0`,
    `length(${column}) > ${maxChars}`,
    `length(CAST(${column} AS BLOB)) > ${maxUtf8Bytes(maxChars)})`,
  ].join(' OR ');
}

function maxUtf8Bytes(maxChars: number): number {
  return maxChars * MAX_UTF8_BYTES_PER_CHAR;
}

function attestationFor(
  request: Readonly<{ snapshot_ref: string; snapshot_at: number }>,
  revisionRef: string,
): ContextSnapshotAttestation {
  return Object.freeze({
    snapshot_ref: request.snapshot_ref,
    snapshot_at: request.snapshot_at,
    revision_ref: revisionRef,
  });
}

function snapshotKey(request: Readonly<{ snapshot_ref: string; snapshot_at: number }>): string {
  return `${request.snapshot_ref}:${request.snapshot_at}`;
}

function stableSnapshotKey(request: ContextRecallRequest): string {
  return JSON.stringify([
    request.snapshot_ref,
    request.snapshot_at,
    request.owner.tenant_ref,
    request.owner.principal_ref,
    request.owner.local_user_ref,
    request.recall_key ?? null,
    request.zone ?? null,
    request.hint ?? null,
  ]);
}

async function contentRevision(
  seed: string,
  label: string,
  request: Readonly<{ snapshot_ref: string; snapshot_at: number }>,
  payload: unknown,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ seed, label, request, payload })),
  );
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  return `rev_${hex.slice(0, 32)}`;
}
