import { WorkspaceError, r2Bodies, workspaceStore, type Admission, type Metadata, type OwnerBinding, type WorkspaceState } from '@waldo/workspace';
import { signedRpc, type OwnerDirectoryEnv } from '../identity/owner-directory';

// SQLite callback is synchronous. No network, body writes or thenables belong here.
export const workspaceMetadata = (storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>): Metadata => ({
  transaction<T>(work: (state: WorkspaceState) => T): T {
    return storage.transactionSync(() => {
      storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_manifest (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_json TEXT NOT NULL)');
      const row = storage.sql.exec<{ state_json: string }>('SELECT state_json FROM workspace_manifest WHERE singleton = 1').toArray()[0];
      const state: WorkspaceState = row ? JSON.parse(row.state_json) : { binding: null, files: [], bodies: [], operations: [] };
      const result = work(state);
      if (result && typeof result === 'object' && 'then' in result) throw new WorkspaceError('invalid');
      storage.sql.exec('INSERT INTO workspace_manifest(singleton,state_json) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET state_json=excluded.state_json', JSON.stringify(state));
      return result;
    });
  },
});

export type WorkspaceEnv = OwnerDirectoryEnv & Readonly<{ WALDO_ENVIRONMENT?: string; WALDO_OWNER_DO_NAMESPACE?: string; TELEGRAM_OWNER_DO?: DurableObjectNamespace; ARTIFACTS?: R2Bucket }>;
type MappingRow = { owner_id: string; environment: string; namespace: string; do_name: string; do_id: string; state_version: number; mapping_version: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rowBinding = (value: unknown): OwnerBinding | null => {
  if (!value || typeof value !== 'object') return null;
  const r = value as MappingRow;
  if (typeof r.owner_id !== 'string' || !uuid.test(r.owner_id) || ![r.environment, r.namespace, r.do_name, r.do_id].every(x => typeof x === 'string' && x.length > 0) || !Number.isSafeInteger(r.state_version) || r.state_version < 0 || !Number.isSafeInteger(r.mapping_version) || r.mapping_version < 1) return null;
  return { ownerId: r.owner_id, environment: r.environment, namespace: r.namespace, doName: r.do_name, doId: r.do_id, stateVersion: r.state_version, mappingVersion: r.mapping_version };
};
export const workspaceOwnerHost = async (
  env: WorkspaceEnv,
  storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>,
  actualDoId: string,
  doName: string | undefined,
  fetcher: typeof fetch = fetch,
) => {
  const call = signedRpc(env, async (input,init) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fetcher(input,{...init,signal:controller.signal}).then(async response => {
          if(!response.body)return new Response(null,{status:response.status,headers:response.headers});
          const reader=response.body.getReader();const chunks:Uint8Array[]=[];let total=0;
          try { while(true){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>16_384){await reader.cancel();throw new WorkspaceError('unavailable');}chunks.push(part.value);} }
          finally {reader.releaseLock();}
          const bytes=new Uint8Array(total);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
          return new Response(bytes,{status:response.status,headers:response.headers});
        }),
        new Promise<Response>((_resolve,reject)=> { timer=setTimeout(()=> { controller.abort();reject(new WorkspaceError('unavailable')); },5_000); }),
      ]);
    } finally { if(timer!==undefined)clearTimeout(timer); }
  });
  const { WALDO_ENVIRONMENT: environment, WALDO_OWNER_DO_NAMESPACE: namespace, TELEGRAM_OWNER_DO: owners } = env;
  if (!call || !environment || !namespace || !/^[a-zA-Z0-9_-]{1,120}$/.test(environment) || !/^[a-zA-Z0-9_-]{1,240}$/.test(namespace) || !owners || !doName || owners.idFromName(doName).toString() !== actualDoId || !env.ARTIFACTS) throw new WorkspaceError('unavailable');
  const args = { p_environment: environment, p_namespace: namespace, p_do_name: doName, p_do_id: actualDoId, p_locator: JSON.stringify([environment, namespace, doName, actualDoId]) };
  // Hash the complete locator tuple to avoid delimiter ambiguity in the signed RPC.
  const locator = JSON.stringify([environment, namespace, doName, actualDoId]);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(locator)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const resolve = async (): Promise<OwnerBinding | null> => rowBinding(await call('workspace_owner_binding', `workspace.bind.${hash}`, args));
  const binding = await resolve();
  if (!binding || binding.environment !== environment || binding.namespace !== namespace || binding.doName !== doName || binding.doId !== actualDoId) throw new WorkspaceError('rejected');
  const admit: Admission = async supplied => {
    try {
      const current = await resolve();
      if (!current) return { status: 'rejected' };
      if (Object.keys(binding).some(key => supplied[key as keyof OwnerBinding] !== current[key as keyof OwnerBinding])) return { status: 'rejected' };
      return { status: 'ok' };
    } catch { return { status: 'unavailable' }; }
  };
  const bodies = await r2Bodies(env.ARTIFACTS, binding, admit);
  return workspaceStore({ binding, admit, metadata: workspaceMetadata(storage), bodies, now: Date.now, newId: () => crypto.randomUUID() });
};

export const workspaceRequest = async (
  request: Request,
  csrf: string,
  open: () => ReturnType<typeof workspaceOwnerHost>,
  present: (files: Awaited<ReturnType<Awaited<ReturnType<typeof workspaceOwnerHost>>['list']>>['files'], csrf: string, cursor: string | null) => Response,
  uploadLease: () => Promise<Readonly<{ release(): void; assert(): void }>>,
  download: (bytes: Uint8Array, meta: Awaited<ReturnType<Awaited<ReturnType<typeof workspaceOwnerHost>>['export']>>['meta']) => Response,
): Promise<Response> => {
  const url = new URL(request.url);
  const failure = (code: string, status: number) => Response.json({ error: `workspace_${code}` }, { status, headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  try {
    if (url.pathname === '/console/workspace' && request.method === 'GET') {
      const page = await (await open()).list(url.searchParams.get('cursor') ?? undefined);
      return present(page.files, csrf, page.next_cursor);
    }
    if (url.pathname === '/console/workspace/file' && request.method === 'GET') {
      const revision = url.searchParams.get('revision');
      if (!revision || !/^[1-9]\d*$/.test(revision)) return failure('invalid', 400);
      const out = await (await open()).export(url.searchParams.get('id') ?? '', Number(revision));
      return download(out.bytes, out.meta);
    }
    if (!['/console/workspace/upload', '/console/workspace/remove'].includes(url.pathname)) return failure('not_found', 404);
    if (request.method !== 'POST') return failure('method', 405);
    // Read bounded raw multipart bytes BEFORE formData can allocate arbitrary input.
    const maxRequest = 10 * 1024 * 1024 + 64 * 1024;
    const declared = request.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxRequest)) return failure('quota', 413);
    if (!request.body) return failure('invalid', 400);
    // Reject cross-origin browser writes even before bounded multipart parsing.
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return failure('rejected',403);
    const lease = url.pathname.endsWith('/upload') ? await uploadLease() : { release() {}, assert() {} };
    try {
    const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let count = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void reader.cancel(); }, 60_000);
    try {
      while (true) {
        const part = await reader.read();
        if (timedOut) return failure('unavailable', 503);
        if (part.done) break;
        count += part.value.byteLength;
        if (count > maxRequest) { await reader.cancel(); return failure('quota', 413); }
        chunks.push(part.value);
      }
    } finally { clearTimeout(timer); reader.releaseLock(); }
    if (timedOut) return failure('unavailable', 503);
    const bytes = new Uint8Array(count); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    const form = await new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type') ?? '' }, body: bytes }).formData();
    if (form.get('csrf') !== csrf) return failure('rejected', 403);
    lease.assert();
    const store = await open();
    if (url.pathname.endsWith('/remove')) {
      const revision = form.get('revision');
      if (typeof revision !== 'string' || !/^[1-9]\d*$/.test(revision) || typeof form.get('file_id') !== 'string') return failure('invalid', 400);
      return Response.json(await store.tombstone(String(form.get('file_id')), Number(revision)), { headers: { 'cache-control': 'private, no-store' } });
    }
    const file: unknown = form.get('file'); const path = form.get('path'); const expected = form.get('expected_revision'); const operation = form.get('operation_id');
    if (!(file instanceof File) || typeof path !== 'string' || typeof expected !== 'string' || !/^\d+$/.test(expected) || typeof operation !== 'string') return failure('invalid', 400);
    lease.assert();
    const meta = await store.write({ path, bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type || 'application/octet-stream', expected_revision: Number(expected), operation_id: operation, provenance: 'owner_upload' });
    return Response.json({ file_id: meta.file_id, revision: meta.revision, byte_size: meta.byte_size, sha256: meta.sha256 }, { headers: { 'cache-control': 'private, no-store' } });
    } finally { lease.release(); }
  } catch (error) {
    const code = error instanceof WorkspaceError ? error.code : 'unavailable';
    return failure(code, code === 'rejected' ? 403 : code === 'invalid' ? 400 : code === 'not_found' ? 404 : code === 'quota' ? 413 : code === 'conflict' || code === 'pending' ? 409 : 503);
  }
};


// One durable owner-local upload reservation BEFORE reading request bytes. Reserve
// available capacity up to maximum file bytes, then the store reserves exact bytes.
// Raw request memory has its own fixed ceiling; even zero remaining storage must
// admit a bounded exact committed retry. Store fingerprint/quota gates NEW bytes.
// No R2 write occurs while this lease alone exists; expired leases are safe to clear
// because incomplete raw uploads have no retained bodies or operations.
export const workspaceUploadLease = async (storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>, open: () => ReturnType<typeof workspaceOwnerHost>): Promise<Readonly<{ release(): void; assert(): void }>> => {
  await open(); // mapping and lifecycle admission before reservation
  const token = crypto.randomUUID();
  storage.transactionSync(() => {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_upload_lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL, expires_at INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL)');
    const lease = storage.sql.exec<{ token: string; expires_at: number }>('SELECT token,expires_at FROM workspace_upload_lease WHERE singleton=1').toArray()[0];
    if (lease && lease.expires_at > Date.now()) throw new WorkspaceError('pending');
    const row = storage.sql.exec<{ state_json: string }>('SELECT state_json FROM workspace_manifest WHERE singleton=1').toArray()[0];
    if (!row) throw new WorkspaceError('unavailable');
    const state = JSON.parse(row.state_json) as WorkspaceState;
    const used = state.bodies.reduce((n,b) => n+b.byte_size,0) + state.operations.filter(o=>o.status==='pending').reduce((n,o)=>n+o.body.byte_size,0);
    const available = Math.max(0,100*1024*1024-used);
    const reserved = Math.min(10*1024*1024,available);
    storage.sql.exec('INSERT INTO workspace_upload_lease(singleton,token,expires_at,reserved_bytes) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at,reserved_bytes=excluded.reserved_bytes',token,Date.now()+60_000,reserved);
  });
  return {
    release: () => { storage.sql.exec('DELETE FROM workspace_upload_lease WHERE singleton=1 AND token=?',token); },
    assert: () => { const row = storage.sql.exec<{token:string; expires_at:number}>('SELECT token,expires_at FROM workspace_upload_lease WHERE singleton=1').toArray()[0]; if (!row || row.token !== token || row.expires_at <= Date.now()) throw new WorkspaceError('pending'); },
  };
};
