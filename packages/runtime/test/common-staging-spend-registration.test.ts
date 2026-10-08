import {expect,it} from 'vitest';
import {commonStagingBillingIdentity,commonAllocationEnvelope,commonModelCallEnvelope,commonRegistrationFits} from '../src/channels/common-staging-spend-registration';
// Grounded 2026-10-07 live billing read: mapped staging account, Workers Paid
// active, cycle Sep 11 - Oct 10 2026 = 30 days.
const billing=commonStagingBillingIdentity({cloudflareAccountId:'31680869a0e27d263df99818ceca94fb',billingCycleDays:30,workersPaid:true});
it('accepts only the exact grounded account identity shape',()=>{
 expect(billing).toEqual({cloudflareAccountId:'31680869a0e27d263df99818ceca94fb',billingCycleDays:30,workersPaid:true});
 for(const bad of [{cloudflareAccountId:'31680869A0E27D263DF99818CECA94FB',billingCycleDays:30,workersPaid:true},{cloudflareAccountId:'31680869a0e27d263df99818ceca94fb',billingCycleDays:30,workersPaid:false},{cloudflareAccountId:'31680869a0e27d263df99818ceca94fb',billingCycleDays:0,workersPaid:true},{cloudflareAccountId:'0'.repeat(32),billingCycleDays:367,workersPaid:true}])expect(()=>commonStagingBillingIdentity(bad)).toThrow();
});
it('one 120-second one-day browser allocation fits alongside counted model calls under the one-dollar scope',()=>{
 const allocation={reservedBrowserMs:120_000,allocationDayCount:1,maxAllocations:1};
 expect(commonAllocationEnvelope(allocation,billing)).toBe(156667);
 expect(commonModelCallEnvelope({countedInputTokens:1000,maxOutputTokens:4096})).toBe(7309);
 expect(commonRegistrationFits({identity:billing,allocation,modelCalls:[{countedInputTokens:1000,maxOutputTokens:4096},{countedInputTokens:2000,maxOutputTokens:4096},{countedInputTokens:4000,maxOutputTokens:4096}],limitMicrousd:1_000_000})).toBe(true);
 expect(commonRegistrationFits({identity:billing,allocation:{...allocation,maxAllocations:7},modelCalls:[{countedInputTokens:1000,maxOutputTokens:4096}],limitMicrousd:1_000_000})).toBe(false);
});
it('refuses day counts beyond the cycle and full-context counted input under the scope',()=>{
 expect(()=>commonAllocationEnvelope({reservedBrowserMs:120000,allocationDayCount:31,maxAllocations:1},billing)).toThrow();
 expect(commonRegistrationFits({identity:billing,allocation:{reservedBrowserMs:120000,allocationDayCount:1,maxAllocations:1},modelCalls:[{countedInputTokens:1_050_000,maxOutputTokens:4096}],limitMicrousd:1_000_000})).toBe(true);
 expect(commonRegistrationFits({identity:billing,allocation:{reservedBrowserMs:120000,allocationDayCount:1,maxAllocations:1},modelCalls:[{countedInputTokens:1_050_000,maxOutputTokens:4096},{countedInputTokens:1,maxOutputTokens:1}],limitMicrousd:584_261})).toBe(false);
 for(const bad of [{countedInputTokens:-1,maxOutputTokens:1},{countedInputTokens:1_050_001,maxOutputTokens:1},{countedInputTokens:1,maxOutputTokens:0},{countedInputTokens:1.5,maxOutputTokens:1}])expect(()=>commonModelCallEnvelope(bad)).toThrow();
});

it('model quote requires an immutable counted witness or reserves the full context window',async()=>{
 const {commonStagingModelQuote}=await import('../src/channels/common-staging-spend-registration');
 const material={request:{max_tokens:4096}};
 expect(commonStagingModelQuote(material)).toBe(584259);
 expect(commonStagingModelQuote({...material,countedInputTokens:1000})).toBe(7309);
 expect(commonStagingModelQuote({...material,countedInputTokens:0})).toBe(commonStagingModelQuote({request:{max_tokens:4096},countedInputTokens:0}));
 expect(()=>commonStagingModelQuote({...material,estimatedInputTokens:1000})).toThrow('not admitted');
 expect(()=>commonStagingModelQuote({request:{max_tokens:4096},countedInputTokens:NaN})).toThrow('count witness invalid');
 expect(()=>commonStagingModelQuote({request:{max_tokens:128001},countedInputTokens:1})).toThrow();
 expect(()=>commonStagingModelQuote({request:{max_tokens:0}})).toThrow();
 expect(()=>commonStagingModelQuote({})).toThrow('request invalid');
});
