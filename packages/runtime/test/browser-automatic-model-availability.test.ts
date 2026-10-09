import {expect,it,vi} from 'vitest';
import {ownerBrowserRuntime} from '../src/channels/owner-browser-runtime';
import type {RunEffectScope} from '../src/channels/run-effect-scope';
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async()=>({directoryOwnerId:'10000000-0000-0000-0000-000000000091',custodyDigest:'a'.repeat(64)})})}));
const model=vi.hoisted(()=>({calls:0}));
vi.mock('../src/llm/openai',()=>({OpenAIResponsesAdapter:class{complete=async()=>{model.calls++;return {status:'ordinary_model'};};}}));
it('an invalid automatic browser registration leaves ordinary model work available before an allocation',async()=>{
 model.calls=0;const rows=new Map<string,any>([['do_name','ordinary-owner'],['telegram_subject','81191']]),storage={kv:{get:(k:string)=>rows.get(k),put:(k:string,v:any)=>rows.set(k,v),list:({prefix}: {prefix:string})=>new Map([...rows].filter(([key])=>key.startsWith(prefix)))},transactionSync:<T>(f:()=>T)=>f()} as unknown as DurableObjectStorage;
 const scope={runId:'ordinary',attempt:'ordinary-attempt',deadline:Date.now()+60000,signal:new AbortController().signal,admit:vi.fn(),commit:<T>(f:()=>T)=>f()} as RunEffectScope;
 const runtime=ownerBrowserRuntime({env:{WALDO_ENVIRONMENT:'staging',COMMON_BROWSER_REGISTRATION:'{',OPENAI_API_KEY:'synthetic',TELEGRAM_OWNER_DO:{idFromName:()=>({toString:()=> 'fixture'})}} as never,storage,actualDoId:'fixture',activeScope:()=>scope});
 expect(await runtime.gateway()!.complete({runScope:scope,request:{model:'synthetic-unpriced-model'}} as never)).toEqual({status:'ordinary_model'});expect(model.calls).toBe(1);expect(rows.size).toBe(2);
});
