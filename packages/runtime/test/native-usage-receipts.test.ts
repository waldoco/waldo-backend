import { expect, it } from 'vitest';
import { reconcileTrialUsage, parseResponseUsage, estimateTrialUsage } from '../evals/usage-reconciliation';
const response={id:'resp-one',model:'model-a',usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:10}}};
it('collects actual response usage without pretending to capture billed charges',()=>{
 const captured=parseResponseUsage(response);
 expect(captured).toEqual({response_id:'resp-one',model:'model-a',input_tokens:100,output_tokens:20,cached_tokens:10});
 expect(reconcileTrialUsage([captured],[captured],null)).toMatchObject({status:'consistent_unverified',total_usd:null,billing_status:'unreconciled'});
});
it('rejects malformed, missing, duplicate or changed response receipts',()=>{
 expect(()=>parseResponseUsage({...response,usage:{input_tokens:1,output_tokens:2,input_tokens_details:{cached_tokens:2}}})).toThrow();
 expect(()=>parseResponseUsage({...response,id:''})).toThrow();
 const u=parseResponseUsage(response);
 expect(reconcileTrialUsage([u],[{...u,output_tokens:21}],null).status).toBe('harness_error');
 expect(reconcileTrialUsage([u,u],[u,u],null).status).toBe('harness_error');
});
it('prices only from a pinned estimate table, keeps estimate separate from billing',()=>{
 const u=parseResponseUsage(response);
 const tariff={version:'fixture-v1',input_per_million:2,cached_per_million:1,output_per_million:4,model:'model-a'};
 expect(estimateTrialUsage([u],tariff)).toEqual({kind:'estimate_not_bill',tariff_version:'fixture-v1',total_usd:0.00027});
 expect(()=>estimateTrialUsage([{...u,model:'wrong'}],tariff)).toThrow();
 expect(()=>estimateTrialUsage([u],{...tariff,input_per_million:-1})).toThrow();
});
