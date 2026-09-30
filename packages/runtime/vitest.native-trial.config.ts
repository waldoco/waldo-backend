// Opt-in actual-model trial. Never normal CI and never a request to approve spend.
// Parse/admit every selected bundle BEFORE reading the model credential.
import { readFileSync } from 'node:fs';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { parseNativeCaseBundle } from './evals/native-case-bundle';
import { inspectNativeExecutionSupport } from './evals/native-execution-readiness';
import { validModelCredential } from './src/llm/credential-shape';
import {OPENAI_GPT_6_LUNA_MODEL as WALDO_CHAT_MODEL} from '../contracts/src/model/roster';
if(process.env.WALDO_RUN_NATIVE_TRIAL!=='reviewed')throw new Error('native trial needs explicit supervisor opt-in');
const paths=(process.env.WALDO_NATIVE_BUNDLE_PATHS??'').split(',').filter(Boolean);
if(!paths.length||paths.length>6||new Set(paths).size!==paths.length)throw new Error('native trial needs1-6 distinct bundle paths');
const bundles=paths.map(path=>parseNativeCaseBundle(readFileSync(path,'utf8')));
if(new Set(bundles.map(b=>b.bundle.manifest.case_id)).size!==bundles.length)throw new Error('native trial duplicate case');
// This initial concrete supervisor only implements read-only Google families and
// owner text and exact declared source revision turns. Other provider events and
// effect/source families remain blocked.
const support={source_families:['calendar','mail','tasks'],effect_kinds:[],turn_kinds:['owner_text','provider_event'] as const,
 production_tools:['query_calendar','get_communication','search_communication','read_thread','query_tasks']};
for(const {bundle} of bundles){const missing=inspectNativeExecutionSupport(bundle,support);if(missing.length)throw new Error(`blocked_fixture ${bundle.manifest.case_id}: ${missing.join(';')}`);}
const receiptKeys=JSON.parse(process.env.WALDO_NATIVE_RECEIPT_KEYS??'null') as Record<string,string>|null;
if(!receiptKeys||Object.keys(receiptKeys).sort().join(',')!=='effect_interceptor,provider_readback,runner,source_adapter'||Object.values(receiptKeys).some(v=>typeof v!=='string'||v.length<32)||new Set(Object.values(receiptKeys)).size!==4)throw new Error('native supervisor receipt key custody missing');
const key=process.env.WALDO_SMOKE_OPENAI_KEY;
if(!key||!validModelCredential(key))throw new Error('native trial supervisor credential missing/invalid');
export default defineConfig({test:{include:['test/owner-do-native-trial.ts'],testTimeout:180000,reporters:['default','json'],outputFile:{json:process.env.WALDO_NATIVE_REPORT_PATH??'/tmp/waldo-native-trial.json'}},plugins:[cloudflareTest({miniflare:{bindings:{
 WALDO_ENV:'test',RUN_LOOP_PROVIDER_MODE:'fake',RUN_LOOP_LOCAL_INGRESS_TOKEN:'test-run-loop-local-token-000000000000',RESPONSIBILITY_INGRESS_HMAC_SECRET:'test-responsibility-ingress-hmac-secret-000000000000',
 TELEGRAM_BOT_TOKEN:'fictional-native-bot',TELEGRAM_WEBHOOK_SECRET:'fictional-native-secret',OPENAI_API_KEY:key,GOOGLE_CLIENT_ID:'fictional-native-google',GOOGLE_CLIENT_SECRET:'fictional-native-google',
 WALDO_NATIVE_RECEIPT_KEYS:JSON.stringify(receiptKeys),WALDO_NATIVE_BUNDLES:JSON.stringify(bundles),WALDO_NATIVE_MODEL:WALDO_CHAT_MODEL,
}},wrangler:{configPath:'./wrangler.jsonc'}})]});
