import { describe, expect, it } from 'vitest';
import { reconcileTrialUsage, type UsageLine } from '../evals/usage-reconciliation';
const first: UsageLine = { response_id:'res-1',model:'model-a',input_tokens:100,output_tokens:20,cached_tokens:10,billed_usd:0.001 };
const second: UsageLine = { response_id:'res-2',model:'model-a',input_tokens:200,output_tokens:40,cached_tokens:0,billed_usd:0.002 };
describe('trial usage consistency, not provider authentication', () => {
  it('matches full response IDs, token counts and billed cost regardless of order', () => {
    expect(reconcileTrialUsage([first,second],[second,first],0.003)).toEqual({status:'consistent_unverified',errors:[],total_usd:0.003});
  });
  it('fails on absent, duplicate, changed or impossible provider usage and cost drift', () => {
    expect(reconcileTrialUsage([first],[],0.001).errors).toContain('missing model usage');
    expect(reconcileTrialUsage([first,first],[first,first],0.002).errors).toContain('duplicate response id');
    expect(reconcileTrialUsage([first],[{...first,output_tokens:21}],0.001).errors).toContain('provider response usage mismatch');
    expect(reconcileTrialUsage([first],[{...first,cached_tokens:101}],0.001).errors).toContain('invalid usage line');
    expect(reconcileTrialUsage([first,second],[{...first,billed_usd:0.002},{...second,billed_usd:0.001}],0.003).errors).toContain('provider response usage mismatch');
    expect(reconcileTrialUsage([first],[first],0.002).errors).toContain('provider cost mismatch');
    expect(reconcileTrialUsage([first],[second],0.001).status).toBe('harness_error');
  });
});
