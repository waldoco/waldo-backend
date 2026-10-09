import {browserUploadBinding,browserUploadBytes} from './browser-upload-binding';
import type {BrowserSubmitProposal} from './approvals';
import type {BrowserSubmitOutcome} from '../tools/live/browser';
import type {NativeHandoffMetadata} from './native-browser-handoff';
import { triggerTypeSchema, TOOL_PERMISSIONS, browserSessionSchema, browsePageArgsSchema, browseActArgsSchema, type BrowseActArgs, type BrowserSession, type ToolHandler, type BrowsePageArgs, type LLMAttachment } from '@waldo/contracts';
import type { BrowserWorker } from '@cloudflare/playwright';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';
import { cloudflareGeneralBrowser,GeneralBrowserError } from './cloudflare-general-browser';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { TaskSourceSnapshot } from './task-source-scope';
import { PUBLIC_WEB_ORIGIN, isPublicWebUrl } from './public-web-policy';
import type { GeneralSnapshot, GeneralActionSnapshot } from './general-browser-observation';
import type {workspaceOwnerHost} from './workspace-host';
import {generalDigest} from './general-browser-observation';
import {browserScreenshotToWorkspace} from './browser-screenshot-workspace';
import {browserDownloadToWorkspace,type BrowserDownloadMetadata,type BrowserDownloadReceipt} from './browser-download-workspace';
import type { GeneralBrowserAction } from './general-browser-actions';
export type CommonBrowserGrant = Readonly<{ ref:string;taskId:string;ownerId:string;expiresAt:number;allowedOrigins:readonly string[];maxScreenshotBytes:number;lifetimeMs:number;keepAliveMs?:number }>;
// Private registered host capability. Neither model arguments nor environment switches mint it.
export type CommonBrowserConfiguration = Readonly<{
 // Trusted owner runtime capability; direct hosts default to close-before-detach.
 retainInteractions?:true;
 ownsGrant?(grant:CommonBrowserGrant):boolean;
 allocationClosed?(grant:CommonBrowserGrant,session:BrowserSession):Promise<void>;
 binding:BrowserWorker;loadSdk:CloudflareBrowserSdkLoader;
 bindingForOperation?(grant:CommonBrowserGrant,operationId:string):BrowserWorker;
 cleanupBinding?(grant:CommonBrowserGrant,providerSessionId:string):BrowserWorker;
 meterGateway?(gateway:import('../llm/provider').LLMGatewayAdapter):import('../llm/provider').LLMGatewayAdapter;
 grant(task:TaskSourceSnapshot,ownerId:string):Promise<CommonBrowserGrant>;
 reserveAllocation(grant:CommonBrowserGrant):Promise<void>;
 assertGrantCurrent(grant:CommonBrowserGrant):Promise<void>;
 assertHandoffCurrent?(grant:CommonBrowserGrant):Promise<void>;
}>;
// Application checkpoint budget, deliberately below SQLite's 2 MiB combined
// key/value limit. Measure UTF-8 JSON, including the envelope, and reserve room
// for the bounded intent/cleanup metadata added after observation publication.
export const COMMON_BROWSER_CHECKPOINT_BYTES=128*1024;
const encodedCheckpointBytes=(record:BrowserRecord)=>new TextEncoder().encode(JSON.stringify(record)).byteLength;
export const COMMON_BROWSER_DUE='common_browser_due_v1';
type BrowserRecord={upload?:Readonly<{proposal:BrowserSubmitProposal;approvalRef?:string;state:'proposing'|'pending'|'exposed'|'verified'|'denied';outcome?:BrowserSubmitOutcome}>;download?:Readonly<{operationId:string;digest:string;state:'prepared'|'importing'|'ready';metadata?:BrowserDownloadMetadata;receipt?:BrowserDownloadReceipt}>;handoff?:NativeHandoffMetadata;grant:CommonBrowserGrant;session:BrowserSession;tabs:Readonly<{url:string;ref:string}>[];allocation:'prepared'|'observed';observation?:GeneralActionSnapshot;action?:Readonly<{digest:string;state:'prepared'|'observed'|'uncertain'}>;cleanup?:'pending'|'closed';cleanupFailed?:boolean};
const sameSession=(a:BrowserRecord,b:BrowserRecord)=>a.session.ownerId===b.session.ownerId&&a.session.id===b.session.id&&a.session.generation===b.session.generation&&a.session.providerSessionId===b.session.providerSessionId&&JSON.stringify(a.grant)===JSON.stringify(b.grant);
const publishCleanup=(storage:DurableObjectStorage,key:string,expected:BrowserRecord,closed:boolean)=>storage.transactionSync(()=>{
 const current=storage.kv.get<BrowserRecord>(key);
 if(!current||!sameSession(current,expected)||current.cleanup==='closed')return;
 storage.kv.put(key,{...current,cleanup:closed?'closed':'pending',cleanupFailed:closed?undefined:true,session:{...current.session,state:closed?'ended':current.session.state}});
});
export function commonBrowserHost(options:Readonly<{
 storage:DurableObjectStorage;config:CommonBrowserConfiguration;ownerId:string;egressAllowlist?:readonly string[];
 proposeUpload?(proposal:BrowserSubmitProposal):Promise<string>;
 files?(assertCurrent:()=>Promise<void>,ownerId:string,approved?:true):Promise<{workspace:Awaited<ReturnType<typeof workspaceOwnerHost>>;origin:string}>;
 source():TaskSourceSnapshot;assertCurrent():Promise<void>;deadline():number;now():number;
}>) {
 let images:LLMAttachment[]=[];
 let handoffSession:BrowserSession|undefined;
 let human: Awaited<ReturnType<ReturnType<typeof cloudflareGeneralBrowser>['beginOwnerHandoff']>>|undefined;
 let execution:Readonly<{grant:string;driver:ReturnType<typeof cloudflareGeneralBrowser>}>|undefined;
 const snapshot=()=>options.source();
 const checked=async()=>{await options.assertCurrent();const task=snapshot();if(!task.ready||!task.sources.includes('browser')&&!task.sources.includes('web'))throw Error('common browser source unavailable');return task;};
 const granted=async()=>{
  const task=await checked();const supplied=await options.config.grant(task,options.ownerId);const grant=Object.freeze({...supplied,allowedOrigins:Object.freeze([...supplied.allowedOrigins])});await checked();
  if(grant.ownerId!==options.ownerId||grant.taskId!==task.taskId||grant.expiresAt<=options.now()||!grant.ref||!Number.isSafeInteger(grant.expiresAt)||!Number.isSafeInteger(grant.lifetimeMs)||grant.lifetimeMs<10000||!Number.isSafeInteger(grant.keepAliveMs??grant.lifetimeMs)||(grant.keepAliveMs??grant.lifetimeMs)<10000||(grant.keepAliveMs??grant.lifetimeMs)>600000||!Number.isSafeInteger(grant.maxScreenshotBytes)||grant.maxScreenshotBytes<1||!grant.allowedOrigins.length||grant.allowedOrigins.some(origin=>{if(origin===PUBLIC_WEB_ORIGIN)return false;try{const url=new URL(origin);return url.protocol!=='https:'||url.origin!==origin||!!url.username||!!url.password;}catch{return true;}}))throw Error('common browser grant rejected');
  await options.config.assertGrantCurrent(grant);return grant;
 };
 type Record=BrowserRecord;
 const key=(taskId:string)=>`common-browser:${taskId}`;
 const makeDriver=(grant:CommonBrowserGrant,operationId?:string,retainConnection=false)=>cloudflareGeneralBrowser({ownerId:options.ownerId,publicRead:true,retainConnection,binding:operationId&&options.config.bindingForOperation?options.config.bindingForOperation(grant,operationId):options.config.binding,cleanupBinding:options.config.cleanupBinding? id=>options.config.cleanupBinding!(grant,id):undefined,loadSdk:options.config.loadSdk,now:options.now,deadline:options.deadline,cleanupTimeoutMs:10000,maxScreenshotBytes:grant.maxScreenshotBytes,
  admit:async()=>{await checked();await options.config.assertGrantCurrent(grant);await checked();const row=options.storage.kv.get<BrowserRecord>(key(grant.taskId));if(row?.cleanup||row?.handoff&&row.handoff.state!=='resuming')throw Error('common browser stopped');},
  authorizeHumanRequest:async(url,_method)=>{await handoffCurrent(grant);return isPublicWebUrl(url,options.egressAllowlist)&&(grant.allowedOrigins.includes(PUBLIC_WEB_ORIGIN)||grant.allowedOrigins.includes(new URL(url).origin));},
  authorizeRequest:async(url,method)=>{if(!['GET','HEAD'].includes(method))return false;try{return isPublicWebUrl(url,options.egressAllowlist)&&(grant.allowedOrigins.includes(PUBLIC_WEB_ORIGIN)||grant.allowedOrigins.includes(new URL(url).origin));}catch{return false;}}});
 const executionDriver=(grant:CommonBrowserGrant,ctx:ToolDispatcherContext)=>{
  if(options.config.bindingForOperation&&(!ctx.turnId||!ctx.toolCallId))throw Error('common browser operation identity unavailable');
  const identity=JSON.stringify(grant);
  if(execution&&execution.grant!==identity)throw Error('common browser execution grant changed');
  execution??={grant:identity,driver:makeDriver(grant,JSON.stringify([grant.ownerId,grant.taskId,ctx.turnId,ctx.toolCallId]),options.config.retainInteractions===true)};
  return execution.driver;
 };
 const save=(record:BrowserRecord,storageKey:string)=>options.storage.transactionSync(()=>{
  if(encodedCheckpointBytes(record)>COMMON_BROWSER_CHECKPOINT_BYTES)throw new GeneralBrowserError('observation_oversize');
  options.storage.kv.put(storageKey,record);
  const due=[...options.storage.kv.list<BrowserRecord>({prefix:'common-browser:'})].map(([,row])=>row).filter(row=>row.cleanup!=='closed'&&!row.cleanupFailed).map(row=>row.session.expiresAt);
  options.storage.kv.put(COMMON_BROWSER_DUE,due.length?Math.min(...due):null);
 });
 const handoffCurrent=async(grant:CommonBrowserGrant)=>{
  if(!options.config.assertHandoffCurrent)throw Error('owner handoff custody unavailable');
  await options.config.assertHandoffCurrent(grant);
  const row=options.storage.kv.get<Record>(key(grant.taskId));
  if(!row||row.cleanup||row.session.ownerId!==options.ownerId||row.session.expiresAt<=options.now()||JSON.stringify(row.grant)!==JSON.stringify(grant)||!row.handoff||handoffSession&&(row.session.id!==handoffSession.id||row.session.generation!==handoffSession.generation||row.session.providerSessionId!==handoffSession.providerSessionId))throw Error('owner handoff unavailable');
  return row;
 };
 const publishObservation=async(grant:CommonBrowserGrant,record:Record,observed:GeneralSnapshot,ctx:ToolDispatcherContext)=>{
  await checked();await ctx.assertTaskSourceCurrent?.();
  const latest=options.storage.kv.get<Record>(key(grant.taskId));
  if(!latest||latest.cleanup||!sameSession(latest,record))throw Error('common browser custody changed');
  const {image:_,...observation}=observed;
  const checkpoint={...latest,observation,tabs:observed.observation.tabs.map(tab=>({url:tab.url,ref:tab.ref}))};
  if(encodedCheckpointBytes(checkpoint)>COMMON_BROWSER_CHECKPOINT_BYTES-1024){
   // Do not truncate native refs/state or leave an older observation actionable.
   // The retained exact session remains available for explicit cleanup.
   save({...latest,observation:undefined,tabs:[]},key(grant.taskId));
   throw new GeneralBrowserError('observation_oversize');
  }
  save(checkpoint,key(grant.taskId));
  let binary='';for(const byte of observed.image.bytes)binary+=String.fromCharCode(byte);
  if(images.length>=4)images.shift();
  images.push({kind:'image',filename:`browser-${observed.observation.revision}.png`,mime_type:observed.image.mime_type,data_base64:btoa(binary)});
  return {ok:true as const,data:{...observed.observation,session_handle:record.session.id,text:observed.observation.text.slice(0,8000),elements:observed.observation.elements.slice(0,64),tabs:observed.observation.tabs.slice(0,8),
   field_values:observed.state.elements.slice(0,64).flatMap((element,index)=>['input','textarea','select'].includes(element.tag)&&!['password','file','hidden'].includes(element.type)?[{ref:observed.observation.elements[index]!.ref,name:element.name,value:element.value}]:[]),
   ...(latest.action?.state==='uncertain'||latest.action?.state==='prepared'?{action_outcome:'uncertain'}:{})},source_taint:'external' as const};
 };
 const handler:ToolHandler<BrowsePageArgs,unknown,ToolDispatcherContext>={name:'browse_page',description:'Read a granted public page in the retained task browser. Returns a bounded observation; its screenshot reaches the model as an image. No login, page writes or submit.',schema:browsePageArgsSchema,trigger_allowlist:triggerTypeSchema.options.filter(trigger=>TOOL_PERMISSIONS[trigger].includes('browse_page')),autonomy_gated:false,
  async handle(args,ctx){
   try{
    await ctx.assertTaskSourceCurrent?.();const grant=await granted();
    if(args.provider&&args.provider!=='cloudflare_playwright'||ctx.authenticatedUserId!==options.ownerId||args.session_handle&&options.storage.kv.get<Record>(key(grant.taskId))?.session.id!==args.session_handle||(!isPublicWebUrl(args.url,options.egressAllowlist)||!grant.allowedOrigins.includes(PUBLIC_WEB_ORIGIN)&&!grant.allowedOrigins.includes(new URL(args.url).origin)))throw Error('common browser target rejected');
    if(options.config.bindingForOperation&&(!ctx.turnId||!ctx.toolCallId))throw Error('common browser operation identity unavailable');
    const driver=executionDriver(grant,ctx);const storageKey=key(grant.taskId);let record=options.storage.kv.get<Record>(storageKey);
    if(record?.handoff){if(!human)await api.cancel();throw Error('owner login pending');}
    if(record&&(JSON.stringify(record.grant)!==JSON.stringify(grant)||record.session.ownerId!==options.ownerId||record.cleanup||record.allocation!=='observed'))throw Error('common browser retained identity uncertain');
    if(!record){
     const now=options.now();record={grant,allocation:'prepared',tabs:[],session:browserSessionSchema.parse({id:crypto.randomUUID(),ownerId:options.ownerId,provider:'cloudflare_playwright',providerSessionId:'pending',contextHandle:null,mode:'public',state:'starting',generation:1,expiresAt:Math.min(grant.expiresAt,now+grant.lifetimeMs),updatedAt:now})};
     await driver.start(grant.allowedOrigins.includes(PUBLIC_WEB_ORIGIN)?'public':grant.allowedOrigins.map(origin=>new URL(origin).hostname),grant.keepAliveMs??grant.lifetimeMs,async()=>{await options.config.reserveAllocation(grant);await checked();save(record!,storageKey);},async id=>{options.storage.transactionSync(()=>{const retained=options.storage.kv.get<Record>(storageKey);if(!retained||retained.session.id!==record!.session.id||retained.session.generation!==record!.session.generation||JSON.stringify(retained.grant)!==JSON.stringify(grant))throw Error('common browser allocation custody changed');record={...retained,cleanupFailed:undefined,allocation:'observed',session:{...retained.session,providerSessionId:id,state:retained.cleanup?retained.session.state:'active',updatedAt:options.now()}};save(record!,storageKey);});},async()=>{await options.config.allocationClosed?.(grant,record!.session);publishCleanup(options.storage,storageKey,record!,true);});
    }
    // Trusted interaction preparation can retain the guarded connection in a
    // turn; default serving reads close documents before disconnect. Stop
    // terminates the exact separately funded session in either mode.
    const recovering=!!record.observation&&!driver.hasRetainedConnection();
    const observed=record.observation?.observation.url===args.url&&driver.hasRetainedConnection()?await driver.observe(record.session,record.observation.observation.tab_ref):await driver.navigate(record.session,args.url);
    const published=await publishObservation(grant,record,observed,ctx);
    return {...published,data:{...published.data,...(recovering?{document_state:'recreated',previous_document_lost:true,document_notice:'The prior browser document was lost. Unsent form values and old action refs are unavailable. The page was recreated in the same paid session; no effect was replayed.'}:{})}};
   }catch(error){return {ok:false,code:'rejected',error:'Public browser read is unavailable or uncertain. Inspect retained task state before retrying; no successful read is claimed.'+(error instanceof GeneralBrowserError?' Browser diagnostic: '+JSON.stringify({browser_code:error.code,...(error.diagnostic?{diagnostic:error.diagnostic}:{}),...(error.cleanup_failed?{cleanup_failed:true}:{}),...(error.release_failed?{release_failed:true}:{})}):''),source_taint:'external'};}
  }};
 const actionHandler:ToolHandler<BrowseActArgs,unknown,ToolDispatcherContext>={name:'browse_act',description:'Interact with the current Cloudflare public page using observed refs: goto, read, inspect, type, click, select, set_checked, scroll. Download observed HTTP GET attachment links into the private owner workspace. File selection, page sends and native submits are unsupported. Unknown outcomes block repeated effects; read evidence before deciding what completed.',schema:browseActArgsSchema,trigger_allowlist:triggerTypeSchema.options.filter(trigger=>TOOL_PERMISSIONS[trigger].includes('browse_act')),autonomy_gated:false,
  async handle(args,ctx){let storageKey:string|undefined,digest:string|undefined;
   try{
    if(options.config.retainInteractions!==true)throw Error('retained interaction capability unavailable');
    await ctx.assertTaskSourceCurrent?.();const grant=await granted();storageKey=key(grant.taskId);
    let record=options.storage.kv.get<Record>(storageKey);
    if(ctx.authenticatedUserId!==options.ownerId||!args.command||!record||args.session_handle&&record.session.id!==args.session_handle||record.cleanup||record.allocation!=='observed'||JSON.stringify(record.grant)!==JSON.stringify(grant)||!record.handoff&&(!record.observation||args.url!==record.observation.observation.url))throw Error('current browser observation unavailable');
    const command=args.command;
    if(command.operation==='cancel'){await api.cancel();return {ok:true,data:{ended:true},source_taint:'external'};}
    if(record.handoff){
     if(command.operation!=='resume_owner_login'||record.handoff.requestRunId===(ctx.runScope?.runId??ctx.turnId)||!human){if(!human)await api.cancel();throw Error('owner login pending');}
     const held=human;
     await held.controller.resume(()=>options.storage.transactionSync(()=>{
      const latest=options.storage.kv.get<Record>(storageKey!);
      if(!latest||latest.cleanup||!sameSession(latest,record!)||latest.handoff?.handoffId!==held.handoffId||latest.handoff.state!=='pending'||latest.session.expiresAt<=options.now())throw Error('owner login custody changed');
      save({...latest,handoff:{...latest.handoff,state:'resuming'},observation:undefined,tabs:[]},storageKey!);
     }));
     const driver=executionDriver(grant,ctx);
     const reference=await generalDigest(JSON.stringify([record.session.ownerId,record.session.id,record.session.generation,record.handoff.targetId])).then(value=>`tab:${value.slice(0,24)}`);
     const observed=await driver.finishOwnerHandoff(record.session,reference);
     await checked();await handoffCurrent(grant);
     const latest=options.storage.kv.get<Record>(storageKey!)!;
     save({...latest,handoff:undefined,observation:undefined},storageKey!);human=undefined;
     const published=await publishObservation(grant,record,observed,ctx);
     return {...published,data:{...published.data,owner_login:'completed',intended_account_verification_required:true,notice:'Provider completion is not intended-account verification. Verify the observed signed-in account before continuing.'}};
    }
    const driver=executionDriver(grant,ctx),before=record.observation!;
    if(command.operation==='upload'){
     if(!options.files||!options.proposeUpload||!options.config.assertHandoffCurrent||record.upload&&record.upload.state!=='denied'||record.action?.state==='prepared'||record.action?.state==='uncertain'||record.download&&record.download.state!=='ready')throw Error('native upload unavailable');
     const files=await options.files(async()=>{await checked();},options.ownerId),file=await files.workspace.stat(command.file_id);await checked();await ctx.assertTaskSourceCurrent?.();
     if(!file||file.revision!==command.revision)throw Error('exact current file revision unavailable');
     const binding=browserUploadBinding({session:record.session,snapshot:before,elementRef:command.element_ref,file,operationId:crypto.randomUUID(),now:options.now()});
     const element=before.state.elements[before.observation.elements.findIndex(element=>element.ref===command.element_ref)]!;
     const proposal:BrowserSubmitProposal={url:before.observation.url,action:{selector:element.selector,description:`Select and upload ${binding.filename} (${binding.byteSize} bytes)`,method:'POST'},binding:{file_id:binding.fileId,revision:String(binding.revision),sha256:binding.sha256,filename:binding.filename,byte_size:String(binding.byteSize),destination:binding.destination,session_handle:binding.sessionHandle,generation:String(binding.generation),document_revision:binding.documentRevision},steps:['Owner approval exposes this exact file to page JavaScript at the named destination.','Verify independent server filename, size and SHA acknowledgment; never repeat an uncertain upload.'],request:{url:binding.destination,method:'POST',fields:[binding.filename]},approvalExpiresAt:binding.expiresAt,nativeUpload:{taskId:grant.taskId,binding}};
     options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey!);if(!latest||latest.cleanup||latest.handoff||!sameSession(latest,record!)||latest.observation?.digest!==before.digest||latest.upload?.proposal.nativeUpload?.binding.operationId!==record!.upload?.proposal.nativeUpload?.binding.operationId)throw Error('upload preparation changed');save({...latest,upload:{proposal,state:'proposing'}},storageKey!);});
     const approvalRef=await options.proposeUpload(proposal);await checked();
     options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey!);if(!latest||latest.cleanup||!sameSession(latest,record!)||latest.upload?.proposal.nativeUpload?.binding.operationId!==binding.operationId||latest.upload.state!=='proposing')throw Error('upload approval custody changed');save({...latest,upload:{...latest.upload,approvalRef,state:'pending'}},storageKey!);});
     return {ok:true,data:{stopped:'approval_pending',proposal_id:approvalRef,notice:'Approve the exact file and destination before any bytes enter the page.'},source_taint:'external'};
    }
    if(command.operation==='download'){
     const duration=Math.min(record.session.expiresAt,options.deadline())-options.now();
     if(!Number.isSafeInteger(duration)||duration<1||duration>2147483647)throw Error('download expired');
     let timer:ReturnType<typeof setTimeout>|undefined,downloadExpired=false;
     const interrupted=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{downloadExpired=true;reject(Error('download expired'));},duration);});
     const runDownload=async()=>{
     if(!options.files||record.action?.state==='prepared'||record.action?.state==='uncertain')throw Error('owner download unavailable');
     const downloadDigest=await generalDigest(JSON.stringify([before.targetId,before.observation.revision,command.element_ref]));
     const prior=record.download;
     if(prior&&prior.digest!==downloadDigest&&prior.state!=='ready')throw Error('prior download uncertain');
     const operationId=prior?.digest===downloadDigest?prior.operationId:crypto.randomUUID();
     const currentDownload=()=>{
      const latest=options.storage.kv.get<Record>(storageKey!);
      if(downloadExpired||!latest||latest.cleanup||latest.handoff||!sameSession(latest,record!)||latest.session.expiresAt<=options.now()||options.deadline()<=options.now()||latest.download?.operationId!==operationId||latest.download.digest!==downloadDigest)throw Error('download custody changed');
      return latest;
     };
     const assertDownload=async()=>{
      await checked();await options.config.assertGrantCurrent(grant);await ctx.assertTaskSourceCurrent?.();
      currentDownload();
     };
     const importFile=async(metadata:BrowserDownloadMetadata,bytes?:Uint8Array)=>{
      await assertDownload();const files=await options.files!(assertDownload,options.ownerId);await assertDownload();
      const receipt=await browserDownloadToWorkspace({...files,operationId,metadata,bytes,deadline:Math.min(record.session.expiresAt,options.deadline()),now:options.now,assertCurrent:assertDownload});
      await assertDownload();options.storage.transactionSync(()=>{const latest=currentDownload();save({...latest,download:{...latest.download!,state:'ready',receipt}},storageKey!);});
      return receipt;
     };
     let receipt:BrowserDownloadReceipt|undefined;
     if(prior?.digest===downloadDigest){
      if(!prior.metadata)throw Error('download body unavailable; no repeat');
      receipt=await importFile(prior.metadata);
     }else{
      await driver.download(record.session,before,command.element_ref,async()=>{
       await checked();await options.config.assertGrantCurrent(grant);await ctx.assertTaskSourceCurrent?.();
       options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey!);if(downloadExpired||!latest||latest.cleanup||latest.handoff||!sameSession(latest,record!)||latest.observation?.observation.revision!==before.observation.revision||latest.download?.operationId!==prior?.operationId||latest.session.expiresAt<=options.now()||options.deadline()<=options.now())throw Error('download document changed');save({...latest,download:{operationId,digest:downloadDigest,state:'prepared'}},storageKey!);});
      },async(metadata,bytes)=>{
       await assertDownload();options.storage.transactionSync(()=>{const latest=currentDownload();save({...latest,download:{...latest.download!,state:'importing',metadata}},storageKey!);});
       receipt=await importFile(metadata,bytes);
      });
     }
     if(!receipt)throw Error('download receipt unavailable');await assertDownload();
     return {ok:true,data:{session_handle:record.session.id,download:receipt,notice:'Attachment bytes are saved and retrieval verified in your private workspace. This is not verification of the broader browser task.'},source_taint:'external'} as const;
     };
     try{return await Promise.race([runDownload(),interrupted]);}finally{if(timer!==undefined)clearTimeout(timer);}
    }
    if(command.operation==='owner_login'){
     if(!options.config.assertHandoffCurrent||!(ctx.runScope?.runId??ctx.turnId))throw Error('owner login unavailable');
     images=[];handoffSession={...record.session};
     save({...record,observation:undefined,tabs:[],handoff:{version:1,state:'starting',targetId:before.targetId,origin:new URL(before.observation.url).origin,reason:command.reason,requestRunId:(ctx.runScope?.runId??ctx.turnId)!}},storageKey);
     try {
      human=await driver.beginOwnerHandoff(record.session,before,command.reason,async()=>{await handoffCurrent(grant);});
      const latest=await handoffCurrent(grant);
      save({...latest,handoff:{...latest.handoff!,state:'pending',handoffId:human.handoffId,origin:human.origin}},storageKey);
      return {ok:true,data:{owner_login:'pending',console_path:'/console/browser-handoff',session_handle:record.session.id,notice:'End this turn. Open the authenticated owner console to sign in directly on the provider page, then send Waldo a new reply to resume.'},source_taint:'external'};
     }catch {await api.cancel();throw Error('owner login unavailable');}
    }
    if(command.operation==='resume_owner_login')throw Error('no pending login');
    let observed:GeneralSnapshot;
    if(command.operation==='read'||command.operation==='inspect'||command.operation==='screenshot'||command.operation==='switch_tab')observed=await driver.observe(record.session,command.operation==='switch_tab'?command.tab_ref:before.observation.tab_ref);
    else {
     if(record.action?.state==='prepared'||record.action?.state==='uncertain')throw Error('prior browser effect uncertain');
     if('intent' in command&&command.intent==='send')throw Error('browser approval required');
     const prepare=async(prepared:string)=>{
       await checked();await options.config.assertGrantCurrent(grant);await ctx.assertTaskSourceCurrent?.();
       options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey!);if(!latest||latest.cleanup||!sameSession(latest,record!)||latest.observation?.observation.revision!==before.observation.revision||latest.action?.state==='prepared'||latest.action?.state==='uncertain')throw Error('browser effect custody changed');save({...latest,action:{digest:prepared,state:'prepared'}},storageKey!);digest=prepared;});
     };
     if(command.operation==='open_tab'){await prepare(await generalDigest(JSON.stringify({revision:before.observation.revision,...command})));observed=await driver.openTab(record.session,command.url);}
     else if(command.operation==='close_tab'){await driver.closeTab(record.session,command.tab_ref,prepare);observed=await driver.observe(record.session);}
     else if(command.operation==='goto'){await prepare(await generalDigest(JSON.stringify({revision:before.observation.revision,...command})));observed=await driver.navigate(record.session,command.url,before.observation.tab_ref);}
     else {
      const action:GeneralBrowserAction|undefined=command.operation==='click'?{operation:'click',element_ref:command.element_ref}:command.operation==='select'?{operation:'select',element_ref:command.element_ref,value:command.value}:command.operation==='set_checked'?{operation:'set_checked',element_ref:command.element_ref,checked:command.checked}:command.operation==='type'?command.key?{operation:'press',element_ref:command.element_ref,key:command.key}:{operation:'fill',element_ref:command.element_ref,value:command.value!}:command.operation==='scroll'?{operation:'scroll',delta:command.delta}:undefined;
      if(!action)throw Error('unsupported current browser command');
      const element=action.operation==='scroll'?undefined:before.state.elements[before.observation.elements.findIndex(row=>row.ref===action.element_ref)];
      if(element?.inForm&&(action.operation==='press'&&action.key==='Enter'||action.operation==='click'&&(element.tag==='button'&&element.type!=='button'||element.tag==='input'&&['submit','image'].includes(element.type))))throw Error('native browser submit approval required');
      observed=await driver.act(record.session,before,action,prepare);
     }
    }
    if(digest){const completed=digest;options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey!);if(latest?.action?.digest===completed)save({...latest,action:{digest:completed,state:'observed'}},storageKey!);});}
    const published=await publishObservation(grant,record,observed,ctx);
    if(command.operation==='screenshot'){
      if(!options.files)throw Error('owner screenshot storage unavailable');
      const files=await options.files(async()=>{await checked();},options.ownerId);
      const receipt=await browserScreenshotToWorkspace({...files,image:observed.image.bytes,maxScreenshotBytes:grant.maxScreenshotBytes,operationId:crypto.randomUUID(),deadline:Math.min(record.session.expiresAt,options.deadline()),now:options.now,assertCurrent:async()=>{await checked();}});
      return {...published,data:{...published.data,screenshot:receipt}};
    }
    return {...published,data:{...published.data,...(!['read','inspect','screenshot','switch_tab'].includes(command.operation)?{browser_action_session_handle:record.session.id}:{})}};
   }catch(error){
    if(storageKey&&digest){const failed=digest;options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey!);if(latest?.action?.digest===failed)save({...latest,action:{digest:failed,state:'uncertain'}},storageKey!);});}
    return {ok:false,code:'rejected',error:'The public browser action was rejected or its outcome is uncertain. No replacement browser or unapproved page write was allowed. Inspect the current page before retrying.'+(error instanceof GeneralBrowserError?' Browser diagnostic: '+JSON.stringify({browser_code:error.code,...(error.diagnostic?{diagnostic:error.diagnostic}:{}),...(error.cleanup_failed?{cleanup_failed:true}:{}),...(error.release_failed?{release_failed:true}:{})}):''),source_taint:'external'};
   }
  }};
 const uploadRecord=(proposal:BrowserSubmitProposal)=>{
  const native=proposal.nativeUpload;if(!native||native.binding.ownerId!==options.ownerId)throw Error('upload owner unavailable');
  const row=options.storage.kv.get<Record>(key(native.taskId));
  if(!row?.upload||row.cleanup||row.handoff||row.session.ownerId!==options.ownerId||row.session.id!==native.binding.sessionHandle||row.session.generation!==native.binding.generation||row.session.expiresAt<=options.now()||row.observation?.digest!==native.binding.documentDigest||JSON.stringify(row.upload.proposal)!==JSON.stringify(proposal)||row.upload.state==='denied')throw Error('upload custody unavailable');
  return row;
 };
 const uploadCurrent=async(proposal:BrowserSubmitProposal)=>{const before=uploadRecord(proposal);if(!options.config.assertHandoffCurrent)throw Error('approved custody unavailable');await options.config.assertHandoffCurrent(before.grant);const after=uploadRecord(proposal);if(!sameSession(before,after))throw Error('upload session changed');return after;};
 const uploadReceiptVerified=async(proposal:BrowserSubmitProposal,receipt:Extract<BrowserSubmitOutcome,{status:'verified_with_receipt'}>['receipt'])=>{
  try{const row=await uploadCurrent(proposal);return row.upload?.state==='verified'&&row.upload.outcome?.status==='verified_with_receipt'&&JSON.stringify(row.upload.outcome.receipt)===JSON.stringify(receipt);}catch{return false;}
 };
 const reconcileUpload=async(proposal:BrowserSubmitProposal,_approvalRef?:string):Promise<BrowserSubmitOutcome>=>{
  try{const row=await uploadCurrent(proposal);if(row.upload?.state==='verified'&&row.upload.outcome)return row.upload.outcome;return {status:'uncertain',message:'Upload outcome is unknown; the file was not selected or sent again.'};}catch{return {status:'uncertain',message:'Upload custody is unavailable; this cannot prove the server did not receive bytes. No retry was performed.'};}
 };
 const submitUpload=async(proposal:BrowserSubmitProposal,approvalRef?:string):Promise<BrowserSubmitOutcome>=>{
  let exposed=false;
  try{
   const row=await uploadCurrent(proposal),binding=proposal.nativeUpload!.binding;
   if(!approvalRef||row.upload?.approvalRef&&row.upload.approvalRef!==approvalRef)throw Error('approval reference changed');
   const approved=options.storage.sql.exec<{status:string;payload_json:string}>('SELECT status, payload_json FROM ledger WHERE id = ? AND kind = ?',approvalRef,'browser_submit').toArray()[0];
   if(approved?.status!=='uncertain'||approved.payload_json!==JSON.stringify(proposal))throw Error('owner approval not claimed');
   if(row.upload?.state==='exposed'||row.upload?.state==='verified')return reconcileUpload(proposal,approvalRef);
   if(!options.files||!execution||execution.grant!==JSON.stringify(row.grant)||!row.observation)throw Error('retained upload document unavailable');
   const authority=async()=>{await uploadCurrent(proposal);},files=await options.files(authority,options.ownerId,true);await authority();
   let receipt:BrowserDownloadMetadata|undefined;
   await browserUploadBytes({binding,session:row.session,snapshot:row.observation,workspace:files.workspace,now:options.now,assertCurrent:authority,beforeExposure:authority,select:async file=>{
    receipt=await execution!.driver.upload(row.session,row.observation!,binding.elementRef,file,{destination:binding.destination,expiresAt:binding.expiresAt,assertCurrent:authority},async()=>{
     await authority();options.storage.transactionSync(()=>{const latest=uploadRecord(proposal);if(!sameSession(latest,row)||!['pending','proposing'].includes(latest.upload!.state))throw Error('upload already exposed');save({...latest,upload:{...latest.upload!,approvalRef,state:'exposed'}},key(row.grant.taskId));exposed=true;});
    });
   }});
   if(!receipt||receipt.filename!==binding.filename||receipt.byte_size!==binding.byteSize||receipt.sha256!==binding.sha256)throw Error('upload acknowledgment mismatch');
   await authority();const outcome:BrowserSubmitOutcome={status:'verified_with_receipt',message:`Server acknowledged ${binding.filename}, ${binding.byteSize} bytes, SHA-256 ${binding.sha256}. Broader task completion is unverified.`,receipt:{id:binding.operationId,observed_at:new Date(options.now()).toISOString(),source:'provider',action_digest:await generalDigest(JSON.stringify(proposal.action)),binding_digest:await generalDigest(JSON.stringify(proposal.binding))}};
   await authority();options.storage.transactionSync(()=>{const latest=uploadRecord(proposal);if(!sameSession(latest,row)||latest.upload!.state!=='exposed')throw Error('upload receipt custody changed');save({...latest,upload:{...latest.upload!,state:'verified',outcome}},key(row.grant.taskId));});return outcome;
  }catch{return {status:'uncertain',message:exposed?'Upload outcome is unknown; do not select or send the file again.':'The approved upload is unavailable or uncertain; no retry was performed.'};}
 };
 const denyUpload=async(proposal:BrowserSubmitProposal)=>{const row=uploadRecord(proposal);options.storage.transactionSync(()=>{const latest=uploadRecord(proposal);if(!sameSession(latest,row)||!['pending','proposing'].includes(latest.upload!.state))throw Error('upload already handled');save({...latest,upload:{...latest.upload!,state:'denied'}},key(row.grant.taskId));});};
 const api={handler,actionHandler,submitUpload,reconcileUpload,uploadReceiptVerified,denyUpload,
 async handoffStatus(){const row=options.storage.kv.get<Record>(key(snapshot().taskId));if(!row?.handoff)return undefined;if(!human||row.handoff.state!=='pending')throw Error('owner login transition');const held=human,origin=await held.controller.origin();const fresh=await handoffCurrent(row.grant);if(human!==held||fresh.handoff!.state!=='pending')throw Error('owner login transition');return {state:fresh.handoff!.state,origin,reason:fresh.handoff!.reason,expiresAt:fresh.session.expiresAt};},
 async openHandoff(){const row=options.storage.kv.get<Record>(key(snapshot().taskId));if(!row?.handoff||!human){if(row?.handoff)await api.cancel();throw Error('owner login unavailable');}await handoffCurrent(row.grant);const url=await human.controller.open();await handoffCurrent(row.grant);return url;},
 async maintainHandoff(){
  const row=options.storage.kv.get<Record>(key(snapshot().taskId));if(!row?.handoff||row.cleanup==='closed')return;
  if(row.cleanup||row.session.expiresAt<=options.now()){await api.cancel();return;}
  try{await handoffCurrent(row.grant);}catch{await api.cancel();return;}
  const current=options.storage.kv.get<Record>(key(snapshot().taskId));
  if(!current||current.cleanup||current.session.expiresAt<=options.now()){await api.cancel();return;}
  if(current.handoff?.state==='starting'||current.handoff?.state==='resuming')return;
  if(!human){await api.cancel();return;}
  try{await human.controller.status();}catch{
   // A concurrent resume can consume the volatile controller during status.
   // Recheck owner custody before accepting a newer valid durable transition.
   try{await options.config.assertHandoffCurrent!(row.grant);}catch{await api.cancel();return;}
   const latest=options.storage.kv.get<Record>(key(snapshot().taskId));
   if(latest&&!latest.cleanup&&latest.session.expiresAt>options.now()&&latest.session.ownerId===options.ownerId&&sameSession(latest,row)&&(!latest.handoff||latest.handoff.state==='starting'||latest.handoff.state==='resuming'))return;
   await api.cancel();
  }
 },
resetAttachments(){images=[];},sessionHandle:()=>options.storage.kv.get<Record>(key(snapshot().taskId))?.session.id,attachments:()=>[...images],async cancel(){images=[];const task=snapshot();const record=options.storage.kv.get<Record>(key(task.taskId));if(!record||record.cleanup==='closed')return;
  if(record.cleanupFailed)throw new GeneralBrowserError('cleanup_unconfirmed');
  save({...record,observation:undefined,tabs:[],cleanup:'pending'},key(task.taskId));
  if(record.session.providerSessionId==='pending')throw Error('common browser allocation uncertain');
  try{await human?.controller.dispose();}catch{/* Exact termination below revokes viewers. */}finally{human=undefined;handoffSession=undefined;}
  try{await execution?.driver.disconnect();}catch{/* Exact physical termination below is the authoritative cleanup. */}finally{execution=undefined;}
  // Cleanup does not depend on a still-live execution lease.
  try{
   await makeDriver(record.grant).terminate(record.session);
   await options.config.allocationClosed?.(record.grant,record.session);
   publishCleanup(options.storage,key(task.taskId),record,true);
  }catch(error){publishCleanup(options.storage,key(task.taskId),record,false);throw error;}
 }};return api;
}

// Expiry cleanup uses retained provider identity without reviving execution or allocating.
// A failed physical termination stays explicitly unresolved, never an endless I/O retry.
export async function maintainCommonBrowsers(storage:DurableObjectStorage,config:CommonBrowserConfiguration,now:number){
 for(const [key,row] of [...storage.kv.list<BrowserRecord>({prefix:'common-browser:'})]) {
  if(config.ownsGrant&&!config.ownsGrant(row.grant)||row.cleanup==='closed'||row.cleanupFailed||row.session.expiresAt>now&&row.cleanup!=='pending')continue;
  storage.transactionSync(()=>storage.kv.put(key,{...row,cleanup:'pending'}));
  try {
   if(row.session.providerSessionId==='pending')throw Error('allocation identity uncertain');
   const driver=cloudflareGeneralBrowser({ownerId:row.session.ownerId,binding:config.binding,cleanupBinding:config.cleanupBinding? id=>config.cleanupBinding!(row.grant,id):undefined,loadSdk:config.loadSdk,now:()=>now,deadline:()=>now,cleanupTimeoutMs:10000,maxScreenshotBytes:row.grant.maxScreenshotBytes,admit:async()=>{throw Error('cleanup only');},authorizeRequest:async()=>false});
   await driver.terminate(row.session);
   await config.allocationClosed?.(row.grant,row.session);
   publishCleanup(storage,key,row,true);
  }catch{publishCleanup(storage,key,row,false);}
 }
 const due=[...storage.kv.list<BrowserRecord>({prefix:'common-browser:'})].map(([,row])=>row).filter(row=>row.cleanup!=='closed'&&!row.cleanupFailed).map(row=>row.session.expiresAt);
 storage.kv.put(COMMON_BROWSER_DUE,due.length?Math.min(...due):null);
}

// Stop fences retained sessions synchronously before asynchronous physical cleanup.
// This still works after physical host recreation with no active execution object.
export function revokeCommonBrowsers(storage:DurableObjectStorage,now:number){
 storage.transactionSync(()=>{
  let pending=false;
  for(const [key,row] of [...storage.kv.list<BrowserRecord>({prefix:'common-browser:'})])if(row.cleanup!=='closed'){
   storage.kv.put(key,{...row,cleanup:'pending'});if(!row.cleanupFailed)pending=true;
  }
  storage.kv.put(COMMON_BROWSER_DUE,pending?now:null);
 });
}

// A reconstructed runtime has no authenticated completion listener or native
// document custody. Never resurrect its login from durable metadata alone.
export function fenceLostNativeHandoffs(storage:DurableObjectStorage,now:number){
 if(![...storage.kv.list<BrowserRecord>({prefix:'common-browser:'})].some(([,row])=>row.handoff&&row.cleanup!=='closed'))return;
 storage.transactionSync(()=>{
  let pending=false;
  for(const [key,row] of storage.kv.list<BrowserRecord>({prefix:'common-browser:'}))if(row.handoff&&row.cleanup!=='closed'){
   storage.kv.put(key,{...row,observation:undefined,tabs:[],cleanup:'pending'});if(!row.cleanupFailed)pending=true;
  }
  if(pending)storage.kv.put(COMMON_BROWSER_DUE,now);
 });
}
