import type { RunEffectScope } from './run-effect-scope';
import {
  createArtifactArgsSchema, listArtifactsArgsSchema, readArtifactArgsSchema, restoreArtifactArgsSchema, reviseArtifactArgsSchema,
  TOOL_PERMISSIONS, triggerTypeSchema,
  type ArtifactKind, type CreateArtifactArgs, type ListArtifactsArgs, type ReadArtifactArgs, type RestoreArtifactArgs, type ReviseArtifactArgs,
  type ToolHandler, type ToolName,
} from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { DeliverArtifact } from './artifact-delivery';
import type { OwnerClock } from '../tools/live/get-context';

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
  r2_key: string;
  provenance: string;
  taint: string;
  created_at: number;
  updated_at: number;
}>;

// The R2 subset the book needs - an in-memory stub satisfies it in tests and in a deploy
// missing the binding (degraded to per-DO-memory artifacts rather than crashing turns).
export type ArtifactBodies = Readonly<{
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
}>;

// Metadata is DO-local, but the bucket is shared. The immutable DO identity,
// supplied by the authenticated host rather than tool args, scopes every body.
// Never fall back to old unscoped keys: their owner cannot be proven by the key.
export const r2ArtifactBodies = (bucket: R2Bucket, ownerScope: string): ArtifactBodies => {
  if (typeof ownerScope !== 'string' || !ownerScope.trim()) throw new Error('Artifact owner scope is required');
  const scoped = (key: string) => `artifacts/by-owner/${encodeURIComponent(ownerScope)}/${encodeURIComponent(key)}`;
  return {
    put: async (key, body) => { await bucket.put(scoped(key), body); },
    get: async (key) => (await bucket.get(scoped(key)))?.text() ?? null,
  };
};

export const inMemoryArtifactBodies = (): ArtifactBodies => {
  const map = new Map<string, string>();
  return { put: async (key, body) => { map.set(key, body); }, get: async (key) => map.get(key) ?? null };
};

export type ReviseResult =
  | Readonly<{ status: 'ok'; meta: ArtifactMeta }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'conflict'; current_revision: number }>;

export type RestoreResult =
  | Readonly<{ status: 'ok'; meta: ArtifactMeta; restored_from: number }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'conflict'; current_revision: number }>
  | Readonly<{ status: 'current' }>
  | Readonly<{ status: 'not_kept'; kept: readonly number[] }>
  | Readonly<{ status: 'body_unavailable' }>;

export type ReadResult = Readonly<{
  meta: ArtifactMeta;
  text: string;
  total_chars: number;
  next_offset: number | null;
}>;

export type ArtifactBook = Readonly<{
  create(args: CreateArtifactArgs, provenance: string, scope?: RunEffectScope): Promise<ArtifactMeta>;
  revise(args: ReviseArtifactArgs, provenance: string, scope?: RunEffectScope): Promise<ReviseResult>;
  restore(args: RestoreArtifactArgs, provenance: string, scope?: RunEffectScope): Promise<RestoreResult>;
  revisions(id: string): readonly number[];
  list(kind?: ArtifactKind): readonly ArtifactMeta[];
  read(id: string, offset: number, length: number): Promise<ReadResult | null>;
  byId(id: string): ArtifactMeta | null;
}>;

type Sql = Pick<SqlStorage, 'exec'>;

export const artifactBook = (sql: Sql, bodies: ArtifactBodies, clock: OwnerClock, newId: () => string): ArtifactBook => {
  sql.exec(`CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0), byte_size INTEGER NOT NULL,
    r2_key TEXT NOT NULL, provenance TEXT NOT NULL, taint TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  // Every revision's body stays in R2 under its own key; this side table keeps which key each revision had, so an earlier one
  // can be restored. An artifact from before the table has only the revision it was at when next revised.
  sql.exec(`CREATE TABLE IF NOT EXISTS artifact_revisions (
    artifact_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0), byte_size INTEGER NOT NULL,
    r2_key TEXT NOT NULL, provenance TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (artifact_id, revision))`);
  const byId = (id: string): ArtifactMeta | null =>
    sql.exec<ArtifactMeta>('SELECT * FROM artifacts WHERE id = ?', id).toArray()[0] ?? null;
  const keep = (meta: ArtifactMeta) => sql.exec(
    'INSERT OR IGNORE INTO artifact_revisions (artifact_id, revision, byte_size, r2_key, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    meta.id, meta.revision, meta.byte_size, meta.r2_key, meta.provenance, meta.updated_at,
  );
  const revisions = (id: string): number[] =>
    sql.exec<{ revision: number }>('SELECT revision FROM artifact_revisions WHERE artifact_id = ? ORDER BY revision', id).toArray().map((row) => row.revision);
  // The new revision moves the row by compare-and-swap; the revision it replaces and the new one are kept in the same commit.
  const advance = (current: ArtifactMeta, next: ArtifactMeta, scope?: RunEffectScope) => {
    const commit = () => {
      keep(current);
      sql.exec(
        'UPDATE artifacts SET revision = ?, byte_size = ?, r2_key = ?, provenance = ?, updated_at = ? WHERE id = ? AND revision = ?',
        next.revision, next.byte_size, next.r2_key, next.provenance, next.updated_at, next.id, current.revision,
      );
      keep(next);
    };
    if (scope) scope.commit(commit); else commit();
  };
  return {
    byId,
    revisions,
    async create(args, provenance, scope) {
      const id = `art:${newId()}`;
      const r2Key = `artifacts/${id}/r1/${crypto.randomUUID()}`;
      scope?.admit();
      await bodies.put(r2Key, args.body_markdown);
      const now = clock.now().getTime();
      const meta: ArtifactMeta = {
        id, name: args.name, kind: args.kind, revision: 1,
        byte_size: new TextEncoder().encode(args.body_markdown).length,
        r2_key: r2Key, provenance, taint: 'external', created_at: now, updated_at: now,
      };
      const commit = () => {
        sql.exec(
          'INSERT INTO artifacts (id, name, kind, revision, byte_size, r2_key, provenance, taint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          meta.id, meta.name, meta.kind, meta.revision, meta.byte_size, meta.r2_key, meta.provenance, meta.taint, meta.created_at, meta.updated_at,
        );
        keep(meta);
      };
      if (scope) scope.commit(commit); else commit();
      return meta;
    },
    async revise(args, provenance, scope) {
      const current = byId(args.artifact_id);
      if (current === null) return { status: 'not_found' };
      if (current.revision !== args.expected_revision) return { status: 'conflict', current_revision: current.revision };
      // Bodies are immutable per revision: the new body lands under a new key BEFORE the row
      // moves, so a crash between the two never leaves the row pointing at a missing body.
      const r2Key = `artifacts/${args.artifact_id}/r${current.revision + 1}/${crypto.randomUUID()}`;
      scope?.admit();
      await bodies.put(r2Key, args.body_markdown);
      const meta: ArtifactMeta = {
        ...current, revision: current.revision + 1,
        byte_size: new TextEncoder().encode(args.body_markdown).length,
        r2_key: r2Key, provenance, updated_at: clock.now().getTime(),
      };
      // Recheck after body I/O and compare-and-swap in the same synchronous SQL operation.
      const after = byId(args.artifact_id);
      if (after === null) return { status: 'not_found' };
      if (after.revision !== args.expected_revision) return { status: 'conflict', current_revision: after.revision };
      advance(after, meta, scope);
      return { status: 'ok', meta };
    },
    async restore(args, provenance, scope) {
      const current = byId(args.artifact_id);
      if (current === null) return { status: 'not_found' };
      if (current.revision !== args.expected_revision) return { status: 'conflict', current_revision: current.revision };
      if (args.revision === current.revision) return { status: 'current' };
      const kept = sql.exec<{ byte_size: number; r2_key: string }>(
        'SELECT byte_size, r2_key FROM artifact_revisions WHERE artifact_id = ? AND revision = ?', args.artifact_id, args.revision,
      ).toArray()[0];
      if (kept === undefined) return { status: 'not_kept', kept: [...new Set([...revisions(args.artifact_id), current.revision])].sort((a, b) => a - b) };
      // Bodies are immutable per key, so the restored revision points at the kept body rather than copying it.
      scope?.admit();
      if (await bodies.get(kept.r2_key) === null) return { status: 'body_unavailable' };
      const after = byId(args.artifact_id);
      if (after === null) return { status: 'not_found' };
      if (after.revision !== args.expected_revision) return { status: 'conflict', current_revision: after.revision };
      const meta: ArtifactMeta = { ...after, revision: after.revision + 1, byte_size: kept.byte_size, r2_key: kept.r2_key, provenance, updated_at: clock.now().getTime() };
      advance(after, meta, scope);
      return { status: 'ok', meta, restored_from: args.revision };
    },
    list: (kind) => (kind === undefined
      ? sql.exec<ArtifactMeta>('SELECT * FROM artifacts ORDER BY updated_at DESC').toArray()
      : sql.exec<ArtifactMeta>('SELECT * FROM artifacts WHERE kind = ? ORDER BY updated_at DESC', kind).toArray()),
    async read(id, offset, length) {
      const meta = byId(id);
      if (meta === null) return null;
      // R2 is the system of record for bodies; a missing body means the artifact is
      // unreadable, so the handler reports not_found rather than inventing content.
      const body = await bodies.get(meta.r2_key);
      if (body === null) return null;
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
      const meta = await book.create(args, 'tool:create_artifact', ctx?.runScope);
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
      const result = await book.revise(args, 'tool:revise_artifact', ctx?.runScope);
      if (result.status === 'not_found') return { ok: false, code: 'not_found', error: 'No artifact with that id. Use list_artifacts to see what exists.' };
      if (result.status === 'conflict') return { ok: false, code: 'rejected', error: `Revision mismatch: the artifact is at revision ${result.current_revision}. Read it again and retry with expected_revision ${result.current_revision}.` };
      ctx?.runScope?.admit();
      return { ok: true, data: { artifact_id: result.meta.id, revision: result.meta.revision, stored_chars: args.body_markdown.length, delivery: deliver ? await deliver(result.meta) : { status: 'saved_internal', url: null, audience: 'unverified' } }, source_taint: null };
    },
  } satisfies ToolHandler<ReviseArtifactArgs, unknown, ToolDispatcherContext>,
  {
    name: 'restore_artifact',
    description: "Undo a revise: bring back an earlier revision of an artifact as its new revision. revision is the one to bring back; expected_revision must match the revision you last saw, as with revise_artifact. The restore is itself a revision, so it can be undone the same way.",
    schema: restoreArtifactArgsSchema,
    trigger_allowlist: allowlist('restore_artifact'),
    autonomy_gated: false,
    mutates_state: true,
    handle: async (args: RestoreArtifactArgs, ctx?: ToolDispatcherContext) => {
      const result = await book.restore(args, 'tool:restore_artifact', ctx?.runScope);
      switch (result.status) {
        case 'not_found': return { ok: false, code: 'not_found', error: 'No artifact with that id. Use list_artifacts to see what exists.' };
        case 'conflict': return { ok: false, code: 'rejected', error: `Revision mismatch: the artifact is at revision ${result.current_revision}. Read it again and retry with expected_revision ${result.current_revision}.` };
        case 'current': return { ok: false, code: 'rejected', error: 'That revision is the current one; nothing to restore.' };
        case 'not_kept': return { ok: false, code: 'rejected', error: `Revision ${args.revision} is not kept. Kept revisions: ${result.kept.join(', ')}.` };
        case 'body_unavailable': return { ok: false, code: 'rejected', error: 'body_unavailable: that revision is kept but its stored body could not be read. Nothing was changed; tell the owner.' };
      }
      ctx?.runScope?.admit();
      return { ok: true, data: { artifact_id: result.meta.id, revision: result.meta.revision, restored_from: result.restored_from, delivery: deliver ? await deliver(result.meta) : { status: 'saved_internal', url: null, audience: 'unverified' } }, source_taint: null };
    },
  } satisfies ToolHandler<RestoreArtifactArgs, unknown, ToolDispatcherContext>,
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
