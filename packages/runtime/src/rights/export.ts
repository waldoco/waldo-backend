import { WorkspaceError, type WorkspaceStore } from '@waldo/workspace';
import type { ArtifactBook } from '../channels/artifacts';
import type { ArtifactBinaries, ExportRow } from '../channels/artifact-exports';
import type { AppRightsInventoryV1 } from '../../../contracts/src/app/rights';
import { RightsError } from './jobs';
import { rightsDigest } from './capability';
import { workspaceOperationId } from '../tools/live/workspace-operation';

const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
const encode = (bytes: Uint8Array): string => { let out = ''; for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.slice(i, i + 8192)); return btoa(out); };
export type RightsExportHost = {
  accountRef: string; now(): number; assertCurrent(): Promise<void>; inventory: AppRightsInventoryV1;
  productState(): Promise<object>; // Source-owned projections/history, never security/session/trace tables.
  directoryMetadata(): Promise<object>; openWorkspace(): Promise<WorkspaceStore>; artifacts: ArtifactBook;
  binaryArtifacts(): Promise<readonly { meta: Omit<ExportRow, 'r2_key'>; bytes: Uint8Array }[]>;
};
// Every file and artifact revision is read back through its existing owner-scoped
// store. Missing/oversized content fails the export rather than silently omitting it.
export const buildOwnerRightsExport = async (host: RightsExportHost): Promise<Uint8Array> => {
  const files: object[] = [], artifacts: object[] = []; let total = 0;
  const admit = async (bytes: number) => { total += bytes; if (total > MAX_EXPORT_BYTES) throw new RightsError('unavailable'); await host.assertCurrent(); };
  await host.assertCurrent();
  const state = await host.productState(), directory = await host.directoryMetadata(); await host.assertCurrent();
  const store = await host.openWorkspace(); let cursor: string | undefined;
  do {
    const page = await store.list(cursor, 50);
    for (const meta of page.files) {
      const revisions = await store.revisions(meta.file_id);
      for (const revision of revisions) {
        const saved = await store.export(meta.file_id, revision.revision); await admit(saved.bytes.byteLength);
        files.push({ file: { artifact_id: saved.meta.file_id, path: saved.meta.path, revision: saved.meta.revision, mime: saved.meta.mime, byte_size: saved.meta.byte_size, sha256: saved.meta.sha256, provenance: saved.meta.provenance }, encoding: 'base64', content: encode(saved.bytes) });
      }
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  for (const meta of host.artifacts.list()) {
    for (const revision of host.artifacts.revisions(meta.id)) {
      let offset = 0, text = '';
      while (true) {
        const read = await host.artifacts.read(meta.id, offset, 8000, revision.revision);
        if (!read || read.meta.id !== meta.id || read.meta.revision !== revision.revision || read.meta.byte_size !== revision.byte_size) throw new RightsError('unavailable');
        await admit(new TextEncoder().encode(read.text).byteLength); text += read.text;
        if (read.next_offset === null) break;
        if (read.next_offset <= offset) throw new RightsError('unavailable'); offset = read.next_offset;
      }
      if (new TextEncoder().encode(text).byteLength !== revision.byte_size) throw new RightsError('unavailable');
      const captured_sha256 = await rightsDigest(text);
      if (revision.sha256 && captured_sha256 !== revision.sha256) throw new RightsError('unavailable');
      artifacts.push({ artifact_id: meta.id, revision: revision.revision, name: revision.name, kind: revision.kind, byte_size: revision.byte_size,
        sha256: revision.sha256 ?? null, captured_sha256, integrity: revision.sha256 ? 'verified_original' : 'legacy_original_unverified', encoding: 'utf8', content: text });
    }
  }
  const binary_artifacts: object[] = [];
  for (const binary of await host.binaryArtifacts()) { await admit(binary.bytes.byteLength); binary_artifacts.push({ ...binary.meta, encoding: 'base64', content: encode(binary.bytes) }); }
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 'rights-export.v1', account_ref: host.accountRef, captured_at: host.now(), inventory: host.inventory, product_state: state, directory_metadata: directory, files, artifacts, binary_artifacts, exclusions: ['raw_health_separate_authority', 'credentials', 'private_security_state', 'provider_records', 'backups', 'offline_devices'] }));
  if (bytes.byteLength > MAX_EXPORT_BYTES) throw new RightsError('unavailable'); await host.assertCurrent(); return bytes;
};
export const saveOwnerRightsExport = async (store: WorkspaceStore, receiptId: string, bytes: Uint8Array) => {
  const operation_id = await workspaceOperationId([receiptId], 'rights_export'), intent = `rights-export.v1:${receiptId}`;
  let meta;
  try { meta = await store.reconcile(operation_id, intent); }
  catch (error) {
    if (!(error instanceof WorkspaceError) || error.code !== 'not_found') throw error;
    meta = await store.write({ path: `exports/waldo-${receiptId}.json`, expected_revision: 0, operation_id, intent, bytes, mime: 'application/json', provenance: 'agent_generated' });
  }
  const verified = await store.export(meta.file_id, meta.revision);
  if (verified.meta.sha256 !== meta.sha256 || verified.bytes.byteLength !== meta.byte_size) throw new RightsError('unavailable');
  return { artifact_id: meta.file_id, revision: meta.revision, sha256: meta.sha256, byte_size: meta.byte_size, download_path: `/app/v1/files/${encodeURIComponent(meta.file_id)}/content?revision=${meta.revision}` };
};


export const readOwnerArtifactBinaries = async (sql: SqlStorage, binaries: ArtifactBinaries): Promise<readonly { meta: Omit<ExportRow, 'r2_key'>; bytes: Uint8Array }[]> => {
  if (!sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='artifact_exports'").toArray().length) return [];
  const out: { meta: Omit<ExportRow, 'r2_key'>; bytes: Uint8Array }[] = []; let total = 0;
  for (const row of sql.exec<ExportRow>('SELECT * FROM artifact_exports ORDER BY created_at,id').toArray()) {
    if (!Number.isSafeInteger(row.byte_size) || row.byte_size < 0 || total + row.byte_size > MAX_EXPORT_BYTES) throw new RightsError('unavailable');
    const bytes = await binaries.getBytes(row.r2_key, row.byte_size);
    if (!bytes || bytes.byteLength !== row.byte_size) throw new RightsError('unavailable');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== row.sha256) throw new RightsError('unavailable');
    const { r2_key: _key, ...meta } = row; out.push({ meta, bytes }); total += bytes.byteLength;
  }
  return out;
};
