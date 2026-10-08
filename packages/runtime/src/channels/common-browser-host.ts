import { triggerTypeSchema, TOOL_PERMISSIONS, browserSessionSchema, browsePageArgsSchema, browseActArgsSchema, type BrowseActArgs, type BrowserSession, type ToolHandler, type BrowsePageArgs, type LLMAttachment } from '@waldo/contracts';
import type { BrowserWorker } from '@cloudflare/playwright';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';
import { cloudflareGeneralBrowser,GeneralBrowserError } from './cloudflare-general-browser';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { TaskSourceSnapshot } from './task-source-scope';
import { PUBLIC_WEB_ORIGIN, isPublicWebUrl } from './public-web-policy';
import type { GeneralSnapshot, GeneralActionSnapshot } from './general-browser-observation';
import type { GeneralBrowserAction } from './general-browser-actions';
export type CommonBrowserGrant = Readonly<{ ref:string;taskId:string;ownerId:string;expiresAt:number;allowedOrigins:readonly string[];maxScreenshotBytes:number;lifetimeMs:number }>;
// Private registered host capability. Neither model arguments nor environment switches mint it.
export type CommonBrowserConfiguration = Readonly<{
 binding:BrowserWorker;loadSdk:CloudflareBrowserSdkLoader;
 bindingForOperation?(grant:CommonBrowserGrant,operationId:string):BrowserWorker;
 cleanupBinding?(grant:CommonBrowserGrant,providerSessionId:string):BrowserWorker;
 meterGateway?(gateway:import('../llm/provider').LLMGatewayAdapter):import('../llm/provider').LLMGatewayAdapter;
 grant(task:TaskSourceSnapshot,ownerId:string):Promise<CommonBrowserGrant>;
 reserveAllocation(grant:CommonBrowserGrant):Promise<void>;
 assertGrantCurrent(grant:CommonBrowserGrant):Promise<void>;
}>;
export const COMMON_BROWSER_DUE='common_browser_due_v1';
type BrowserRecord={grant:CommonBrowserGrant;session:BrowserSession;tabs:Readonly<{url:string;ref:string}>[];allocation:'prepared'|'observed';observation?:GeneralActionSnapshot;action?:Readonly<{digest:string;state:'prepared'|'observed'|'uncertain'}>;cleanup?:'pending'|'closed';cleanupFailed?:boolean};
const sameSession=(a:BrowserRecord,b:BrowserRecord)=>a.session.id===b.session.id&&a.session.generation===b.session.generation&&a.session.providerSessionId===b.session.providerSessionId&&JSON.stringify(a.grant)===JSON.stringify(b.grant);
const publishCleanup=(storage:DurableObjectStorage,key:string,expected:BrowserRecord,closed:boolean)=>storage.transactionSync(()=>{
 const current=storage.kv.get<BrowserRecord>(key);
 if(!current||!sameSession(current,expected)||current.cleanup==='closed')return;
 storage.kv.put(key,{...current,cleanup:closed?'closed':'pending',cleanupFailed:closed?undefined:true,session:{...current.session,state:closed?'ended':current.session.state}});
});
export function commonBrowserHost(options:Readonly<{
 storage:DurableObjectStorage;config:CommonBrowserConfiguration;ownerId:string;egressAllowlist?:readonly string[];
 source():TaskSourceSnapshot;assertCurrent():Promise<void>;deadline():number;now():number;
}>) {
 let images:LLMAttachment[]=[];
 let execution:Readonly<{grant:string;driver:ReturnType<typeof cloudflareGeneralBrowser>}>|undefined;
 const snapshot=()=>options.source();
 const checked=async()=>{await options.assertCurrent();const task=snapshot();if(!task.ready||!task.sources.includes('browser')&&!task.sources.includes('web'))throw Error('common browser source unavailable');return task;};
 const granted=async()=>{
  const task=await checked();const supplied=await options.config.grant(task,options.ownerId);const grant=Object.freeze({...supplied,allowedOrigins:Object.freeze([...supplied.allowedOrigins])});await checked();
  if(grant.ownerId!==options.ownerId||grant.taskId!==task.taskId||grant.expiresAt<=options.now()||!grant.ref||!Number.isSafeInteger(grant.expiresAt)||!Number.isSafeInteger(grant.lifetimeMs)||grant.lifetimeMs<10000||grant.lifetimeMs>600000||!Number.isSafeInteger(grant.maxScreenshotBytes)||grant.maxScreenshotBytes<1||!grant.allowedOrigins.length||grant.allowedOrigins.some(origin=>{if(origin===PUBLIC_WEB_ORIGIN)return false;try{const url=new URL(origin);return url.protocol!=='https:'||url.origin!==origin||!!url.username||!!url.password;}catch{return true;}}))throw Error('common browser grant rejected');
  await options.config.assertGrantCurrent(grant);return grant;
 };
 type Record=BrowserRecord;
 const key=(taskId:string)=>`common-browser:${taskId}`;
 const makeDriver=(grant:CommonBrowserGrant,operationId?:string,retainConnection=false)=>cloudflareGeneralBrowser({ownerId:options.ownerId,publicRead:true,retainConnection,binding:operationId&&options.config.bindingForOperation?options.config.bindingForOperation(grant,operationId):options.config.binding,cleanupBinding:options.config.cleanupBinding? id=>options.config.cleanupBinding!(grant,id):undefined,loadSdk:options.config.loadSdk,now:options.now,deadline:options.deadline,cleanupTimeoutMs:10000,maxScreenshotBytes:grant.maxScreenshotBytes,
  admit:async()=>{await checked();await options.config.assertGrantCurrent(grant);await checked();if(options.storage.kv.get<BrowserRecord>(key(grant.taskId))?.cleanup)throw Error('common browser stopped');},
  authorizeRequest:async(url,method)=>{if(!['GET','HEAD'].includes(method))return false;try{return isPublicWebUrl(url,options.egressAllowlist)&&(grant.allowedOrigins.includes(PUBLIC_WEB_ORIGIN)||grant.allowedOrigins.includes(new URL(url).origin));}catch{return false;}}});
 const executionDriver=(grant:CommonBrowserGrant,ctx:ToolDispatcherContext)=>{
  if(options.config.bindingForOperation&&(!ctx.turnId||!ctx.toolCallId))throw Error('common browser operation identity unavailable');
  const identity=JSON.stringify(grant);
  if(execution&&execution.grant!==identity)throw Error('common browser execution grant changed');
  execution??={grant:identity,driver:makeDriver(grant,JSON.stringify([grant.ownerId,grant.taskId,ctx.turnId,ctx.toolCallId]),true)};
  return execution.driver;
 };
 const save=(record:BrowserRecord,storageKey:string)=>options.storage.transactionSync(()=>{
  options.storage.kv.put(storageKey,record);
  const due=[...options.storage.kv.list<BrowserRecord>({prefix:'common-browser:'})].map(([,row])=>row).filter(row=>row.cleanup!=='closed'&&!row.cleanupFailed).map(row=>row.session.expiresAt);
  options.storage.kv.put(COMMON_BROWSER_DUE,due.length?Math.min(...due):null);
 });
 const publishObservation=async(grant:CommonBrowserGrant,record:Record,observed:GeneralSnapshot,ctx:ToolDispatcherContext)=>{
  await checked();await ctx.assertTaskSourceCurrent?.();
  const latest=options.storage.kv.get<Record>(key(grant.taskId));
  if(!latest||latest.cleanup||!sameSession(latest,record)||images.length>=4)throw Error('common browser custody changed');
  let binary='';for(const byte of observed.image.bytes)binary+=String.fromCharCode(byte);
  images.push({kind:'image',filename:`browser-${images.length+1}.png`,mime_type:observed.image.mime_type,data_base64:btoa(binary)});
  const {image:_,...observation}=observed;
  save({...latest,observation,tabs:observed.observation.tabs.map(tab=>({url:tab.url,ref:tab.ref}))},key(grant.taskId));
  return {ok:true as const,data:{...observed.observation,session_handle:record.session.id,text:observed.observation.text.slice(0,8000),elements:observed.observation.elements.slice(0,64),tabs:observed.observation.tabs.slice(0,8),
   field_values:observed.state.elements.slice(0,64).flatMap((element,index)=>['input','textarea','select'].includes(element.tag)&&!['password','file','hidden'].includes(element.type)?[{ref:observed.observation.elements[index]!.ref,name:element.name,value:element.value}]:[]),
   ...(latest.action?.state==='uncertain'||latest.action?.state==='prepared'?{action_outcome:'uncertain'}:{})},source_taint:'external' as const};
 };
 const handler:ToolHandler<BrowsePageArgs,unknown,ToolDispatcherContext>={name:'browse_page',description:'Read a granted public page in the retained task browser. Returns a bounded observation; its screenshot reaches the model as an image. No login, page writes or submit.',schema:browsePageArgsSchema,trigger_allowlist:triggerTypeSchema.options.filter(trigger=>TOOL_PERMISSIONS[trigger].includes('browse_page')),autonomy_gated:false,
  async handle(args,ctx){
   try{
    await ctx.assertTaskSourceCurrent?.();const grant=await granted();
    if(args.provider&&args.provider!=='cloudflare_playwright'||ctx.authenticatedUserId!==options.ownerId||(!isPublicWebUrl(args.url,options.egressAllowlist)||!grant.allowedOrigins.includes(PUBLIC_WEB_ORIGIN)&&!grant.allowedOrigins.includes(new URL(args.url).origin)))throw Error('common browser target rejected');
    if(options.config.bindingForOperation&&(!ctx.turnId||!ctx.toolCallId))throw Error('common browser operation identity unavailable');
    const driver=executionDriver(grant,ctx);const storageKey=key(grant.taskId);let record=options.storage.kv.get<Record>(storageKey);
    if(record&&(JSON.stringify(record.grant)!==JSON.stringify(grant)||record.session.ownerId!==options.ownerId||record.cleanup||record.allocation!=='observed'))throw Error('common browser retained identity uncertain');
    if(!record){
     const now=options.now();record={grant,allocation:'prepared',tabs:[],session:browserSessionSchema.parse({id:crypto.randomUUID(),ownerId:options.ownerId,provider:'cloudflare_playwright',providerSessionId:'pending',contextHandle:null,mode:'public',state:'starting',generation:1,expiresAt:Math.min(grant.expiresAt,now+grant.lifetimeMs),updatedAt:now})};
     await driver.start(grant.allowedOrigins.includes(PUBLIC_WEB_ORIGIN)?'public':grant.allowedOrigins.map(origin=>new URL(origin).hostname),grant.lifetimeMs,async()=>{await options.config.reserveAllocation(grant);await checked();save(record!,storageKey);},async id=>{options.storage.transactionSync(()=>{const retained=options.storage.kv.get<Record>(storageKey);if(!retained||retained.session.id!==record!.session.id||retained.session.generation!==record!.session.generation||JSON.stringify(retained.grant)!==JSON.stringify(grant))throw Error('common browser allocation custody changed');record={...retained,cleanupFailed:undefined,allocation:'observed',session:{...retained.session,providerSessionId:id,state:retained.cleanup?retained.session.state:'active',updatedAt:options.now()}};save(record!,storageKey);});},()=>publishCleanup(options.storage,storageKey,record!,true));
    }
    if(images.length>=4)throw Error('common browser image budget exhausted');
    // The guarded connection stays live through this admitted owner turn. Stop
    // closes documents and terminates the exact separately funded session.
    const observed=await driver.navigate(record.session,args.url);
    return publishObservation(grant,record,observed,ctx);
   }catch(error){return {ok:false,code:'rejected',error:'Public browser read is unavailable or uncertain. Inspect retained task state before retrying; no successful read is claimed.'+(error instanceof GeneralBrowserError?' Browser diagnostic: '+JSON.stringify({browser_code:error.code,...(error.diagnostic?{diagnostic:error.diagnostic}:{}),...(error.cleanup_failed?{cleanup_failed:true}:{}),...(error.release_failed?{release_failed:true}:{})}):''),source_taint:'external'};}
  }};
 const actionHandler:ToolHandler<BrowseActArgs,unknown,ToolDispatcherContext>={name:'browse_act',description:'Interact with the current Cloudflare public page using observed refs: goto, read, inspect, type, click, scroll. Page writes and native submits require the owner approval path. Unknown outcomes block repeated effects; read evidence before deciding what completed.',schema:browseActArgsSchema,trigger_allowlist:triggerTypeSchema.options.filter(trigger=>TOOL_PERMISSIONS[trigger].includes('browse_act')),autonomy_gated:false,
  async handle(args,ctx){let storageKey:string|undefined,digest:string|undefined;
   try{
    await ctx.assertTaskSourceCurrent?.();const grant=await granted();storageKey=key(grant.taskId);
    let record=options.storage.kv.get<Record>(storageKey);
    if(ctx.authenticatedUserId!==options.ownerId||!args.command||!record||record.cleanup||record.allocation!=='observed'||JSON.stringify(record.grant)!==JSON.stringify(grant)||!record.observation||args.url!==record.observation.observation.url)throw Error('current browser observation unavailable');
    const command=args.command;
    if(command.operation==='cancel'){await api.cancel();return {ok:true,data:{ended:true},source_taint:'external'};}
    const driver=executionDriver(grant,ctx),before=record.observation;
    if(images.length>=4)throw Error('common browser image budget exhausted');
    let observed:GeneralSnapshot;
    if(command.operation==='read'||command.operation==='inspect')observed=await driver.observe(record.session,before.observation.tab_ref);
    else {
     if(record.action?.state==='prepared'||record.action?.state==='uncertain')throw Error('prior browser effect uncertain');
     if('intent' in command&&command.intent==='send')throw Error('browser approval required');
     if(command.operation==='goto')observed=await driver.navigate(record.session,command.url,before.observation.tab_ref);
     else {
      const action:GeneralBrowserAction|undefined=command.operation==='click'?{operation:'click',element_ref:command.element_ref}:command.operation==='type'?command.key?{operation:'press',element_ref:command.element_ref,key:command.key}:{operation:'fill',element_ref:command.element_ref,value:command.value!}:command.operation==='scroll'?{operation:'scroll',delta:command.delta}:undefined;
      if(!action)throw Error('unsupported current browser command');
      const element=action.operation==='scroll'?undefined:before.state.elements[before.observation.elements.findIndex(row=>row.ref===action.element_ref)];
      if(element?.inForm&&(action.operation==='press'&&action.key==='Enter'||action.operation==='click'&&(element.tag==='button'&&element.type!=='button'||element.tag==='input'&&['submit','image'].includes(element.type))))throw Error('native browser submit approval required');
      observed=await driver.act(record.session,before,action,async prepared=>{
       await checked();await options.config.assertGrantCurrent(grant);await ctx.assertTaskSourceCurrent?.();
       options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey!);if(!latest||latest.cleanup||!sameSession(latest,record!)||latest.observation?.observation.revision!==before.observation.revision||latest.action?.state==='prepared'||latest.action?.state==='uncertain')throw Error('browser effect custody changed');digest=prepared;save({...latest,action:{digest:prepared,state:'prepared'}},storageKey!);});
      });
     }
    }
    if(digest){const completed=digest;options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey!);if(latest?.action?.digest===completed)save({...latest,action:{digest:completed,state:'observed'}},storageKey!);});}
    return await publishObservation(grant,record,observed,ctx);
   }catch(error){
    if(storageKey&&digest){const failed=digest;options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey!);if(latest?.action?.digest===failed)save({...latest,action:{digest:failed,state:'uncertain'}},storageKey!);});}
    return {ok:false,code:'rejected',error:'The public browser action was rejected or its outcome is uncertain. No replacement browser or unapproved page write was allowed. Inspect the current page before retrying.'+(error instanceof GeneralBrowserError?' Browser diagnostic: '+JSON.stringify({browser_code:error.code,...(error.diagnostic?{diagnostic:error.diagnostic}:{}),...(error.cleanup_failed?{cleanup_failed:true}:{}),...(error.release_failed?{release_failed:true}:{})}):''),source_taint:'external'};
   }
  }};
 const api={handler,actionHandler,attachments:()=>[...images],async cancel(){images=[];const task=snapshot();const record=options.storage.kv.get<Record>(key(task.taskId));if(!record||record.cleanup==='closed')return;
  save({...record,cleanup:'pending'},key(task.taskId));
  if(record.session.providerSessionId==='pending')throw Error('common browser allocation uncertain');
  try{await execution?.driver.disconnect();}catch{/* Exact physical termination below is the authoritative cleanup. */}finally{execution=undefined;}
  // Cleanup does not depend on a still-live execution lease.
  await makeDriver(record.grant).terminate(record.session);
  publishCleanup(options.storage,key(task.taskId),record,true);
 }};return api;
}

// Expiry cleanup uses retained provider identity without reviving execution or allocating.
// A failed physical termination stays explicitly unresolved, never an endless I/O retry.
export async function maintainCommonBrowsers(storage:DurableObjectStorage,config:CommonBrowserConfiguration,now:number){
 for(const [key,row] of storage.kv.list<BrowserRecord>({prefix:'common-browser:'})) {
  if(row.cleanup==='closed'||row.cleanupFailed||row.session.expiresAt>now&&row.cleanup!=='pending')continue;
  storage.transactionSync(()=>storage.kv.put(key,{...row,cleanup:'pending'}));
  try {
   if(row.session.providerSessionId==='pending')throw Error('allocation identity uncertain');
   const driver=cloudflareGeneralBrowser({ownerId:row.session.ownerId,binding:config.binding,cleanupBinding:config.cleanupBinding? id=>config.cleanupBinding!(row.grant,id):undefined,loadSdk:config.loadSdk,now:()=>now,deadline:()=>now,cleanupTimeoutMs:10000,maxScreenshotBytes:row.grant.maxScreenshotBytes,admit:async()=>{throw Error('cleanup only');},authorizeRequest:async()=>false});
   await driver.terminate(row.session);
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
  for(const [key,row] of storage.kv.list<BrowserRecord>({prefix:'common-browser:'}))if(row.cleanup!=='closed'){
   storage.kv.put(key,{...row,cleanup:'pending'});if(!row.cleanupFailed)pending=true;
  }
  storage.kv.put(COMMON_BROWSER_DUE,pending?now:null);
 });
}
