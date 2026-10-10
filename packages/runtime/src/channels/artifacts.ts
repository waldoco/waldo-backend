import type { RunEffectScope } from './run-effect-scope';
import {
  createArtifactArgsSchema, listArtifactsArgsSchema, readArtifactArgsSchema, reviseArtifactArgsSchema,
  TOOL_PERMISSIONS, triggerTypeSchema,
  type ArtifactKind, type CreateArtifactArgs, type ListArtifactsArgs, type ReadArtifactArgs, type ReviseArtifactArgs,
  type ToolHandler, type ToolName,
} from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { DeliverArtifact } from './artifact-delivery';
import type { OwnerClock } from '../tools/live/get-context';
import { sha256Hex } from '../connectors/google';
import type { OwnerByteCustody, OwnerByteInvocation } from '../rights/write-custody';
import { RightsError } from '../rights/jobs';

// A5 (BUILD_PLAN_2026-09-25; the adaptation audit's typed-workspace answer): the agent's own
// working artifacts - the research brief built over an hour, the shortlist refined across
// messages. Metadata lives here in the owner DO; bodies live in R2 behind the minimal store
// interface below. Reads are ranged and on demand, and every read result is stamped
// 'external': bodies are model-composed across turns and can quote provider text, so the
// read boundary takes the same posture as read_tool_output (ADR-0049). The per-row taint
// column exists for a future trusted-write path (e.g. an owner upload); honoring anything
// but 'external' at read time requires the dispatcher contract to allow it first.
export type ArtifactMeta = Readonly<{
  id: string;
  name: string;
  kind: ArtifactKind;
  revision: number;
  byte_size: number;
  sha256?: string | null;
  r2_key: string;
  provenance: string;
  taint: string;
  created_at: number;
  updated_at: number;
}>;

// The R2 subset the book needs. Missing durable bindings fail artifact writes
// explicitly; in-memory storage is for tests only.
export type ArtifactBodies = Readonly<{
  put(key: string, body: string, invocation?: OwnerByteInvocation): Promise<void>;
  get(key: string): Promise<string | null>;
}>;

// Metadata is DO-local, but the bucket is shared. The immutable DO identity,
// supplied by the authenticated host rather than tool args, scopes every body.
// Never fall back to old unscoped keys: their owner cannot be proven by the key.
export const r2ArtifactBodies = (bucket: R2Bucket, ownerScope: string, custody?: OwnerByteCustody): ArtifactBodies => {
  if (typeof ownerScope !== 'string' || !ownerScope.trim()) throw new Error('Artifact owner scope is required');
  const scoped = (key: string) => `artifacts/by-owner/${encodeURIComponent(ownerScope)}/${encodeURIComponent(key)}`;
  return {
    put: async (key, body, invocation) => { if (!custody) throw new RightsError('unavailable'); const objectKey = scoped(key); await custody.put(objectKey, new TextEncoder().encode(body), immutable => bucket.put(objectKey, immutable), invocation); },
    get: async (key) => (await bucket.get(scoped(key)))?.text() ?? null,
  };
};

// Missing durable storage degrades only artifact operations, keeping ordinary
// owner conversation available without claiming a volatile artifact was saved.
export const unavailableArtifactBodies = (): ArtifactBodies => ({
  put: async () => { throw new RightsError('unavailable'); }, get: async () => null,
});

export const inMemoryArtifactBodies = (): ArtifactBodies => {
  const map = new Map<string, string>();
  return { put: async (key, body) => { map.set(key, body); }, get: async (key) => map.get(key) ?? null };
};

export type ReviseResult =
  | Readonly<{ status: 'ok'; meta: ArtifactMeta }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'conflict'; current_revision: number }>;

export type ReadResult = Readonly<{
  meta: ArtifactMeta;
  text: string;
  total_chars: number;
  next_offset: number | null;
}>;

export type ArtifactBook = Readonly<{
  create(args: CreateArtifactArgs, provenance: string, scope?: RunEffectScope, assertSourceCurrent?: () => Promise<void>): Promise<ArtifactMeta>;
  revise(args: ReviseArtifactArgs, provenance: string, scope?: RunEffectScope, assertSourceCurrent?: () => Promise<void>): Promise<ReviseResult>;
  list(kind?: ArtifactKind): readonly ArtifactMeta[];
  read(id: string, offset: number, length: number, revision?: number): Promise<ReadResult | null>;
  byId(id: string): ArtifactMeta | null;
  byRevision(id: string, revision: number): ArtifactMeta | null;
  revisions(id: string): readonly ArtifactMeta[];
}>;

type Sql = Pick<SqlStorage, 'exec'>;

export const artifactBook = (sql: Sql, bodies: ArtifactBodies, clock: OwnerClock, newId: () => string): ArtifactBook => {
  sql.exec(`CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0), byte_size INTEGER NOT NULL,
    r2_key TEXT NOT NULL, provenance TEXT NOT NULL, taint TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS artifact_revisions (
    id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0), metadata_json TEXT NOT NULL,
    PRIMARY KEY(id, revision))`);
  if(!sql.exec<{name:string}>('PRAGMA table_info(artifacts)').toArray().some(column=>column.name==='sha256'))sql.exec('ALTER TABLE artifacts ADD COLUMN sha256 TEXT');
  const byId = (id: string): ArtifactMeta | null =>
    sql.exec<ArtifactMeta>('SELECT * FROM artifacts WHERE id = ?', id).toArray()[0] ?? null;
  // Current rows also serve legacy artifacts. Snapshot the old row before moving it:
  // a crash can leave extra immutable history, never lose the previous saved version.
  const remember = (meta: ArtifactMeta) => sql.exec('INSERT OR IGNORE INTO artifact_revisions (id, revision, metadata_json) VALUES (?, ?, ?)', meta.id, meta.revision, JSON.stringify(meta));
  const byRevision = (id: string, revision: number): ArtifactMeta | null => {
    const current = byId(id);
    if (!current || !Number.isSafeInteger(revision) || revision < 1) return null;
    if (current.revision === revision) return current;
    const row = sql.exec<{ metadata_json: string }>('SELECT metadata_json FROM artifact_revisions WHERE id = ? AND revision = ?', id, revision).toArray()[0];
    return row ? JSON.parse(row.metadata_json) as ArtifactMeta : null;
  };
  return {
    byId,
    byRevision,
    revisions(id) {
      const current = byId(id);
      if (!current) return [];
      return [...sql.exec<{ metadata_json: string }>('SELECT metadata_json FROM artifact_revisions WHERE id = ? ORDER BY revision DESC', id).toArray()
        .map(row => JSON.parse(row.metadata_json) as ArtifactMeta).filter(meta => meta.revision !== current.revision), current]
        .sort((a, b) => b.revision - a.revision);
    },
    async create(args, provenance, scope, assertSourceCurrent) {
      const id = `art:${newId()}`;
      const r2Key = `artifacts/${id}/r1/${crypto.randomUUID()}`;
      const sha256=await sha256Hex(args.body_markdown);
      scope?.admit();
      await bodies.put(r2Key, args.body_markdown, { scope, assertCurrent: assertSourceCurrent });
      await assertSourceCurrent?.();
      const now = clock.now().getTime();
      const meta: ArtifactMeta = {
        id, name: args.name, kind: args.kind, revision: 1,
        byte_size: new TextEncoder().encode(args.body_markdown).length,
        sha256,
        r2_key: r2Key, provenance, taint: 'external', created_at: now, updated_at: now,
      };
      const commit = () => sql.exec(
        'INSERT INTO artifacts (id, name, kind, revision, byte_size, r2_key, provenance, taint, created_at, updated_at, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        meta.id, meta.name, meta.kind, meta.revision, meta.byte_size, meta.r2_key, meta.provenance, meta.taint, meta.created_at, meta.updated_at,sha256,
      );
      if (scope) scope.commit(commit); else commit();
      return meta;
    },
    async revise(args, provenance, scope, assertSourceCurrent) {
      const current = byId(args.artifact_id);
      if (current === null) return { status: 'not_found' };
      if (current.revision !== args.expected_revision) return { status: 'conflict', current_revision: current.revision };
      // Bodies are immutable per revision: the new body lands under a new key BEFORE the row
      // moves, so a crash between the two never leaves the row pointing at a missing body.
      const r2Key = `artifacts/${args.artifact_id}/r${current.revision + 1}/${crypto.randomUUID()}`;
      const sha256=await sha256Hex(args.body_markdown);
      scope?.admit();
      await bodies.put(r2Key, args.body_markdown, { scope, assertCurrent: assertSourceCurrent });
      await assertSourceCurrent?.();
      const meta: ArtifactMeta = {
        ...current, revision: current.revision + 1,
        byte_size: new TextEncoder().encode(args.body_markdown).length,
        sha256,
        r2_key: r2Key, provenance, updated_at: clock.now().getTime(),
      };
      // Recheck after body I/O and compare-and-swap in the same synchronous SQL operation.
      const after = byId(args.artifact_id);
      if (after === null) return { status: 'not_found' };
      if (after.revision !== args.expected_revision) return { status: 'conflict', current_revision: after.revision };
      const commit = () => {
        remember(current);
        sql.exec('UPDATE artifacts SET revision = ?, byte_size = ?, r2_key = ?, provenance = ?, updated_at = ?, sha256 = ? WHERE id = ? AND revision = ?',
          meta.revision, meta.byte_size, meta.r2_key, meta.provenance, meta.updated_at, sha256,meta.id, args.expected_revision);
      };
      if (scope) scope.commit(commit); else commit();
      return { status: 'ok', meta };
    },
    list: (kind) => (kind === undefined
      ? sql.exec<ArtifactMeta>('SELECT * FROM artifacts ORDER BY updated_at DESC').toArray()
      : sql.exec<ArtifactMeta>('SELECT * FROM artifacts WHERE kind = ? ORDER BY updated_at DESC', kind).toArray()),
    async read(id, offset, length, revision) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) return null;
      const meta = revision === undefined ? byId(id) : byRevision(id, revision);
      if (meta === null) return null;
      // R2 is the system of record for bodies; a missing body means the artifact is
      // unreadable, so the handler reports not_found rather than inventing content.
      const body = await bodies.get(meta.r2_key);
      if (body === null) return null;
      if(new TextEncoder().encode(body).byteLength!==meta.byte_size || meta.sha256 && await sha256Hex(body)!==meta.sha256)return null;
      const text = body.slice(offset, offset + length);
      const next = offset + text.length;
      return { meta, text, total_chars: body.length, next_offset: next < body.length ? next : null };
    },
  };
};

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

export const artifactHandlers = (book: ArtifactBook, deliver?: DeliverArtifact) => [
  {
    name: 'create_artifact',
    description: "Save a working artifact with a name and kind. A verified delivery receipt may return an owner-authenticated viewing URL. Use only the exact URL returned by the tool. Never build a URL from the id. If delivery is unavailable, say it is saved internally only. The owner may need to sign in to open a private link; this does not share access with other people. Use read_artifact and revise_artifact to read or update it.",
    schema: createArtifactArgsSchema,
    trigger_allowlist: allowlist('create_artifact'),
    autonomy_gated: false,
    mutates_state: true,
    // A mutation ack (id + revision), not stored content: taint-null like the other write tools.
    handle: async (args: CreateArtifactArgs, ctx?: ToolDispatcherContext) => {
      let meta: ArtifactMeta;
      try { meta = await book.create(args, 'tool:create_artifact', ctx?.runScope, ctx?.assertTaskSourceCurrent); }
      catch (error) { if (error instanceof RightsError && error.code === 'unavailable') return { ok: false as const, code: 'transient' as const, error: 'Artifact storage is unavailable. No artifact was saved.' }; throw error; }
      ctx?.runScope?.admit();
      return { ok: true, data: { artifact_id: meta.id, revision: meta.revision, stored_chars: args.body_markdown.length, delivery: deliver ? await deliver(meta) : { status: 'saved_internal', url: null, audience: 'unverified' } }, source_taint: null };
    },
  } satisfies ToolHandler<CreateArtifactArgs, unknown, ToolDispatcherContext>,
  {
    name: 'revise_artifact',
    description: "Replace an artifact's body. expected_revision must match the revision you last saw (create returns 1; each revise adds one); on a mismatch nothing is written - re-read the artifact and retry.",
    schema: reviseArtifactArgsSchema,
    trigger_allowlist: allowlist('revise_artifact'),
    autonomy_gated: false,
    mutates_state: true,
    handle: async (args: ReviseArtifactArgs, ctx?: ToolDispatcherContext) => {
      let result: ReviseResult;
      try { result = await book.revise(args, 'tool:revise_artifact', ctx?.runScope, ctx?.assertTaskSourceCurrent); }
      catch (error) { if (error instanceof RightsError && error.code === 'unavailable') return { ok: false as const, code: 'transient' as const, error: 'Artifact storage is unavailable. No revision was saved.' }; throw error; }
      if (result.status === 'not_found') return { ok: false, code: 'not_found', error: 'No artifact with that id. Use list_artifacts to see what exists.' };
      if (result.status === 'conflict') return { ok: false, code: 'rejected', error: `Revision mismatch: the artifact is at revision ${result.current_revision}. Read it again and retry with expected_revision ${result.current_revision}.` };
      ctx?.runScope?.admit();
      return { ok: true, data: { artifact_id: result.meta.id, revision: result.meta.revision, stored_chars: args.body_markdown.length, delivery: deliver ? await deliver(result.meta) : { status: 'saved_internal', url: null, audience: 'unverified' } }, source_taint: null };
    },
  } satisfies ToolHandler<ReviseArtifactArgs, unknown, ToolDispatcherContext>,
  {
    name: 'list_artifacts',
    description: "List the agent's saved working artifacts (id, name, kind, revision, size, when updated) - metadata only, never bodies. Optionally filter by kind.",
    schema: listArtifactsArgsSchema,
    trigger_allowlist: allowlist('list_artifacts'),
    autonomy_gated: false,
    handle: async (args: ListArtifactsArgs) => ({
      ok: true,
      data: {
        artifacts: book.list(args.kind).map((meta) => ({
          artifact_id: meta.id, name: meta.name, kind: meta.kind, revision: meta.revision,
          byte_size: meta.byte_size, updated_at: new Date(meta.updated_at).toISOString(),
        })),
      },
      source_taint: null,
    }),
  } satisfies ToolHandler<ListArtifactsArgs, unknown, ToolDispatcherContext>,
  {
    name: 'read_artifact',
    description: 'Read a slice of one artifact by id. Defaults to the first 4000 chars; pass offset and length (max 8000) for more - the result carries total_chars and next_offset.',
    schema: readArtifactArgsSchema,
    trigger_allowlist: allowlist('read_artifact'),
    autonomy_gated: false,
    // Always 'external' (see the file header): the body is model-composed across turns and can
    // quote provider text; membership in EXTERNAL_ORIGIN_TOOLS makes a null stamp unrepresentable.
    handle: async (args: ReadArtifactArgs) => {
      const result = await book.read(args.artifact_id, args.offset, args.length);
      if (result === null) {
        // The row exists but its body could not be read (R2 eviction or loss): say so, so the model does not
        // treat it as an unknown id or silently recreate it. Fixed words only; the name is not echoed.
        const meta = book.byId(args.artifact_id);
        if (meta !== null) return { ok: false, code: 'rejected', error: 'body_unavailable: this artifact exists but its stored body could not be read. Do not recreate it on your own; tell the owner and offer to recreate it if they want.', source_taint: 'external' };
        return { ok: false, code: 'not_found', error: 'No readable artifact with that id. Use list_artifacts to see what exists.', source_taint: 'external' };
      }
      return {
        ok: true,
        data: {
          artifact_id: result.meta.id, name: result.meta.name, kind: result.meta.kind, revision: result.meta.revision,
          offset: args.offset, text: result.text, total_chars: result.total_chars, next_offset: result.next_offset,
        },
        source_taint: 'external' as const,
      };
    },
  } satisfies ToolHandler<ReadArtifactArgs, unknown, ToolDispatcherContext>,
];
