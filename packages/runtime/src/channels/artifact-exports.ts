import { exportArtifactArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type ExportArtifactArgs, type ToolHandler, type ToolName } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { OwnerClock } from '../tools/live/get-context';
import type { ArtifactBook, ArtifactBodies } from './artifacts';
import { renderMarkdownPdf } from './artifact-export';

// Binary store for exported files. Same owner-scope key prefix idea as r2ArtifactBodies, but bytes.
export type ArtifactBinaries = Readonly<{
  putBytes(key: string, bytes: Uint8Array): Promise<void>;
  getBytes(key: string): Promise<Uint8Array | null>;
}>;

export const r2ArtifactBinaries = (bucket: R2Bucket, ownerScope: string): ArtifactBinaries => {
  if (typeof ownerScope !== 'string' || !ownerScope.trim()) throw new Error('Artifact owner scope is required');
  const scoped = (key: string) => `artifacts/exports/by-owner/${encodeURIComponent(ownerScope)}/${encodeURIComponent(key)}`;
  return {
    putBytes: async (key, bytes) => { await bucket.put(scoped(key), bytes); },
    getBytes: async (key) => {
      const object = await bucket.get(scoped(key));
      return object === null ? null : new Uint8Array(await object.arrayBuffer());
    },
  };
};

export const inMemoryArtifactBinaries = (): ArtifactBinaries => {
  const map = new Map<string, Uint8Array>();
  return { putBytes: async (key, bytes) => { map.set(key, bytes); }, getBytes: async (key) => map.get(key) ?? null };
};

type Sql = Pick<SqlStorage, 'exec'>;
export type ExportRow = Readonly<{
  id: string; source_artifact_id: string; source_revision: number; format: string; mime_type: string;
  byte_size: number; sha256: string; r2_key: string; created_at: number;
}>;

export const artifactExports = (sql: Sql, book: ArtifactBook, bodies: ArtifactBodies, binaries: ArtifactBinaries, clock: OwnerClock, newId: () => string) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS artifact_exports (
    id TEXT PRIMARY KEY, source_artifact_id TEXT NOT NULL, source_revision INTEGER NOT NULL, format TEXT NOT NULL,
    mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, r2_key TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  return {
    rows: (artifactId: string) => sql.exec<ExportRow>('SELECT * FROM artifact_exports WHERE source_artifact_id = ?', artifactId).toArray(),
    async exportPdf(args: ExportArtifactArgs) {
      if (args.format !== 'pdf') return { ok: false as const, code: 'unsupported_format' };
      const meta = book.byId(args.artifact_id);
      if (meta === null) return { ok: false as const, code: 'not_found' };
      if (meta.revision !== args.expected_revision) return { ok: false as const, code: 'conflict', current_revision: meta.revision };
      const body = await bodies.get(meta.r2_key);
      if (body === null) return { ok: false as const, code: 'not_found' };
      const rendered = await renderMarkdownPdf(body);
      if (rendered.status === 'too_large') return { ok: false as const, code: 'too_large' };
      if (rendered.status !== 'exported') return { ok: false as const, code: 'render_failed' };
      const id = `exp:${newId()}`;
      const key = `${meta.id}/r${meta.revision}/${id}`;
      await binaries.putBytes(key, rendered.bytes);
      // Re-check the source did not move while we wrote bytes; orphan bytes are harmless, a stale row is not.
      const after = book.byId(args.artifact_id);
      if (after === null || after.revision !== args.expected_revision) return { ok: false as const, code: 'conflict', current_revision: after?.revision ?? 0 };
      sql.exec('INSERT INTO artifact_exports (id, source_artifact_id, source_revision, format, mime_type, byte_size, sha256, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, meta.id, meta.revision, 'pdf', rendered.mime_type, rendered.bytes.length, rendered.sha256, key, clock.now().getTime());
      return { ok: true as const, id, bytes: rendered.bytes.length, mime_type: rendered.mime_type, sha256: rendered.sha256, key };
    },
  };
};

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

export const exportArtifactHandler = (exporter: ReturnType<typeof artifactExports>) => ({
  name: 'export_artifact',
  description: "Render a saved artifact to a file (format 'pdf', Latin text only) and store it. expected_revision must match the revision you last saw. The receipt reports status, size and sha256; delivery is 'saved_internal' with no URL until an owner-authenticated link exists, so say it is saved internally only. Never invent a link.",
  schema: exportArtifactArgsSchema,
  trigger_allowlist: allowlist('export_artifact'),
  autonomy_gated: false,
  mutates_state: true,
  handle: async (args: ExportArtifactArgs) => {
    const r = await exporter.exportPdf(args);
    if (r.ok) return { ok: true, data: { status: 'exported', artifact_id: args.artifact_id, bytes: r.bytes, mime_type: r.mime_type, sha256: r.sha256, delivery: { status: 'saved_internal', url: null, audience: 'unverified' } }, source_taint: null };
    if (r.code === 'not_found') return { ok: false, code: 'not_found', error: 'No artifact with that id.' };
    if (r.code === 'conflict') return { ok: false, code: 'rejected', error: `Revision mismatch: the artifact is at revision ${r.current_revision}. Read it again and retry with expected_revision ${r.current_revision}.` };
    const status = r.code;
    return { ok: true, data: { status, artifact_id: args.artifact_id, bytes: 0, delivery: { status: 'none', url: null } }, source_taint: null };
  },
} satisfies ToolHandler<ExportArtifactArgs, unknown, ToolDispatcherContext>);
