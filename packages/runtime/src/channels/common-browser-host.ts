import { triggerTypeSchema, TOOL_PERMISSIONS, browserSessionSchema, browsePageArgsSchema, type BrowserSession, type ToolHandler, type BrowsePageArgs, type LLMAttachment } from '@waldo/contracts';
import type { BrowserWorker } from '@cloudflare/playwright';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';
import { cloudflareGeneralBrowser,GeneralBrowserError } from './cloudflare-general-browser';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { TaskSourceSnapshot } from './task-source-scope';
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
type BrowserRecord={grant:CommonBrowserGrant;session:BrowserSession;tabs:Readonly<{url:string;ref:string}>[];allocation:'prepared'|'observed';cleanup?:'pending'|'closed';cleanupFailed?:boolean};
const sameSession=(a:BrowserRecord,b:BrowserRecord)=>a.session.id===b.session.id&&a.session.generation===b.session.generation&&a.session.providerSessionId===b.session.providerSessionId&&JSON.stringify(a.grant)===JSON.stringify(b.grant);
const publishCleanup=(storage:DurableObjectStorage,key:string,expected:BrowserRecord,closed:boolean)=>storage.transactionSync(()=>{
 const current=storage.kv.get<BrowserRecord>(key);
 if(!current||!sameSession(current,expected)||current.cleanup==='closed')return;
 storage.kv.put(key,{...current,cleanup:closed?'closed':'pending',cleanupFailed:closed?undefined:true,session:{...current.session,state:closed?'ended':current.session.state}});
});
export function commonBrowserHost(options:Readonly<{
 storage:DurableObjectStorage;config:CommonBrowserConfiguration;ownerId:string;
 source():TaskSourceSnapshot;assertCurrent():Promise<void>;deadline():number;now():number;
}>) {
 let images:LLMAttachment[]=[];
 const snapshot=()=>options.source();
 const checked=async()=>{await options.assertCurrent();const task=snapshot();if(!task.ready||!task.sources.includes('browser')&&!task.sources.includes('web'))throw Error('common browser source unavailable');return task;};
 const granted=async()=>{
  const task=await checked();const supplied=await options.config.grant(task,options.ownerId);const grant=Object.freeze({...supplied,allowedOrigins:Object.freeze([...supplied.allowedOrigins])});await checked();
  if(grant.ownerId!==options.ownerId||grant.taskId!==task.taskId||grant.expiresAt<=options.now()||!grant.ref||!Number.isSafeInteger(grant.expiresAt)||!Number.isSafeInteger(grant.lifetimeMs)||grant.lifetimeMs<10000||grant.lifetimeMs>600000||!Number.isSafeInteger(grant.maxScreenshotBytes)||grant.maxScreenshotBytes<1||!grant.allowedOrigins.length||grant.allowedOrigins.some(origin=>{try{const url=new URL(origin);return url.protocol!=='https:'||url.origin!==origin||!!url.username||!!url.password;}catch{return true;}}))throw Error('common browser grant rejected');
  await options.config.assertGrantCurrent(grant);return grant;
 };
 type Record=BrowserRecord;
 const key=(taskId:string)=>`common-browser:${taskId}`;
 const makeDriver=(grant:CommonBrowserGrant,operationId?:string)=>cloudflareGeneralBrowser({ownerId:options.ownerId,binding:operationId&&options.config.bindingForOperation?options.config.bindingForOperation(grant,operationId):options.config.binding,cleanupBinding:options.config.cleanupBinding? id=>options.config.cleanupBinding!(grant,id):undefined,loadSdk:options.config.loadSdk,now:options.now,deadline:options.deadline,cleanupTimeoutMs:10000,maxScreenshotBytes:grant.maxScreenshotBytes,
  admit:async()=>{await checked();await options.config.assertGrantCurrent(grant);await checked();if(options.storage.kv.get<BrowserRecord>(key(grant.taskId))?.cleanup)throw Error('common browser stopped');},
  authorizeRequest:async(url,method)=>{if(!['GET','HEAD'].includes(method))return false;try{return grant.allowedOrigins.includes(new URL(url).origin);}catch{return false;}}});
 const save=(record:BrowserRecord,storageKey:string)=>options.storage.transactionSync(()=>{
  options.storage.kv.put(storageKey,record);
  const due=[...options.storage.kv.list<BrowserRecord>({prefix:'common-browser:'})].map(([,row])=>row).filter(row=>row.cleanup!=='closed'&&!row.cleanupFailed).map(row=>row.session.expiresAt);
  options.storage.kv.put(COMMON_BROWSER_DUE,due.length?Math.min(...due):null);
 });
 const handler:ToolHandler<BrowsePageArgs,unknown,ToolDispatcherContext>={name:'browse_page',description:'Read a granted public page in the retained task browser. Returns a bounded observation; its screenshot reaches the model as an image. No login, page writes or submit.',schema:browsePageArgsSchema,trigger_allowlist:triggerTypeSchema.options.filter(trigger=>TOOL_PERMISSIONS[trigger].includes('browse_page')),autonomy_gated:false,
  async handle(args,ctx){
   try{
    await ctx.assertTaskSourceCurrent?.();const grant=await granted();
    if(args.provider&&args.provider!=='cloudflare_playwright'||ctx.authenticatedUserId!==options.ownerId||!grant.allowedOrigins.includes(new URL(args.url).origin))throw Error('common browser target rejected');
    if(options.config.bindingForOperation&&(!ctx.turnId||!ctx.toolCallId))throw Error('common browser operation identity unavailable');
    const driver=makeDriver(grant,JSON.stringify([grant.ownerId,grant.taskId,ctx.turnId,ctx.toolCallId]));const storageKey=key(grant.taskId);let record=options.storage.kv.get<Record>(storageKey);
    if(record&&(JSON.stringify(record.grant)!==JSON.stringify(grant)||record.session.ownerId!==options.ownerId||record.cleanup||record.allocation!=='observed'))throw Error('common browser retained identity uncertain');
    if(!record){
     const now=options.now();record={grant,allocation:'prepared',tabs:[],session:browserSessionSchema.parse({id:crypto.randomUUID(),ownerId:options.ownerId,provider:'cloudflare_playwright',providerSessionId:'pending',contextHandle:null,mode:'public',state:'starting',generation:1,expiresAt:Math.min(grant.expiresAt,now+grant.lifetimeMs),updatedAt:now})};
     await driver.start(grant.allowedOrigins.map(origin=>new URL(origin).hostname),grant.lifetimeMs,async()=>{await options.config.reserveAllocation(grant);await checked();save(record!,storageKey);},async id=>{options.storage.transactionSync(()=>{const retained=options.storage.kv.get<Record>(storageKey);if(!retained||retained.session.id!==record!.session.id||retained.session.generation!==record!.session.generation||JSON.stringify(retained.grant)!==JSON.stringify(grant))throw Error('common browser allocation custody changed');record={...retained,cleanupFailed:undefined,allocation:'observed',session:{...retained.session,providerSessionId:id,state:retained.cleanup?retained.session.state:'active',updatedAt:options.now()}};save(record!,storageKey);});},()=>publishCleanup(options.storage,storageKey,record!,true));
    }
    if(images.length>=4)throw Error('common browser image budget exhausted');
    const existing=record.tabs.find(tab=>tab.url===args.url);
    const observed=existing?await driver.observe(record.session,existing.ref):record.tabs.length?await driver.openTab(record.session,args.url):await driver.navigate(record.session,args.url);
    await checked();await ctx.assertTaskSourceCurrent?.();
    const latest=options.storage.kv.get<Record>(storageKey);
    if(!latest||latest.cleanup||latest.session.id!==record.session.id||latest.session.generation!==record.session.generation||JSON.stringify(latest.grant)!==JSON.stringify(grant))throw Error('common browser custody changed');
    // Bytes stay out of JSON tool results/logs and never become trusted instructions.
    let binary='';for(const byte of observed.image.bytes)binary+=String.fromCharCode(byte);
    images.push({kind:'image',filename:`browser-${images.length+1}.png`,mime_type:observed.image.mime_type,data_base64:btoa(binary)});
    record={...record,tabs:observed.observation.tabs.map(tab=>({url:tab.url,ref:tab.ref}))};save(record!,storageKey);
    return {ok:true,data:{...observed.observation,text:observed.observation.text.slice(0,8000),elements:observed.observation.elements.slice(0,64),tabs:observed.observation.tabs.slice(0,8)},source_taint:'external'};
   }catch(error){return {ok:false,code:'rejected',error:'Public browser read is unavailable or uncertain. Inspect retained task state before retrying; no successful read is claimed.'+(error instanceof GeneralBrowserError?' Browser diagnostic: '+JSON.stringify({browser_code:error.code,...(error.diagnostic?{diagnostic:error.diagnostic}:{}),...(error.cleanup_failed?{cleanup_failed:true}:{}),...(error.release_failed?{release_failed:true}:{})}):''),source_taint:'external'};}
  }};
 return {handler,attachments:()=>[...images],async cancel(){images=[];const task=snapshot();const record=options.storage.kv.get<Record>(key(task.taskId));if(!record||record.cleanup==='closed')return;
  save({...record,cleanup:'pending'},key(task.taskId));
  if(record.session.providerSessionId==='pending')throw Error('common browser allocation uncertain');
  // Cleanup does not depend on a still-live execution lease.
  await makeDriver(record.grant).terminate(record.session);
  publishCleanup(options.storage,key(task.taskId),record,true);
 }};
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
