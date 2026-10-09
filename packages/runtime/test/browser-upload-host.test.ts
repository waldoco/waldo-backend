import {env,runInDurableObject} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import {workspaceStore,type WorkspaceState} from '@waldo/workspace';
import {commonBrowserHost} from '../src/channels/common-browser-host';
import {approvalDesk,type BrowserSubmitProposal} from '../src/channels/approvals';
import {ownerEffectLedger} from '../src/channels/owner-effect-ledger';
import {commonBrowserFixture,commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
import {generalDigest} from '../src/channels/general-browser-observation';
const probe=vi.hoisted(()=>({exposures:0,uncertain:false,afterExposure:undefined as undefined|(()=>void)}));
vi.mock('../src/channels/cloudflare-general-browser',async load=>{
 const actual=await load<typeof import('../src/channels/cloudflare-general-browser')>();
 return {...actual,cloudflareGeneralBrowser:(options:any)=>({...actual.cloudflareGeneralBrowser(options),upload:async(_session:any,_snapshot:any,_ref:string,file:any,authority:any,prepare:()=>Promise<void>)=>{
  await authority.assertCurrent();await prepare();probe.exposures++;probe.afterExposure?.();if(probe.uncertain)throw Error('server response lost');
  return {filename:file.name,mime:file.mimeType,byte_size:file.buffer.length,sha256:await generalDigest(file.buffer)};
 }})};
});
async function proof(mode:'approve'|'deny'|'revoked'|'expired'|'uncertain'|'uncertain_revoked'|'changed'){
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`upload-proof-${crypto.randomUUID()}`));
 await runInDurableObject(stub,async(_instance,state)=>{
  commonBrowserFixture.reset();probe.exposures=0;probe.uncertain=mode==='uncertain'||mode==='uncertain_revoked';let owner=true,model=true,now=Date.now(),sequence=0;probe.afterExposure=mode==='uncertain_revoked'?()=>{owner=false;}:undefined;
  const admitted=async()=>{if(!owner)throw Error('owner revoked');},current=async()=>{await admitted();if(!model)throw Error('model turn ended');};
  const workspaceState:WorkspaceState={binding:null,files:[],bodies:[],operations:[]},bodies=new Map<string,Uint8Array>();
  const workspace=await workspaceStore({binding:{ownerId:'12345678-1234-1234-1234-123456789abc',environment:'staging',namespace:'fixture',doName:'owner',doId:'physical',stateVersion:1,mappingVersion:1},metadata:{transaction:work=>work(workspaceState)},admit:async()=>{await admitted();return {status:'ok'};},bodies:{put:async(meta,bytes)=>{bodies.set(meta.blob_id,bytes.slice());},get:async meta=>bodies.get(meta.blob_id)??null,remove:async()=>{}},now:()=>now,newId:()=>crypto.randomUUID()});
  const bytes=new TextEncoder().encode('fictional,7\n'),file=await workspace.write({path:'reports/report.csv',bytes,mime:'text/csv',provenance:'owner_upload',expected_revision:0,operation_id:crypto.randomUUID()});
  const grant={ref:'upload-grant',ownerId:'fixture-owner',taskId:'upload-task',expiresAt:now+60000,allowedOrigins:['https://public-pages.fixture.invalid'],maxScreenshotBytes:1024,lifetimeMs:60000};
  let host:ReturnType<typeof commonBrowserHost>;
  const desk=approvalDesk(state.storage.sql,{effects:ownerEffectLedger(state.storage,()=>now),owner:42,call:async()=>({message_id:1}),google:async()=>null,newId:()=>String(++sequence),now:()=>now,timezone:'UTC',log:()=>{},browserSubmit:(proposal,approval)=>host.submitUpload(proposal,approval),browserReconcile:(proposal,approval)=>host.reconcileUpload(proposal,approval),browserReceiptVerified:(proposal,receipt)=>host.uploadReceiptVerified(proposal,receipt),browserDeny:proposal=>host.denyUpload(proposal)});
  host=commonBrowserHost({storage:state.storage,config:{retainInteractions:true,binding:{} as never,loadSdk:commonBrowserFixtureLoader,grant:async()=>grant,reserveAllocation:async()=>{},assertGrantCurrent:current,assertHandoffCurrent:admitted},ownerId:grant.ownerId,source:()=>({taskId:grant.taskId,revision:1,sources:['browser'],ready:true,startRef:'owner'}),assertCurrent:current,deadline:()=>grant.expiresAt,now:()=>now,files:async(check)=>{await check();return {workspace,origin:'https://owner.invalid'};},proposeUpload:proposal=>desk.proposeBrowserSubmit(proposal)});
  const ctx={authenticatedUserId:grant.ownerId,turnId:'turn',toolCallId:'upload'} as never;
  await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read'},ctx);
  const page=commonBrowserFixture.pages[0],evaluate=page.evaluate;page.evaluate=async()=>{const result=await evaluate();return {...result,elements:result.elements.map((element:any)=>element.type==='file'?{...element,inForm:true,formAction:'https://public-pages.fixture.invalid/upload',formMethod:'post'}:element)};};
  const read=await host.actionHandler.handle({url:page.url(),task:'Inspect',max_actions:1,command:{operation:'inspect'}},ctx) as any;
  const ref=read.data.elements.find((element:any)=>element.name==='Document').ref;
  const proposed=await host.actionHandler.handle({url:page.url(),session_handle:read.data.session_handle,task:'Upload exact CSV',max_actions:1,command:{operation:'upload',element_ref:ref,file_id:file.file_id,revision:file.revision}} as never,ctx) as any;
  expect(proposed).toMatchObject({ok:true,data:{stopped:'approval_pending'}});expect(probe.exposures).toBe(0);
  const id=proposed.data.proposal_id,payload=JSON.parse(state.storage.sql.exec<{payload_json:string}>('SELECT payload_json FROM ledger WHERE id = ?',id).one().payload_json) as BrowserSubmitProposal;
  expect(JSON.stringify(payload)).not.toContain('fictional,7');expect(payload.nativeUpload?.binding.sha256).toBe(file.sha256);
  model=false;if(mode==='revoked')owner=false;if(mode==='expired')now=grant.expiresAt+1;
  if(mode==='changed'){const record=state.storage.kv.get<any>('common-browser:upload-task')!;record.session.generation++;state.storage.kv.put('common-browser:upload-task',record);}
  await desk.decide(id,mode==='deny'?'s':'a','fixture');
  const status=state.storage.sql.exec<{status:string}>('SELECT status FROM ledger WHERE id = ?',id).one().status;
  expect(status).toBe(mode==='approve'?'done':mode==='deny'?'skipped':mode==='expired'?'expired':'uncertain');
  expect(probe.exposures).toBe(mode==='approve'||mode==='uncertain'||mode==='uncertain_revoked'?1:0);
  if(mode==='uncertain_revoked')expect(state.storage.kv.get<any>(`owner:effect:approval:${id}:apply`)?.state).toBe('unknown');
  await desk.decide(id,'a','replay');expect(probe.exposures).toBe(mode==='approve'||mode==='uncertain'||mode==='uncertain_revoked'?1:0);
  await host.cancel();await state.storage.deleteAlarm();
 });
}
it.each(['approve','deny','revoked','expired','uncertain','uncertain_revoked','changed'] as const)('existing approval desk %s gates exact file exposure and never replays',proof);
