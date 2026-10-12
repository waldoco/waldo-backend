import { describe, expect, it, vi } from 'vitest';
import { workspaceMetadata, workspaceOwnerHost } from '../src/channels/workspace-host';

const owner = '10000000-0000-0000-0000-000000000001';
const binding = { owner_id: owner, environment: 'test', namespace: 'namespace-fixture', do_name: 'workspace-owner', do_id: 'opaque-id', state_version: 0, mapping_version: 1 };
const config = { SUPABASE_PROJECT_URL: 'https://db.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture', WALDO_ROUTER_HMAC_SECRET: 'fictional-router', WALDO_ENVIRONMENT: 'test', WALDO_OWNER_DO_NAMESPACE: 'namespace-fixture', TELEGRAM_OWNER_DO: { idFromName: () => ({ toString: () => 'opaque-id' }) } as unknown as DurableObjectNamespace, ARTIFACTS: { put: vi.fn(), get: vi.fn(), delete: vi.fn() } as unknown as R2Bucket };
const storageFixture = () => {
  let json: string | undefined;
  const sql = { exec: vi.fn((query: string, value?: string) => {
    if (query.startsWith('INSERT')) json = value;
    return { toArray: () => query.startsWith('SELECT') && json ? [{ state_json: json }] : [] };
  }) } as unknown as SqlStorage;
  return { sql, transactionSync<T>(work: () => T) { const prior = json; try { return work(); } catch (e) { json = prior; throw e; } } };
};
describe('workspace canonical host admission', () => {
  it('rejects missing configuration or wrong actual DO before directory/metadata/bodies', async () => {
    const fetcher = vi.fn(); const storage = storageFixture();
    await expect(workspaceOwnerHost({ ...config, WALDO_OWNER_DO_NAMESPACE: undefined }, storage, 'opaque-id', 'workspace-owner', fetcher)).rejects.toThrow('workspace_unavailable');
    await expect(workspaceOwnerHost(config, storage, 'different-id', 'workspace-owner', fetcher)).rejects.toThrow('workspace_unavailable');
    expect(fetcher).not.toHaveBeenCalled(); expect(storage.sql.exec).not.toHaveBeenCalled();
  });
  it('rejects malformed canonical/mismatched locator responses before metadata', async () => {
    const storage = storageFixture();
    for (const row of [{ ...binding, owner_id: 'telegram:42' }, { ...binding, environment: 'production' }]) {
      await expect(workspaceOwnerHost(config, storage, 'opaque-id', 'workspace-owner', vi.fn(async () => Response.json(row)))).rejects.toThrow('workspace_rejected');
    }
    expect(storage.sql.exec).not.toHaveBeenCalled();
  });
  it('rechecks lifecycle version and active mapping rather than cached construction authority', async () => {
    let current: unknown = binding;
    const fetcher = vi.fn(async () => Response.json(current));
    const store = await workspaceOwnerHost(config, storageFixture(), 'opaque-id', 'workspace-owner', fetcher);
    current = { ...binding, state_version: 1 };
    await expect(store.list()).rejects.toThrow('workspace_rejected');
    current = null;
    await expect(store.list()).rejects.toThrow('workspace_rejected');
    expect(config.ARTIFACTS!.get).not.toHaveBeenCalled();
  });
  it('synchronous metadata preserves complete state and rolls back thrown callbacks', () => {
    const metadata = workspaceMetadata(storageFixture());
    metadata.transaction(state => { state.binding = { ownerId: owner, environment: 'test', namespace: 'ns', doName: 'name', doId: 'id', stateVersion: 0, mappingVersion: 1 }; });
    expect(() => metadata.transaction(state => { state.binding = null; throw new Error('rollback'); })).toThrow('rollback');
    expect(metadata.transaction(state => state.binding?.ownerId)).toBe(owner);
    expect(() => metadata.transaction(() => Promise.resolve())).toThrow('workspace_invalid');
  });
});

import { workspaceRequest } from '../src/channels/workspace-host';
import { workspaceDownload, workspacePage } from '../src/channels/console-workspace';
const lease = async () => ({ release() {}, assert() {} });
it('CSRF denial occurs before storage open and no byte upload', async () => {
  const open = vi.fn(); const form = new FormData(); form.set('csrf', 'foreign');
  const result = await workspaceRequest(new Request('https://fixture/console/workspace/upload', { method:'POST', body:form }), 'session-csrf', open, workspacePage, lease, workspaceDownload);
  expect(result.status).toBe(403); expect(open).not.toHaveBeenCalled();
});
it('multipart binary upload/private export uses exact owner revision and observed bytes', async () => {
  const saved = new Map<string,Uint8Array>();
  const bucket = { put:async(k:string,bytes:Uint8Array)=>{saved.set(k,bytes.slice());}, get:async(k:string)=> { const bytes=saved.get(k);return bytes?{arrayBuffer:async()=>bytes.slice().buffer}:null; }, delete:async(k:string)=>{saved.delete(k);} } as unknown as R2Bucket;
  const storage = storageFixture(); const localConfig={...config,ARTIFACTS:bucket};
  const open=()=>workspaceOwnerHost(localConfig,storage,'opaque-id','workspace-owner',vi.fn(async()=>Response.json(binding)));
  const form=new FormData();form.set('csrf','token');form.set('file',new File([new Uint8Array([0,255,1])],'binary.bin',{type:'application/octet-stream'}));form.set('path','binary.bin');form.set('expected_revision','0');form.set('operation_id',crypto.randomUUID());
  const response=await workspaceRequest(new Request('https://fixture/console/workspace/upload',{method:'POST',body:form}),'token',open,workspacePage,lease,workspaceDownload);
  expect(response.status).toBe(200); const result=await response.json() as {file_id:string;revision:number};
  const exported=await workspaceRequest(new Request(`https://fixture/console/workspace/file?id=${result.file_id}&revision=${result.revision}`),'token',open,workspacePage,lease,workspaceDownload);
  expect(exported.status).toBe(200);expect(new Uint8Array(await exported.arrayBuffer())).toEqual(new Uint8Array([0,255,1]));expect(exported.headers.get('cache-control')).toBe('private, no-store');
  expect([...saved.keys()][0]).toContain(`workspace/v1/test/namespace-fixture/${owner}/`);
});
it('untrue or missing content length does not bypass observed stream ceiling', async () => {
  const open=vi.fn(); const req=new Request('https://fixture/console/workspace/upload',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=x','content-length':'1'},body:new Uint8Array(10*1024*1024+65537)});
  const result=await workspaceRequest(req,'token',open,workspacePage,lease,workspaceDownload);expect(result.status).toBe(413);expect(open).not.toHaveBeenCalled();
});

import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { consoleAccess, CONSOLE_COOKIE } from '../src/channels/console';
const ownerNamespace = (env as unknown as { TELEGRAM_OWNER_DO: DurableObjectNamespace }).TELEGRAM_OWNER_DO;
it('real owner DO SQLite metadata survives eviction and transaction rollback', async () => {
  const id=ownerNamespace.idFromName(`workspace-sql-${crypto.randomUUID()}`);const stub=ownerNamespace.get(id);
  await runInDurableObject(stub, (_instance,state)=>{
    const metadata=workspaceMetadata(state.storage);
    metadata.transaction(s=>{s.binding={ownerId:owner,environment:'test',namespace:'ns',doName:'sql',doId:id.toString(),stateVersion:0,mappingVersion:1};});
    expect(()=>metadata.transaction(s=>{s.binding=null;throw new Error('rollback');})).toThrow('rollback');
    expect(metadata.transaction(s=>s.binding?.ownerId)).toBe(owner);
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub,(_instance,state)=>{expect(workspaceMetadata(state.storage).transaction(s=>s.binding?.ownerId)).toBe(owner);});
});
it('real console route denies missing sessions and fails closed without namespace config', async()=>{
  const stub=ownerNamespace.get(ownerNamespace.idFromName(`workspace-console-${crypto.randomUUID()}`));
  const unauth=await stub.fetch('https://fixture/console/workspace');expect(unauth.status).toBe(401);
  const cookie=await runInDurableObject(stub, async(_instance,state)=>{
    const access=consoleAccess(state.storage);const url=await access.mintLink('https://fixture');return access.redeem(new URL(url).searchParams.get('t')!);
  });
  const admitted=await stub.fetch('https://fixture/console/workspace',{headers:{cookie:`${CONSOLE_COOKIE}=${cookie}`}});expect(admitted.status).toBe(503);expect(await admitted.json()).toEqual({error:'workspace_unavailable'});
});

import { workspaceUploadLease } from '../src/channels/workspace-host';
it('real SQLite upload prelease serializes raw streams and stale release cannot clear replacement lease',async()=>{
 const stub=ownerNamespace.get(ownerNamespace.idFromName(`workspace-lease-${crypto.randomUUID()}`));
 await runInDurableObject(stub,async(_instance,state)=>{
  workspaceMetadata(state.storage).transaction(s=>{s.binding={ownerId:owner,environment:'test',namespace:'ns',doName:'lease',doId:'id',stateVersion:0,mappingVersion:1};});
  const open=async()=>({} as Awaited<ReturnType<typeof workspaceOwnerHost>>);
  const first=await workspaceUploadLease(state.storage,open);first.assert();
  await expect(workspaceUploadLease(state.storage,open)).rejects.toThrow('workspace_pending');
  state.storage.sql.exec('UPDATE workspace_upload_lease SET expires_at=0 WHERE singleton=1');
  const next=await workspaceUploadLease(state.storage,open);
  expect(()=>first.assert()).toThrow('workspace_pending');first.release();next.assert();next.release();
 });
});
it('cross-origin browser mutation rejects before reservation/open/body parse',async()=>{
 const open=vi.fn();const reserve=vi.fn();
 const response=await workspaceRequest(new Request('https://fixture/console/workspace/remove',{method:'POST',headers:{origin:'https://other.invalid'},body:'x'}),'token',open,workspacePage,reserve,workspaceDownload);
 expect(response.status).toBe(403);expect(open).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();
});
it('full custody quota admits bounded committed retry prelease without granting new byte capacity',async()=>{
 const stub=ownerNamespace.get(ownerNamespace.idFromName(`workspace-full-${crypto.randomUUID()}`));
 await runInDurableObject(stub,async(_instance,state)=>{
  workspaceMetadata(state.storage).transaction(s=>{s.bodies=[{file_id:crypto.randomUUID(),blob_id:crypto.randomUUID(),revision:1,byte_size:100*1024*1024,sha256:'fixture',mime:'application/octet-stream',provenance:'owner_upload',created_at:0,binding:{ownerId:owner,environment:'test',namespace:'ns',doName:'full',doId:'id',stateVersion:0,mappingVersion:1}}];});
  const lease=await workspaceUploadLease(state.storage,async()=>({} as Awaited<ReturnType<typeof workspaceOwnerHost>>));
  lease.assert();expect(state.storage.sql.exec<{reserved_bytes:number}>('SELECT reserved_bytes FROM workspace_upload_lease').one().reserved_bytes).toBe(0);lease.release();
 });
});
it('hung signed directory construction aborts and settles sanitized unavailable within5seconds',async()=>{
 vi.useFakeTimers();try{
  let signal:AbortSignal|undefined;const fetcher=vi.fn((_i:RequestInfo|URL,init?:RequestInit)=>{signal=init?.signal??undefined;return new Promise<Response>(()=>{});});
  const operation=workspaceOwnerHost(config,storageFixture(),'opaque-id','workspace-owner',fetcher);const result=expect(operation).rejects.toThrow('workspace_unavailable');
  await vi.advanceTimersByTimeAsync(5_001);await result;expect(signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
 }finally{vi.useRealTimers();}
});
it('hung fresh admission after body put settles unavailable retaining pending operation and no ready file',async()=>{
 vi.useFakeTimers();try{
  let hung=false;const fetcher=vi.fn(()=>hung?new Promise<Response>(()=>{}):Promise.resolve(Response.json(binding)));
  const storage=storageFixture();const bucket={put:async()=>{hung=true;},get:async()=>null,delete:async()=>{}} as unknown as R2Bucket;
  const store=await workspaceOwnerHost({...config,ARTIFACTS:bucket},storage,'opaque-id','workspace-owner',fetcher);
  const operation=store.write({path:'one.txt',bytes:new Uint8Array([1]),mime:'text/plain',expected_revision:0,provenance:'owner_upload',operation_id:crypto.randomUUID()});const result=expect(operation).rejects.toThrow('workspace_unavailable');
  await vi.advanceTimersByTimeAsync(5_001);await result;
  const state=workspaceMetadata(storage).transaction(s=>s);expect(state.operations[0]?.status).toBe('pending');expect(state.files).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);
 }finally{vi.useRealTimers();}
});
it('full-quota committed multipart replay returns original receipt; changed bytes conflict and new operation rejects before put',async()=>{
 const id=ownerNamespace.idFromName(`workspace-replay-${crypto.randomUUID()}`);const stub=ownerNamespace.get(id);
 await runInDurableObject(stub,async(_instance,state)=>{
  const mapping={...binding,do_id:id.toString()};const bodies=new Map<string,Uint8Array>();let puts=0;
  const bucket={put:async(k:string,b:Uint8Array)=>{puts++;bodies.set(k,b.slice());},get:async(k:string)=>{const b=bodies.get(k);return b?{arrayBuffer:async()=>b.slice().buffer}:null;},delete:async()=>{}} as unknown as R2Bucket;
  const cfg={...config,TELEGRAM_OWNER_DO:ownerNamespace,ARTIFACTS:bucket};
  // Directory doName must derive exactly the real stub id.
  const realCfg={...cfg,TELEGRAM_OWNER_DO:{idFromName:()=>id} as unknown as DurableObjectNamespace};
  const open=()=>workspaceOwnerHost(realCfg,state.storage,id.toString(),'workspace-owner',vi.fn(async()=>Response.json(mapping)));
  const op=crypto.randomUUID();
  const send=async(operation:string,data:number,path='one.bin')=>{
   const form=new FormData();form.set('csrf','token');form.set('file',new File([new Uint8Array([data])],'one.bin',{type:'application/octet-stream'}));form.set('path',path);form.set('expected_revision','0');form.set('operation_id',operation);
   return workspaceRequest(new Request('https://fixture/console/workspace/upload',{method:'POST',body:form}),'token',open,workspacePage,()=>workspaceUploadLease(state.storage,open),workspaceDownload);
  };
  const first=await send(op,7);expect(first.status).toBe(200);const receipt=await first.json();expect(puts).toBe(1);
  workspaceMetadata(state.storage).transaction(s=>{s.bodies.push({...s.bodies[0]!,file_id:crypto.randomUUID(),blob_id:crypto.randomUUID(),byte_size:100*1024*1024-1});});
  const repeated=await send(op,7);expect(repeated.status).toBe(200);expect(await repeated.json()).toEqual(receipt);expect(puts).toBe(1);
  const changed=await send(op,8);expect(changed.status).toBe(409);expect(puts).toBe(1);
  const newOperation=await send(crypto.randomUUID(),7,'new.bin');expect(newOperation.status).toBe(413);expect(puts).toBe(1);
 });
});
it('oversized directory body cancels at16KiB before metadata construction',async()=>{
 const cancel=vi.fn();const stream=new ReadableStream<Uint8Array>({pull(c){c.enqueue(new Uint8Array(8193));},cancel});const storage=storageFixture();
 await expect(workspaceOwnerHost(config,storage,'opaque-id','workspace-owner',vi.fn(async()=>new Response(stream)))).rejects.toThrow('workspace_unavailable');expect(cancel).toHaveBeenCalledOnce();expect(storage.sql.exec).not.toHaveBeenCalled();
});
it('hung directory response body is cancelled by the5second deadline',async()=>{
 vi.useFakeTimers();try{
  const cancel=vi.fn();const stream=new ReadableStream<Uint8Array>({pull(){},cancel});
  const result=expect(workspaceOwnerHost(config,storageFixture(),'opaque-id','workspace-owner',vi.fn(async()=>new Response(stream)))).rejects.toThrow('workspace_unavailable');
  await vi.advanceTimersByTimeAsync(5_001);await result;expect(cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 }finally{vi.useRealTimers();}
});

it('recent receipt projection survives real owner SQLite eviction and rejects revoked or foreign mapping',async()=>{
 const name=`workspace-receipt-${crypto.randomUUID()}`;const id=ownerNamespace.idFromName(name);const stub=ownerNamespace.get(id);
 const objects=new Map<string,Uint8Array>();
 const bucket={put:vi.fn(async(key:string,bytes:Uint8Array)=>{objects.set(key,bytes.slice());}),get:vi.fn(async(key:string)=>{const bytes=objects.get(key);return bytes?{arrayBuffer:async()=>bytes.slice().buffer}:null;}),delete:vi.fn(async(key:string)=>{objects.delete(key);})};
 const mapped={...binding,do_name:name,do_id:id.toString()};let current:unknown=mapped;
 const fetcher=vi.fn(async()=>Response.json(current));
 const configured={...config,TELEGRAM_OWNER_DO:ownerNamespace,ARTIFACTS:bucket as unknown as R2Bucket};
 let receipt:{file_id:string;revision:number}|undefined;
 await runInDurableObject(stub,async(_instance,state)=>{
  const store=await workspaceOwnerHost(configured,state.storage,id.toString(),name,fetcher);
  receipt=await store.write({path:'drafts/current.md',bytes:new TextEncoder().encode('Retained draft body'),mime:'text/markdown',expected_revision:0,provenance:'agent_generated',operation_id:crypto.randomUUID()});
 });
 await evictDurableObject(stub);
 await runInDurableObject(stub,async(_instance,state)=>{
  const store=await workspaceOwnerHost(configured,state.storage,id.toString(),name,fetcher);
  expect(await store.recentWrites()).toEqual([expect.objectContaining({backend:'workspace',path:'drafts/current.md',file_id:receipt!.file_id,revision:1})]);
  expect(bucket.get).not.toHaveBeenCalled();
  current=null;await expect(store.recentWrites()).rejects.toThrow('workspace_rejected');
  current={...mapped,owner_id:'10000000-0000-0000-0000-000000000099'};
  await expect(store.recentWrites()).rejects.toThrow('workspace_rejected');
  current={...mapped,state_version:1};await expect(store.recentWrites()).rejects.toThrow('workspace_rejected');
 });
});
