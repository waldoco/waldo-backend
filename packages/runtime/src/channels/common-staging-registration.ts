import {commonCloudflareWorstCaseEnvelope} from './common-staging-price-envelope';
import type {CloudflareBrowserSdkLoader} from './public-fixture-browser';
import type {CommonBrowserSpendRegistration,CommonPublicReadPolicy} from './common-public-browser-configuration';
import {commonAllocationEnvelope,commonStagingBillingIdentity,commonStagingModelQuote} from './common-staging-spend-registration';
// Deployment registration for the common public browser. All values are non-secret
// deployment vars (staging only). Nothing here approves spend: the owner's caps are hard
// ceilings the registration may not exceed, and the ledger still reserves before each call.
export const COMMON_TEST_CEILING_MICROUSD=10_000_000;     // owner: $10 total test cap
const HISTORICAL_TEST_FORMAT_MAX_MICROUSD=20_000_000; // retained format, never new admission
export const COMMON_BROWSER_MONTH_CEILING_MICROUSD=5_000_000; // owner: $5/month browser cap
let sdkLoader:CloudflareBrowserSdkLoader|undefined;
export const registerCommonBrowserSdk=(loader:CloudflareBrowserSdkLoader)=>{if(sdkLoader)throw Error('common browser sdk already registered');sdkLoader=loader;};
export const commonBrowserSdk=()=>sdkLoader;
export type CommonStagingRegistration=Readonly<{policy:CommonPublicReadPolicy;spend:CommonBrowserSpendRegistration}>;
export function commonStagingRegistration(env:Readonly<{WALDO_ENVIRONMENT?:string;COMMON_BROWSER_REGISTRATION?:string}>,purpose:'admission'|'retained_read'='admission'):CommonStagingRegistration|undefined{
 if(env.WALDO_ENVIRONMENT!=='staging'||!env.COMMON_BROWSER_REGISTRATION)return undefined;
 let raw:any;try{raw=JSON.parse(env.COMMON_BROWSER_REGISTRATION);}catch{throw Error('common browser registration invalid');}
 const policy=raw?.policy as CommonPublicReadPolicy,spend=raw?.spend,conservative=raw?.billing?.conservativeWorstCase===true,billing=conservative?undefined:commonStagingBillingIdentity(raw?.billing);
 // Historical inspection and already-funded cleanup cannot authorize new work.
 const maximum=purpose==='retained_read'?HISTORICAL_TEST_FORMAT_MAX_MICROUSD:COMMON_TEST_CEILING_MICROUSD;
 if(!policy||!spend||!Number.isSafeInteger(spend.limitMicrousd)||spend.limitMicrousd<1||spend.limitMicrousd>maximum
  ||!Number.isSafeInteger(spend.maxCalls)||spend.maxCalls<1||!Number.isSafeInteger(spend.validUntil)||(!conservative&&!Number.isSafeInteger(spend.allocationDayCount)))throw Error('common browser registration invalid');
 if(conservative&& !/^[a-f0-9]{32}$/.test(raw.billing.cloudflareAccountId??''))throw Error('staging billing identity invalid');
 // A cheaper daily-peak envelope must cover every billing day that an
 // allocation in this immutable window could touch, including reserved idle.
 if(!conservative){
  const lastReservedAt=policy.expiresAt+policy.lifetimeMs*2;
  if(!Number.isSafeInteger(policy.createdAt)||policy.createdAt<0||!Number.isSafeInteger(lastReservedAt)||lastReservedAt<=policy.createdAt)throw Error('common browser allocation day bound invalid');
  // Billing-day alignment is not supplied by the vendor registration.
  // Cover the worst alignment instead of assuming a UTC boundary.
  const requiredDays=Math.ceil((lastReservedAt-policy.createdAt)/86400000)+1;
  if(spend.allocationDayCount<requiredDays)throw Error('common browser allocation day bound understated');
 }
 const allocationMicrousd=conservative?commonCloudflareWorstCaseEnvelope(policy.lifetimeMs*2):commonAllocationEnvelope({reservedBrowserMs:policy.lifetimeMs*2,allocationDayCount:spend.allocationDayCount,maxAllocations:policy.maxAllocations},billing!);
 if(allocationMicrousd*policy.maxAllocations>COMMON_BROWSER_MONTH_CEILING_MICROUSD||allocationMicrousd*policy.maxAllocations>spend.limitMicrousd)throw Error('common browser registration exceeds owner caps');
 return Object.freeze({policy,spend:Object.freeze({
  policy:Object.freeze({ref:policy.ref,ownerId:`prn_${policy.directoryOwnerId.toLowerCase().replaceAll('-','')}`,validUntil:spend.validUntil,limitMicrousd:spend.limitMicrousd,maxCalls:spend.maxCalls}),
  quote:(kind:'model'|'browser',request:unknown)=>kind==='browser'?0:commonStagingModelQuote(request),
  allocationMicrousd})});
}
