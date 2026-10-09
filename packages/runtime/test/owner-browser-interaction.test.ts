import {expect,it,vi} from 'vitest';
import {ownerBrowserRuntime} from '../src/channels/owner-browser-runtime';
import {commonBrowserFixture,commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
import type {RunEffectScope} from '../src/channels/run-effect-scope';
vi.mock('../src/channels/common-staging-registration',async load=>({...await load<object>(),commonBrowserSdk:()=>commonBrowserFixtureLoader}));
let custody='b'.repeat(64);
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async()=>({directoryOwnerId:'10000000-0000-0000-0000-000000000002',custodyDigest:custody})})}));
function fixture(){
 commonBrowserFixture.reset();commonBrowserFixture.filters=true;custody='b'.repeat(64);
 const rows=new Map<string,any>([['do_name','interactive-owner'],['telegram_subject','81102']]);let alarm:number|null=null;
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>rows.set(key,structuredClone(value)),list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix))},transactionSync:<T>(work:()=>T)=>work(),getAlarm:async()=>alarm,setAlarm:async(at:number)=>{alarm=at;}} as unknown as DurableObjectStorage;
 const scope=(id:string):RunEffectScope=>({runId:id,attempt:id,deadline:Date.now()+3_600_000,signal:new AbortController().signal,admit(){},commit:work=>work()});let active=scope('first');
 const env={WALDO_ENVIRONMENT:'staging',BROWSER:{},TELEGRAM_OWNER_DO:{idFromName:()=>({toString:()=> 'physical'})}} as never;
 const options={env,storage,actualDoId:'physical',activeScope:()=>active},runtime=ownerBrowserRuntime(options),fallback={name:'browse_page',handle:vi.fn(()=>{throw Error('No provider fallback');})} as never;
 const context=()=>({authenticatedUserId:'trusted-local-owner',runScope:active,turnId:active.runId,toolCallId:crypto.randomUUID(),egressAllowlist:['*']}) as never;
 const url='https://example.com/a';
 return {rows,storage,runtime,fallback,context,env,url,read:()=>runtime.read(fallback).handle({url,instruction:'Interact',retain_session:true},context()),act:(handle:string,command:unknown)=>runtime.act(fallback).handle({url,task:'Continue journey',max_actions:1,session_handle:handle,command} as never,context()),next:async()=>{await runtime.finish(active);active=scope('second');},reconstruct:()=>ownerBrowserRuntime(options)};
}
it('ordinary interactive owner journey continues past four observations and into the next run without trial refill',async()=>{
 const f=fixture(),first:any=await f.read();expect(first).toMatchObject({ok:true,data:{session_handle:expect.any(String),accessibility_snapshot:expect.any(String)}});
 let current=first;const handle=first.data.session_handle;
 for(const command of [()=>({operation:'type',element_ref:current.data.elements[0].ref,value:'Temporary note'}),()=>({operation:'type',element_ref:current.data.elements[0].ref,key:'Enter'}),()=>({operation:'select',element_ref:current.data.elements.find((e:any)=>e.name==='Region').ref,value:'north'}),()=>({operation:'set_checked',element_ref:current.data.elements.find((e:any)=>e.name==='Available only').ref,checked:true}),...Array.from({length:5},()=>()=>({operation:'read'}))]){current=await f.act(handle,command());expect(current).toMatchObject({ok:true});}
 expect(current.data.field_values[0].value).toBe('Temporary note');expect(current.data.elements.find((e:any)=>e.name==='Available only').checked).toBe(true);expect(commonBrowserFixture.allocations).toBe(1);
 expect(f.rows.has('common_owner_browser_registration_v1')).toBe(false);expect([...f.rows.keys()].some(key=>key.startsWith('common-spend:'))).toBe(false);
 await f.next();expect(await f.act(handle,{operation:'read'})).toMatchObject({ok:true});
 expect(await f.act(handle,{operation:'cancel'})).toMatchObject({ok:true,data:{ended:true}});expect(commonBrowserFixture.ends).toBe(1);
 expect(f.rows.get('owner-public-browser-spend:v2').reservations[0].settled).toBe(true);expect(commonBrowserFixture.allocations).toBe(1);
});
it('reconstructed stop cleans exact ordinary session after custody revocation',async()=>{
 const f=fixture(),first:any=await f.read();expect(first.ok).toBe(true);custody='c'.repeat(64);expect(await f.act(first.data.session_handle,{operation:'read'})).toMatchObject({ok:false});
 f.rows.set('telegram_unlinked',true);const reconstructed=f.reconstruct();reconstructed.stop();await reconstructed.maintain();expect(commonBrowserFixture.ends).toBe(1);expect(f.rows.get('common-browser:first').cleanup).toBe('closed');
});
it('unknown handle refuses before allocation and explicit reconstructed read reports document loss without replacement',async()=>{
 const f=fixture();expect(await f.act('missing',{operation:'read'})).toMatchObject({ok:false});expect(commonBrowserFixture.allocations).toBe(0);
 const first:any=await f.read(),handle=first.data.session_handle;expect(first.ok).toBe(true);
 const reconstructed=f.reconstruct();expect(await reconstructed.read(f.fallback).handle({url:f.url,instruction:'Recover same session',session_handle:handle},f.context())).toMatchObject({ok:true,data:{session_handle:handle,document_state:'recreated',previous_document_lost:true}});expect(commonBrowserFixture.allocations).toBe(1);
});
it('uncertain ordinary cancellation retains the full hold and does not retry cleanup forever',async()=>{
 const f=fixture(),first:any=await f.read();expect(first.ok).toBe(true);const before=f.rows.get('owner-public-browser-spend:v2').reservedMicrousd;
 let attempts=0;commonBrowserFixture.onTerminate=()=>{attempts++;throw Error('Unconfirmed exact closure');};
 expect(await f.act(first.data.session_handle,{operation:'cancel'})).toMatchObject({ok:false});
 expect(f.rows.get('owner-public-browser-spend:v2').reservedMicrousd).toBe(before);expect(f.rows.get('owner-public-browser-spend:v2').reservations[0].settled).toBe(false);
 await f.runtime.maintain();await f.runtime.maintain();expect(attempts).toBe(1);expect(f.rows.get('common-browser:first').cleanupFailed).toBe(true);
});
it('expired trial history stays unchanged while ordinary interaction uses the existing owner accounting ceiling',async()=>{
 const f=fixture(),ownerId='prn_10000000000000000000000000000002';
 (f.env as any).COMMON_BROWSER_REGISTRATION=JSON.stringify({policy:{ref:'expired',doName:'interactive-owner',subject:'81102',directoryOwnerId:'10000000-0000-0000-0000-000000000002',createdAt:1,expiresAt:2,allowedOrigins:['*'],maxAllocations:1,maxReservedBrowserMs:20000,lifetimeMs:10000,maxScreenshotBytes:1024},billing:{cloudflareAccountId:'a'.repeat(32),conservativeWorstCase:true},spend:{limitMicrousd:10000000,maxCalls:100,validUntil:2}});
 const retained={policy:{ref:'expired',ownerId,validUntil:2,limitMicrousd:10000000,maxCalls:100},reservedMicrousd:100,calls:[{id:'prior',upperBoundMicrousd:100}],cleanup:[]};f.rows.set('common-spend:expired',structuredClone(retained));
 const first:any=await f.read();expect(first.ok).toBe(true);expect(f.rows.get('common-spend:expired')).toEqual(retained);expect(f.rows.has('common_owner_browser_registration_v1')).toBe(false);
 expect(await f.act(first.data.session_handle,{operation:'cancel'})).toMatchObject({ok:true});expect(f.rows.get('common-spend:expired')).toEqual(retained);
});
it('ordinary interaction cannot exceed a retained lower owner ceiling',async()=>{
 const f=fixture();f.rows.set('owner-public-browser-spend:v2',{ownerId:'prn_10000000000000000000000000000002',custodyDigest:'b'.repeat(64),limitMicrousd:1,reservedMicrousd:0,reservations:[]});
 const prior=structuredClone(f.rows.get('owner-public-browser-spend:v2'));expect(await f.read()).toMatchObject({ok:false});expect(commonBrowserFixture.allocations).toBe(0);expect(f.rows.get('owner-public-browser-spend:v2')).toEqual(prior);
});
it('a dropped handle cannot silently replace an open ordinary journey with a fresh one-shot read',async()=>{
 const f=fixture(),first:any=await f.read();expect(first.ok).toBe(true);
 expect(await f.act(first.data.session_handle,{operation:'type',element_ref:first.data.elements[0].ref,value:'Unsent owner note'})).toMatchObject({ok:true});
 for(let turn=0;turn<2;turn++){
  if(turn)await f.next();
  for(const runtime of [f.runtime,f.reconstruct()])expect(await runtime.read(f.fallback).handle({url:f.url,instruction:'Read the current page'},f.context())).toMatchObject({ok:false,code:'rejected',error:expect.stringContaining('session_handle')});
 }
 expect(commonBrowserFixture.allocations).toBe(1);
 expect(await f.act(first.data.session_handle,{operation:'read'})).toMatchObject({ok:true,data:{field_values:expect.arrayContaining([expect.objectContaining({value:'Unsent owner note'})])}});
});
