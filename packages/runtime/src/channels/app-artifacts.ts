import { ARTIFACT_BODY_MAX_CHARS, WORKSPACE_TEXT_MAX_BYTES } from '@waldo/contracts';
import {
  appArtifactExportV1Schema, appArtifactIdV1Schema, appArtifactReadQueryV1Schema, appArtifactsQueryV1Schema,
  appFileContentQueryV1Schema, appFileIdV1Schema, appFileRemoveV1Schema, appFileRenderV1Schema,
  appFilesQueryV1Schema, appFileSearchQueryV1Schema, appFileUploadFieldsV1Schema, appFileWriteV1Schema,
  appFileOperationMutationV1Schema, appFileOperationQueryV1Schema, APP_FILE_TEXT_MAX_REQUEST_BYTES,
} from '../../../contracts/src/app/artifacts';
import { LIMITS, WorkspaceError, type FileMeta, type WorkspaceStore } from '@waldo/workspace';
import type { ArtifactBook, ArtifactMeta } from './artifacts';
import { renderWorkspaceDocument } from './document-render';
import { workspaceOperationId } from '../tools/live/workspace-operation';
import { workspaceDelivery } from './workspace-delivery';

export type AppArtifactsDeps = Readonly<{
  openWorkspace(): Promise<WorkspaceStore>;
  book: ArtifactBook;
  assertCurrent(): Promise<void>;
  // Immutable authenticated owner DO identity, supplied by the host.
  operationScope: string;
  origin(): Promise<string | null>;
  uploadLease(): Promise<Readonly<{ assert(): void; release(): void }>>;
}>;
const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const json = (body: object, status = 200) => Response.json(body, { status, headers });
const fileView = (meta: FileMeta) => ({ storage: 'workspace' as const, artifact_id: meta.file_id, revision: meta.revision, path: meta.path, mime: meta.mime, byte_size: meta.byte_size, sha256: meta.sha256, provenance: meta.provenance, created_at: meta.created_at, updated_at: meta.updated_at });
const artifactView = (meta: ArtifactMeta) => ({ storage: 'artifact' as const, artifact_id: meta.id, revision: meta.revision, name: meta.name, kind: meta.kind, byte_size: meta.byte_size, sha256: meta.sha256 ?? null, integrity: meta.sha256 ? 'verified_original' : 'legacy_original_unverified', created_at: meta.created_at, updated_at: meta.updated_at });
const invalid = (): never => { throw new WorkspaceError('invalid'); };
const query = (url: URL) => {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) { if (Object.hasOwn(values, key)) invalid(); values[key] = value; }
  return values;
};
const parse = <T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, input: unknown): T => {
  const result = schema.safeParse(input);
  return result.success ? result.data : invalid();
};
// Bound streamed bodies before JSON or multipart parsing can allocate arbitrary input.
const boundedBody = async (request: Request, ceiling: number): Promise<Uint8Array> => {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > ceiling)) throw new WorkspaceError('quota');
  if (!request.body) invalid();
  const reader = request.body!.getReader(), chunks: Uint8Array[] = [];
  let size = 0, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel(); }, LIMITS.uploadMs);
  try {
    while (true) {
      const next = await reader.read();
      if (timedOut) throw new WorkspaceError('unavailable');
      if (next.done) break;
      size += next.value.byteLength;
      if (size > ceiling) { await reader.cancel(); throw new WorkspaceError('quota'); }
      chunks.push(next.value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
};
const readJson = async (request: Request) => {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) invalid();
  const bytes = await boundedBody(request, APP_FILE_TEXT_MAX_REQUEST_BYTES);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown; } catch { return invalid(); }
};
const renderedFile = async (request: Request, deps: AppArtifactsDeps, sourceId: string, source: 'workspace' | 'artifact') => {
  const input = await readJson(request);
  const args = source === 'workspace' ? parse(appFileRenderV1Schema, input) : parse(appArtifactExportV1Schema, input);
  const extension = args.format === 'markdown' ? 'md' : args.format;
  if (!args.path.endsWith(`.${extension}`)) invalid();
  const intent = JSON.stringify([source, sourceId, args.source_revision, args.path, args.expected_revision, args.format]);
  const operation_id = await workspaceOperationId([deps.operationScope, args.operation_id], 'app_document_export');
  const store = await deps.openWorkspace();
  let meta: FileMeta;
  try { meta = await store.reconcile(operation_id, intent); }
  catch (error) {
    if (!(error instanceof WorkspaceError) || error.code !== 'not_found') throw error;
    await deps.assertCurrent();
    let text: string;
    if (source === 'workspace') {
      const saved = await store.export(sourceId, args.source_revision, WORKSPACE_TEXT_MAX_BYTES);
      if (!['text/plain', 'text/markdown'].includes(saved.meta.mime)) invalid();
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(saved.bytes); } catch { return invalid(); }
    } else {
      const saved = await deps.book.read(sourceId, 0, ARTIFACT_BODY_MAX_CHARS + 1, args.source_revision);
      if (!saved) throw new WorkspaceError('not_found');
      if (saved.next_offset !== null || saved.total_chars > ARTIFACT_BODY_MAX_CHARS) throw new WorkspaceError('quota');
      text = saved.text;
    }
    await deps.assertCurrent();
    let bytes: Uint8Array, mime: string;
    if (args.format === 'markdown') { bytes = new TextEncoder().encode(text); mime = 'text/markdown'; }
    else {
      const rendered = await renderWorkspaceDocument(text, args.format);
      if (rendered.status !== 'exported') return json({ error: `document_${rendered.status}` }, rendered.status === 'too_large' ? 413 : 422);
      bytes = rendered.bytes; mime = rendered.mime;
    }
    await deps.assertCurrent();
    meta = await store.write({ path: args.path, expected_revision: args.expected_revision, operation_id, intent, bytes, mime, provenance: 'agent_generated' });
  }
  // Readback verifies digest, owner mapping and lifecycle before returning a retrievable result.
  const delivery = await workspaceDelivery(store, meta, { origin: deps.origin, durable: true });
  await deps.assertCurrent();
  return json({ file: fileView(meta), delivery });
};

// Called only after authenticated current-session admission has selected this owner DO.
export const appArtifactsRequest = async (request: Request, deps: AppArtifactsDeps): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!/^\/app\/v1\/(files|artifacts)(?:\/|$)/.test(url.pathname)) return null;
  try {
    await deps.assertCurrent();
    if (request.method !== 'GET' && url.search) invalid();
    if (!deps.operationScope.trim()) throw new WorkspaceError('unavailable');
    const origin = request.headers.get('origin');
    if (request.method !== 'GET' && origin !== null && origin !== url.origin) throw new WorkspaceError('rejected');
    const parts = url.pathname.split('/').slice(3);
    const [collection, rawId, action] = parts;
    if (collection === 'files' && rawId === 'operations') {
      const operationId = parse(appFileIdV1Schema, action), mutation = parts[3];
      if (parts.length > 4 || mutation && !['reconcile', 'cancel'].includes(mutation)) return json({ error: 'not_found' }, 404);
      const args: ReturnType<typeof appFileOperationQueryV1Schema.parse> | ReturnType<typeof appFileOperationMutationV1Schema.parse> = !mutation && request.method === 'GET' ? parse(appFileOperationQueryV1Schema, query(url)) : mutation && request.method === 'POST' && !url.search ? parse(appFileOperationMutationV1Schema, await readJson(request)) : invalid();
      const kinds = { upload: 'app_upload', text_write: 'app_text_write', document_export: 'app_document_export' } as const;
      const scoped = await workspaceOperationId([deps.operationScope, operationId], kinds[args.kind]), store = await deps.openWorkspace();
      let receipt = await store.operation(scoped);
      const expectedFingerprint = 'expected_fingerprint' in args ? args.expected_fingerprint : undefined;
      if (mutation && typeof expectedFingerprint !== 'string') invalid();
      if (typeof expectedFingerprint === 'string' && receipt.fingerprint !== expectedFingerprint) throw new WorkspaceError('conflict');
      if (mutation === 'cancel' && typeof expectedFingerprint === 'string') receipt = await store.cancel(scoped, expectedFingerprint);
      if (mutation === 'reconcile') { await store.reconcile(scoped); receipt = await store.operation(scoped); }
      await deps.assertCurrent();
      return json({ operation_id: operationId, kind: args.kind, fingerprint: receipt.fingerprint, state: receipt.state, reserved_at: receipt.reserved_at, file: receipt.file ? fileView(receipt.file) : null });
    }
    if (parts.length > 3) return json({ error: 'not_found' }, 404);
    let response: Response;
    if (collection === 'files') {
      if (!rawId) {
        if (request.method === 'GET') {
          const args = parse(appFilesQueryV1Schema, query(url)), page = await (await deps.openWorkspace()).list(args.cursor, args.limit, args.prefix);
          response = json({ files: page.files.map(fileView), next_cursor: page.next_cursor });
        } else if (request.method === 'POST') {
          if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data;')) invalid();
          const lease = await deps.uploadLease();
          try {
            const bytes = await boundedBody(request, LIMITS.fileBytes + 64 * 1024); lease.assert(); await deps.assertCurrent();
            const form = await new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type')! }, body: bytes }).formData();
            const allowed = new Set(['file', 'path', 'expected_revision', 'operation_id']);
            for (const key of form.keys()) if (!allowed.has(key) || form.getAll(key).length !== 1) invalid();
            const file: unknown = form.get('file'); if (!(file instanceof File)) invalid();
            const expected = form.get('expected_revision');
            if (typeof expected !== 'string' || !/^\d+$/.test(expected)) invalid();
            const args = parse(appFileUploadFieldsV1Schema, { path: form.get('path'), expected_revision: expected, operation_id: form.get('operation_id') });
            lease.assert(); await deps.assertCurrent();
            const store = await deps.openWorkspace();
            const meta = await store.write({ ...args, operation_id: await workspaceOperationId([deps.operationScope, args.operation_id], 'app_upload'), bytes: new Uint8Array(await (file as File).arrayBuffer()), mime: (file as File).type || 'application/octet-stream', provenance: 'owner_upload' });
            response = json({ file: fileView(meta), delivery: await workspaceDelivery(store, meta, { origin: deps.origin, durable: true }) });
          } finally { lease.release(); }
        } else return json({ error: 'method' }, 405);
      } else if (rawId === 'search' && !action) {
        if (request.method !== 'GET') return json({ error: 'method' }, 405);
        const args = parse(appFileSearchQueryV1Schema, query(url));
        response = json(await (await deps.openWorkspace()).search(args.query, args.prefix, args.limit));
      } else if (rawId === 'write' && !action) {
        if (request.method !== 'POST') return json({ error: 'method' }, 405);
        const args = parse(appFileWriteV1Schema, await readJson(request)), bytes = new TextEncoder().encode(args.text);
        if (bytes.byteLength > LIMITS.textWriteBytes) throw new WorkspaceError('quota');
        const store = await deps.openWorkspace();
        const meta = await store.write({ path: args.path, bytes, mime: args.mime, expected_revision: args.expected_revision, provenance: 'owner_upload', operation_id: await workspaceOperationId([deps.operationScope, args.operation_id], 'app_text_write') });
        response = json({ file: fileView(meta), delivery: await workspaceDelivery(store, meta, { origin: deps.origin, durable: true }) });
      } else {
        let decoded: string; try { decoded = decodeURIComponent(rawId); } catch { return invalid(); }
        const id = parse(appFileIdV1Schema, decoded), store = await deps.openWorkspace();
        if (request.method === 'GET' && !action) { if (url.search) invalid(); const meta = await store.stat(id); if (!meta) throw new WorkspaceError('not_found'); response = json({ file: fileView(meta) }); }
        else if (request.method === 'GET' && action === 'revisions') { if (url.search) invalid(); response = json({ artifact_id: id, revisions: await store.revisions(id) }); }
        else if (request.method === 'GET' && action === 'content') {
          const args = parse(appFileContentQueryV1Schema, query(url)), out = await store.export(id, args.revision);
          response = new Response(out.bytes, { headers: { ...headers, 'content-type': out.meta.mime, 'content-length': String(out.bytes.byteLength), 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.meta.path.split('/').at(-1)!)}`, 'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'", 'etag': `"${out.meta.sha256}"` } });
        } else if (request.method === 'POST' && action === 'remove') { const args = parse(appFileRemoveV1Schema, await readJson(request)); response = json(await store.tombstone(id, args.expected_revision)); }
        else if (request.method === 'POST' && action === 'render') response = await renderedFile(request, deps, id, 'workspace');
        else return json({ error: 'method' }, 405);
      }
    } else if (!rawId) {
      if (request.method !== 'GET') return json({ error: 'method' }, 405);
      const args = parse(appArtifactsQueryV1Schema, query(url)); response = json({ artifacts: deps.book.list(args.kind).map(artifactView) });
    } else {
      let decoded: string; try { decoded = decodeURIComponent(rawId); } catch { return invalid(); }
      const id = parse(appArtifactIdV1Schema, decoded);
      if (request.method === 'GET' && !action) {
        const args = parse(appArtifactReadQueryV1Schema, query(url)), saved = await deps.book.read(id, args.offset, args.length, args.revision);
        if (!saved) throw new WorkspaceError('not_found');
        response = json({ artifact: artifactView(saved.meta), text: saved.text, offset: args.offset, total_chars: saved.total_chars, next_offset: saved.next_offset, source_taint: 'external' });
      } else if (request.method === 'GET' && action === 'revisions') {
        if (url.search) invalid();
        if (!deps.book.byId(id)) throw new WorkspaceError('not_found'); response = json({ artifact_id: id, revisions: deps.book.revisions(id).map(artifactView) });
      } else if (request.method === 'POST' && action === 'export') response = await renderedFile(request, deps, id, 'artifact');
      else return json({ error: 'method' }, 405);
    }
    await deps.assertCurrent();
    return response;
  } catch (error) {
    const code = error instanceof WorkspaceError ? error.code : 'unavailable';
    return json({ error: `workspace_${code}` }, code === 'invalid' ? 400 : code === 'rejected' ? 403 : code === 'not_found' ? 404 : code === 'conflict' || code === 'pending' ? 409 : code === 'quota' || code === 'capacity' ? 413 : 503);
  }
};
