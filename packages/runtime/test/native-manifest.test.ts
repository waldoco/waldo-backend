import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectNativeManifest, type NativeManifest } from '../evals/native-manifest';
import { loadNativeSuite } from '../evals/waldo-native-suite';
const spec = loadNativeSuite().find((row)=>row.id==='W23')!;
const sources = { calendar:[{owner_id:'a',id:'event-a',title:'A'},{owner_id:'b',id:'event-b',title:'B'}],priorities:[{owner_id:'a',id:'goal-a',text:'A'}] };
const m:NativeManifest = {case_id:'W23',candidate_owner:'a',control_owner:'b',visible_prompt:spec.user_prompt,
  world:{clock:spec.fixture.now,owners:[{id:'a'},{id:'b'}],sources},
  grants:[{owner_id:'a',purpose:'calendar planning',scope:'read only',effective_at:'2026-10-04T00:00:00+05:30',expires_at:'2026-10-06T00:00:00+05:30'}],
  branches:[],supported_tools:['query_calendar'],source_digest:`sha256:${createHash('sha256').update(JSON.stringify(sources)).digest('hex')}`};
describe('native fixture readiness, not a trial',()=>{
  it('requires typed source rows, grant and digest before opening isolated run',()=>{
    expect(inspectNativeManifest(m).status).toBe('ready_for_isolated_trial');
    expect(inspectNativeManifest({...m,world:{...m.world,sources:{calendar:sources.calendar}}}).missing).toContain('missing candidate-owner priorities rows');
    expect(inspectNativeManifest({...m,grants:[]}).missing).toContain('current typed synthetic grant');
    expect(inspectNativeManifest({...m,source_digest:'sha256:wrong'}).missing).toContain('source manifest digest mismatch');
    expect(inspectNativeManifest({...m,world:{...m.world,owners:[{id:'a'},{id:'a'}]}}).missing).toContain('duplicate fixture owner');
  });
  it('keeps R33 fixture-blocked rather than inventing tariff or research input',()=>{
    const r=loadNativeSuite().find((row)=>row.id==='R33')!;
    expect(inspectNativeManifest({...m,case_id:'R33',visible_prompt:r.user_prompt,world:{...m.world,clock:r.fixture.now}}).status).toBe('blocked_fixture');
  });
});
