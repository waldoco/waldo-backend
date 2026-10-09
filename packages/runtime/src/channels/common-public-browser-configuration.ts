import {commonSpendCalls,commonSpendReservation,type CommonSpendPolicy,type CommonSpendQuote} from './common-spend-reservation';
import type {LLMGatewayAdapter} from '../llm/provider';
import type {BrowserWorker} from '@cloudflare/playwright';
import {commonOwnerAuthority} from '../identity/common-owner-authority';
import type {CommonBrowserConfiguration,CommonBrowserGrant} from './common-browser-host';
import type {CloudflareBrowserSdkLoader} from './public-fixture-browser';
import type {TelegramWebhookEnv} from './telegram-webhook';
import {COMMON_BROWSER_MONTH_CEILING_MICROUSD} from './common-staging-registration';

// Deployment/test host policy must be supplied within owner-approved testing scope.
// This module does not create an owner decision, widen fixture authorization or enable BROWSER.
export type CommonPublicReadPolicy=Readonly<{
 ref:string;doName:string;subject:string;directoryOwnerId:string;createdAt:number;expiresAt:number;
 allowedOrigins:readonly string[];maxAllocations:number;maxReservedBrowserMs:number;lifetimeMs:number;maxScreenshotBytes:number;
}>;
export type CommonBrowserSpendRegistration=Readonly<{policy:CommonSpendPolicy;quote:CommonSpendQuote;allocationMicrousd:number;countModel?(material:unknown):Promise<number>}>;
let registration:Readonly<{policy:CommonPublicReadPolicy;loadSdk:CloudflareBrowserSdkLoader;spend?:CommonBrowserSpendRegistration}>|undefined;
export function configureCommonPublicBrowser(policy:CommonPublicReadPolicy,loadSdk:CloudflareBrowserSdkLoader,spend?:CommonBrowserSpendRegistration){
 if(registration)throw Error('common public browser already configured');
 registration=Object.freeze({policy:freezePolicy(policy),loadSdk,spend:spend?freezeSpend(spend):undefined});
}
const freezeSpend=(spend:CommonBrowserSpendRegistration):CommonBrowserSpendRegistration=>{
 if(!Number.isSafeInteger(spend.allocationMicrousd)||spend.allocationMicrousd<1||spend.quote('browser',null)!==0)throw Error('common allocation price registration invalid');
 return Object.freeze({policy:Object.freeze({...spend.policy}),quote:spend.quote,allocationMicrousd:spend.allocationMicrousd,countModel:spend.countModel});
};
const freezePolicy=(policy:CommonPublicReadPolicy):CommonPublicReadPolicy=>{
 const row={...policy,allowedOrigins:[...policy.allowedOrigins]};
 if(!row.ref||!row.doName||!/^\d{1,32}$/.test(row.subject)||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.directoryOwnerId)
  ||![row.createdAt,row.expiresAt,row.maxAllocations,row.maxReservedBrowserMs,row.lifetimeMs,row.maxScreenshotBytes].every(Number.isSafeInteger)
  ||row.createdAt<0||row.expiresAt<=row.createdAt||row.maxAllocations<1||row.maxReservedBrowserMs<row.lifetimeMs*2||row.lifetimeMs<10000||row.lifetimeMs>600000||row.maxScreenshotBytes<1
  ||!row.allowedOrigins.length||new Set(row.allowedOrigins).size!==row.allowedOrigins.length||row.allowedOrigins.some(origin=>{if(origin==='*')return false;try{const url=new URL(origin);return url.protocol!=='https:'||url.origin!==origin||!!url.username||!!url.password;}catch{return true;}}))throw Error('common public browser policy invalid');
 return Object.freeze({...row,allowedOrigins:Object.freeze(row.allowedOrigins)});
};
type Usage={custodyDigest?:string;allocationMicrousd:number;policy:CommonPublicReadPolicy;allocations:number;reservedBrowserMs:number;taskGrants:CommonBrowserGrant[]};
export function assertCommonPublicBrowserUsage(retained:Usage,policy:CommonPublicReadPolicy,allocationMicrousd:number):void{
  if(retained.allocationMicrousd!==allocationMicrousd||JSON.stringify(retained.policy)!==JSON.stringify(policy)||!Number.isSafeInteger(retained.allocations)||retained.allocations<0||retained.allocations>policy.maxAllocations||!Number.isSafeInteger(retained.reservedBrowserMs)||retained.reservedBrowserMs<0||retained.reservedBrowserMs>policy.maxReservedBrowserMs||!Array.isArray(retained.taskGrants)||retained.taskGrants.length>policy.maxAllocations
   ||retained.allocations*policy.lifetimeMs*2!==retained.reservedBrowserMs
   ||typeof retained.custodyDigest!=='string'||!/^[a-f0-9]{64}$/.test(retained.custodyDigest)
   ||new Set(retained.taskGrants.map(grant=>grant.taskId)).size!==retained.taskGrants.length
   ||retained.taskGrants.some(grant=>!grant||!grant.taskId||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=policy.createdAt||grant.expiresAt>policy.expiresAt||JSON.stringify(grant)!==JSON.stringify({ref:policy.ref,ownerId:`prn_${policy.directoryOwnerId.toLowerCase().replaceAll('-','')}`,taskId:grant.taskId,expiresAt:grant.expiresAt,allowedOrigins:policy.allowedOrigins,lifetimeMs:policy.lifetimeMs,maxScreenshotBytes:policy.maxScreenshotBytes})))throw Error('common public browser retained policy conflict');
}
export function commonPublicBrowserConfiguration(options:Readonly<{env:TelegramWebhookEnv;storage:DurableObjectStorage;actualDoId:string;policy?:CommonPublicReadPolicy;loadSdk?:CloudflareBrowserSdkLoader;spend?:CommonBrowserSpendRegistration;cleanupOnly?:boolean;now?:()=>number}>):(CommonBrowserConfiguration & Readonly<{ownerId:string;lifetimeMs:number;expiresAt:number}>)|undefined{
 const {env,storage,actualDoId}=options,selected=options.policy?{policy:options.policy,loadSdk:options.loadSdk,spend:options.spend}:registration;
 if(env.WALDO_ENVIRONMENT!=='staging'||!env.BROWSER||!selected?.loadSdk||!selected.spend)return undefined;
 const policy=freezePolicy(selected.policy),now=options.now??Date.now,directory=commonOwnerAuthority(env);
 // This registration belongs to one physical owner. Selecting it on another
 // owner would also install its model spend gate and break unrelated chat.
 if(env.TELEGRAM_OWNER_DO?.idFromName(policy.doName).toString()!==actualDoId)return undefined;
 if(!options.cleanupOnly&&(storage.kv.get('do_name')!==policy.doName||storage.kv.get('telegram_subject')!==policy.subject))return undefined;
 const spend=freezeSpend(selected.spend);
 if(spend.policy.ownerId!==`prn_${policy.directoryOwnerId.toLowerCase().replaceAll('-','')}`||spend.policy.validUntil>policy.expiresAt)throw Error('common browser spend policy rejected');
 const ledger=commonSpendReservation(storage,spend.policy,now,()=>physical());
 const calls=commonSpendCalls(ledger,(kind,request)=>{const bound=spend.quote(kind,request);if(kind==='browser'&&bound!==0)throw Error('common browser allocation price changed');return bound;},{countModel:spend.countModel?material=>spend.countModel!(material):undefined});
 const key=`common-public-browser-usage:${policy.ref}`;
 const physical=()=>{const at=now();if(!Number.isSafeInteger(at)||at<policy.createdAt||at>=policy.expiresAt||storage.kv.get('do_name')!==policy.doName||storage.kv.get('telegram_subject')!==policy.subject||storage.kv.get('telegram_unlinked')===true||env.TELEGRAM_OWNER_DO?.idFromName(policy.doName).toString()!==actualDoId)throw Error('common public browser policy unavailable');};
 const read=():Usage=>{
  const retained=storage.kv.get<Usage>(key);
  if(!retained)return {policy,allocationMicrousd:spend.allocationMicrousd,allocations:0,reservedBrowserMs:0,taskGrants:[]};
  assertCommonPublicBrowserUsage(retained,policy,spend.allocationMicrousd);
  return retained;
 };
 const owner=async()=>{physical();const row=await directory.resolve('telegram',policy.subject,policy.doName);physical();if(!row||row.directoryOwnerId!==policy.directoryOwnerId.toLowerCase())throw Error('common public browser owner unavailable');return {ownerId:`prn_${row.directoryOwnerId.replaceAll('-','')}`,custodyDigest:row.custodyDigest};};
 const verify=async(grant:CommonBrowserGrant)=>{const current=await owner();if(current.ownerId!==grant.ownerId)throw Error('common public browser owner changed');const row=read();if(row.custodyDigest!==current.custodyDigest)throw Error('common public browser authority changed');if(!row.taskGrants.some(retained=>JSON.stringify(retained)===JSON.stringify(grant)))throw Error('common public browser grant changed');};
 return {
  ownerId:spend.policy.ownerId,
  lifetimeMs:policy.lifetimeMs,expiresAt:policy.expiresAt,
  binding:{fetch:async()=>{throw Error('common browser operation identity unavailable');}} as BrowserWorker,loadSdk:selected.loadSdk,
  bindingForOperation:(grant,operationId)=>{
   if(!operationId||!read().taskGrants.some(retained=>JSON.stringify(retained)===JSON.stringify(grant)))throw Error('common browser operation custody unavailable');
   return calls.binding(env.BROWSER as BrowserWorker,operationId);
  },
  cleanupBinding:(grant,id)=>{
   // Retained host custody, not current action authority, names the obligation.
   const retained=storage.kv.get<{grant:CommonBrowserGrant;session:{providerSessionId:string}}>(`common-browser:${grant.taskId}`);
   if(!retained||JSON.stringify(retained.grant)!==JSON.stringify(grant)||retained.session.providerSessionId!==id)throw Error('common cleanup custody unavailable');
   return calls.cleanupBinding(env.BROWSER as BrowserWorker,`browser-cleanup:${grant.taskId}`,id);
  },
  meterGateway:(gateway:LLMGatewayAdapter)=>calls.gateway(gateway),
  grant:async(task,ownerId)=>{
   const current=await owner();
   if(!task.ready||!task.sources.some(source=>source==='browser'||source==='web')||current.ownerId!==ownerId)throw Error('common public browser source unavailable');
   return storage.transactionSync(()=>{
    physical();const row=read();if(row.custodyDigest&&row.custodyDigest!==current.custodyDigest)throw Error('common public browser authority changed');const retained=row.taskGrants.find(grant=>grant.taskId===task.taskId);
    if(retained){if(retained.ownerId!==ownerId)throw Error('common public browser task owner changed');return retained;}
    // A grant consumes no provider time; allocation is separately reserved before I/O.
    if(row.taskGrants.length>=policy.maxAllocations)throw Error('common public browser task budget unavailable');
    const grant:CommonBrowserGrant={ref:policy.ref,ownerId,taskId:task.taskId,expiresAt:policy.expiresAt,allowedOrigins:policy.allowedOrigins,lifetimeMs:policy.lifetimeMs,maxScreenshotBytes:policy.maxScreenshotBytes};
    storage.kv.put(key,{...row,custodyDigest:current.custodyDigest,taskGrants:[...row.taskGrants,grant]});return grant;
   });
  },
  assertGrantCurrent:verify,
  reserveAllocation:async(grant)=>{
   await verify(grant);
    // keep_alive is idle, not total lifetime. Reserve the full task window plus
    // one idle timeout for unknown acquire identity or failed physical termination.
    const reserve=grant.lifetimeMs*2;
    // Reserve the lifetime/day envelope once, before acquire. Binding requests
    // consume zero-money slots inside this funded allocation. Cleanup retains
    // three slots after expiry without reserving the same allocation again.
    ledger.reserveCleanup(`browser-cleanup:${grant.taskId}`,spend.allocationMicrousd,3,()=>{
     physical();const row=read();
     if(row.allocations>=policy.maxAllocations||row.reservedBrowserMs+reserve>policy.maxReservedBrowserMs)throw Error('common public browser allocation budget unavailable');
     // The monthly browser ceiling is per owner storage and billing month (UTC), summed across every policy ref.
     const month=`common-public-browser-month:${new Date(now()).toISOString().slice(0,7)}`,spent=storage.kv.get<number>(month)??0;
     if(!Number.isSafeInteger(spent)||spent<0||spent+spend.allocationMicrousd>COMMON_BROWSER_MONTH_CEILING_MICROUSD)throw Error('common public browser monthly budget unavailable');
     storage.kv.put(month,spent+spend.allocationMicrousd);
     storage.kv.put(key,{...row,allocations:row.allocations+1,reservedBrowserMs:row.reservedBrowserMs+reserve});
    });
  },
 };
}
