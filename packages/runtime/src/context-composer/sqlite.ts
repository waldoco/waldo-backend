import { InFlightSnapshotRegistry } from './lifecycle';
import { ContextSourceRejectedError } from './faults';
import type {
  ContextSnapshotAttestation,
  LocalOwnerBinding,
  LocalOwnerBindingResolver,
  SystemSkillRepository,
  SystemSkillSnapshot,
} from './types';

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
const MAX_UTF8_BYTES_PER_CHAR = 4;
const REVISION_REF = /^rev_[a-f0-9]{32}$/;

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

export type HeadlessLocalOwnerBinding = Readonly<{
  principal_ref: string;
  tenant_ref: string;
  local_user_ref: string;
}>;

// The current DO schema has only legacy `user_id` rows. This intentionally bounded local/headless
// resolver proves the exact principal+tenant mapping before SQLite ever receives a local user id;
// it is not a production identity directory and does not attest any memory-row taint.
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
    if (binding === undefined) throw new ContextSourceRejectedError('owner_binding_mismatch');
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
  readonly #snapshots = new InFlightSnapshotRegistry<SystemSkillSnapshot>();

  constructor(
    private readonly sql: SqlStorage,
    private readonly revisionSeedRef: string,
  ) {
    if (!REVISION_REF.test(revisionSeedRef)) throw new Error('invalid SQLite skill revision seed');
  }

  async list(request: Readonly<{ snapshot_ref: string; snapshot_at: number }>): Promise<SystemSkillSnapshot> {
    return this.#snapshots.capture(snapshotKey(request), () => this.capture(request));
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
      throw new ContextSourceRejectedError('skill_snapshot_invalid');
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
    if (oversized.length > 0) throw new ContextSourceRejectedError('skill_snapshot_invalid');
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
