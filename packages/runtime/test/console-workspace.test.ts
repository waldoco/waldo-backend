import { expect, it } from 'vitest';
import { workspaceDownload, workspacePage, workspaceRead } from '../src/channels/console-workspace';
import type { FileMeta } from '../../workspace/src/store';
const meta:FileMeta={file_id:'fixture',path:'<script>alert(1)</script>.txt',revision:1,mime:'text/html',byte_size:3,sha256:'fixture',provenance:'owner_upload',source_taint:'external',created_at:0,updated_at:0,state:'ready'};
it('uses private opaque attachment with encoded filename, no executable MIME or public link',async()=>{
 const r=workspaceDownload(new Uint8Array([0,1,2]),meta);expect(r.headers.get('content-type')).toBe('application/octet-stream');expect(r.headers.get('cache-control')).toBe('private, no-store');expect(r.headers.get('content-security-policy')).toContain('sandbox');expect(r.headers.get('content-disposition')).not.toContain('<script>');expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([0,1,2]));
});
it('escapes hostile paths and renders pure controls and empty state',async()=>{
 const r=workspacePage([meta], 'token<canary>', 'cursor');const html=await r.text();expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('action="/console/workspace/upload"');expect(html).toContain('token&lt;canary&gt;');expect(html).toContain('/console/workspace?cursor=cursor');expect(r.headers.get('content-security-policy')).toContain("form-action 'self'");expect(r.headers.get('content-security-policy')).not.toContain('sandbox');expect(html).not.toContain('<script');expect(await workspacePage([], 'csrf', null).text()).toContain('No retained files.');
});

it('projects only admitted workspace metadata for the dashboard without storage custody internals',async()=>{const response=workspaceRead([{...meta,sha256:'never-public-digest'}],'csrf','next');expect(response.headers.get('cache-control')).toBe('private, no-store');const body=await response.json() as {files:unknown[]};expect(body).toMatchObject({version:1,csrf:'csrf',next_cursor:'next',files:[{file_id:'fixture',revision:1,path:meta.path}]});expect(JSON.stringify(body)).not.toContain('never-public-digest');expect(body.files).toHaveLength(1);});
it.each(['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/markdown','text/plain'])('preserves admitted download MIME %s without relaxing private attachment headers',async(mime)=>{
 const bytes=new TextEncoder().encode('Synthetic retained content');
 const r=workspaceDownload(bytes,{...meta,path:'synthetic-file',mime});
 expect(r.headers.get('content-type')).toBe(mime);
 expect(r.headers.get('content-disposition')).toMatch(/^attachment;/);
 expect(r.headers.get('x-content-type-options')).toBe('nosniff');
 expect(r.headers.get('cache-control')).toBe('private, no-store');
 expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'; sandbox");
 expect(r.headers.get('content-length')).toBe(String(bytes.length));
 expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
});
it.each(['text/html','image/svg+xml','application/javascript','application/msword','application/octet-stream','','text/plain; charset=utf-8','application/pdf\r\nX-Test: unsafe'])('keeps unlisted or malformed MIME opaque: %s',(mime)=>{
 const r=workspaceDownload(new Uint8Array([0,1,2]),{...meta,path:'misleading.pdf',mime});
 expect(r.headers.get('content-type')).toBe('application/octet-stream');
 expect(r.headers.get('content-disposition')).toMatch(/^attachment;/);
 expect(r.headers.get('x-content-type-options')).toBe('nosniff');
});

import { workspaceStore, r2Bodies, type WorkspaceState, type OwnerBinding } from '@waldo/workspace';
import { workspaceRequest } from '../src/channels/workspace-host';
import { env, runInDurableObject } from 'cloudflare:test';
import { consoleAccess, CONSOLE_COOKIE } from '../src/channels/console';
it('browse/download keeps two owners isolated and uses the requested immutable revision',async()=>{
 const objects=new Map<string,Uint8Array>();let gets=0;
 const bucket={put:async(k:string,b:Uint8Array)=>{objects.set(k,b.slice());},get:async(k:string)=>{gets++;const b=objects.get(k);return b?{arrayBuffer:async()=>b.slice().buffer}:null;},delete:async(k:string)=>{objects.delete(k);}};
 const make=async(n:number)=>{
  const binding:OwnerBinding={ownerId:`00000000-0000-4000-8000-00000000000${n}`,environment:'test',namespace:'console-qa',doName:`owner-${n}`,doId:`do-${n}`,stateVersion:0,mappingVersion:1};
  let state:WorkspaceState={binding:null,files:[],bodies:[],operations:[]};
  const admit=async()=>({status:'ok' as const});
  return workspaceStore({binding,admit,bodies:await r2Bodies(bucket,binding,admit),metadata:{transaction(work){const next=structuredClone(state);const out=work(next);state=next;return out;}},now:()=>0,newId:()=>crypto.randomUUID()});
 };
 const a=await make(1),b=await make(2);
 const path='notes/<img src=x onerror=alert(1)> "हैलो".md';
 const first=await a.write({path,bytes:new TextEncoder().encode('owner A revision 1'),mime:'text/markdown',expected_revision:0,provenance:'owner_upload',operation_id:crypto.randomUUID()});
 await a.write({path,bytes:new TextEncoder().encode('owner A revision 2'),mime:'text/plain',expected_revision:1,provenance:'owner_upload',operation_id:crypto.randomUUID()});
 const request=(store:typeof a,path:string)=>workspaceRequest(new Request('https://fixture'+path),'csrf',async()=>store,workspacePage,async()=>({release(){},assert(){}}),workspaceDownload);
 const list=await request(a,'/console/workspace');const html=await list.text();
 expect(html).toContain('revision 2');expect(html).toContain(`id=${first.file_id}&amp;revision=2`);expect(html).toContain('&lt;img');expect(html).not.toContain('<img');
 expect(await (await request(b,'/console/workspace')).text()).not.toContain(first.file_id);
 const before=gets;const crossed=await request(b,`/console/workspace/file?id=${first.file_id}&revision=1`);expect(crossed.status).toBe(404);expect(gets).toBe(before);
 const old=await request(a,`/console/workspace/file?id=${first.file_id}&revision=1`);expect(old.status).toBe(200);expect(old.headers.get('content-type')).toBe('text/markdown');expect(old.headers.get('content-disposition')).toContain(encodeURIComponent(path.split('/').at(-1)!).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`));expect(await old.text()).toBe('owner A revision 1');
 expect(await (await request(a,`/console/workspace/file?id=${first.file_id}&revision=2`)).text()).toBe('owner A revision 2');
 for(const revision of ['','0','-1','1.5','999'])expect((await request(a,`/console/workspace/file?id=${first.file_id}&revision=${revision}`)).status).toBe(revision==='999'?404:400);
 await a.tombstone(first.file_id,2);expect((await request(a,`/console/workspace/file?id=${first.file_id}&revision=1`)).status).toBe(404);
});
it('real owner console rejects unsigned and another owner session for both browse and download',async()=>{
 const a=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`console-file-a-${crypto.randomUUID()}`));
 const b=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`console-file-b-${crypto.randomUUID()}`));
 const token=await runInDurableObject(a,async(_instance,state)=>consoleAccess(state.storage).grant());
 for(const path of ['/console/workspace','/console/workspace/file?id=00000000-0000-4000-8000-000000000001&revision=1']){
  expect((await a.fetch('https://fixture'+path)).status).toBe(401);
  expect((await b.fetch('https://fixture'+path,{headers:{cookie:`${CONSOLE_COOKIE}=${token}`}})).status).toBe(401);
 }
 // Positive control: the right owner's own session is not rejected, so an always-401 bug cannot pass this test.
 expect((await a.fetch('https://fixture/console/workspace',{headers:{cookie:`${CONSOLE_COOKIE}=${token}`}})).status).not.toBe(401);
});
