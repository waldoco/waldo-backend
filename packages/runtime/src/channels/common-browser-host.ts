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
type BrowserRecord={handoff?:NativeHandoffMetadata;grant:CommonBrowserGrant;session:BrowserSession;tabs:Readonly<{url:string;ref:string}>[];allocation:'prepared'|'observed';observation?:GeneralActionSnapshot;action?:Readonly<{digest:string;state:'prepared'|'observed'|'uncertain'}>;cleanup?:'pending'|'closed';cleanupFailed?:boolean};
const sameSession=(a:BrowserRecord,b:BrowserRecord)=>a.session.id===b.session.id&&a.session.generation===b.session.generation&&a.session.providerSessionId===b.session.providerSessionId&&JSON.stringify(a.grant)===JSON.stringify(b.grant);
const publishCleanup=(storage:DurableObjectStorage,key:string,expected:BrowserRecord,closed:boolean)=>storage.transactionSync(()=>{
 const current=storage.kv.get<BrowserRecord>(key);
 if(!current||!sameSession(current,expected)||current.cleanup==='closed')return;
 storage.kv.put(key,{...current,cleanup:closed?'closed':'pending',cleanupFailed:closed?undefined:true,session:{...current.session,state:closed?'ended':current.session.state}});
});
export function commonBrowserHost(options:Readonly<{
 storage:DurableObjectStorage;config:CommonBrowserConfiguration;ownerId:string;egressAllowlist?:readonly string[];
 files?(assertCurrent:()=>Promise<void>,ownerId:string):Promise<{workspace:Awaited<ReturnType<typeof workspaceOwnerHost>>;origin:string}>;
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
 const actionHandler:ToolHandler<BrowseActArgs,unknown,ToolDispatcherContext>={name:'browse_act',description:'Interact with the current Cloudflare public page using observed refs: goto, read, inspect, type, click, select, set_checked, scroll. File selection, page sends and native submits are unsupported. Unknown outcomes block repeated effects; read evidence before deciding what completed.',schema:browseActArgsSchema,trigger_allowlist:triggerTypeSchema.options.filter(trigger=>TOOL_PERMISSIONS[trigger].includes('browse_act')),autonomy_gated:false,
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
 const api={handler,actionHandler,
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
   if(latest&&!latest.cleanup&&latest.session.expiresAt>options.now()&&latest.session.id===row.session.id&&latest.session.providerSessionId===row.session.providerSessionId&&JSON.stringify(latest.grant)===JSON.stringify(row.grant)&&(!latest.handoff||latest.handoff.state==='starting'||latest.handoff.state==='resuming'))return;
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
 storage.transactionSync(()=>{
  let pending=false;
  for(const [key,row] of storage.kv.list<BrowserRecord>({prefix:'common-browser:'}))if(row.handoff&&row.cleanup!=='closed'){
   storage.kv.put(key,{...row,observation:undefined,tabs:[],cleanup:'pending'});if(!row.cleanupFailed)pending=true;
  }
  if(pending)storage.kv.put(COMMON_BROWSER_DUE,now);
 });
}
