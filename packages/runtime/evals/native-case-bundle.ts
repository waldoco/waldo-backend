// Supervisor parser for the reviewed fixture handoff. Never admits evaluator facts
// or hidden sources to the candidate prompt. No credential read occurs here.
import { createHash } from 'node:crypto';
import { inspectNativeManifest, type NativeManifest } from './native-manifest';
import { loadNativeSuite, WALDO_NATIVE_SUITE_SHA256 } from './waldo-native-suite';
import { NATIVE_BASELINE_HEAD, type NativeFixtureInput } from './native-runner';
export type NativeCaseBundleV1=Readonly<{
 version:1;suite_digest:string;baseline_head:string;revision:string;manifest:NativeManifest;
 selected_source_ids:Readonly<Record<string,readonly string[]>>;
 decisions:readonly {id:string;missing_spec_field:string;synthetic_value:unknown;rationale:string}[];
 turns:readonly {id:string;at:string;kind:'owner_text'|'provider_event'|'disconnect'|'reconnect'|'revoke';text?:string;payload?:unknown;source_decision_id?:string}[];
 required_source_families:readonly string[];required_effect_kinds:readonly string[];
 readiness:{sources_complete:boolean;branches_complete:boolean;provider_readback_complete:boolean;missing:readonly string[]};
}>;
export const parseNativeCaseBundle=(bytes:string):Readonly<{bundle:NativeCaseBundleV1;digest:string}>=>{
 const bundle=JSON.parse(bytes) as NativeCaseBundleV1;
 if(!bundle||bundle.version!==1||bundle.suite_digest!==WALDO_NATIVE_SUITE_SHA256||bundle.baseline_head!==NATIVE_BASELINE_HEAD||typeof bundle.revision!=='string'||!bundle.revision.trim())throw new Error('native bundle version/pin missing');
 const manifest=bundle.manifest;
 const spec=loadNativeSuite().find(s=>s.id===manifest?.case_id);
 if(!spec)throw new Error('native bundle case missing');
 const check=inspectNativeManifest(manifest);if(check.status!=='ready_for_isolated_trial')throw new Error(`native bundle blocked: ${check.missing.join(';')}`);
 const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(s=>typeof s==='string'&&Boolean(s.trim()))&&new Set(v).size===v.length;
 if(!strings(bundle.required_source_families)||!strings(bundle.required_effect_kinds)||!bundle.required_source_families.length)throw new Error('native adapter requirements missing');
 if(!bundle.readiness||bundle.readiness.sources_complete!==true||bundle.readiness.branches_complete!==true||bundle.readiness.provider_readback_complete!==true||!Array.isArray(bundle.readiness.missing)||bundle.readiness.missing.length)throw new Error('native bundle completeness unavailable');
 if(!bundle.selected_source_ids||typeof bundle.selected_source_ids!=='object'||Array.isArray(bundle.selected_source_ids))throw new Error('native selected source scope missing');
 for(const family of bundle.required_source_families){
  const selected=bundle.selected_source_ids[family];const rows=manifest.world.sources[family];
  if(!strings(selected)||!selected.length||!Array.isArray(rows)||selected.some(id=>!rows.some(r=>r.owner_id===manifest.candidate_owner&&r.id===id)))throw new Error('native selected source row unavailable');
 }
 for(const family of Object.keys(bundle.selected_source_ids))if(!bundle.required_source_families.includes(family))throw new Error('undeclared native selected source family');
 if(!Array.isArray(bundle.decisions)||bundle.decisions.some(d=>!d.id?.trim()||!d.missing_spec_field?.trim()||!d.rationale?.trim())||new Set(bundle.decisions.map(d=>d.id)).size!==bundle.decisions.length)throw new Error('native fixture decisions malformed');
 if(!Array.isArray(bundle.turns)||!bundle.turns.length||bundle.turns[0]?.kind!=='owner_text'||bundle.turns[0]?.text!==spec.user_prompt||bundle.turns[0]?.at!==manifest.world.clock||new Set(bundle.turns.map(t=>t.id)).size!==bundle.turns.length)throw new Error('native initial turn differs from pinned prompt/clock');
 let at=Date.parse(manifest.world.clock);
 for(const turn of bundle.turns){
  if(!turn.id?.trim()||!['owner_text','provider_event','disconnect','reconnect','revoke'].includes(turn.kind)||!Number.isFinite(Date.parse(turn.at))||Date.parse(turn.at)<at||
    (turn.kind==='owner_text'&&(typeof turn.text!=='string'||!turn.text.trim()))||
    (turn.source_decision_id!==undefined&&!bundle.decisions.some(d=>d.id===turn.source_decision_id)))throw new Error('native turn identity/time/decision invalid');
  at=Date.parse(turn.at);
 }
 return {bundle,digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`};
};
export const fixtureInputFromBundle=(bundle:NativeCaseBundleV1,support:Readonly<{sources:readonly string[];effects:readonly string[]}>) : NativeFixtureInput=>{
 if(bundle.required_source_families.some(f=>!support.sources.includes(f))||bundle.required_effect_kinds.some(e=>!support.effects.includes(e)))throw new Error('native adapter capability unavailable');
 return {manifest:structuredClone(bundle.manifest),revision:bundle.revision,supported_source_families:support.sources,supported_effects:support.effects,readiness:bundle.readiness};
};
