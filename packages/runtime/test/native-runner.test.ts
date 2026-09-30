import { expect, it, vi } from 'vitest';
import { inspectNativeChunk, runNativeChunk, NATIVE_BASELINE_HEAD } from '../evals/native-runner';
import { WALDO_NATIVE_SUITE_SHA256 } from '../evals/waldo-native-suite';
const chunk={head:NATIVE_BASELINE_HEAD,suite_digest:WALDO_NATIVE_SUITE_SHA256,case_ids:['W23'],fixtures:[]};
it('blocks absent native fixtures before reading a model credential or executing/grading',async()=>{
 const executor={acquireKey:vi.fn(),execute:vi.fn(),review:vi.fn()};
 const out=await runNativeChunk(chunk,executor);
 expect(out.status).toBe('blocked_fixture');expect(out.native_score).toBeNull();
 expect(out.missing).toContain('W23: typed fixture missing');
 expect(executor.acquireKey).not.toHaveBeenCalled();expect(executor.execute).not.toHaveBeenCalled();expect(executor.review).not.toHaveBeenCalled();
});
it('pins baseline and suite and rejects overlarge, duplicate, foreign or empty chunk selection',()=>{
 expect(inspectNativeChunk({...chunk,head:'new-head'}).missing).toContain('baseline HEAD differs from pinned revision');
 expect(inspectNativeChunk({...chunk,suite_digest:'forged'}).missing).toContain('suite digest differs from pinned bytes');
 for(const case_ids of [[],['W23','W23'],['foreign'],['W01','W02','W03','W04','W05','W06','W07']])expect(inspectNativeChunk({...chunk,case_ids}).missing).toContain('chunk must select 1-6 distinct native cases');
});
import { createHash } from 'node:crypto';
import { loadNativeSuite } from '../evals/waldo-native-suite';
import type { NativeFixtureInput } from '../evals/native-runner';
const fixture=():NativeFixtureInput=>{
 const spec=loadNativeSuite().find(s=>s.id==='W23')!;
 const sources={calendar:[{owner_id:'a',id:'cal'}],priorities:[{owner_id:'a',id:'priorities'}]};
 return {revision:'fixture-v1',supported_source_families:['calendar','priorities'],supported_effects:[],readiness:{sources_complete:true,branches_complete:true,provider_readback_complete:true},manifest:{case_id:'W23',candidate_owner:'a',control_owner:'b',visible_prompt:spec.user_prompt,world:{clock:spec.fixture.now,owners:[{id:'a'},{id:'b'}],sources},grants:[{owner_id:'a',purpose:'synthetic read',scope:'selectedcalendar',allowed_effects:[],effective_at:'2026-10-01T00:00:00+05:30',expires_at:'2026-11-01T00:00:00+05:30'}],branches:[],supported_tools:['query_calendar'],source_digest:`sha256:${createHash('sha256').update(JSON.stringify(sources)).digest('hex')}`}};
};
it('rejects incomplete source/effect adapter and readiness metadata even when selected manifest unit filter is green',()=>{
 const f=fixture();expect(inspectNativeChunk({...chunk,fixtures:[f]}).status).toBe('ready');
 for(const readiness of [{...f.readiness,sources_complete:false},{...f.readiness,branches_complete:false},{...f.readiness,provider_readback_complete:false}])expect(inspectNativeChunk({...chunk,fixtures:[{...f,readiness}]}).status).toBe('blocked_fixture');
 expect(inspectNativeChunk({...chunk,fixtures:[{...f,supported_source_families:[]}]}).missing).toContain('W23: source adapter missing');
 const manifest={...f.manifest,grants:[{...f.manifest.grants[0]!,allowed_effects:['mail.send']}]};
 expect(inspectNativeChunk({...chunk,fixtures:[{...f,manifest}]}).missing).toContain('W23: effect readback adapter missing');
});
it('never repeats failed model/executor attempt or exposes errors that may carry credentials',async()=>{
 const f=fixture();const acquireKey=vi.fn(async()=> 'restricted-key');
 const execute=vi.fn(async()=>{throw new Error('restricted-key');});const review=vi.fn();
 const out=await runNativeChunk({...chunk,fixtures:[f]},{acquireKey,execute,review});
 expect(execute).toHaveBeenCalledTimes(1);expect(review).not.toHaveBeenCalled();
 expect(out.results[0]?.status).toBe('harness_error');expect(JSON.stringify(out)).not.toContain('restricted-key');
});
