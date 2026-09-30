// Actual model, synthetic selected sources, real webhook/DO path. Unsupported
// adapters are blocked by config before key access. No benchmark score emitted.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach,it,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { IsolatedSourceWorld } from '../scenarios/isolated-source-world';
import {nativeSelectedSource} from '../scenarios/native-selected-source';
import { isolatedGoogleClient } from '../scenarios/isolated-google-client';
import { settleSmokeOwner } from '../scenarios/smoke-settle';
import { nativeModelBoundary } from '../evals/native-model-boundary';
import { captureFixtureAdapters } from '../evals/fixture-adapter-capture';
import { assembleIsolatedCapture } from '../evals/isolated-capture';
import { sealCaptureReceipt,type ReceiptKeys } from '../evals/trial-provenance';
import type { NativeCaseBundleV1 } from '../evals/native-case-bundle';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import type { OwnerDirectory } from '../src/identity/owner-directory';
import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import {parseResponseUsage,type UsageLine} from '../evals/usage-reconciliation';
const sdkUsage:UsageLine[]=[];
vi.mock('openai',async(load)=>{
 const original=await load<typeof import('openai')>();
 return {...original,default:class extends original.default{
  constructor(...args:ConstructorParameters<typeof original.default>){super(...args);
   const create=this.responses.create.bind(this.responses);
   this.responses.create=((...call:Parameters<typeof create>)=>{const work=create(...call);return work.then(response=>{sdkUsage.push(parseResponseUsage(response));return response;});}) as typeof this.responses.create;
  }
 }};
});
let world:IsolatedSourceWorld|null=null;
let bundle:NativeCaseBundleV1|null=null;
const sends:{method:string;body:Record<string,unknown>}[]=[];
vi.mock('../src/seams/deps',async(load)=>{const original=await load<typeof import('../src/seams/deps')>();return {...original,productionDeps:()=>({...original.productionDeps(),now:()=>{if(!world)throw new Error('native world missing');return Date.parse(world.now());}})};});
vi.mock('../src/connectors/google',async(load)=>{const original=await load<typeof import('../src/connectors/google')>();return {...original,googleClient:(_app:unknown,tokens:{email?:string})=>{
 if(!world||!bundle||tokens.email!==bundle.manifest.candidate_owner)throw new Error('native owner source denied');
 const w=world,b=bundle;
 const restricted=nativeSelectedSource(w,tokens.email,b.selected_source_ids);
 return isolatedGoogleClient(restricted,tokens.email);
 }};});
vi.mock('../src/channels/telegram-api',async(load)=>{const original=await load<typeof import('../src/channels/telegram-api')>();return {...original,createTelegramCaller:()=>async(method:string,body:object)=>{sends.push({method,body:body as Record<string,unknown>});return method==='getMe'?{username:'fixture_bot'}:method==='sendMessage'?{message_id:sends.length}:true;}};});
const {handleTelegramWebhook}=await import('../src/channels/telegram-webhook');
afterEach(()=>{world=null;bundle=null;vi.unstubAllGlobals();});
it('captures each admitted actual-model owner turn, adapter custody and usage without official score',async()=>{
 const runtime=env as typeof env & {WALDO_NATIVE_BUNDLES:string;WALDO_NATIVE_MODEL:string;WALDO_NATIVE_SCRIPTED?:string};
 const inputs=JSON.parse(runtime.WALDO_NATIVE_BUNDLES) as {bundle:NativeCaseBundleV1;digest:string}[];
 if(runtime.WALDO_NATIVE_MODEL!==WALDO_CHAT_MODEL)throw new Error('native model pin differs');
 for(const input of inputs){
  bundle=input.bundle;world=new IsolatedSourceWorld(bundle.manifest.world);sends.length=0;sdkUsage.length=0;
  const manifest=bundle.manifest,seed=crypto.randomUUID();
  const scripted=runtime.WALDO_NATIVE_SCRIPTED==='diagnostic_only';
  let fakeSequence=0;
  const network=scripted?((async(_input:RequestInfo|URL,init?:RequestInit)=>{
   const request=JSON.parse(String(init?.body)) as {text?:{format?:{name?:string}}};
   const text=request.text?.format?.name==='claim_ops'?'{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}':'Scripted supervisor diagnostic reply, not native outcome.';
   return new Response(JSON.stringify({id:`scripted-response-${++fakeSequence}`,model:WALDO_CHAT_MODEL,output_text:text,output:[{type:'message',role:'assistant',content:[{type:'output_text',text,annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,input_tokens_details:{cached_tokens:0}}}),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch):globalThis.fetch.bind(globalThis);
  const transport=nativeModelBoundary(network,{max_attempts:24,timeout_ms:30000,model:WALDO_CHAT_MODEL});
  vi.stubGlobal('fetch',transport.fetch);
  const subject=81201;const doName=`native-${seed}`;
  const directory:OwnerDirectory={byPresence:async(provider,id)=>provider==='telegram'&&id===String(subject)?{doName,subject:String(subject),timezone: 'Asia/Kolkata'}:null,redeem:async()=>null};
  const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(doName)) as DurableObjectStub<TelegramOwnerDO>;
  await runInDurableObject(stub,async(_instance,state)=>{await state.storage.put('google:accounts',[{id:`local:${manifest.candidate_owner}`,email:manifest.candidate_owner,scopes:null,refresh_token:'fictional-not-a-token'}]);});
  const transcript:{id:string;at:string;owner_text:string;channel_sends:unknown}[]=[];
  for(const [index,turn] of bundle.turns.entries()){
   if(turn.kind!=='owner_text'||!turn.text)throw new Error('blocked native supervisor turn');world.advance(turn.at);
   const previous=sends.length;const pending:Promise<unknown>[]=[];
   const response=await handleTelegramWebhook(new Request('https://fixture.invalid/telegram/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'fictional-native-secret'},body:JSON.stringify({update_id:index+1,message:{message_id:index+1,from:{id:subject,is_bot:false},chat:{id:subject,type:'private'},text:turn.text}})}),env,work=>pending.push(work),directory);
   await Promise.all(pending);await runInDurableObject(stub,async(instance)=>settleSmokeOwner(instance as unknown as {queue:Promise<unknown>},transport));
   if(response.status!==200)throw new Error('native ingress rejected');
   transcript.push({id:turn.id,at:turn.at,owner_text:turn.text,channel_sends:sends.slice(previous)});
  }
  const traces=await runInDurableObject(stub,async(_instance,state)=>state.storage.sql.exec('SELECT at, trace, hop, ok, model, input_tokens, output_tokens, cached_tokens, usd FROM trace_log ORDER BY id').toArray());
  const keys:ReceiptKeys={runner:crypto.randomUUID(),source_adapter:crypto.randomUUID(),effect_interceptor:crypto.randomUUID(),provider_readback:crypto.randomUUID()};
  const identity={case_id:manifest.case_id,seed,candidate_owner:manifest.candidate_owner,control_owner:manifest.control_owner};
  const adapters=captureFixtureAdapters(world,identity,keys);
  const source=(bytes:string)=>({owner_id:manifest.candidate_owner,role:'runner' as const,bytes});
  const observed=assembleIsolatedCapture({case_id:identity.case_id,seed,owners:[manifest.candidate_owner,manifest.control_owner],candidate_owner:manifest.candidate_owner,
   fixture_manifest:source(JSON.stringify(manifest)),transcript:source(JSON.stringify(transcript)),tool_trace:source(JSON.stringify({traces,model_attempts:transport.receipts()})),authority_timeline:source(JSON.stringify({grants:manifest.grants,branches:manifest.branches,turns:bundle.turns})),
   source_revisions:{owner_id:manifest.candidate_owner,role:'source_adapter',bytes:adapters.artifacts.source_revisions.bytes},intercepted_effects:{owner_id:manifest.candidate_owner,role:'effect_interceptor',bytes:adapters.artifacts.intercepted_effects.bytes},final_state_readback:{owner_id:manifest.candidate_owner,role:'provider_readback',bytes:adapters.artifacts.final_state_readback.bytes}});
  const receipts=[...adapters.receipts,...(['fixture_manifest','transcript','tool_trace','authority_timeline'] as const).map(field=>sealCaptureReceipt(observed,manifest.candidate_owner,field,'runner',keys.runner))];
  const attempts=transport.receipts();const usage=attempts.flatMap(a=>a.usage?[a.usage]:[]);
  // SDK return usage and raw transport response capture are separate token observations,
  // not independent provider billing. Trace aggregates are retained for external review.
  const capture={observed,isolation:{owners:[manifest.candidate_owner,manifest.control_owner] as readonly [string,string],candidate_owner:manifest.candidate_owner},receipts,world_evidence:JSON.parse(adapters.artifacts.final_state_readback.bytes).data.world_evidence,actual_model_calls:attempts.length,scripted_model:scripted,observed_cost_usd:null,runner_usage:[...sdkUsage],provider_usage:usage};
  // Native suite filesystem/grading belongs in Node supervisor, not workerd.
  const result={status:scripted?'scripted_diagnostic':'captured_ungraded',native_score:null};
  console.log('WALDO_NATIVE_CAPTURE '+JSON.stringify({kind:scripted?'scripted-supervisor-diagnostic':'actual-model-synthetic-native-capture',native_score:null,bundle_digest:input.digest,case_id:identity.case_id,seed,result,capture,receipt_key_digests:Object.fromEntries(Object.entries(keys).map(([role,key])=>[role,createHash('sha256').update(key).digest('hex')]))}));
  vi.unstubAllGlobals();
  if(attempts.length===0||usage.length!==sdkUsage.length||attempts.some(a=>a.outcome!=='captured'))throw new Error('native capture transport incomplete, stop chunk before further spend');
 }
});
