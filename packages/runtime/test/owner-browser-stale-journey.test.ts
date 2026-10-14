import {expect,it,vi} from 'vitest';
import {ownerBrowserRuntime} from '../src/channels/owner-browser-runtime';
import {commonBrowserFixture,commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
import type {RunEffectScope} from '../src/channels/run-effect-scope';
vi.mock('../src/channels/common-staging-registration',async load=>({...await load<object>(),commonBrowserSdk:()=>commonBrowserFixtureLoader}));
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async()=>({directoryOwnerId:'10000000-0000-0000-0000-000000000002',custodyDigest:'b'.repeat(64)})})}));
// The fixture SDK models one provider session, so a real one-shot read would end the journey under test. The one-shot
// reader has its own suite; here it only records that the runtime routed the read to it.
const oneShot=vi.hoisted(()=>({calls:0}));
vi.mock('../src/channels/cloudflare-public-read',async load=>({...await load<object>(),cloudflarePublicRead:()=>async(args:{url:string})=>{oneShot.calls++;return {ok:true,data:{url:args.url,provider:'cloudflare_playwright',data:{title:'One-shot page',text:'One-shot text'}},source_taint:'external'};}}));
function fixture(){
 commonBrowserFixture.reset();oneShot.calls=0;
 const rows=new Map<string,any>([['do_name','stale-journey-owner'],['telegram_subject','81102']]);let alarm:number|null=null;
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>rows.set(key,structuredClone(value)),list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix))},transactionSync:<T>(work:()=>T)=>work(),getAlarm:async()=>alarm,setAlarm:async(at:number)=>{alarm=at;}} as unknown as DurableObjectStorage;
 const scope=(id:string):RunEffectScope=>({runId:id,attempt:id,deadline:Date.now()+3_600_000,signal:new AbortController().signal,admit(){},commit:work=>work()});let active=scope('first');
 const env={WALDO_ENVIRONMENT:'staging',BROWSER:{},OWNER_DO:{idFromName:()=>({toString:()=> 'physical'})}} as never;
 const options={env,storage,actualDoId:'physical',activeScope:()=>active},runtime=ownerBrowserRuntime(options),fallback={name:'browse_page',handle:vi.fn(()=>{throw Error('No provider fallback');})} as never;
 const context=()=>({authenticatedUserId:'trusted-local-owner',runScope:active,turnId:active.runId,toolCallId:crypto.randomUUID(),egressAllowlist:['*']}) as never;
 const url='https://example.com/a';
 return {rows,runtime,fallback,context,url,
  read:()=>runtime.read(fallback).handle({url,instruction:'Interact',retain_session:true},context()) as Promise<any>,
  oneShot:()=>runtime.read(fallback).handle({url:'https://example.com/other',instruction:'Read another page'},context()) as Promise<any>,
  act:(handle:string,command:unknown,at=url)=>runtime.act(fallback).handle({url:at,task:'Continue journey',max_actions:1,session_handle:handle,command} as never,context()) as Promise<any>,
  next:async()=>{await runtime.finish(active);active=scope('second');},switchWithoutFinish:()=>{active=scope('second');},reconstruct:()=>ownerBrowserRuntime(options)};
}
it('a failed first retained read leaves no journey behind: a one-shot read runs now, and the next turn starts fresh',async()=>{
 const f=fixture();commonBrowserFixture.onGoto=()=>{throw Error('provider dropped the navigation');};
 expect(await f.read()).toMatchObject({ok:false});commonBrowserFixture.onGoto=undefined;
 expect(await f.oneShot()).toMatchObject({ok:true,data:{data:{text:'One-shot text'}}});
 await f.next();
 expect(await f.read()).toMatchObject({ok:true,data:{session_handle:expect.any(String)}});
 expect(commonBrowserFixture.ends).toBe(1);expect(commonBrowserFixture.allocations).toBe(2);
});
it('a journey held by an earlier turn does not block this turn\'s one-shot read, which names that journey and leaves it intact',async()=>{
 const f=fixture(),first=await f.read(),handle=first.data.session_handle;
 expect(await f.act(handle,{operation:'type',element_ref:first.data.elements[0].ref,value:'Unsent owner note'})).toMatchObject({ok:true});
 await f.next();
 for(const runtime of [f.runtime,f.reconstruct()])
  expect(await runtime.read(f.fallback).handle({url:'https://example.com/other',instruction:'Read another page'},f.context())).toMatchObject({ok:true,data:{data:{text:'One-shot text'},open_browser_session:{session_handle:handle}}});
 expect(oneShot.calls).toBe(2);expect(commonBrowserFixture.allocations).toBe(1);
 expect(await f.act(handle,{operation:'read'})).toMatchObject({ok:true,data:{field_values:expect.arrayContaining([expect.objectContaining({value:'Unsent owner note'})])}});
});
it('the turn that holds the journey is told its session_handle and how to end it when it drops the handle',async()=>{
 const f=fixture(),first=await f.read();
 const refused=await f.oneShot();
 expect(refused).toMatchObject({ok:false,code:'rejected'});expect(refused.error).toContain(first.data.session_handle);expect(refused.error).toContain('cancel');
 expect(oneShot.calls).toBe(0);
});
it('a later turn asking for a new retained session is told the open journey\'s handle, and can end it with only that handle',async()=>{
 const f=fixture(),first=await f.read(),handle=first.data.session_handle;await f.next();
 const refused=await f.read();
 expect(refused).toMatchObject({ok:false});expect(refused.error).toContain(handle);
 expect(await f.act(handle,{operation:'cancel'},'https://example.com/elsewhere')).toMatchObject({ok:true,data:{ended:true}});
 expect(commonBrowserFixture.ends).toBe(1);
 const fresh=await f.read();expect(fresh).toMatchObject({ok:true});expect(fresh.data.session_handle).not.toBe(handle);
});
it('a journey whose cleanup failed never blocks later reads',async()=>{
 const f=fixture(),first=await f.read();
 commonBrowserFixture.onTerminate=()=>{throw Error('Unconfirmed exact closure');};
 expect(await f.act(first.data.session_handle,{operation:'cancel'})).toMatchObject({ok:false});commonBrowserFixture.onTerminate=undefined;
 expect(f.rows.get('common-browser:first')).toMatchObject({cleanup:'pending',cleanupFailed:true});
 await f.next();
 expect(await f.oneShot()).toMatchObject({ok:true});
 const fresh=await f.read();expect(fresh).toMatchObject({ok:true});expect(fresh.data.session_handle).not.toBe(first.data.session_handle);
});
it('the turn whose first read failed can retry that same session by the handle the failure returned',async()=>{
 const f=fixture();commonBrowserFixture.onGoto=()=>{throw Error('provider dropped the navigation');};
 const failed=await f.read();commonBrowserFixture.onGoto=undefined;
 const handle=/session_handle is ([0-9a-f-]{36})/.exec(failed.error)?.[1];expect(handle).toBeDefined();
 expect(await f.runtime.read(f.fallback).handle({url:f.url,instruction:'Retry',retain_session:true,session_handle:handle},f.context())).toMatchObject({ok:true,data:{session_handle:handle}});
 expect(commonBrowserFixture.allocations).toBe(1);
});
it('a failed action does not publish a session whose first read failed',async()=>{
 const f=fixture();commonBrowserFixture.onGoto=()=>{throw Error('provider dropped the navigation');};
 const failed=await f.read();commonBrowserFixture.onGoto=undefined;
 const handle=/session_handle is ([0-9a-f-]{36})/.exec(failed.error)![1]!;
 expect(await f.act(handle,{operation:'read'})).toMatchObject({ok:false});
 expect(await f.oneShot()).toMatchObject({ok:true});
 expect(await f.act(handle,{operation:'cancel'})).toMatchObject({ok:true,data:{ended:true}});expect(commonBrowserFixture.ends).toBe(1);
});
it('a turn that is still finishing is named as the reason, not reported as an unavailable browser',async()=>{
 const f=fixture();expect(await f.read()).toMatchObject({ok:true});
 f.switchWithoutFinish();
 const refused=await f.read();
 expect(refused).toMatchObject({ok:false});expect(refused.error).toContain('earlier turn that is finishing');
 expect(await f.oneShot()).toMatchObject({ok:true});
});
