// Registration binds an immutable staging billing identity and owner policy to
// vendor envelopes. It authorizes nothing by itself; the deployment supplies
// it once and the ledger refuses any identity widening.
import {commonCloudflareEnvelope,commonLunaEnvelope,commonLunaFullContextEnvelope} from './common-staging-price-envelope';
export type CommonStagingBillingIdentity=Readonly<{cloudflareAccountId:string;billingCycleDays:number;workersPaid:boolean}>;
export type CommonAllocationPlan=Readonly<{reservedBrowserMs:number;allocationDayCount:number;maxAllocations:number}>;
export type CommonModelCallPlan=Readonly<{countedInputTokens:number;maxOutputTokens:number}>;
export function commonStagingBillingIdentity(value:unknown):CommonStagingBillingIdentity{
 const row=value as Partial<CommonStagingBillingIdentity>;
 if(!row||typeof row.cloudflareAccountId!=='string'||!/^[a-f0-9]{32}$/.test(row.cloudflareAccountId)
  ||!Number.isSafeInteger(row.billingCycleDays)||row.billingCycleDays!<1||row.billingCycleDays!>366||row.workersPaid!==true)throw Error('staging billing identity invalid');
 const days=row.billingCycleDays as number;return Object.freeze({cloudflareAccountId:row.cloudflareAccountId,billingCycleDays:days,workersPaid:true});
}
export function commonAllocationEnvelope(plan:CommonAllocationPlan,billing:CommonStagingBillingIdentity):number{
 if(!Number.isSafeInteger(plan.reservedBrowserMs)||plan.reservedBrowserMs<1
  ||!Number.isSafeInteger(plan.allocationDayCount)||plan.allocationDayCount<1||plan.allocationDayCount>billing.billingCycleDays
  ||!Number.isSafeInteger(plan.maxAllocations)||plan.maxAllocations<1)throw Error('allocation plan invalid');
 return commonCloudflareEnvelope(plan.reservedBrowserMs,plan.allocationDayCount,billing.billingCycleDays);
}
export function commonModelCallEnvelope(call:CommonModelCallPlan):number{
 if(!Number.isSafeInteger(call.countedInputTokens)||call.countedInputTokens<0||call.countedInputTokens>1_050_000
  ||!Number.isSafeInteger(call.maxOutputTokens)||call.maxOutputTokens<1||call.maxOutputTokens>128_000)throw Error('model call plan invalid');
 // countedInputTokens must come from an exact immutable witness for the same
 // wire payload (vendor input-token count). Char/image estimates are not admitted.
 return commonLunaEnvelope(call.countedInputTokens,call.maxOutputTokens);
}
// Model quote for the registered staging scope. An exact counted-token witness
// supplied through the metered gateway is the only admitted input count; without
// it the honest bound is the entire model context window. Estimates are refused.
export function commonStagingModelQuote(material:unknown):number{
 const row=material as {request?:{max_tokens?:unknown};countedInputTokens?:unknown;estimatedInputTokens?:unknown};
 if(!row||typeof row!=='object'||!row.request||typeof row.request!=='object'||!Number.isSafeInteger(row.request.max_tokens))throw Error('model quote request invalid');
 if(row.estimatedInputTokens!==undefined)throw Error('estimated token counts are not admitted');
 const maxOutputTokens=row.request.max_tokens as number;
 if(row.countedInputTokens===undefined)return commonLunaFullContextEnvelope(maxOutputTokens);
 if(!Number.isSafeInteger(row.countedInputTokens))throw Error('model count witness invalid');
 return commonModelCallEnvelope({countedInputTokens:row.countedInputTokens as number,maxOutputTokens});
}
export function commonRegistrationFits(options:Readonly<{identity:CommonStagingBillingIdentity;allocation:CommonAllocationPlan;modelCalls:readonly CommonModelCallPlan[];limitMicrousd:number}>):boolean{
 const {identity,allocation,modelCalls,limitMicrousd}=options;
 if(!Number.isSafeInteger(limitMicrousd)||limitMicrousd<1||modelCalls.length<1)return false;
 const perAllocation=commonAllocationEnvelope(allocation,identity);
 const total=perAllocation*allocation.maxAllocations+modelCalls.reduce((sum,call)=>sum+commonModelCallEnvelope(call),0);
 return Number.isSafeInteger(total)&&total<=limitMicrousd;
}
