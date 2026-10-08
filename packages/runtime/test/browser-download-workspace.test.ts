import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { workspaceStore, LIMITS, type WorkspaceState } from '@waldo/workspace';
import { browserDownloadToWorkspace } from '../src/channels/browser-download-workspace';
import { workspaceDownload } from '../src/channels/console-workspace';

it('native download bytes become an owner-scoped retrievable file with integrity proof and no provider URL', async () => {
 const state: WorkspaceState = { binding: null, files: [], bodies: [], operations: [] }, objects = new Map<string, Uint8Array>();
 const binding = { ownerId: '12345678-1234-1234-1234-123456789abc', environment: 'staging', namespace: 'fixture', doName: 'owner', doId: 'physical', stateVersion: 1, mappingVersion: 1 };
 const store = await workspaceStore({ binding, admit: async () => ({ status: 'ok' }), metadata: { transaction: f => f(state) }, bodies: { put: async (body, bytes) => { objects.set(body.blob_id, bytes.slice()); }, get: async body => objects.get(body.blob_id) ?? null, remove: async body => { objects.delete(body.blob_id); } }, now: Date.now, newId: () => crypto.randomUUID() });
 const page = {} as any, bytes = new TextEncoder().encode('Useful synthetic downloaded report'); let deleted = 0;
 const download = { page: () => page, url: () => 'https://download.invalid/report', suggestedFilename: () => 'report.txt', failure: async () => null, createReadStream: async () => Readable.from([bytes.slice(0, 5), bytes.slice(5)]), delete: async () => { deleted++; }, cancel: async () => {} } as any;
 const receipt = await browserDownloadToWorkspace({ download, page, workspace: store, operationId: crypto.randomUUID(), deadline: Date.now() + 60000, now: Date.now, assertCurrent: async () => {}, origin: 'https://owner.invalid', sourceOrigin: 'https://download.invalid' });
 expect(receipt).toMatchObject({ byte_size: bytes.length, provenance: 'provider_import', audience: 'owner_authenticated', retrieval: 'verified' });
 expect(receipt.url).toContain('/console/workspace/file?id='); expect(deleted).toBe(1);
 const exported = await store.export(receipt.file_id, receipt.revision);
 const response = workspaceDownload(exported.bytes, exported.meta);
 expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
 expect(response.headers.get('content-disposition')).toContain('attachment');
 expect(JSON.stringify(receipt)).not.toContain('provider-session');
 const other = await workspaceStore({ binding: { ...binding, ownerId: '22345678-1234-1234-1234-123456789abc', doName: 'other', doId: 'other-physical' }, admit: async () => ({ status: 'ok' }), metadata: { transaction: f => f({ binding: null, files: [], bodies: [], operations: [] }) }, bodies: { put: async () => {}, get: async () => null, remove: async () => {} }, now: Date.now, newId: () => crypto.randomUUID() });
 await expect(other.export(receipt.file_id, receipt.revision)).rejects.toThrow('not_found');
});

it('withdrawn owner authority prevents opening a native stream after failure inspection', async () => {
 let active=true, opens=0;const page={} as any;
 const download={page:()=>page,url:()=> 'https://download.invalid/report',suggestedFilename:()=> 'report.txt',failure:async()=>{active=false;return null;},createReadStream:async()=>{opens++;return Readable.from([new Uint8Array([1])]);},cancel:async()=>{}} as any;
 await expect(browserDownloadToWorkspace({download,page,workspace:{} as any,operationId:crypto.randomUUID(),deadline:Date.now()+60000,now:Date.now,origin:'https://owner.invalid',sourceOrigin:'https://download.invalid',assertCurrent:async()=>{if(!active)throw Error('withdrawn');}})).rejects.toThrow('browser_download_');
 expect(opens).toBe(0);
});

import { env, runInDurableObject } from 'cloudflare:test';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { workspaceOwnerHost } from '../src/channels/workspace-host';
import { consoleAccess, CONSOLE_COOKIE } from '../src/channels/console';
import { vi } from 'vitest';

it('native bytes served by actual owner console route require its session and current owner mapping', async () => {
 const name=`browser-download-${crypto.randomUUID()}`,namespace=env.TELEGRAM_OWNER_DO!,id=namespace.idFromName(name),stub=namespace.get(id);
 await runInDurableObject(stub,async(_instance,state)=>{
  const owner='10000000-0000-0000-0000-000000000001',objects=new Map<string,Uint8Array>();
  let mapping:any={owner_id:owner,environment:'staging',namespace:'browser-download-fixture',do_name:name,do_id:id.toString(),state_version:0,mapping_version:1};
  const cfg={...env,WALDO_ENVIRONMENT:'staging',WALDO_OWNER_DO_NAMESPACE:mapping.namespace,SUPABASE_PROJECT_URL:'https://download-directory.invalid',SUPABASE_PUBLISHABLE_KEY:'synthetic',WALDO_ROUTER_HMAC_SECRET:'synthetic-download-secret',ARTIFACTS:{put:async(k:string,b:Uint8Array)=>{objects.set(k,b.slice());},get:async(k:string)=>{const b=objects.get(k);return b?{arrayBuffer:async()=>b.slice().buffer}:null;},delete:async(k:string)=>{objects.delete(k);}} as unknown as R2Bucket};
  const network=vi.spyOn(globalThis,'fetch').mockImplementation(async(input)=>{if(String(input)!=='https://download-directory.invalid/rest/v1/rpc/workspace_owner_binding')throw Error('Live network forbidden');return Response.json(mapping);});
  try{
   state.storage.kv.put('do_name',name);state.storage.kv.put('telegram_subject','81101');
   const store=await workspaceOwnerHost(cfg,state.storage,id.toString(),name),page={} as any,bytes=new TextEncoder().encode('<html><script>window.privateDownload = true</script></html>');
   const download={page:()=>page,url:()=> 'https://download.invalid/report',suggestedFilename:()=> 'owner-report.html',failure:async()=>null,createReadStream:async()=>Readable.from([bytes]),delete:async()=>{},cancel:async()=>{}} as any;
   const receipt=await browserDownloadToWorkspace({download,page,workspace:store,operationId:crypto.randomUUID(),deadline:Date.now()+60000,now:Date.now,assertCurrent:async()=>{},origin:'https://owner.invalid',sourceOrigin:'https://download.invalid'});
   const instance=new TelegramOwnerDO(state,cfg);
   expect((await instance.fetch(new Request(receipt.url))).status).toBe(401);
   const access=consoleAccess(state.storage),link=await access.mintLink('https://owner.invalid'),cookie=await access.redeem(new URL(link).searchParams.get('t')!);
   const request=()=>new Request(receipt.url,{headers:{cookie:`${CONSOLE_COOKIE}=${cookie}`}});
   const response=await instance.fetch(request());expect(response.status).toBe(200);expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
   expect(response.headers.get('content-disposition')).toContain('attachment');expect(response.headers.get('x-content-type-options')).toBe('nosniff');expect(response.headers.get('content-type')).toBe('application/octet-stream');expect(response.headers.get('cache-control')).toBe('private, no-store');
   mapping={...mapping,owner_id:'10000000-0000-0000-0000-000000000002',mapping_version:2};expect((await instance.fetch(request())).status).toBe(403);
   mapping=null;expect((await instance.fetch(request())).status).toBe(403);
  }finally{network.mockRestore();await state.storage.deleteAlarm();}
 });
});

it.each(['native_failure','no_stream','oversize','stream_error','deadline','corrupt'])('download %s returns a typed failure without a useful file receipt',async(mode)=>{
 const state:WorkspaceState={binding:null,files:[],bodies:[],operations:[]},objects=new Map<string,Uint8Array>();
 const store=await workspaceStore({binding:{ownerId:'12345678-1234-1234-1234-123456789abc',environment:'staging',namespace:'fixture',doName:'owner',doId:'physical',stateVersion:1,mappingVersion:1},admit:async()=>({status:'ok'}),metadata:{transaction:f=>f(state)},bodies:{put:async(b,v)=>{objects.set(b.blob_id,v.slice());},get:async b=>mode==='corrupt'?new Uint8Array([9]):objects.get(b.blob_id)??null,remove:async()=>{}},now:Date.now,newId:()=>crypto.randomUUID()});
 const page={} as any;let cancelled=false;
 const download={page:()=>page,url:()=> 'https://download.invalid/report',suggestedFilename:()=> 'report.txt',failure:async()=>mode==='native_failure'?'denied':null,createReadStream:async()=>mode==='no_stream'?null:mode==='deadline'?new Readable({read(){}}):mode==='stream_error'?Readable.from((async function*(){throw Error('secret-provider-body');})()):Readable.from([new Uint8Array(mode==='oversize'?10*1024*1024+1:1)]),delete:async()=>{},cancel:async()=>{cancelled=true;}} as any;
 await expect(browserDownloadToWorkspace({download,page,workspace:store,operationId:crypto.randomUUID(),deadline:Date.now()+(mode==='deadline'?20:60000),now:Date.now,assertCurrent:async()=>{},origin:'https://owner.invalid',sourceOrigin:'https://download.invalid'})).rejects.toThrow('browser_download_');
 expect(cancelled).toBe(true);if(mode!=='corrupt')expect(state.files).toHaveLength(0);
});

it('a stalled authority check settles at the existing task deadline before stream dispatch',async()=>{
 const page={} as any;let opens=0;
 const download={page:()=>page,url:()=> 'https://download.invalid/report',suggestedFilename:()=> 'report.txt',createReadStream:async()=>{opens++;return null;},cancel:async()=>{},failure:async()=>null} as any;
 const outcome=browserDownloadToWorkspace({download,page,workspace:{} as any,operationId:crypto.randomUUID(),deadline:Date.now()+20,now:Date.now,assertCurrent:()=>new Promise<void>(()=>{}),origin:'https://owner.invalid',sourceOrigin:'https://download.invalid'}).then(()=> 'receipt',()=> 'typed_failure');
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{expect(await Promise.race([outcome,new Promise<string>(yes=>{timer=setTimeout(()=>yes('hung'),100);})])).toBe('typed_failure');expect(opens).toBe(0);}finally{clearTimeout(timer);}
});

import { Buffer } from 'node:buffer';
it('reused native Buffer memory cannot change previously received download chunks',async()=>{
 const state:WorkspaceState={binding:null,files:[],bodies:[],operations:[]},objects=new Map<string,Uint8Array>();
 const store=await workspaceStore({binding:{ownerId:'12345678-1234-1234-1234-123456789abc',environment:'staging',namespace:'fixture',doName:'owner',doId:'physical',stateVersion:1,mappingVersion:1},admit:async()=>({status:'ok'}),metadata:{transaction:f=>f(state)},bodies:{put:async(b,v)=>{objects.set(b.blob_id,v.slice());},get:async b=>objects.get(b.blob_id)??null,remove:async()=>{}},now:Date.now,newId:()=>crypto.randomUUID()});
 const page={} as any,buffer=Buffer.from([1,2]);
 const download={page:()=>page,url:()=> 'https://download.invalid/report',suggestedFilename:()=> 'bytes.bin',failure:async()=>null,createReadStream:async()=>({destroy(){},async *[Symbol.asyncIterator](){yield buffer;buffer[0]=9;yield Buffer.from([3]);}}),delete:async()=>{},cancel:async()=>{}} as any;
 const receipt=await browserDownloadToWorkspace({download,page,workspace:store,operationId:crypto.randomUUID(),deadline:Date.now()+60000,now:Date.now,assertCurrent:async()=>{},origin:'https://owner.invalid',sourceOrigin:'https://download.invalid'});
 expect((await store.export(receipt.file_id,receipt.revision)).bytes).toEqual(new Uint8Array([1,2,3]));
});


it('rejects a native download URL outside the approved private site before stream or workspace I/O',async()=>{
 const page={} as any;let opened=0,written=0;
 const download={page:()=>page,url:()=> 'https://unapproved.invalid/report',suggestedFilename:()=> 'report.txt',failure:async()=>null,createReadStream:async()=>{opened++;return Readable.from([new Uint8Array([1])]);},delete:async()=>{},cancel:async()=>{}} as any;
 const failure=await browserDownloadToWorkspace({download,page,workspace:{write:async()=>{written++;throw Error('unexpected write');}} as any,operationId:crypto.randomUUID(),deadline:Date.now()+60000,now:Date.now,assertCurrent:async()=>{},origin:'https://owner.invalid',sourceOrigin:'https://download.invalid'} as any).then(()=>null,error=>error);
 expect(opened).toBe(0);expect(written).toBe(0);expect(failure?.message).toBe('browser_download_rejected');
});


const downloadFixture = async () => {
 const state:WorkspaceState={binding:null,files:[],bodies:[],operations:[]},objects=new Map<string,Uint8Array>();let puts=0;
 const store=await workspaceStore({binding:{ownerId:'12345678-1234-1234-1234-123456789abc',environment:'staging',namespace:'fixture',doName:'owner',doId:'physical',stateVersion:1,mappingVersion:1},admit:async()=>({status:'ok'}),metadata:{transaction:f=>f(state)},bodies:{put:async(b,v)=>{puts++;objects.set(b.blob_id,v.slice());},get:async b=>objects.get(b.blob_id)??null,remove:async()=>{}},now:Date.now,newId:()=>crypto.randomUUID()});
 const page={} as any;let opens=0;
 const run=(name:string,bytes=new Uint8Array([1]),operationId=crypto.randomUUID())=>browserDownloadToWorkspace({download:{page:()=>page,url:()=> 'https://download.invalid/report',suggestedFilename:()=>name,failure:async()=>null,createReadStream:async()=>{opens++;return Readable.from([bytes]);},delete:async()=>{},cancel:async()=>{}} as any,page,workspace:store,operationId,deadline:Date.now()+60000,now:Date.now,assertCurrent:async()=>{},origin:'https://owner.invalid',sourceOrigin:'https://download.invalid'});
 return {state,store,run,opens:()=>opens,puts:()=>puts};
};
it.each(['..','folder\\report.txt','bad\u0000name','x'.repeat(300)])('hostile suggested filename %j is rejected before opening a stream',async name=>{
 const fixture=await downloadFixture();await expect(fixture.run(name)).rejects.toThrow('browser_download_');
 expect(fixture.opens()).toBe(0);expect(fixture.puts()).toBe(0);expect(fixture.state.files).toHaveLength(0);
});
it('leading-dot names remain safe logical attachments and same filenames cannot overwrite another operation folder',async()=>{
 const fixture=await downloadFixture(),firstOperation=crypto.randomUUID();
 const a=await fixture.run('.report.html',new Uint8Array([1]),firstOperation),b=await fixture.run('.report.html',new Uint8Array([2]));
 expect(a.file_id).not.toBe(b.file_id);expect(fixture.state.files.map(f=>f.path)).toEqual([expect.stringContaining(firstOperation+'/.report.html'),expect.stringMatching(/^browser-downloads\/[^/]+\/.report.html$/)]);
 await expect(fixture.run('.report.html',new Uint8Array([3]),firstOperation)).rejects.toThrow('browser_download_');
 expect((await fixture.store.export(a.file_id,a.revision)).bytes).toEqual(new Uint8Array([1]));
 expect((await fixture.store.export(b.file_id,b.revision)).bytes).toEqual(new Uint8Array([2]));
 expect(fixture.puts()).toBe(2);
});
it.each(['count','aggregate_bytes'])('native imports cannot bypass existing owner %s quota',async mode=>{
 const fixture=await downloadFixture();await fixture.run('existing.bin');
 // The owner store's retained metadata is the quota authority. Seed its limit,
 // then exercise the actual import write boundary without allocating100MiB here.
 if(mode==='count'){const meta=fixture.state.files[0]!;fixture.state.files=Array.from({length:LIMITS.files},(_,i)=>({...meta,file_id:crypto.randomUUID(),path:`existing/${i}.bin`}));}
 else {const body=fixture.state.bodies[0]!;fixture.state.bodies=Array.from({length:LIMITS.ownerBytes/LIMITS.fileBytes},()=>({...body,blob_id:crypto.randomUUID(),byte_size:LIMITS.fileBytes}));}
 const before=structuredClone(fixture.state);
 await expect(fixture.run('one-more.bin')).rejects.toThrow('browser_download_');
 expect(fixture.puts()).toBe(1);expect(fixture.state).toEqual(before);
});
