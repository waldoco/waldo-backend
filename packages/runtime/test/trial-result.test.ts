import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateCapturedTrial, type CapturedTrial } from '../evals/trial-result';
import { sealCaptureReceipt, type ReceiptKeys } from '../evals/trial-provenance';
import type { ObservedTrial } from '../evals/grading-contract';
const owner = 'owner-a';
const a = (bytes: string, role: string) => ({ bytes, source: `${role}:${owner}`, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
const observed: ObservedTrial = { case_id:'W23', seed:'trial-1', fixture_manifest:a('fixture','runner'), transcript:a('answer','runner'), tool_trace:a('model tool','runner'), authority_timeline:a('grant','runner'), source_revisions:a('revision','source_adapter'), intercepted_effects:a('none','effect_interceptor'), final_state_readback:a('state','provider_readback') };
const keys: ReceiptKeys = { runner:'runner-key', source_adapter:'source-key', effect_interceptor:'effect-key', provider_readback:'readback-key' };
const roles = { fixture_manifest:'runner', transcript:'runner', tool_trace:'runner', authority_timeline:'runner', source_revisions:'source_adapter', intercepted_effects:'effect_interceptor', final_state_readback:'provider_readback' } as const;
const capture: CapturedTrial = { observed, isolation:{owners:[owner,'owner-b'],candidate_owner:owner},
  receipts:Object.entries(roles).map(([field,role]) => sealCaptureReceipt(observed,owner,field as keyof typeof roles,role,keys[role])),
  actual_model_calls:1, scripted_model:false, observed_cost_usd:0.02 };
describe('native trial status truth', () => {
  it('distinguishes no run, scripted smoke, missing receipts and independent review', () => {
    expect(evaluateCapturedTrial('W23',null,keys).status).toBe('not_run');
    expect(evaluateCapturedTrial('W23',{...capture,scripted_model:true},keys).status).toBe('harness_error');
    expect(evaluateCapturedTrial('W23',{...capture,actual_model_calls:0},keys).status).toBe('harness_error');
    expect(evaluateCapturedTrial('W23',{...capture,receipts:capture.receipts.slice(1)},keys).status).toBe('harness_error');
    expect(evaluateCapturedTrial('W23',capture,keys).status).toBe('review_pending');
  });
  it('keeps R33 blocked even when cost and model receipt are present', () => {
    const r33 = { ...observed, case_id:'R33' };
    expect(evaluateCapturedTrial('R33',{...capture,observed:r33,receipts:Object.entries(roles).map(([field,role]) => sealCaptureReceipt(r33,owner,field as keyof typeof roles,role,keys[role]))},keys).status).toBe('blocked_fixture');
  });
});
