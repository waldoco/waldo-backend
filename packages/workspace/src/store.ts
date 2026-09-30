// Host authenticates this binding. A structural check never proves identity or admission.
export type OwnerBinding = Readonly<{ ownerId: string; environment: string; namespace: string; doName: string; doId: string; stateVersion: number; mappingVersion: number }>;
export type Provenance = 'owner_upload' | 'agent_generated' | 'provider_import' | 'sandbox_output';
export type FileMeta = Readonly<{ file_id: string; path: string; revision: number; mime: string; byte_size: number; sha256: string; provenance: Provenance; source_taint: 'external'; created_at: number; updated_at: number; state: 'ready' | 'tombstoned' }>;
export type BodyRevision = Readonly<{ file_id: string; blob_id: string; revision: number; mime: string; provenance: Provenance; created_at: number; byte_size: number; sha256: string; binding: OwnerBinding }>;
export type Operation = Readonly<{ operation_id: string; fingerprint: string; meta: FileMeta; body: BodyRevision; status: 'pending' | 'committed'; reserved_at: number }>;
export type WorkspaceState = { binding: OwnerBinding | null; files: FileMeta[]; bodies: BodyRevision[]; operations: Operation[] };
// Callback must be synchronous and atomic: thrown callbacks roll back ALL changes.
// Host stores the full map/body inventory durably; a process-local implementation is test-only.
export type Metadata = { transaction<T>(work: (state: WorkspaceState) => T): T };
export type Bodies = { put(body: BodyRevision, bytes: Uint8Array): Promise<void>; get(body: BodyRevision): Promise<Uint8Array | null>; remove(body: BodyRevision): Promise<void> };
export type Admission = (binding: OwnerBinding, action: 'construct' | 'read' | 'write' | 'finalize' | 'export' | 'delete') => Promise<Readonly<{ status: 'ok' | 'unavailable' | 'rejected' }>>;
export type WorkspaceHost = Readonly<{ binding: OwnerBinding; admit: Admission; metadata: Metadata; bodies: Bodies; now(): number; newId(): string }>;
export const LIMITS = { fileBytes: 10 * 1024 * 1024, ownerBytes: 100 * 1024 * 1024, files: 500, retainedBodies: 500, operationReceipts: 500, textWriteBytes: 256 * 1024, textReadBytes: 8192, pageRows: 50, uploadMs: 60_000 } as const;
export class WorkspaceError extends Error { constructor(public readonly code: 'invalid' | 'unavailable' | 'rejected' | 'conflict' | 'pending' | 'not_found' | 'quota' | 'capacity') { super(`workspace_${code}`); } }
const fail = (code: WorkspaceError['code']): never => { throw new WorkspaceError(code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
export const validateBinding = (binding: OwnerBinding): void => {
  if (!binding || !validId(binding.ownerId) || ![binding.environment, binding.namespace, binding.doName, binding.doId].every(v => typeof v === 'string' && v.length > 0 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v)) || !Number.isSafeInteger(binding.stateVersion) || binding.stateVersion < 0 || !Number.isSafeInteger(binding.mappingVersion) || binding.mappingVersion < 1) fail('unavailable');
};
export const sameMapping = (a: OwnerBinding, b: OwnerBinding): boolean => a.ownerId === b.ownerId && a.environment === b.environment && a.namespace === b.namespace && a.doName === b.doName && a.doId === b.doId && a.mappingVersion === b.mappingVersion;
export const validatePath = (path: string): void => {
  if (typeof path !== 'string' || !path || new TextEncoder().encode(path).length > 240 || path !== path.normalize('NFC') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(path) || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(v => !v || v === '.' || v === '..') || /^[a-z]:/i.test(path)) fail('invalid');
};
export const digest = async (bytes: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))].map(b => b.toString(16).padStart(2, '0')).join('');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const decode = (bytes: Uint8Array): string => { try { return utf8.decode(bytes); } catch { return fail('invalid'); } };
const byteTotal = (state: WorkspaceState): number => state.bodies.reduce((s, b) => s + b.byte_size, 0) + state.operations.filter(o => o.status === 'pending').reduce((s, o) => s + o.body.byte_size, 0);
const copyMeta = (meta: FileMeta): FileMeta => ({ ...meta });
export type Write = Readonly<{ path: string; bytes: Uint8Array; mime: string; expected_revision: number; provenance: Provenance; operation_id: string }>;
export const workspaceStore = async (host: WorkspaceHost) => {
  validateBinding(host.binding);
  const binding = Object.freeze({ ...host.binding });
  const admit = async (action: Parameters<Admission>[1]) => {
    let result: Awaited<ReturnType<Admission>>;
    try { result = await host.admit(binding, action); } catch { return fail('unavailable'); }
    if (!result || typeof result !== 'object') fail('unavailable');
    if (!['ok', 'unavailable', 'rejected'].includes(result.status)) fail('unavailable');
    if (result.status !== 'ok') fail(result.status === 'rejected' ? 'rejected' : 'unavailable');
  };
  await admit('construct');
  const transact = <T>(work: (state: WorkspaceState) => T): T => {
    return host.metadata.transaction(state => {
      if (state.binding === null) state.binding = { ...binding };
      if (!sameMapping(state.binding, binding) || state.bodies.some(b => !sameMapping(b.binding, binding)) || state.operations.some(o => !sameMapping(o.body.binding, binding))) fail('rejected');
      return work(state);
    });
  };
  // Validate retained binding before exposing an operational store, not on first body access.
  transact(() => undefined);
  const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WorkspaceError('unavailable')), LIMITS.uploadMs); })]);
    } catch { return fail('unavailable'); } finally { clearTimeout(timer); }
  };
  const verifyBody = async (body: BodyRevision): Promise<Uint8Array> => {
    await admit('read');
    if (!sameMapping(body.binding, binding)) fail('rejected');
    let bytes: Uint8Array | null;
    try { bytes = await bounded(() => host.bodies.get(body)); } catch { return fail('unavailable'); }
    if (!bytes || bytes.byteLength !== body.byte_size || await digest(bytes) !== body.sha256) fail('unavailable');
    await admit('read');
    return bytes!.slice();
  };
  const commit = async (operation: Operation): Promise<FileMeta> => {
    await admit('finalize');
    return transact(state => {
    const index = state.operations.findIndex(o => o.operation_id === operation.operation_id);
    if (index < 0 || state.operations[index]!.fingerprint !== operation.fingerprint) fail('rejected');
    const saved = state.operations[index]!;
    if (saved.body.binding.stateVersion !== binding.stateVersion) fail('rejected');
    if (saved.status === 'committed') return copyMeta(saved.meta);
    const file = state.files.find(f => f.path === saved.meta.path);
    if ((file?.revision ?? 0) !== saved.meta.revision - 1 || file?.state === 'tombstoned') fail('conflict');
    state.files = [...state.files.filter(f => f.file_id !== saved.meta.file_id), saved.meta];
    state.bodies.push(saved.body);
    state.operations[index] = { ...saved, status: 'committed' };
    return copyMeta(saved.meta);
    });
  };
  return {
    async list(cursor?: string, limit = 20, prefix = '') {
      await admit('read');
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.pageRows || typeof prefix !== 'string' || new TextEncoder().encode(prefix).length > 240 || (cursor !== undefined && !validId(cursor))) fail('invalid');
      return transact(state => {
        const rows = state.files.filter(f => f.state === 'ready' && f.path.startsWith(prefix)).sort((a, b) => a.file_id.localeCompare(b.file_id));
        const index = cursor === undefined ? -1 : rows.findIndex(f => f.file_id === cursor);
        if (cursor !== undefined && index < 0) fail('invalid');
        const page = rows.slice(index + 1, index + 1 + limit);
        return { files: page.map(copyMeta), count: page.length, next_cursor: index + 1 + limit < rows.length ? page.at(-1)!.file_id : null };
      });
    },
    async stat(fileId: string) {
      await admit('read');
      if (!validId(fileId)) fail('invalid');
      return transact(state => { const file = state.files.find(f => f.file_id === fileId && f.state === 'ready'); return file ? copyMeta(file) : null; });
    },
    async write(args: Write): Promise<FileMeta> {
      await admit('write');
      validatePath(args.path);
      if (!validId(args.operation_id) || !(args.bytes instanceof Uint8Array) || !Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0 || !['owner_upload', 'agent_generated', 'provider_import', 'sandbox_output'].includes(args.provenance) || typeof args.mime !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(args.mime)) fail('invalid');
      const bytes = args.bytes.slice();
      if (bytes.byteLength > LIMITS.fileBytes) fail('quota');
      const hash = await digest(bytes);
      const fingerprint = JSON.stringify([args.path, args.mime, args.expected_revision, args.provenance, bytes.byteLength, hash]);
      const reserved = transact(state => {
        const prior = state.operations.find(o => o.operation_id === args.operation_id);
        if (prior) { if (prior.fingerprint !== fingerprint) fail('conflict'); return { operation: prior, fresh: false }; }
        if (state.operations.length >= LIMITS.operationReceipts || state.bodies.length + state.operations.filter(o => o.status === 'pending').length >= LIMITS.retainedBodies) fail('capacity');
        const current = state.files.find(f => f.path === args.path);
        if ((current?.revision ?? 0) !== args.expected_revision || current?.state === 'tombstoned') fail('conflict');
        if (state.operations.some(o => o.status === 'pending')) fail('pending');
        if ((!current && state.files.filter(f => f.state === 'ready').length >= LIMITS.files) || byteTotal(state) + bytes.byteLength > LIMITS.ownerBytes) fail('quota');
        const fileId = current?.file_id ?? host.newId(); const blobId = host.newId();
        if (!validId(fileId) || !validId(blobId) || state.bodies.some(b => b.blob_id === blobId) || state.operations.some(o => o.body.blob_id === blobId) || (!current && state.files.some(f => f.file_id === fileId))) fail('unavailable');
        const now = host.now();
        const meta: FileMeta = { file_id: fileId, path: args.path, revision: args.expected_revision + 1, mime: args.mime, byte_size: bytes.byteLength, sha256: hash, provenance: args.provenance, source_taint: 'external', created_at: current?.created_at ?? now, updated_at: now, state: 'ready' };
        const operation: Operation = { operation_id: args.operation_id, fingerprint, meta, body: { file_id: fileId, blob_id: blobId, revision: meta.revision, mime: meta.mime, provenance: meta.provenance, created_at: now, byte_size: bytes.byteLength, sha256: hash, binding }, status: 'pending', reserved_at: now };
        state.operations.push(operation);
        return { operation, fresh: true };
      });
      if (reserved.operation.status === 'committed') {
        const current = transact(state => state.files.find(f => f.file_id === reserved.operation.meta.file_id));
        if (current?.state !== 'ready') fail('not_found');
        return copyMeta(reserved.operation.meta);
      }
      if (!reserved.fresh) { if (reserved.operation.body.binding.stateVersion !== binding.stateVersion) fail('rejected'); await verifyBody(reserved.operation.body); return commit(reserved.operation); }
      await admit('write');
      await bounded(() => host.bodies.put(reserved.operation.body, bytes));
      return commit(reserved.operation);
    },
    async reconcile(operationId: string): Promise<FileMeta> {
      await admit('finalize');
      if (!validId(operationId)) fail('invalid');
      const operation = transact(state => state.operations.find(o => o.operation_id === operationId));
      if (!operation) fail('not_found');
      if (operation!.status === 'committed') {
        if (!transact(state => state.files.some(f => f.file_id === operation!.meta.file_id && f.state === 'ready'))) fail('not_found');
        return copyMeta(operation!.meta);
      }
      if (operation!.body.binding.stateVersion !== binding.stateVersion) fail('rejected');
      await verifyBody(operation!.body);
      return commit(operation!);
    },
    async read(fileId: string, revision: number, offset: number, length: number) {
      if (!validId(fileId) || !Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > LIMITS.textReadBytes) fail('invalid');
      await admit('read');
      const record = transact(state => { const meta = state.files.find(f => f.file_id === fileId && f.state === 'ready'); const body = state.bodies.find(b => b.file_id === fileId && b.revision === revision); return meta && body ? { meta, body } : null; });
      if (!record) fail('not_found');
      const bytes = await verifyBody(record!.body);
      decode(bytes); // Invalid UTF-8 remains binary; never replacement-text fallback.
      if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)) fail('invalid');
      let end = Math.min(offset + length, bytes.length);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      if (end === offset && offset < bytes.length) fail('invalid');
      transact(state => { if (!state.files.some(f => f.file_id === fileId && f.state === 'ready') || !state.bodies.some(b => b.blob_id === record!.body.blob_id)) fail('not_found'); });
      return { file_id: fileId, revision, text: decode(bytes.slice(offset, end)), total_bytes: bytes.length, next_offset: end < bytes.length ? end : null, source_taint: 'external' as const };
    },
    async tombstone(fileId: string, expectedRevision: number) {
      await admit('delete');
      if (!validId(fileId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('invalid');
      const bodies = transact(state => {
        const index = state.files.findIndex(f => f.file_id === fileId);
        if (index < 0) fail('not_found');
        const meta = state.files[index]!;
        if (meta.revision !== expectedRevision) fail('conflict');
        if (state.operations.some(o => o.status === 'pending' && o.meta.file_id === fileId)) fail('pending');
        state.files[index] = { ...meta, state: 'tombstoned' };
        return state.bodies.filter(b => b.file_id === fileId).map(b => ({ ...b }));
      });
      // Each confirmed remove retires only that inventory row. Failure leaves visible,
      // quota-accounted cleanup work; no false purge receipt or resurrection on replay.
      for (const body of bodies) {
        await admit('delete');
        try { await bounded(() => host.bodies.remove(body)); } catch { return { status: 'cleanup_pending' as const }; }
        await admit('delete');
        transact(state => { state.bodies = state.bodies.filter(b => b.blob_id !== body.blob_id); });
      }
      return { status: 'purged' as const };
    },
    async export(fileId: string, revision: number) {
      await admit('export');
      if (!validId(fileId) || !Number.isSafeInteger(revision) || revision < 1) fail('invalid');
      const record = transact(state => { const meta = state.files.find(f => f.file_id === fileId && f.state === 'ready'); const body = state.bodies.find(b => b.file_id === fileId && b.revision === revision); return meta && body ? { meta, body } : null; });
      if (!record) fail('not_found');
      const bytes = await verifyBody(record!.body);
      await admit('export');
      transact(state => { if (!state.files.some(f => f.file_id === fileId && f.state === 'ready') || !state.bodies.some(b => b.blob_id === record!.body.blob_id)) fail('not_found'); });
      return { bytes, meta: { ...record!.meta, revision, mime: record!.body.mime, provenance: record!.body.provenance, updated_at: record!.body.created_at, byte_size: record!.body.byte_size, sha256: record!.body.sha256 } };
    },
  };
};
export type WorkspaceStore = Awaited<ReturnType<typeof workspaceStore>>;
