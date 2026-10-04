import { exportArtifactArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type ExportArtifactArgs, type ToolHandler, type ToolName } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { OwnerClock } from '../tools/live/get-context';
import type { ArtifactBook, ArtifactBodies } from './artifacts';
import { renderMarkdownPdf } from './artifact-export';

// Binary store for exported files. Same owner-scope key prefix idea as r2ArtifactBodies, but bytes.
export type ArtifactBinaries = Readonly<{
  putBytes(key: string, bytes: Uint8Array): Promise<void>;
  // maxBytes, when given, bounds the read itself: an object larger than it throws before any body is read.
  getBytes(key: string, maxBytes?: number): Promise<Uint8Array | null>;
}>;

export const r2ArtifactBinaries = (bucket: R2Bucket, ownerScope: string): ArtifactBinaries => {
  if (typeof ownerScope !== 'string' || !ownerScope.trim()) throw new Error('Artifact owner scope is required');
  const scoped = (key: string) => `artifacts/exports/by-owner/${encodeURIComponent(ownerScope)}/${encodeURIComponent(key)}`;
  return {
    putBytes: async (key, bytes) => { await bucket.put(scoped(key), bytes); },
    getBytes: async (key, maxBytes) => {
      const object = await bucket.get(scoped(key));
      if (object === null) return null;
      if (maxBytes !== undefined && object.size > maxBytes) throw new Error('artifact binary exceeds read bound');
      return new Uint8Array(await object.arrayBuffer());
    },
  };
};

export const inMemoryArtifactBinaries = (): ArtifactBinaries => {
  const map = new Map<string, Uint8Array>();
  return { putBytes: async (key, bytes) => { map.set(key, bytes); }, getBytes: async (key, maxBytes) => {
    const bytes = map.get(key) ?? null;
    if (bytes !== null && maxBytes !== undefined && bytes.length > maxBytes) throw new Error('artifact binary exceeds read bound');
    return bytes;
  } };
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
    // Exact-id lookup for the download helper. Returns the stored row or null; callers validate it.
    byId: (id: string): ExportRow | null => sql.exec<ExportRow>('SELECT * FROM artifact_exports WHERE id = ?', id).toArray()[0] ?? null,
    rows: (artifactId: string) => sql.exec<ExportRow>('SELECT * FROM artifact_exports WHERE source_artifact_id = ?', artifactId).toArray(),
    async exportPdf(args: ExportArtifactArgs, assertSourceCurrent?: () => Promise<void>) {
      await assertSourceCurrent?.();
      if (args.format !== 'pdf') return { ok: false as const, code: 'unsupported_format' };
      const meta = book.byId(args.artifact_id);
      if (meta === null) return { ok: false as const, code: 'not_found' };
      if (meta.revision !== args.expected_revision) return { ok: false as const, code: 'conflict', current_revision: meta.revision };
      // One export per source id + revision + format: a retry returns the stored receipt instead of
      // writing another file. (PDF bytes embed a creation date, so sha256 differs per render and
      // cannot be the dedupe key; the revision is immutable, so id + revision identifies the content.)
      const prior = sql.exec<ExportRow>('SELECT * FROM artifact_exports WHERE source_artifact_id = ? AND source_revision = ? AND format = ?', meta.id, meta.revision, 'pdf').toArray()[0];
      if (prior !== undefined) return { ok: true as const, id: prior.id, bytes: prior.byte_size, mime_type: prior.mime_type, sha256: prior.sha256, key: prior.r2_key, deduped: true };
      await assertSourceCurrent?.();
      const body = await bodies.get(meta.r2_key);
      await assertSourceCurrent?.();
      if (body === null) return { ok: false as const, code: 'not_found' };
      const rendered = await renderMarkdownPdf(body);
      if (rendered.status !== 'exported') return { ok: false as const, code: rendered.status };
      const id = `exp:${newId()}`;
      const key = `${meta.id}/r${meta.revision}/${id}`;
      await assertSourceCurrent?.();
      await binaries.putBytes(key, rendered.bytes);
      await assertSourceCurrent?.();
      // Re-check the source did not move while we wrote bytes; orphan bytes are harmless, a stale row is not.
      const after = book.byId(args.artifact_id);
      if (after === null || after.revision !== args.expected_revision) return { ok: false as const, code: 'conflict', current_revision: after?.revision ?? 0 };
      sql.exec('INSERT INTO artifact_exports (id, source_artifact_id, source_revision, format, mime_type, byte_size, sha256, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, meta.id, meta.revision, 'pdf', rendered.mime_type, rendered.bytes.length, rendered.sha256, key, clock.now().getTime());
      return { ok: true as const, id, bytes: rendered.bytes.length, mime_type: rendered.mime_type, sha256: rendered.sha256, key, deduped: false };
    },
  };
};

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

// `link` turns a stored export id into the owner-authenticated download URL (the console route, behind the owner session). Without it the
// receipt says saved internally, as before.
export const exportArtifactHandler = (exporter: ReturnType<typeof artifactExports>, link?: (exportId: string) => Promise<string | null>) => ({
  name: 'export_artifact',
  description: "Render a saved artifact to a file (format 'pdf', Latin text only) and store it. expected_revision must match the revision you last saw. A failure comes back as an error with the real reason, never as a receipt; success reports status 'exported', size and sha256, and a repeat export of the same revision returns the stored receipt (deduped: true); delivery is 'owner_link' with a URL only when the receipt carries one (the owner opens it signed in); otherwise it is 'saved_internal' with no URL, so say it is saved internally only. Never invent a link.",
  schema: exportArtifactArgsSchema,
  trigger_allowlist: allowlist('export_artifact'),
  autonomy_gated: false,
  mutates_state: true,
  handle: async (args: ExportArtifactArgs, ctx?: ToolDispatcherContext) => {
    const r = await exporter.exportPdf(args, ctx?.assertTaskSourceCurrent);
    // Discriminated: only status 'exported' is ok:true. Every failure is ok:false with its real reason.
    if (r.ok) {
      let url: string | null = null;
      try { url = link ? await link(r.id) : null; } catch { url = null; }
      return { ok: true, data: { status: 'exported', artifact_id: args.artifact_id, bytes: r.bytes, mime_type: r.mime_type, sha256: r.sha256, deduped: r.deduped,
        delivery: url ? { status: 'owner_link', url, audience: 'owner_authenticated' } : { status: 'saved_internal', url: null, audience: 'unverified' } }, source_taint: null };
    }
    if (r.code === 'not_found') return { ok: false, code: 'not_found', error: 'No artifact with that id.' };
    if (r.code === 'conflict') return { ok: false, code: 'rejected', error: `Revision mismatch: the artifact is at revision ${r.current_revision}. Read it again and retry with expected_revision ${r.current_revision}.` };
    const why: Record<string, string> = {
      unsupported_format: "Only format 'pdf' is supported.",
      unsupported_text: 'The text has characters the built-in PDF font cannot draw (non-Latin scripts). Nothing was exported.',
      empty: 'The artifact body is empty. Nothing was exported.',
      too_large: 'The artifact is too large to export. Nothing was exported.',
    };
    return { ok: false, code: 'rejected', error: why[r.code] ?? 'Export failed. Nothing was exported.' };
  },
} satisfies ToolHandler<ExportArtifactArgs, unknown, ToolDispatcherContext>);
