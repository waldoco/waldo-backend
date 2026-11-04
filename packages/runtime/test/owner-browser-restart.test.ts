import {expect,it,vi} from 'vitest';
import {ownerBrowserRuntime} from '../src/channels/owner-browser-runtime';
import {commonBrowserFixture,commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
import type {RunEffectScope} from '../src/channels/run-effect-scope';
vi.mock('../src/channels/common-staging-registration',async load=>({...await load<object>(),commonBrowserSdk:()=>commonBrowserFixtureLoader}));
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async()=>({directoryOwnerId:'10000000-0000-0000-0000-000000000003',custodyDigest:'c'.repeat(64)})})}));
function fixture(){
 commonBrowserFixture.reset();
 const rows=new Map<string,any>([['do_name','restart-owner'],['telegram_subject','81103']]);let alarm:number|null=null;
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>rows.set(key,structuredClone(value)),list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix))},transactionSync:<T>(work:()=>T)=>work(),getAlarm:async()=>alarm,setAlarm:async(at:number)=>{alarm=at;}} as unknown as DurableObjectStorage;
 const scope=(id:string):RunEffectScope=>({runId:id,attempt:id,deadline:Date.now()+3_600_000,signal:new AbortController().signal,admit(){},commit:work=>work()});let active=scope('first');
 const env={WALDO_ENVIRONMENT:'staging',BROWSER:{},OWNER_DO:{idFromName:()=>({toString:()=> 'physical'})}} as never;
 const runtime=ownerBrowserRuntime({env,storage,actualDoId:'physical',activeScope:()=>active}),fallback={name:'browse_page',handle:vi.fn(()=>{throw Error('No provider fallback');})} as never;
 const context=()=>({authenticatedUserId:'trusted-local-owner',runScope:active,turnId:active.runId,toolCallId:crypto.randomUUID(),egressAllowlist:['*']}) as never;
 return {rows,
  read:(url='https://example.com/a',session_handle?:string)=>runtime.read(fallback).handle({url,instruction:'Read the page',retain_session:true,...(session_handle?{session_handle}:{})},context()) as Promise<any>,
  act:(handle:string,command:unknown,at='https://example.com/a')=>runtime.act(fallback).handle({url:at,task:'Continue the errand',max_actions:1,session_handle:handle,command} as never,context()) as Promise<any>,
  next:async()=>{await runtime.finish(active);active=scope('second');},
  sessions:()=>[...rows].filter(([key])=>key.startsWith('common-browser:')).map(([,row])=>row)};
}
it('a read on a session that has ended starts one fresh session, retries the read once and says so',async()=>{
 const f=fixture(),first=await f.read();expect(first.ok).toBe(true);
 commonBrowserFixture.endProviderSession();
 const read=await f.act(first.data.session_handle,{operation:'read'});
 expect(read).toMatchObject({ok:true,data:{restarted:true,url:'https://example.com/a',text:'Option A costs 10 fictional tokens.'}});
 expect(read.data.session_handle).not.toBe(first.data.session_handle);
 expect(read.data.restart_notice).toContain('tabs');expect(read.data.restart_notice).toContain('sign-in');
 expect(commonBrowserFixture.allocations).toBe(2);
 expect(f.sessions().map(row=>row.cleanup)).toEqual(['closed',undefined]);
 expect(f.sessions()[1]).toMatchObject({allocation:'observed',session:{id:read.data.session_handle,state:'active'}});
 expect(await f.act(read.data.session_handle,{operation:'read'})).toMatchObject({ok:true,data:{session_handle:read.data.session_handle}});
 expect(commonBrowserFixture.allocations).toBe(2);
});
it('a later turn reading an ended session by its handle gets one fresh session too',async()=>{
 const f=fixture(),first=await f.read();await f.next();
 commonBrowserFixture.endProviderSession();
 const read=await f.read('https://example.com/b',first.data.session_handle);
 expect(read).toMatchObject({ok:true,data:{restarted:true,url:'https://example.com/b'}});
 expect(commonBrowserFixture.allocations).toBe(2);
});
it('back on an ended session reopens the page it was on and says the history went with the old session',async()=>{
 const f=fixture(),first=await f.read();
 commonBrowserFixture.endProviderSession();
 const back=await f.act(first.data.session_handle,{operation:'back'});
 expect(back).toMatchObject({ok:true,data:{restarted:true,back:'history_lost',url:'https://example.com/a'}});
 expect(commonBrowserFixture.allocations).toBe(2);
});
it('an effect on an ended session never restarts: its outcome stays fenced',async()=>{
 const f=fixture(),first=await f.read();
 commonBrowserFixture.endProviderSession();
 const typed=await f.act(first.data.session_handle,{operation:'type',element_ref:first.data.elements[0].ref,value:'Owner note'});
 expect(typed).toMatchObject({ok:false});expect(typed.data).toBeUndefined();
 expect(commonBrowserFixture.allocations).toBe(1);
 expect(f.sessions()).toHaveLength(1);
});
it('a read after an uncertain effect never restarts, so the effect cannot be repeated on a fresh page',async()=>{
 const f=fixture(),first=await f.read();
 commonBrowserFixture.onFill=()=>{throw Error('provider dropped the action');};
 expect(await f.act(first.data.session_handle,{operation:'type',element_ref:first.data.elements[0].ref,value:'Owner note'})).toMatchObject({ok:false});
 commonBrowserFixture.onFill=undefined;commonBrowserFixture.endProviderSession();
 expect(await f.act(first.data.session_handle,{operation:'read'})).toMatchObject({ok:false});
 expect(commonBrowserFixture.allocations).toBe(1);
});
it('when the fresh session fails too, the read returns its typed error and no third session is started',async()=>{
 const f=fixture(),first=await f.read();
 commonBrowserFixture.endProviderSession();
 commonBrowserFixture.onAcquire=()=>{commonBrowserFixture.endProviderSession();};
 const read=await f.act(first.data.session_handle,{operation:'read'});
 expect(read).toMatchObject({ok:false});expect(read.error).toContain('session_lost');
 expect(commonBrowserFixture.allocations).toBe(2);
});
it('a read that fails while the provider still holds the session is not a restart',async()=>{
 const f=fixture(),first=await f.read();
 commonBrowserFixture.onGoto=()=>{throw Error('provider dropped the navigation');};
 expect(await f.read('https://example.com/b',first.data.session_handle)).toMatchObject({ok:false});
 commonBrowserFixture.onGoto=undefined;
 expect(commonBrowserFixture.allocations).toBe(1);
});
it('a dropped connection to a session the provider still holds is not restarted: the read fails honestly and the next one reconnects',async()=>{
 const f=fixture(),first=await f.read();
 commonBrowserFixture.dropConnection();
 const read=await f.act(first.data.session_handle,{operation:'read'});
 expect(read).toMatchObject({ok:false});expect(read.error).toContain('provider_unavailable');expect(read.data).toBeUndefined();
 expect(commonBrowserFixture.allocations).toBe(1);
 expect(f.sessions()).toHaveLength(1);expect(f.sessions()[0].cleanup).toBeUndefined();
 const again=await f.read('https://example.com/a',first.data.session_handle);
 expect(again).toMatchObject({ok:true,data:{session_handle:first.data.session_handle}});expect(again.data.restarted).toBeUndefined();
 expect(commonBrowserFixture.allocations).toBe(1);
});
it('a connection that drops mid-read while the provider still holds the session is not restarted',async()=>{
 const f=fixture(),first=await f.read();
 commonBrowserFixture.onGoto=()=>{commonBrowserFixture.dropConnection();throw Error('socket closed');};
 const read=await f.read('https://example.com/b',first.data.session_handle);
 commonBrowserFixture.onGoto=undefined;
 expect(read).toMatchObject({ok:false});expect(read.error).toContain('provider_unavailable');
 expect(commonBrowserFixture.allocations).toBe(1);expect(f.sessions()[0].cleanup).toBeUndefined();
});
it('a connection that drops mid-read because the provider ended the session still gets the bounded restart',async()=>{
 const f=fixture(),first=await f.read();
 commonBrowserFixture.onGoto=()=>{commonBrowserFixture.onGoto=undefined;commonBrowserFixture.endProviderSession();throw Error('socket closed');};
 const read=await f.read('https://example.com/b',first.data.session_handle);
 expect(read).toMatchObject({ok:true,data:{restarted:true,url:'https://example.com/b'}});
 expect(commonBrowserFixture.allocations).toBe(2);
});
