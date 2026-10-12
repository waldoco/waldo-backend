import {expect,it,vi} from 'vitest';
import {WALDO_CHAT_MODEL} from '@waldo/contracts';
import {ownerBrowserRuntime} from '../src/channels/owner-browser-runtime';
import {registerCommonBrowserSdk} from '../src/channels/common-staging-registration';
const proof=vi.hoisted(()=>({calls:0}));
vi.mock('../src/llm/openai',()=>({OpenAIResponsesAdapter:class{async complete(){proof.calls++;return {ok:true,data:{text:'Ordinary reply'}};}}}));
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async(_provider:string,subject:string,doName:string)=>({directoryOwnerId:'10000000-0000-0000-0000-000000000002',custodyDigest:'b'.repeat(64),subject,doName})})}));
registerCommonBrowserSdk(async()=>{throw Error('SDK calls forbidden');});
it.each(['expired','unavailable'])('a retained funded browser record with %s registration cannot close an open ordinary model run',async kind=>{
 const rows=new Map<string,any>([['do_name','model-owner'],['telegram_subject','81102'],['common-browser:funded-run',{allocation:'observed'}],['common_owner_browser_registration_v1',{custodyDigest:'b'.repeat(64),registration:{policy:{directoryOwnerId:'10000000-0000-0000-0000-000000000002'}},operator:'{}'}]]);
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>rows.set(key,structuredClone(value)),list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix))},transactionSync:<T>(work:()=>T)=>work()} as unknown as DurableObjectStorage;
 const env={WALDO_ENVIRONMENT:'staging',BROWSER:{},COMMON_BROWSER_REGISTRATION:kind==='expired'?JSON.stringify({scope:'verified_owners',policy:{ref:'expired',createdAt:1,expiresAt:2,allowedOrigins:['*'],maxAllocations:1,maxReservedBrowserMs:20000,lifetimeMs:10000,maxScreenshotBytes:1024},billing:{cloudflareAccountId:'a'.repeat(32),conservativeWorstCase:true},spend:{limitMicrousd:10000000,maxCalls:100,validUntil:2}}):undefined,TELEGRAM_OWNER_DO:{idFromName:()=>({toString:()=> 'physical'})},OPENAI_API_KEY:'fictional'} as never;
 if(kind==='expired'){
  const raw=JSON.parse((env as any).COMMON_BROWSER_REGISTRATION),directoryOwnerId='10000000-0000-0000-0000-000000000002';
  rows.set('common_owner_browser_registration_v1',{operator:JSON.stringify(raw),custodyDigest:'b'.repeat(64),registration:{policy:{...raw.policy,doName:'model-owner',subject:'81102',directoryOwnerId,ref:`${raw.policy.ref}:owner:${directoryOwnerId}`},spend:raw.spend,billing:raw.billing}});
 }
 const scope={runId:'funded-run',attempt:'attempt',deadline:Date.now()+60000,signal:new AbortController().signal,admit:vi.fn(),commit:<T>(work:()=>T)=>work()};
 const gateway=ownerBrowserRuntime({env,storage,actualDoId:'physical',activeScope:()=>scope}).gateway()!;
 const before=proof.calls,snapshot=structuredClone([...rows]);
 await expect(gateway.complete({request:{model:WALDO_CHAT_MODEL,max_tokens:32},runScope:scope} as never)).resolves.toMatchObject({ok:true,data:{text:'Ordinary reply'}});
 expect(proof.calls).toBe(before+1);expect(scope.signal.aborted).toBe(false);expect([...rows]).toEqual(snapshot);
 rows.set('telegram_unlinked',true);await expect(gateway.complete({request:{model:WALDO_CHAT_MODEL,max_tokens:32},runScope:scope} as never)).rejects.toThrow();expect(proof.calls).toBe(before+1);
});
it('a manual wrapper built before spend expiry uses the normal adapter after expiry while its ordinary run remains open',async()=>{
 const now=Date.now(),rows=new Map<string,any>([['do_name','model-owner'],['telegram_subject','81102'],['common-browser:manual-run',{allocation:'observed'}]]);
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>rows.set(key,structuredClone(value)),list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix))},transactionSync:<T>(work:()=>T)=>work()} as unknown as DurableObjectStorage;
 const env={WALDO_ENVIRONMENT:'staging',BROWSER:{},COMMON_BROWSER_REGISTRATION:JSON.stringify({policy:{ref:'manual',doName:'model-owner',subject:'81102',directoryOwnerId:'10000000-0000-0000-0000-000000000002',createdAt:now-1000,expiresAt:now+60000,allowedOrigins:['*'],maxAllocations:1,maxReservedBrowserMs:20000,lifetimeMs:10000,maxScreenshotBytes:1024},billing:{cloudflareAccountId:'a'.repeat(32),conservativeWorstCase:true},spend:{limitMicrousd:10000000,maxCalls:100,validUntil:now+1000}}),TELEGRAM_OWNER_DO:{idFromName:()=>({toString:()=> 'physical'})},OPENAI_API_KEY:'fictional'} as never;
 const scope={runId:'manual-run',attempt:'attempt',deadline:now+60000,signal:new AbortController().signal,admit:vi.fn(),commit:<T>(work:()=>T)=>work()};
 vi.useFakeTimers();vi.setSystemTime(now);
 const gateway=ownerBrowserRuntime({env,storage,actualDoId:'physical',activeScope:()=>scope}).gateway()!;vi.setSystemTime(now+2000);
 try{await expect(gateway.complete({request:{model:WALDO_CHAT_MODEL,max_tokens:32},runScope:scope} as never)).resolves.toMatchObject({ok:true});expect(rows.has('common-spend:manual')).toBe(false);}finally{vi.useRealTimers();}
});
