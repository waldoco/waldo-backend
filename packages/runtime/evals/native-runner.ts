// Supervisor-only chunk planning and execution. No model key is read until every
// selected fixture and adapter contract is ready. Specifications are not fixtures.
import { inspectNativeManifest, type NativeManifest } from './native-manifest';
import { loadNativeSuite, WALDO_NATIVE_SUITE_SHA256 } from './waldo-native-suite';
import type { CapturedTrial, TrialResult } from './trial-result';
import { evaluateCapturedTrial } from './trial-result';
import type { ReceiptKeys } from './trial-provenance';
import type { IndependentReview } from './outcome-grader';
export const NATIVE_BASELINE_HEAD='8eae4bd1d1c8a3a3338a8c689f20ea2b1bd5077e';
export type NativeFixtureInput=Readonly<{
 manifest:NativeManifest;
 // Authored fixture/adapter revision, never a model assertion of support.
 revision:string;
 supported_source_families:readonly string[];
 supported_effects:readonly string[];
 readiness:Readonly<{sources_complete:boolean;branches_complete:boolean;provider_readback_complete:boolean}>;
}>;
export type NativeChunk=Readonly<{head:string;suite_digest:string;case_ids:readonly string[];fixtures:readonly NativeFixtureInput[]}>;
export type NativeChunkCheck=Readonly<{status:'ready'|'blocked_fixture';missing:readonly string[]}>;
export const inspectNativeChunk=(chunk:NativeChunk):NativeChunkCheck=>{
 const missing:string[]=[]; const ids=new Set(loadNativeSuite().map(s=>s.id));
 if(chunk.head!==NATIVE_BASELINE_HEAD)missing.push('baseline HEAD differs from pinned revision');
 if(chunk.suite_digest!==WALDO_NATIVE_SUITE_SHA256)missing.push('suite digest differs from pinned bytes');
 if(!chunk.case_ids.length||chunk.case_ids.length>6||new Set(chunk.case_ids).size!==chunk.case_ids.length||chunk.case_ids.some(id=>!ids.has(id)))missing.push('chunk must select 1-6 distinct native cases');
 if(chunk.fixtures.length!==chunk.case_ids.length||new Set(chunk.fixtures.map(f=>f.manifest.case_id)).size!==chunk.fixtures.length||chunk.fixtures.some(f=>!chunk.case_ids.includes(f.manifest.case_id)))missing.push('fixture set differs from chunk case set');
 for(const id of chunk.case_ids){
  const f=chunk.fixtures.find(f=>f.manifest.case_id===id);
  if(!f){missing.push(`${id}: typed fixture missing`);continue;}
  if(!f.revision.trim()||!f.readiness.sources_complete||!f.readiness.branches_complete||!f.readiness.provider_readback_complete)missing.push(`${id}: fixture completeness unconfirmed`);
  const sources=Object.keys(f.manifest.world.sources);
  if(sources.some(s=>!f.supported_source_families.includes(s)))missing.push(`${id}: source adapter missing`);
  const effects=new Set(f.manifest.grants.flatMap(g=>g.allowed_effects));
  if([...effects].some(e=>!f.supported_effects.includes(e)))missing.push(`${id}: effect readback adapter missing`);
  try{const check=inspectNativeManifest(f.manifest);missing.push(...check.missing.map(m=>`${id}: ${m}`));}
  catch{missing.push(`${id}: malformed typed fixture`);}
 }
 return {status:missing.length?'blocked_fixture':'ready',missing};
};
export type NativeExecutor=Readonly<{
 // Implemented by isolated DO supervisor, not model tools. Secret never serialized.
 acquireKey:()=>Promise<string>;
 execute:(fixture:NativeFixtureInput,key:string)=>Promise<Readonly<{capture:CapturedTrial;keys:ReceiptKeys}>>;
 review:(capture:CapturedTrial)=>Promise<IndependentReview|null>;
}>;
export type NativeChunkResult=Readonly<{kind:'fixture_conformance_native_chunk';native_score:null;status:'blocked_fixture'|'captured';missing:readonly string[];results:readonly TrialResult[]}>;
export const runNativeChunk=async(chunk:NativeChunk,executor:NativeExecutor):Promise<NativeChunkResult>=>{
 chunk=structuredClone(chunk);
 const check=inspectNativeChunk(chunk);
 if(check.status!=='ready')return {kind:'fixture_conformance_native_chunk',native_score:null,status:'blocked_fixture',missing:check.missing,results:[]};
 const key=await executor.acquireKey();
 if(!key.trim())throw new Error('supervisor model credential missing');
 const results:TrialResult[]=[];
 for(const id of chunk.case_ids){
  const fixture=chunk.fixtures.find(f=>f.manifest.case_id===id)!;
  try{
   const {capture,keys}=await executor.execute(structuredClone(fixture),key);
   const initial=evaluateCapturedTrial(id,capture,keys);
   // Invalid custody/readiness must not be sent to an independent grader as a run.
   const reviewed=initial.status==='review_pending'?await executor.review(capture):null;
   results.push(reviewed?evaluateCapturedTrial(id,capture,keys,reviewed):initial);
  }catch{
   // Do not put thrown provider messages or credentials into receipts.
   results.push({case_id:id,seed:null,status:'harness_error',reasons:['isolated supervisor execution failed; inspect restricted diagnostics'],total_usd:null});
   break; // A failed external attempt cannot silently trigger more spend.
  }
 }
 return {kind:'fixture_conformance_native_chunk',native_score:null,status:'captured',missing:[],results};
};
