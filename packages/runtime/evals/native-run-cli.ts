// Explicit Node supervisor. Parent/user approval is independently required; the
// opt-in flag is mechanical only. Never read keys before selected fixture readiness.
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseNativeCaseBundle } from './native-case-bundle';
import { inspectNativeExecutionSupport } from './native-execution-readiness';
import { evaluateCapturedTrial,type CapturedTrial } from './trial-result';
import type { ReceiptKeys } from './trial-provenance';
import { reconcileTrialUsage } from './usage-reconciliation';
const paths=process.argv.slice(2);
if(process.env.WALDO_RUN_NATIVE_TRIAL!=='reviewed'||!paths.length||paths.length>6||new Set(paths).size!==paths.length)throw new Error('native supervisor requires explicit opt-in and1-6 distinct bundle paths');
const parsed=paths.map(p=>parseNativeCaseBundle(readFileSync(p,'utf8')));
if(new Set(parsed.map(p=>p.bundle.manifest.case_id)).size!==parsed.length)throw new Error('duplicate native case');
const support={source_families:['calendar','mail','tasks'],effect_kinds:[],turn_kinds:['owner_text','provider_event'] as const,production_tools:['query_calendar','get_communication','search_communication','read_thread','get_tasks','get_context']};
for(const {bundle} of parsed){const missing=inspectNativeExecutionSupport(bundle,support);if(missing.length)throw new Error(`blocked_fixture ${bundle.manifest.case_id}: ${missing.join(';')}`);}
// Read credential only after typed inputs/adapters passed. The key is never logged,
// committed, placed in captures or saved to the output directory.
const key=process.env.WALDO_SMOKE_OPENAI_KEY;if(!key?.trim())throw new Error('supervisor model key missing');
const output=resolve(process.env.WALDO_NATIVE_OUTPUT_DIR??'/tmp/waldo-native-capture');mkdirSync(output,{recursive:true,mode:0o700});
const keys:ReceiptKeys={runner:randomBytes(32).toString('hex'),source_adapter:randomBytes(32).toString('hex'),effect_interceptor:randomBytes(32).toString('hex'),provider_readback:randomBytes(32).toString('hex')};
// Run bundle cases one at a time. Failed capture/classification stops spend before
// remaining cases, not an automatic retry or silently continued chunk.
const ledger:unknown[]=[];
for(const [index,path] of paths.entries()){
 const expected=parsed[index]!;
 const run=spawnSync('pnpm',['exec','vitest','run','--config','vitest.native-trial.config.ts'],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env,WALDO_NATIVE_BUNDLE_PATHS:resolve(path),WALDO_NATIVE_RECEIPT_KEYS:JSON.stringify(keys)},encoding:'utf8',timeout:240000,maxBuffer:16*1024*1024});
 const combined=run.stdout??'';
 // No raw failed provider output/headers written or echoed. Captures contain
 // selected synthetic sources only; child stdout remains internal scratch.
 const line=combined.split('\n').find(l=>l.includes('WALDO_NATIVE_CAPTURE '));
 if(run.status!==0||!line){ledger.push({case_id:expected.bundle.manifest.case_id,status:'harness_error',reasons:['isolated capture process failed'],native_score:null});break;}
 const item=JSON.parse(line.slice(line.indexOf('WALDO_NATIVE_CAPTURE ')+21)) as {kind:string;bundle_digest:string;case_id:string;capture:CapturedTrial;control_storage:{before:unknown;after:unknown}};
 if(item.kind!=='actual-model-synthetic-native-capture'||item.bundle_digest!==expected.digest||item.case_id!==expected.bundle.manifest.case_id||JSON.stringify(item.control_storage.before)!==JSON.stringify(item.control_storage.after))throw new Error('native capture identity/custody mismatch');
 const result=evaluateCapturedTrial(item.case_id,item.capture,keys);
 const usage=reconcileTrialUsage(item.capture.runner_usage,item.capture.provider_usage,null);
 writeFileSync(resolve(output,`${item.case_id}.json`),JSON.stringify({version:1,kind:item.kind,native_score:null,bundle_digest:item.bundle_digest,result,capture:item.capture,usage,control_storage:item.control_storage},null,2),{mode:0o600});
 ledger.push(result);
 if(result.status!=='review_pending')break;
}
writeFileSync(resolve(output,'ledger.json'),JSON.stringify({kind:'synthetic_native_chunk_capture',native_score:null,results:ledger},null,2),{mode:0o600});
// Verifier keys remain only in this supervisor's memory; review_pending captures
// must be independently reviewed during this run before closing verified custody.
console.log(JSON.stringify({kind:'native_supervisor_capture',native_score:null,results:ledger}));
