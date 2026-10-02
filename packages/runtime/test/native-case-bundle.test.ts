import {readFileSync} from 'node:fs';
import { createHash } from 'node:crypto';
import { expect,it } from 'vitest';
import { parseNativeCaseBundle,fixtureInputFromBundle,type NativeCaseBundleV1 } from '../evals/native-case-bundle';
import { loadNativeSuite,WALDO_NATIVE_SUITE_SHA256 } from '../evals/waldo-native-suite';
import { NATIVE_BASELINE_HEAD } from '../evals/native-runner';
const bundle=():NativeCaseBundleV1=>{
 const spec=loadNativeSuite().find(s=>s.id==='W23')!;
 const sources={calendar:[{owner_id:'a',id:'cal',start:'2026-10-01T09:00:00+05:30',end:'2026-10-01T09:30:00+05:30',title:'Admin'}],priorities:[{owner_id:'a',id:'priorities',text:'Prepare board'}]};
 return {version:1,suite_digest:WALDO_NATIVE_SUITE_SHA256,baseline_head:NATIVE_BASELINE_HEAD,revision:'unit-fixture-v1',selected_source_ids:{calendar:['cal'],priorities:['priorities']},required_source_families:['calendar','priorities'],required_effect_kinds:[],decisions:[],turns:[{id:'initial',at:spec.fixture.now,kind:'owner_text',text:spec.user_prompt}],readiness:{sources_complete:true,branches_complete:true,provider_readback_complete:true,missing:[]},manifest:{case_id:'W23',candidate_owner:'a',control_owner:'b',visible_prompt:spec.user_prompt,world:{clock:spec.fixture.now,owners:[{id:'a'},{id:'b'}],sources},grants:[{owner_id:'a',purpose:'read',scope:'selected',allowed_effects:[],effective_at:'2026-10-01T00:00:00+05:30',expires_at:'2026-11-01T00:00:00+05:30'}],branches:[],supported_tools:['query_calendar'],source_digest:`sha256:${createHash('sha256').update(JSON.stringify(sources)).digest('hex')}`}};
};
it('pins typed bundle digest and admits only declared available adapter support',()=>{
 const b=bundle();const bytes=JSON.stringify(b);expect(parseNativeCaseBundle(bytes).digest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
 expect(()=>fixtureInputFromBundle(b,{sources:['calendar'],effects:[]})).toThrow('capability');
 expect(fixtureInputFromBundle(b,{sources:['calendar','priorities'],effects:[]}).manifest.visible_prompt).toBe(b.manifest.visible_prompt);
});
it('rejects prompt/pin/readiness/source/decision/time substitutions before model execution',()=>{
 const b=bundle();for(const changed of [
 {...b,baseline_head:'wrong'}, {...b,readiness:{...b.readiness,missing:['unresolved']}},
 {...b,selected_source_ids:{calendar:['foreign'],priorities:['priorities']}},
 {...b,turns:[{...b.turns[0]!,text:'ideal reference answer'}]},
 {...b,turns:[...b.turns,{id:'later',kind:'owner_text',at:'2000-01-01T00:00:00Z',text:'Yes'}]},
 {...b,decisions:[{id:'x',missing_spec_field:'',synthetic_value:'yes',rationale:'fake'}]},
 {...b,turns:[...b.turns,{id:'later',kind:'owner_text',at:b.manifest.world.clock,text:'yes',source_decision_id:'absent'}]},
 ])expect(()=>parseNativeCaseBundle(JSON.stringify(changed))).toThrow();
});
import { inspectNativeExecutionSupport } from '../evals/native-execution-readiness';
it('a declared-ready case cannot silently substitute an unimplemented source/effect/turn/product tool',()=>{
 const b=bundle();expect(inspectNativeExecutionSupport(b,{source_families:[],effect_kinds:[],turn_kinds:[],production_tools:[]})).toEqual(['unimplemented source adapter: calendar','unimplemented source adapter: priorities','unimplemented supervisor turn: owner_text','unavailable actual product tool: query_calendar']);
 expect(inspectNativeExecutionSupport(b,{source_families:b.required_source_families,effect_kinds:[],turn_kinds:['owner_text'],production_tools:b.manifest.supported_tools})).toEqual([]);
});
it('source revision support cannot admit an unbound provider event or silently timed revision',()=>{
 const b=bundle();const at='2026-10-05T03:00:00Z';const revision={at,owner_id:'a',source:'calendar',id:'cal',patch:{title:'Revised'}};
 const revised={...b,manifest:{...b.manifest,world:{...b.manifest.world,revisions:[revision]}}};
 const support={source_families:b.required_source_families,effect_kinds:[],turn_kinds:['owner_text','provider_event'] as const,production_tools:b.manifest.supported_tools};
 expect(inspectNativeExecutionSupport(revised,support)).toContain('unbound timed source revision: calendar/cal');
 const event={id:'rev',kind:'provider_event' as const,at,payload:{owner_id:'a',source:'calendar',id:'cal',patch:{title:'Revised'}}};
 expect(inspectNativeExecutionSupport({...revised,turns:[...b.turns,event]},support)).toEqual([]);
 expect(inspectNativeExecutionSupport({...revised,turns:[...b.turns,{...event,payload:{...event.payload,patch:{title:'Different'}}}]},support)).toContain('unbound source provider event: rev');
});
it('concrete supervisor admission uses the actual product handler names, not invented task aliases',()=>{
 const config=readFileSync(new URL('../vitest.native-trial.config.ts',import.meta.url),'utf8');
 const cli=readFileSync(new URL('../evals/native-run-cli.ts',import.meta.url),'utf8');
 for(const text of [config,cli]){expect(text).toContain("'get_tasks'");expect(text).toContain("'get_context'");expect(text).not.toContain("'query_tasks'");}
});
