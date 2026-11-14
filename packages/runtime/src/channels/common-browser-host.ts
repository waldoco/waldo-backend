import type {NativeHandoffMetadata} from './native-browser-handoff';
import { triggerTypeSchema, TOOL_PERMISSIONS, browserSessionSchema, browsePageArgsSchema, browseActArgsSchema, type BrowseActArgs, type BrowserSession, type ToolHandler, type BrowsePageArgs, type LLMAttachment, LLM_ATTACHMENTS_MAX } from '@waldo/contracts';
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
import type { BrowserSubmitProposal } from './approvals';
import type { BrowserSubmitOutcome } from '../tools/live/browser';
import { FORM_SUBMIT_LIMITS, encodedFormBytes, formBodyMatches } from './general-browser-form';
import type { GeneralRequestBody } from './general-browser-redirects';
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
const OBSERVATION_ELEMENT_LIMIT=64;
const MODEL_PDF_BYTES=8*1024*1024;
const encodedCheckpointBytes=(record:BrowserRecord)=>new TextEncoder().encode(JSON.stringify(record)).byteLength;
export const COMMON_BROWSER_DUE='common_browser_due_v1';
// One approval-gated form send. It names the exact document, control and fields the owner's card showed; the browser
// admits one POST to the form's target carrying those fields, only while the owner's approval is being executed.
type FormReceipt=Extract<BrowserSubmitOutcome,{status:'verified_with_receipt'}>['receipt'];
type FormPermit=Readonly<{id:string;state:'proposed'|'sending'|'sent'|'unsent'|'uncertain';revision:string;targetId:string;elementRef:string;url:string;action:string;fields:readonly (readonly [string,string])[];expiresAt:number;receipt?:FormReceipt}>;
export type CommonBrowserFormSubmit=Readonly<{propose(payload:BrowserSubmitProposal):Promise<string>}>;
const FORM_APPROVAL_MS=600_000,FORM_SEND_MS=30_000;
type BrowserRecord={submit?:FormPermit;download?:Readonly<{operationId:string;digest:string;state:'prepared'|'importing'|'ready';metadata?:BrowserDownloadMetadata;receipt?:BrowserDownloadReceipt}>;handoff?:NativeHandoffMetadata;grant:CommonBrowserGrant;session:BrowserSession;tabs:Readonly<{url:string;ref:string}>[];allocation:'prepared'|'observed';observation?:GeneralActionSnapshot;action?:Readonly<{digest:string;state:'prepared'|'observed'|'uncertain'}>;cleanup?:'pending'|'closed';cleanupFailed?:boolean};
const sameSession=(a:BrowserRecord,b:BrowserRecord)=>a.session.ownerId===b.session.ownerId&&a.session.id===b.session.id&&a.session.generation===b.session.generation&&a.session.providerSessionId===b.session.providerSessionId&&JSON.stringify(a.grant)===JSON.stringify(b.grant);
const publishCleanup=(storage:DurableObjectStorage,key:string,expected:BrowserRecord,closed:boolean)=>storage.transactionSync(()=>{
 const current=storage.kv.get<BrowserRecord>(key);
 if(!current||!sameSession(current,expected)||current.cleanup==='closed')return;
 storage.kv.put(key,{...current,cleanup:closed?'closed':'pending',cleanupFailed:closed?undefined:true,session:{...current.session,state:closed?'ended':current.session.state}});
});
// What the model can try after a failed browser step, by browser_code. Options for the model, never owner instructions.
const BROWSER_NEXT_STEP:Readonly<Record<GeneralBrowserError['code'],string>>={
 rejected:'The browser refused this page or step: it opens public http(s) pages with read-only requests, and this session or turn may have run out of time. Try another public page or site.',
 session_lost:'The browser session was lost. Start a new one with browse_page retain_session:true and no session_handle, or read the page without retain_session.',
 provider_unavailable:'The browser service failed on this step. Retry once; if it fails again, try another site, or read the page without retain_session.',
 page_unavailable:'The site did not serve this page (see the status). Try another page on the site, or another site.',
 empty_content:'The page showed no readable text yet. Read it again, or try another page or site.',
 image_oversize:'The screenshot is over the size limit, so it was not saved. The page itself was read: use browse_act read for its text and controls.',
 observation_oversize:'This page is too large for one observation. Open a narrower page, such as a search result or a detail page, or read it without retain_session for its text.',
 cleanup_unconfirmed:'The browser could not confirm this step closed cleanly, so nothing from it is claimed. Read the page again; if the session is gone, start a new one.',
 stale_observation:'The page changed since it was read. Read it again with browse_act read and use the new refs.',
 outcome_uncertain:'The step may or may not have taken effect, and it cannot be repeated. Read the page with browse_act read to see what changed.',
 native_submit_requires_card:'This submits a form the browser may not send on its own: only a GET form whose target is a page this session may open can be submitted. Open the results page directly with goto if its address is known; otherwise tell the owner what the form would send, because this browser cannot submit it.',
 turn_deadline:'This turn ran out of time before the browser step finished, so nothing from it is claimed. The session stays open: continue it with its session_handle on the next turn.',
};
// Only the turn's own deadline makes a failed step retryable as such; every other failure keeps its typed next step.
const retryable=(error:unknown)=>error instanceof GeneralBrowserError&&error.code==='turn_deadline';
// With approval-gated form sends on, a refused native submit has a way forward: ask the owner through intent send.
const FORM_SEND_NEXT_STEP:Readonly<Record<GeneralBrowserError['code'],string>>={...BROWSER_NEXT_STEP,
 native_submit_requires_card:'This sends a form, which needs the owner\'s approval. Click the form\'s send control (its Submit or Next) with intent "send": the owner gets a card with the answers, and nothing is sent until they approve.'};
const failureText=(lead:string,otherwise:string,error:unknown,handle:string|undefined,steps:Readonly<Record<GeneralBrowserError['code'],string>>=BROWSER_NEXT_STEP)=>`${lead} ${error instanceof GeneralBrowserError?steps[error.code]:otherwise}${handle?` This browser session's session_handle is ${handle}.`:''}`
 +(error instanceof GeneralBrowserError?' Browser diagnostic: '+JSON.stringify({browser_code:error.code,...(error.diagnostic?{diagnostic:error.diagnostic}:{}),...(error.cleanup_failed?{cleanup_failed:true}:{}),...(error.release_failed?{release_failed:true}:{})}):'');
export function commonBrowserHost(options:Readonly<{
 storage:DurableObjectStorage;config:CommonBrowserConfiguration;ownerId:string;egressAllowlist?:readonly string[];
 files?(assertCurrent:()=>Promise<void>,ownerId:string):Promise<{workspace:Awaited<ReturnType<typeof workspaceOwnerHost>>;origin:string}>;
 source():TaskSourceSnapshot;assertCurrent():Promise<void>;deadline():number;now():number;
 // Present only while approval-gated form sends are switched on for this owner runtime.
 formSubmit?():CommonBrowserFormSubmit|undefined;
}>) {
 let modelFiles:LLMAttachment[]=[];
 const attach=(file:LLMAttachment)=>{if(modelFiles.length>=LLM_ATTACHMENTS_MAX)modelFiles.shift();modelFiles.push(file);};
 // Set when the last read failed because its retained session has ended and nothing on that session is unresolved,
 // so the caller may replace the session once. An effect never sets it: its outcome stays fenced on the old session.
 let sessionEnded=false;
 let handoffSession:BrowserSession|undefined;
 let human: Awaited<ReturnType<ReturnType<typeof cloudflareGeneralBrowser>['beginOwnerHandoff']>>|undefined;
 let execution:Readonly<{grant:string;driver:ReturnType<typeof cloudflareGeneralBrowser>}>|undefined;
 // Set only while an owner's approval of a form send executes. It replaces the turn's admission with the owner's
 // custody and the permit, and admits exactly one write: the approved form's POST.
 let approved:{permit:FormPermit;grant:CommonBrowserGrant;storageKey:string;deadline:number;used:boolean}|undefined;
 const snapshot=()=>options.source();
 const checked=async()=>{if(approved)throw Error('approved form send in progress');await options.assertCurrent();const task=snapshot();if(!task.ready||!task.sources.includes('browser')&&!task.sources.includes('web'))throw Error('common browser source unavailable');return task;};
 const granted=async()=>{
  const task=await checked();const supplied=await options.config.grant(task,options.ownerId);const grant=Object.freeze({...supplied,allowedOrigins:Object.freeze([...supplied.allowedOrigins])});await checked();
  if(grant.ownerId!==options.ownerId||grant.taskId!==task.taskId||grant.expiresAt<=options.now()||!grant.ref||!Number.isSafeInteger(grant.expiresAt)||!Number.isSafeInteger(grant.lifetimeMs)||grant.lifetimeMs<10000||!Number.isSafeInteger(grant.keepAliveMs??grant.lifetimeMs)||(grant.keepAliveMs??grant.lifetimeMs)<10000||(grant.keepAliveMs??grant.lifetimeMs)>600000||!Number.isSafeInteger(grant.maxScreenshotBytes)||grant.maxScreenshotBytes<1||!grant.allowedOrigins.length||grant.allowedOrigins.some(origin=>{if(origin===PUBLIC_WEB_ORIGIN)return false;try{const url=new URL(origin);return url.protocol!=='https:'||url.origin!==origin||!!url.username||!!url.password;}catch{return true;}}))throw Error('common browser grant rejected');
  await options.config.assertGrantCurrent(grant);return grant;
 };
 type Record=BrowserRecord;
 const key=(taskId:string)=>`common-browser:${taskId}`;
 const ended=(error:unknown)=>{
  if(!(error instanceof GeneralBrowserError&&error.code==='session_lost'))return false;
  const row=options.storage.kv.get<Record>(key(snapshot().taskId));
  return !!row&&!row.cleanup&&!row.cleanupFailed&&!row.handoff&&row.allocation==='observed'&&row.action?.state!=='prepared'&&row.action?.state!=='uncertain'&&(!row.download||row.download.state==='ready');
 };
 const liveHandle=()=>{const row=options.storage.kv.get<Record>(key(snapshot().taskId));return row&&!row.cleanup&&row.allocation==='observed'?row.session.id:undefined;};
 const readableUrl=(grant:CommonBrowserGrant,url:string,method:string)=>{if(!['GET','HEAD'].includes(method))return false;try{return isPublicWebUrl(url,options.egressAllowlist)&&(grant.allowedOrigins.includes(PUBLIC_WEB_ORIGIN)||grant.allowedOrigins.includes(new URL(url).origin));}catch{return false;}};
 const approvedCurrent=async(held:NonNullable<typeof approved>)=>{
  if(approved!==held||held.deadline<=options.now())throw Error('form approval expired');
  await options.config.assertHandoffCurrent!(held.grant);
  const row=options.storage.kv.get<BrowserRecord>(held.storageKey);
  if(approved!==held||!row||row.cleanup||row.handoff||JSON.stringify(row.grant)!==JSON.stringify(held.grant)||row.session.expiresAt<=options.now()||row.submit?.id!==held.permit.id||!['proposed','sending'].includes(row.submit.state))throw Error('form approval custody changed');
 };
 const approvedPost=(url:string,method:string,body?:GeneralRequestBody)=>{
  const held=approved;
  if(!held||held.used||method!=='POST'||url!==held.permit.action||!formBodyMatches(held.permit.fields,body))return false;
  held.used=true;return true;
 };
 const makeDriver=(grant:CommonBrowserGrant,operationId?:string,retainConnection=false)=>cloudflareGeneralBrowser({ownerId:options.ownerId,publicRead:true,retainConnection,binding:operationId&&options.config.bindingForOperation?options.config.bindingForOperation(grant,operationId):options.config.binding,cleanupBinding:options.config.cleanupBinding? id=>options.config.cleanupBinding!(grant,id):undefined,loadSdk:options.config.loadSdk,now:options.now,deadline:()=>approved?approved.deadline:options.deadline(),cleanupTimeoutMs:10000,maxScreenshotBytes:grant.maxScreenshotBytes,
  admit:async()=>{if(approved){await approvedCurrent(approved);return;}await checked();await options.config.assertGrantCurrent(grant);await checked();const row=options.storage.kv.get<BrowserRecord>(key(grant.taskId));if(row?.cleanup||row?.handoff&&row.handoff.state!=='resuming')throw Error('common browser stopped');},
  authorizeHumanRequest:async(url,_method)=>{await handoffCurrent(grant);return isPublicWebUrl(url,options.egressAllowlist)&&(grant.allowedOrigins.includes(PUBLIC_WEB_ORIGIN)||grant.allowedOrigins.includes(new URL(url).origin));},
  authorizeRequest:async(url,method,body)=>approved&&!['GET','HEAD'].includes(method)?approvedPost(url,method,body):readableUrl(grant,url,method)});
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
 // The checkpoint holds what a later action needs: the refs the model is shown and their native targets.
 // Page text and the accessibility snapshot reach the model only, so a long page never outgrows storage.
 const checkpointOf=(latest:Record,observed:GeneralSnapshot):Record=>{
  const {image:_,state,observation:shown,...identity}=observed;
  const observation={...identity,state:{...state,text:'',elements:state.elements.slice(0,OBSERVATION_ELEMENT_LIMIT)},observation:{...shown,text:'',accessibility_snapshot:undefined,elements:shown.elements.slice(0,OBSERVATION_ELEMENT_LIMIT)}};
  return {...latest,observation,tabs:observed.observation.tabs.map(tab=>({url:tab.url,ref:tab.ref}))};
 };
 const publishObservation=async(grant:CommonBrowserGrant,record:Record,observed:GeneralSnapshot,ctx:ToolDispatcherContext)=>{
  await checked();await ctx.assertTaskSourceCurrent?.();
  const latest=options.storage.kv.get<Record>(key(grant.taskId));
  if(!latest||latest.cleanup||!sameSession(latest,record))throw Error('common browser custody changed');
  const checkpoint=checkpointOf(latest,observed);
  if(encodedCheckpointBytes(checkpoint)>COMMON_BROWSER_CHECKPOINT_BYTES-1024){
   // Do not truncate native refs/state or leave an older observation actionable.
   // The retained exact session remains available for explicit cleanup.
   save({...latest,observation:undefined,tabs:[]},key(grant.taskId));
   throw new GeneralBrowserError('observation_oversize');
  }
  save(checkpoint,key(grant.taskId));
  if(observed.image){
   let binary='';for(const byte of observed.image.bytes)binary+=String.fromCharCode(byte);
   attach({kind:'image',filename:`browser-${observed.observation.revision}.${observed.image.mime_type==='image/png'?'png':'jpg'}`,mime_type:observed.image.mime_type,data_base64:btoa(binary)});
  }
  return {ok:true as const,data:{...observed.observation,session_handle:record.session.id,text:observed.observation.text.slice(0,8000),elements:observed.observation.elements.slice(0,OBSERVATION_ELEMENT_LIMIT),tabs:observed.observation.tabs.slice(0,8),
   field_values:observed.state.elements.slice(0,OBSERVATION_ELEMENT_LIMIT).flatMap((element,index)=>['input','textarea','select'].includes(element.tag)&&!['password','file','hidden'].includes(element.type)?[{ref:observed.observation.elements[index]!.ref,name:element.name,value:element.value}]:[]),
   ...(observed.image?{}:{text_only:true,image_notice:'The screenshot was over the size limit, so no image of this page is attached. Use its text, accessibility_snapshot and element refs; any attached images are from earlier pages.'}),
   ...(latest.action?.state==='uncertain'||latest.action?.state==='prepared'?{action_outcome:'uncertain'}:{})},source_taint:'external' as const};
 };
 const handler:ToolHandler<BrowsePageArgs,unknown,ToolDispatcherContext>={name:'browse_page',description:'Read a granted public page in the retained task browser. Returns a bounded observation; its screenshot reaches the model as an image. No login, page writes or submit.',schema:browsePageArgsSchema,trigger_allowlist:triggerTypeSchema.options.filter(trigger=>TOOL_PERMISSIONS[trigger].includes('browse_page')),autonomy_gated:false,
  async handle(args,ctx){sessionEnded=false;
   try{
    await ctx.assertTaskSourceCurrent?.();const grant=await granted();
    if(ctx.authenticatedUserId!==options.ownerId||args.session_handle&&options.storage.kv.get<Record>(key(grant.taskId))?.session.id!==args.session_handle||(!isPublicWebUrl(args.url,options.egressAllowlist)||!grant.allowedOrigins.includes(PUBLIC_WEB_ORIGIN)&&!grant.allowedOrigins.includes(new URL(args.url).origin)))throw Error('common browser target rejected');
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
   }catch(error){sessionEnded=ended(error);return {ok:false,code:retryable(error)?'transient':'rejected',error:failureText('The browser read failed; nothing was read.','Retry the read, read the page without retain_session, or try another site.',error,liveHandle()),source_taint:'external'};}
  }};
 const formTarget=(grant:CommonBrowserGrant,url:string)=>{try{const target=new URL(url);return ['https:','http:'].includes(target.protocol)&&!target.username&&!target.password&&isPublicWebUrl(`${target.origin}/`,options.egressAllowlist)&&(grant.allowedOrigins.includes(PUBLIC_WEB_ORIGIN)||grant.allowedOrigins.includes(target.origin));}catch{return false;}};
 const formRefusal=(reason:string)=>({ok:false as const,code:'rejected' as const,error:`${reason} Nothing was sent and no approval card was made.`,source_taint:'external' as const});
 // The card is built from the host's own reading of the form, never from model text: the owner approves what the page holds.
 const proposeForm=async(proposer:CommonBrowserFormSubmit,grant:CommonBrowserGrant,record:Record,before:GeneralActionSnapshot,elementRef:string,ctx:ToolDispatcherContext,storageKey:string)=>{
  const form=await executionDriver(grant,ctx).formSubmission(record.session,before,elementRef);
  await checked();await ctx.assertTaskSourceCurrent?.();
  if(!form)return formRefusal('That control is not part of a form, so there is nothing to send. Click it without intent send if it only changes the page.');
  if(form.method!=='post')return formRefusal('This form sends with GET, which is an ordinary navigation: click its control without intent send.');
  if(form.secret)return formRefusal('This form asks for a password or a one-time code, which Waldo never sends; offer the owner owner_login instead.');
  if(form.file)return formRefusal('This form attaches a file, which this browser cannot send.');
  if(form.enctype!=='application/x-www-form-urlencoded'||!formTarget(grant,form.action))return formRefusal('This form sends in a way this browser cannot approve: another encoding, or a target outside the open public web.');
  if(form.fields.length>FORM_SUBMIT_LIMITS.fields||encodedFormBytes(form.fields)>FORM_SUBMIT_LIMITS.bodyBytes||form.answers.length>FORM_SUBMIT_LIMITS.answers)return formRefusal('This form is too large to show the owner in one approval card.');
  const permit:FormPermit={id:crypto.randomUUID(),state:'proposed',revision:before.observation.revision,targetId:before.targetId,elementRef,url:before.observation.url,action:form.action,fields:form.fields,expiresAt:Math.min(record.session.expiresAt,options.now()+FORM_APPROVAL_MS)};
  options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey);if(!latest||latest.cleanup||!sameSession(latest,record)||latest.observation?.observation.revision!==before.observation.revision||latest.action?.state==='prepared'||latest.action?.state==='uncertain')throw Error('browser form custody changed');save({...latest,submit:permit},storageKey);});
  const binding:{[label:string]:string}={};
  for(const answer of form.answers){let label=answer.label,n=2;while(Object.hasOwn(binding,label))label=`${answer.label} (${n++})`;binding[label]=answer.value;}
  const proposalId=await proposer.propose({url:permit.url,action:{selector:elementRef,description:'Send this form',method:'click'},binding,steps:[],request:{url:form.action,method:'POST',fields:[...new Set(form.fields.map(([name])=>name))]},approvalExpiresAt:permit.expiresAt,form:{taskId:grant.taskId,sessionId:record.session.id,permitId:permit.id}});
  return {ok:true as const,data:{session_handle:record.session.id,stopped:'approval_pending',proposal_id:proposalId,answers:form.answers,notice:'Nothing was sent yet. The owner has an approval card with these answers and the form\'s address; end this turn and tell them. Approving sends this form once, from this same page; read the page afterwards to see the result. Any change to the page before they approve makes the card send nothing, so do not act on this page meanwhile.'},source_taint:'external' as const};
 };
 const actionHandler:ToolHandler<BrowseActArgs,unknown,ToolDispatcherContext>={name:'browse_act',description:'Interact with the current Cloudflare public page using observed refs: goto, back, read, inspect, type, click, select, set_checked, scroll. Download observed HTTP GET attachment links into the private owner workspace. File selection, page sends and native submits are unsupported. Unknown outcomes block repeated effects; read evidence before deciding what completed.',schema:browseActArgsSchema,trigger_allowlist:triggerTypeSchema.options.filter(trigger=>TOOL_PERMISSIONS[trigger].includes('browse_act')),autonomy_gated:false,
  async handle(args,ctx){let storageKey:string|undefined,digest:string|undefined;sessionEnded=false;
   try{
    if(options.config.retainInteractions!==true)throw Error('retained interaction capability unavailable');
    await ctx.assertTaskSourceCurrent?.();const grant=await granted();storageKey=key(grant.taskId);
    let record=options.storage.kv.get<Record>(storageKey);
    if(ctx.authenticatedUserId!==options.ownerId||!args.command||!record||args.session_handle&&record.session.id!==args.session_handle||record.cleanup||record.allocation!=='observed'||JSON.stringify(record.grant)!==JSON.stringify(grant))throw Error('current browser observation unavailable');
    const command=args.command;
    // Ending the session needs only its identity, not a current page: a session whose read failed must still close.
    if(command.operation==='cancel'){await api.cancel();return {ok:true,data:{ended:true},source_taint:'external'};}
    if(!record.handoff&&(!record.observation||args.url!==record.observation.observation.url))throw Error('current browser observation unavailable');
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
     let pdf:LLMAttachment|undefined;
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
       // A PDF (a boarding pass, a ticket) is read by the model as a document; other files stay in the workspace.
       // The server's Content-Type is not trusted: the bytes must open with the %PDF- signature.
       if(metadata.mime==='application/pdf'&&bytes&&bytes.byteLength<=MODEL_PDF_BYTES&&String.fromCharCode(...bytes.subarray(0,5))==='%PDF-'){let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);pdf={kind:'file',mime_type:'application/pdf',filename:metadata.filename,data_base64:btoa(binary)};}
      });
     }
     if(!receipt)throw Error('download receipt unavailable');await assertDownload();
     if(pdf)attach(pdf);
     return {ok:true,data:{session_handle:record.session.id,download:receipt,notice:'Attachment bytes are saved and retrieval verified in your private workspace. This is not verification of the broader browser task.'},source_taint:'external'} as const;
     };
     try{return await Promise.race([runDownload(),interrupted]);}finally{if(timer!==undefined)clearTimeout(timer);}
    }
    if(command.operation==='owner_login'){
     if(!options.config.assertHandoffCurrent||!(ctx.runScope?.runId??ctx.turnId))throw Error('owner login unavailable');
     modelFiles=[];handoffSession={...record.session};
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
    // Going back is a read: it loads an earlier page, which passes the same egress check as any navigation.
    else if(command.operation==='back'){
     const returned=await driver.back(record.session,before.observation.tab_ref);
     if(!returned)return {ok:true,data:{session_handle:record.session.id,back:'no_history',notice:'This tab has no earlier page to go back to, so nothing changed. The current page and its refs are still valid; use goto to open another page.'},source_taint:'external'};
     observed=returned;
    }
    else {
     if(record.action?.state==='prepared'||record.action?.state==='uncertain')throw Error('prior browser effect uncertain');
     if('intent' in command&&command.intent==='send'){
      const proposer=options.formSubmit?.();
      if(command.operation!=='click'||!proposer)throw Error('browser approval required');
      return await proposeForm(proposer,grant,record,before,command.element_ref,ctx,storageKey);
     }
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
      if(element?.inForm&&(action.operation==='press'&&action.key==='Enter'||action.operation==='click'&&(element.tag==='button'&&element.type!=='button'||element.tag==='input'&&['submit','image'].includes(element.type)))&&!(element.formMethod==='get'&&element.formAction&&readableUrl(grant,element.formAction,'GET')))throw new GeneralBrowserError('native_submit_requires_card');
      observed=await driver.act(record.session,before,action,prepare);
     }
    }
    if(digest){const completed=digest;options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey!);if(latest?.action?.digest===completed)save({...latest,action:{digest:completed,state:'observed'}},storageKey!);});}
    const published=await publishObservation(grant,record,observed,ctx);
    if(command.operation==='screenshot'){
      // The owner workspace stores the PNG capture only; a JPEG means the PNG was over the size limit.
      if(observed.image?.mime_type!=='image/png')throw new GeneralBrowserError('image_oversize');
      if(!options.files)throw Error('owner screenshot storage unavailable');
      const files=await options.files(async()=>{await checked();},options.ownerId);
      const receipt=await browserScreenshotToWorkspace({...files,image:observed.image.bytes,maxScreenshotBytes:grant.maxScreenshotBytes,operationId:crypto.randomUUID(),deadline:Math.min(record.session.expiresAt,options.deadline()),now:options.now,assertCurrent:async()=>{await checked();}});
      return {...published,data:{...published.data,screenshot:receipt}};
    }
    return {...published,data:{...published.data,...(!['read','inspect','screenshot','switch_tab','back'].includes(command.operation)?{browser_action_session_handle:record.session.id}:{})}};
   }catch(error){
    if(!digest&&['read','inspect','back'].includes(args.command?.operation??''))sessionEnded=ended(error);
    if(storageKey&&digest){const failed=digest;options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey!);if(latest?.action?.digest===failed)save({...latest,action:{digest:failed,state:'uncertain'}},storageKey!);});}
    return {ok:false,code:!digest&&retryable(error)?'transient':'rejected',error:failureText(error instanceof GeneralBrowserError&&error.code==='native_submit_requires_card'?'The browser refused this form submission before sending anything.':'The browser action failed or its outcome is unknown; no replacement browser or unapproved page write was used.','Read the current page with browse_act read and act on its fresh refs; if page actions keep being refused, end this session with cancel and start a new one.',error,liveHandle(),options.formSubmit?.()?FORM_SEND_NEXT_STEP:BROWSER_NEXT_STEP),source_taint:'external'};
   }
  }};
 const notSent=(message:string):BrowserSubmitOutcome=>({status:'rejected',message:`${message} Nothing was sent.`});
 const settleForm=(storageKey:string,permit:FormPermit,state:FormPermit['state'],action:Readonly<{digest:string;state:'observed'|'uncertain'}>|undefined,observed?:GeneralSnapshot,receipt?:FormReceipt)=>options.storage.transactionSync(()=>{
  const latest=options.storage.kv.get<Record>(storageKey);if(!latest||latest.submit?.id!==permit.id)return;
  let next:Record={...latest,submit:{...latest.submit,state,...(receipt?{receipt}:{})},...(action&&latest.action?.digest===action.digest?{action}:{})};
  if(observed){const withPage=checkpointOf(next,observed);next=encodedCheckpointBytes(withPage)>COMMON_BROWSER_CHECKPOINT_BYTES-1024?{...next,observation:undefined,tabs:[]}:withPage;}
  save(next,storageKey);
 });
 // Runs after the owner approves the card, outside any model turn, on the same live document the form was filled in. A
 // closed page, a changed page or form, an expired session or a changed owner sends nothing; the page's POST is admitted
 // once and only with the approved fields, so a mismatch is refused in the browser before it leaves.
 const submitApprovedForm=async(payload:BrowserSubmitProposal):Promise<BrowserSubmitOutcome>=>{
  const reference=payload.form;if(!reference)return notSent('This approval is not for a form in Waldo\'s browser.');
  const storageKey=key(reference.taskId),record=options.storage.kv.get<Record>(storageKey),permit=record?.submit,now=options.now();
  if(!record||record.cleanup||record.handoff||record.session.id!==reference.sessionId||!permit||permit.id!==reference.permitId||permit.state!=='proposed'||payload.request?.url!==permit.action)return notSent('The form this approval was for is no longer waiting.');
  if(permit.expiresAt<=now||record.session.expiresAt<=now)return notSent('The browser session that filled this form has ended. Ask Waldo to fill it again.');
  if(record.action?.state==='prepared'||record.action?.state==='uncertain'||!record.observation||record.observation.observation.revision!==permit.revision||record.observation.targetId!==permit.targetId)return notSent('The page changed after you were asked. Ask Waldo to look at it again.');
  if(approved||!options.config.assertHandoffCurrent||!execution||execution.grant!==JSON.stringify(record.grant)||!execution.driver.hasRetainedConnection())return notSent('The browser page holding this form was closed. Ask Waldo to fill it again.');
  const driver=execution.driver,before=record.observation,held={permit,grant:record.grant,storageKey,deadline:Math.min(record.session.expiresAt,now+FORM_SEND_MS),used:false};
  approved=held;
  let digest:string|undefined;
  try{
   try{await approvedCurrent(held);}catch{return notSent('Your approval could not be confirmed for this browser session.');}
   const current=await driver.formSubmission(record.session,before,permit.elementRef).catch(()=>null);
   if(!current||current.action!==permit.action||JSON.stringify(current.fields)!==JSON.stringify(permit.fields)){settleForm(storageKey,permit,'unsent',undefined);return notSent('The form changed after you were asked. Ask Waldo to look at it again.');}
   let observed:GeneralSnapshot;
   try{
    observed=await driver.act(record.session,before,{operation:'click',element_ref:permit.elementRef},async prepared=>{
     await approvedCurrent(held);
     options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey);if(!latest||latest.cleanup||!sameSession(latest,record)||latest.observation?.observation.revision!==permit.revision||latest.submit?.id!==permit.id||latest.submit.state!=='proposed'||latest.action?.state==='prepared'||latest.action?.state==='uncertain')throw Error('browser form custody changed');save({...latest,action:{digest:prepared,state:'prepared'},submit:{...latest.submit,state:'sending'}},storageKey);digest=prepared;});
    });
   }catch{
    // Every other write stays blocked while the send runs, so an approval that never released its POST sent nothing.
    settleForm(storageKey,permit,held.used?'uncertain':'unsent',digest?{digest,state:held.used?'uncertain':'observed'}:undefined);
    return held.used?{status:'uncertain',message:'The form was sent, but its result could not be read. Do not send it again before checking the page.'}:notSent('The page did not send the form; it may be showing a missing or invalid answer. Ask Waldo to look at it again.');
   }
   if(!held.used||!digest){settleForm(storageKey,permit,'unsent',digest?{digest,state:'observed'}:undefined,observed);return notSent('The page did not send the form; it may be showing a missing or invalid answer. Ask Waldo to look at it again.');}
   // The receipt is this host's own evidence: the one admitted POST carried the approved fields, the site answered it
   // without an error and its result page loaded in this session. What the page says stays for Waldo to read.
   const receipt:FormReceipt={id:permit.id,observed_at:new Date(options.now()).toISOString(),source:'provider',action_digest:digest,binding_digest:await generalDigest(JSON.stringify(permit.fields))};
   settleForm(storageKey,permit,'sent',{digest,state:'observed'},observed,receipt);
   const shown=(observed.observation.title||observed.observation.text).replace(/\s+/g,' ').trim().slice(0,160);
   return {status:'verified_with_receipt',message:`The site accepted the form${shown?` and showed "${shown}"`:''}.`,receipt};
  }finally{if(approved===held)approved=undefined;}
 };
 const api={handler,actionHandler,submitApprovedForm,
 formReceiptVerified(payload:BrowserSubmitProposal,receipt:FormReceipt){const reference=payload.form,row=reference?options.storage.kv.get<Record>(key(reference.taskId)):undefined;return !!reference&&row?.submit?.id===reference.permitId&&row.submit.state==='sent'&&!!row.submit.receipt&&JSON.stringify(row.submit.receipt)===JSON.stringify(receipt);},
 // A declined or withdrawn card closes its permit, so a later approval of it sends nothing.
 withdrawForm(payload:BrowserSubmitProposal){const reference=payload.form;if(!reference)return;const storageKey=key(reference.taskId);options.storage.transactionSync(()=>{const latest=options.storage.kv.get<Record>(storageKey);if(latest?.submit?.id===reference.permitId&&latest.submit.state==='proposed')save({...latest,submit:{...latest.submit,state:'unsent'}},storageKey);});},
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
resetAttachments(){modelFiles=[];},sessionEnded:()=>sessionEnded,sessionHandle:()=>options.storage.kv.get<Record>(key(snapshot().taskId))?.session.id,attachments:()=>[...modelFiles],async cancel(){modelFiles=[];const task=snapshot();const record=options.storage.kv.get<Record>(key(task.taskId));if(!record||record.cleanup==='closed')return;
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
