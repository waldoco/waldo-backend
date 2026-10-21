import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateCapturedTrial, evaluateDiagnosticPacket, type CapturedTrial } from '../evals/trial-result';
import { sealCaptureReceipt, type ReceiptKeys } from '../evals/trial-provenance';
import type { IndependentReview } from '../evals/outcome-grader';
import type { ObservedTrial } from '../evals/grading-contract';
const owner = 'owner-a';
const a = (bytes: string, role: string) => ({ bytes, source: `${role}:${owner}`, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
const observed: ObservedTrial = { case_id:'W23', seed:'trial-1', fixture_manifest:a('fixture','runner'), transcript:a('answer','runner'), tool_trace:a('model tool','runner'), authority_timeline:a('grant','runner'), source_revisions:a('revision','source_adapter'), intercepted_effects:a('none','effect_interceptor'), final_state_readback:a('state','provider_readback') };
const keys: ReceiptKeys = { runner:'runner-key', source_adapter:'source-key', effect_interceptor:'effect-key', provider_readback:'readback-key' };
const roles = { fixture_manifest:'runner', transcript:'runner', tool_trace:'runner', authority_timeline:'runner', source_revisions:'source_adapter', intercepted_effects:'effect_interceptor', final_state_readback:'provider_readback' } as const;
const capture: CapturedTrial = { observed, isolation:{owners:[owner,'owner-b'],candidate_owner:owner},
  receipts:Object.entries(roles).map(([field,role]) => sealCaptureReceipt(observed,owner,field as keyof typeof roles,role,keys[role])),
  actual_model_calls:1, scripted_model:false, observed_cost_usd:0.02,
  runner_usage:[{response_id:'res-1',model:'fixture-model',input_tokens:100,output_tokens:20,cached_tokens:0,billed_usd:0.02}],
  provider_usage:[{response_id:'res-1',model:'fixture-model',input_tokens:100,output_tokens:20,cached_tokens:0,billed_usd:0.02}] };
describe('native trial status truth', () => {
  it.each(['W01','W20','W22','W24'])('threads trial-bound branch evidence through preparation and independent grading for %s', case_id => {
    const trial = { ...observed, case_id };
    const c: CapturedTrial = { ...capture, observed: trial, receipts: Object.entries(roles).map(([field,role]) => sealCaptureReceipt(trial,owner,field as keyof typeof roles,role,keys[role])) };
    expect(evaluateDiagnosticPacket(case_id,c,keys).status).toBe('blocked_fixture');
    const branch = { case_id, trial_seed: trial.seed, artifact: a('evaluator branch fixture decision','fixture_adjudicator') };
    const adjudicated = { ...c, branch_adjudications: [branch] };
    expect(evaluateDiagnosticPacket(case_id,adjudicated,keys).status).toBe('review_pending');
    for (const changed of [{ ...branch, case_id:'W23' }, { ...branch, trial_seed:'other-seed' }])
      expect(evaluateDiagnosticPacket(case_id,{...c,branch_adjudications:[changed]},keys).status).toBe('harness_error');
    expect(evaluateDiagnosticPacket(case_id,{...c,branch_adjudications:[branch,branch]},keys).status).toBe('harness_error');
    expect(evaluateDiagnosticPacket(case_id,{...c,branch_adjudications:[{...branch,artifact:{...branch.artifact,digest:'sha256:wrong'}}]},keys).status).toBe('blocked_fixture');
    const findings: IndependentReview['findings'] = ['useful_outcome','source_evidence','authority','forbidden_effects','final_state'].map(criterion => ({criterion:criterion as IndependentReview['findings'][number]['criterion'],status:'met',artifact:'transcript',excerpt:'answer',explanation:'synthetic cited review only'}));
    const data = {case_id,trial_seed:trial.seed,reviewer:'independent-fixture-reviewer',findings};
    const review: IndependentReview = {...data,review_record:a(JSON.stringify(data),'reviewer')};
    expect(evaluateDiagnosticPacket(case_id,adjudicated,keys,review).status).toBe('candidate_pass_unverified');
    expect(evaluateDiagnosticPacket(case_id,c,keys,review).status).toBe('blocked_fixture');
  });

  it('distinguishes no run, scripted smoke, missing receipts and independent review', () => {
    expect(evaluateDiagnosticPacket('W23',null,keys).status).toBe('not_run');
    expect(evaluateDiagnosticPacket('W23',{...capture,scripted_model:true},keys).status).toBe('harness_error');
    expect(evaluateDiagnosticPacket('W23',{...capture,actual_model_calls:0},keys).status).toBe('harness_error');
    expect(evaluateDiagnosticPacket('W23',{...capture,receipts:capture.receipts.slice(1)},keys).status).toBe('harness_error');
    expect(evaluateDiagnosticPacket('W23',capture,keys).status).toBe('review_pending');
    expect(evaluateDiagnosticPacket('W23',{...capture,provider_usage:[]},keys).status).toBe('harness_error');
    expect(evaluateDiagnosticPacket('W23',{...capture,observed_cost_usd:0.03},keys).status).toBe('harness_error');
  });
  it('keeps R33 blocked even when cost and model receipt are present', () => {
    const r33 = { ...observed, case_id:'R33' };
    expect(evaluateDiagnosticPacket('R33',{...capture,observed:r33,receipts:Object.entries(roles).map(([field,role]) => sealCaptureReceipt(r33,owner,field as keyof typeof roles,role,keys[role]))},keys).status).toBe('blocked_fixture');
  });
});

it('native entry rejects literal fixture packets rather than promoting diagnostic review to a native result',()=>{
 expect(evaluateDiagnosticPacket('W23',capture,keys).status).toBe('review_pending');
 expect(evaluateCapturedTrial('W23',capture,keys).status).toBe('blocked_fixture');
 expect(evaluateCapturedTrial('W23',null,keys).status).toBe('not_run');
});
import {loadNativeSuite} from '../evals/waldo-native-suite';
import type {NativeManifest} from '../evals/native-manifest';
const nativeCapture=():CapturedTrial=>{
 const spec=loadNativeSuite().find(s=>s.id==='W23')!;
 const sources={calendar:[{owner_id:owner,id:'calendar-fixture'}],priorities:[{owner_id:owner,id:'priority-fixture'}]};
 const manifest:NativeManifest={case_id:'W23',candidate_owner:owner,control_owner:'owner-b',visible_prompt:spec.user_prompt,world:{clock:spec.fixture.now,owners:[{id:owner},{id:'owner-b'}],sources},grants:[{owner_id:owner,purpose:'synthetic read',scope:'read only',allowed_effects:[],effective_at:'2026-10-01T00:00:00+05:30',expires_at:'2026-11-01T00:00:00+05:30'}],branches:[],supported_tools:['query_calendar'],source_digest:`sha256:${createHash('sha256').update(JSON.stringify(sources)).digest('hex')}`};
 const trial={...observed,fixture_manifest:a(JSON.stringify(manifest),'runner'),intercepted_effects:a(JSON.stringify({fixture_only:true,owner_id:owner,data:[]}),'effect_interceptor'),final_state_readback:a(JSON.stringify({fixture_only:true,owner_id:owner,data:{calendar:[],world_evidence:{candidate_effects:[],control_effects:[],candidate_calendar:[],control_calendar:[]}}}),'provider_readback')};
 return {...capture,observed:trial,world_evidence:{candidate_effects:[],control_effects:[],candidate_calendar:[],control_calendar:[]},receipts:Object.entries(roles).map(([field,role])=>sealCaptureReceipt(trial,owner,field as keyof typeof roles,role,keys[role]))};
};
it('native entry permits ready read-only fixture without effect branches, but rejects foreign/incomplete/audit-failed captures',()=>{
 const c=nativeCapture();expect(evaluateCapturedTrial('W23',c,keys).status).toBe('review_pending');
 expect(evaluateCapturedTrial('W23',{...c,world_evidence:undefined},keys).status).toBe('blocked_fixture');
 expect(evaluateCapturedTrial('W23',{...c,isolation:{owners:['other','owner-b'],candidate_owner:'other'}},keys).status).toBe('harness_error');
 expect(evaluateCapturedTrial('W23',{...c,world_evidence:{...c.world_evidence!,control_calendar:[{owner_id:'owner-b',id:'unexpected'}]}},keys).status).toBe('harness_error');
 expect(evaluateCapturedTrial('W23',{...c,world_evidence:{...c.world_evidence!,candidate_calendar:[{owner_id:owner,id:'fabricated'}]}},keys).reasons).toContain('world evidence differs from sealed adapter capture');
 const manifest=JSON.parse(c.observed.fixture_manifest.bytes) as NativeManifest;const trial={...c.observed,fixture_manifest:a(JSON.stringify({...manifest,world:{...manifest.world,sources:{}}}),'runner')};
 expect(evaluateCapturedTrial('W23',{...c,observed:trial},keys).status).toBe('blocked_fixture');
});
it('sealed failed world audit and unavailable required branch inputs block native results',()=>{
 const c=nativeCapture();const evidence={...c.world_evidence!,control_calendar:[{owner_id:'owner-b',id:'unexpected'}]};
 const trial={...c.observed,final_state_readback:a(JSON.stringify({fixture_only:true,owner_id:owner,data:{calendar:[],world_evidence:evidence}}),'provider_readback')};
 const receipts=Object.entries(roles).map(([field,role])=>sealCaptureReceipt(trial,owner,field as keyof typeof roles,role,keys[role]));
 expect(evaluateCapturedTrial('W23',{...c,observed:trial,receipts,world_evidence:evidence},keys).reasons).toContain('control owner changed');
 const spec=loadNativeSuite().find(s=>s.id==='W01')!;const manifest=JSON.parse(c.observed.fixture_manifest.bytes) as NativeManifest;
 const branchless={...c.observed,case_id:'W01',fixture_manifest:a(JSON.stringify({...manifest,case_id:'W01',visible_prompt:spec.user_prompt,world:{...manifest.world,clock:spec.fixture.now}}),'runner')};
 expect(evaluateCapturedTrial('W01',{...c,observed:branchless},keys).reasons).toContain('typed owner branch under current grant');
});
