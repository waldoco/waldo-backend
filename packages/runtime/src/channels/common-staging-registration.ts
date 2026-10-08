import type {CloudflareBrowserSdkLoader} from './public-fixture-browser';
import type {CommonBrowserSpendRegistration,CommonPublicReadPolicy} from './common-public-browser-configuration';
import {commonAllocationEnvelope,commonStagingBillingIdentity,commonStagingModelQuote} from './common-staging-spend-registration';
// Deployment registration for the common public browser. All values are non-secret
// deployment vars (staging only). Nothing here approves spend: the owner's caps are hard
// ceilings the registration may not exceed, and the ledger still reserves before each call.
export const COMMON_TEST_CEILING_MICROUSD=20_000_000;     // owner: $20 total test cap
export const COMMON_BROWSER_MONTH_CEILING_MICROUSD=5_000_000; // owner: $5/month browser cap
let sdkLoader:CloudflareBrowserSdkLoader|undefined;
export const registerCommonBrowserSdk=(loader:CloudflareBrowserSdkLoader)=>{if(sdkLoader)throw Error('common browser sdk already registered');sdkLoader=loader;};
export const commonBrowserSdk=()=>sdkLoader;
export type CommonStagingRegistration=Readonly<{policy:CommonPublicReadPolicy;spend:CommonBrowserSpendRegistration}>;
export function commonStagingRegistration(env:Readonly<{WALDO_ENVIRONMENT?:string;COMMON_BROWSER_REGISTRATION?:string}>):CommonStagingRegistration|undefined{
 if(env.WALDO_ENVIRONMENT!=='staging'||!env.COMMON_BROWSER_REGISTRATION)return undefined;
 let raw:any;try{raw=JSON.parse(env.COMMON_BROWSER_REGISTRATION);}catch{throw Error('common browser registration invalid');}
 const policy=raw?.policy as CommonPublicReadPolicy,spend=raw?.spend,billing=commonStagingBillingIdentity(raw?.billing);
 if(!policy||!spend||!Number.isSafeInteger(spend.limitMicrousd)||spend.limitMicrousd<1||spend.limitMicrousd>COMMON_TEST_CEILING_MICROUSD
  ||!Number.isSafeInteger(spend.maxCalls)||spend.maxCalls<1||!Number.isSafeInteger(spend.validUntil)||!Number.isSafeInteger(spend.allocationDayCount))throw Error('common browser registration invalid');
 const allocationMicrousd=commonAllocationEnvelope({reservedBrowserMs:policy.lifetimeMs*2,allocationDayCount:spend.allocationDayCount,maxAllocations:policy.maxAllocations},billing);
 if(allocationMicrousd*policy.maxAllocations>COMMON_BROWSER_MONTH_CEILING_MICROUSD||allocationMicrousd*policy.maxAllocations>spend.limitMicrousd)throw Error('common browser registration exceeds owner caps');
 return Object.freeze({policy,spend:Object.freeze({
  policy:Object.freeze({ref:policy.ref,ownerId:`prn_${policy.directoryOwnerId.toLowerCase().replaceAll('-','')}`,validUntil:spend.validUntil,limitMicrousd:spend.limitMicrousd,maxCalls:spend.maxCalls}),
  quote:(kind:'model'|'browser',request:unknown)=>kind==='browser'?0:commonStagingModelQuote(request),
  allocationMicrousd})});
}
