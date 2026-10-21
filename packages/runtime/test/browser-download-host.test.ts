import {expect,it,vi} from 'vitest';
import {workspaceStore,type WorkspaceState} from '@waldo/workspace';
import {commonBrowserHost} from '../src/channels/common-browser-host';
import {commonBrowserFixture,commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
import {generalDigest} from '../src/channels/general-browser-observation';
const probe=vi.hoisted(()=>({dispatches:0}));
vi.mock('../src/channels/cloudflare-general-browser',async load=>{
 const actual=await load<typeof import('../src/channels/cloudflare-general-browser')>();
 return {...actual,cloudflareGeneralBrowser:(options:any)=>({...actual.cloudflareGeneralBrowser(options),download:async(_session:any,_snapshot:any,_reference:string,prepare:()=>Promise<void>,consume:any)=>{
  await prepare();probe.dispatches++;const bytes=new TextEncoder().encode('owner,amount\nfictional,7\n');await consume({filename:'report.csv',mime:'text/csv',byte_size:bytes.length,sha256:await generalDigest(bytes)},bytes);
 }})};
});
async function fixture(){
 commonBrowserFixture.reset();probe.dispatches=0;let live=true,now=Date.now(),failReady=false,replaceAt:'prepared'|'importing'|undefined,filesStalled=false,taskDeadline=now+60000;
 const rows=new Map<string,any>(),state:WorkspaceState={binding:null,files:[],bodies:[],operations:[]},bodies=new Map<string,Uint8Array>();
 const admitted=async()=>{if(!live)throw Error('owner revoked');};
 const storage={kv:{get:(key:string)=>structuredClone(rows.get(key)),put:(key:string,value:any)=>{if(failReady&&value?.download?.state==='ready')throw Error('runtime interrupted after workspace commit');rows.set(key,structuredClone(value));},list:({prefix}:{prefix:string})=>new Map([...rows].filter(([key])=>key.startsWith(prefix)))},transactionSync:<T>(work:()=>T)=>{const current=rows.get('common-browser:download-task');if(replaceAt&&current?.download?.state===replaceAt){replaceAt=undefined;rows.set('common-browser:download-task',{...current,session:{...current.session,generation:current.session.generation+1}});}return work();}} as unknown as DurableObjectStorage;
 const workspace=await workspaceStore({binding:{ownerId:'12345678-1234-1234-1234-123456789abc',environment:'staging',namespace:'fixture',doName:'owner',doId:'physical',stateVersion:1,mappingVersion:1},metadata:{transaction:work=>work(state)},admit:async()=>{await admitted();return {status:'ok'};},bodies:{put:async(meta,bytes)=>{bodies.set(meta.blob_id,bytes.slice());},get:async meta=>bodies.get(meta.blob_id)??null,remove:async()=>{}},now:()=>now,newId:()=>crypto.randomUUID()});
 const grant={ref:'download-grant',ownerId:'fixture-owner',taskId:'download-task',expiresAt:now+60000,allowedOrigins:['https://public-pages.fixture.invalid'],maxScreenshotBytes:1024,lifetimeMs:60000};
 const config={retainInteractions:true as const,binding:{} as never,loadSdk:commonBrowserFixtureLoader,grant:async()=>grant,reserveAllocation:async()=>{},assertGrantCurrent:admitted};
 const makeHost=()=>commonBrowserHost({storage,config,ownerId:'fixture-owner',source:()=>({taskId:grant.taskId,revision:1,sources:['browser'],ready:true,startRef:'owner'}),assertCurrent:admitted,deadline:()=>taskDeadline,now:()=>now,files:async(check)=>{if(filesStalled)await new Promise<void>(()=>{});await check();return {workspace,origin:'https://owner.invalid'};}});
 const ctx={authenticatedUserId:'fixture-owner',turnId:'owner-turn',toolCallId:'download-call',assertTaskSourceCurrent:admitted} as never;
 const host=makeHost(),read=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read'},ctx) as any;
 const args={url:read.data.url,session_handle:read.data.session_handle,task:'Download report',max_actions:1,command:{operation:'download',element_ref:read.data.elements[0].ref}} as const;
 return {host,makeHost,args,ctx,state,rows,revoke:()=>{live=false;},expire:()=>{now=grant.expiresAt+1;},interrupt:()=>{failReady=true;},recover:()=>{failReady=false;},replaceBeforeCommit:(stage:'prepared'|'importing')=>{replaceAt=stage;},stallFiles:()=>{filesStalled=true;taskDeadline=now+20;}};
}
it('the actual host returns a verified private file and replays its committed receipt without provider transport',async()=>{
 const f=await fixture(),result=await f.host.actionHandler.handle(f.args,f.ctx) as any;
 expect(result).toMatchObject({ok:true,source_taint:'external',data:{download:{filename:'report.csv',retrieval:'verified',audience:'owner_authenticated',provenance:'provider_import'}}});
 const recovered=await f.makeHost().actionHandler.handle(f.args,f.ctx) as any;expect(recovered.data.download).toEqual(result.data.download);expect(probe.dispatches).toBe(1);expect(f.state.files).toHaveLength(1);await f.host.cancel();
});
it('an interrupted ready checkpoint recovers the committed workspace bytes without reclick',async()=>{
 const f=await fixture();f.interrupt();expect(await f.host.actionHandler.handle(f.args,f.ctx)).toMatchObject({ok:false});expect(f.state.operations[0]?.status).toBe('committed');
 f.recover();expect(await f.makeHost().actionHandler.handle(f.args,f.ctx)).toMatchObject({ok:true,data:{download:{retrieval:'verified'}}});expect(probe.dispatches).toBe(1);await f.host.cancel();
});
it.each(['foreign','revoked','expired'] as const)('%s owner cannot obtain a file or dispatch download',async mode=>{
 const f=await fixture();if(mode==='revoked')f.revoke();if(mode==='expired')f.expire();
 expect(await f.host.actionHandler.handle(f.args,mode==='foreign'?{...(f.ctx as any),authenticatedUserId:'other-owner'}:f.ctx)).toMatchObject({ok:false});expect(probe.dispatches).toBe(0);expect(f.state.files).toHaveLength(0);await f.host.cancel();
});

it.each(['prepared','importing'] as const)('a generation replacement at the %s commit boundary cannot inherit old download state',async stage=>{
 const f=await fixture();f.replaceBeforeCommit(stage);expect(await f.host.actionHandler.handle(f.args,f.ctx)).toMatchObject({ok:false});
 const latest=f.rows.get('common-browser:download-task');expect(latest.download.state).toBe(stage);if(stage==='prepared')expect(latest.download.metadata).toBeUndefined();else expect(latest.download.receipt).toBeUndefined();expect(probe.dispatches).toBe(1);await f.host.cancel();
});

it('concurrent requests reserve and dispatch one download, without overwriting its receipt',async()=>{
 const f=await fixture();const results=await Promise.all([f.host.actionHandler.handle(f.args,f.ctx),f.host.actionHandler.handle(f.args,f.ctx)]);
 expect(results.filter(result=>result.ok)).toHaveLength(1);expect(probe.dispatches).toBe(1);expect(f.state.files).toHaveLength(1);await f.host.cancel();
});

it('stalled workspace acquisition settles at the funded deadline without a ready receipt',async()=>{
 const f=await fixture();f.stallFiles();expect(await f.host.actionHandler.handle(f.args,f.ctx)).toMatchObject({ok:false});expect(f.state.files).toHaveLength(0);expect(f.rows.get('common-browser:download-task').download.state).toBe('importing');await f.host.cancel();
},200);
