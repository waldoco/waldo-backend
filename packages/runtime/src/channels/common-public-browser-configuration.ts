import type {BrowserWorker} from '@cloudflare/playwright';
import {commonOwnerAuthority} from '../identity/common-owner-authority';
import type {CommonBrowserConfiguration,CommonBrowserGrant} from './common-browser-host';
import type {CloudflareBrowserSdkLoader} from './public-fixture-browser';
import type {TelegramWebhookEnv} from './telegram-webhook';

// Deployment/test host policy must be supplied within owner-approved testing scope.
// This module does not create an owner decision, widen fixture authorization or enable BROWSER.
export type CommonPublicReadPolicy=Readonly<{
 ref:string;doName:string;subject:string;directoryOwnerId:string;createdAt:number;expiresAt:number;
 allowedOrigins:readonly string[];maxAllocations:number;maxReservedBrowserMs:number;lifetimeMs:number;maxScreenshotBytes:number;
}>;
let registration:Readonly<{policy:CommonPublicReadPolicy;loadSdk:CloudflareBrowserSdkLoader}>|undefined;
export function configureCommonPublicBrowser(policy:CommonPublicReadPolicy,loadSdk:CloudflareBrowserSdkLoader){
 if(registration)throw Error('common public browser already configured');
 registration={policy:freezePolicy(policy),loadSdk};
}
const freezePolicy=(policy:CommonPublicReadPolicy):CommonPublicReadPolicy=>{
 const row={...policy,allowedOrigins:[...policy.allowedOrigins]};
 if(!row.ref||!row.doName||!/^\d{1,32}$/.test(row.subject)||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.directoryOwnerId)
  ||![row.createdAt,row.expiresAt,row.maxAllocations,row.maxReservedBrowserMs,row.lifetimeMs,row.maxScreenshotBytes].every(Number.isSafeInteger)
  ||row.createdAt<0||row.expiresAt<=row.createdAt||row.maxAllocations<1||row.maxReservedBrowserMs<row.lifetimeMs*2||row.lifetimeMs<10000||row.lifetimeMs>600000||row.maxScreenshotBytes<1
  ||!row.allowedOrigins.length||new Set(row.allowedOrigins).size!==row.allowedOrigins.length||row.allowedOrigins.some(origin=>{if(origin==='*')return false;try{const url=new URL(origin);return url.protocol!=='https:'||url.origin!==origin||!!url.username||!!url.password;}catch{return true;}}))throw Error('common public browser policy invalid');
 return Object.freeze({...row,allowedOrigins:Object.freeze(row.allowedOrigins)});
};
type Usage={custodyDigest?:string;policy:CommonPublicReadPolicy;allocations:number;reservedBrowserMs:number;taskGrants:CommonBrowserGrant[]};
export function commonPublicBrowserConfiguration(options:Readonly<{env:TelegramWebhookEnv;storage:DurableObjectStorage;actualDoId:string;policy?:CommonPublicReadPolicy;loadSdk?:CloudflareBrowserSdkLoader;now?:()=>number}>):CommonBrowserConfiguration|undefined{
 const {env,storage,actualDoId}=options,selected=options.policy?{policy:options.policy,loadSdk:options.loadSdk}:registration;
 if(env.WALDO_ENVIRONMENT!=='staging'||!env.BROWSER||!selected?.loadSdk)return undefined;
 const policy=freezePolicy(selected.policy),now=options.now??Date.now,directory=commonOwnerAuthority(env);
 const key=`common-public-browser-usage:${policy.ref}`;
 const physical=()=>{const at=now();if(!Number.isSafeInteger(at)||at<policy.createdAt||at>=policy.expiresAt||storage.kv.get('do_name')!==policy.doName||storage.kv.get('telegram_subject')!==policy.subject||storage.kv.get('telegram_unlinked')===true||env.TELEGRAM_OWNER_DO?.idFromName(policy.doName).toString()!==actualDoId)throw Error('common public browser policy unavailable');};
 const read=():Usage=>{
  const retained=storage.kv.get<Usage>(key);
  if(!retained)return {policy,allocations:0,reservedBrowserMs:0,taskGrants:[]};
  if(JSON.stringify(retained.policy)!==JSON.stringify(policy)||!Number.isSafeInteger(retained.allocations)||retained.allocations<0||retained.allocations>policy.maxAllocations||!Number.isSafeInteger(retained.reservedBrowserMs)||retained.reservedBrowserMs<0||retained.reservedBrowserMs>policy.maxReservedBrowserMs||!Array.isArray(retained.taskGrants)||retained.taskGrants.length>policy.maxAllocations
   ||retained.allocations*policy.lifetimeMs*2!==retained.reservedBrowserMs
   ||typeof retained.custodyDigest!=='string'||!/^[a-f0-9]{64}$/.test(retained.custodyDigest)
   ||new Set(retained.taskGrants.map(grant=>grant.taskId)).size!==retained.taskGrants.length
   ||retained.taskGrants.some(grant=>!grant||!grant.taskId||JSON.stringify(grant)!==JSON.stringify({ref:policy.ref,ownerId:`prn_${policy.directoryOwnerId.toLowerCase().replaceAll('-','')}`,taskId:grant.taskId,expiresAt:policy.expiresAt,allowedOrigins:policy.allowedOrigins,lifetimeMs:policy.lifetimeMs,maxScreenshotBytes:policy.maxScreenshotBytes})))throw Error('common public browser retained policy conflict');
  return retained;
 };
 const owner=async()=>{physical();const row=await directory.resolve('telegram',policy.subject,policy.doName);physical();if(!row||row.directoryOwnerId!==policy.directoryOwnerId.toLowerCase())throw Error('common public browser owner unavailable');return {ownerId:`prn_${row.directoryOwnerId.replaceAll('-','')}`,custodyDigest:row.custodyDigest};};
 const verify=async(grant:CommonBrowserGrant)=>{const current=await owner();if(current.ownerId!==grant.ownerId)throw Error('common public browser owner changed');const row=read();if(row.custodyDigest!==current.custodyDigest)throw Error('common public browser authority changed');if(!row.taskGrants.some(retained=>JSON.stringify(retained)===JSON.stringify(grant)))throw Error('common public browser grant changed');};
 return {
  binding:env.BROWSER as BrowserWorker,loadSdk:selected.loadSdk,
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
   storage.transactionSync(()=>{
    physical();const row=read();
    // keep_alive is idle, not total lifetime. Reserve the full task window plus
    // one idle timeout for unknown acquire identity or failed physical termination.
    const reserve=grant.lifetimeMs*2;
    if(row.allocations>=policy.maxAllocations||row.reservedBrowserMs+reserve>policy.maxReservedBrowserMs)throw Error('common public browser allocation budget unavailable');
    storage.kv.put(key,{...row,allocations:row.allocations+1,reservedBrowserMs:row.reservedBrowserMs+reserve});
   });
  },
 };
}
