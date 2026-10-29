import {afterEach,expect,it,vi} from 'vitest';
import {ownerBrowserRuntime} from '../src/channels/owner-browser-runtime';
import {registerCommonBrowserSdk} from '../src/channels/common-staging-registration';
import {commonBrowserFixture,commonBrowserMeteredFixtureLoader} from './fixtures/common-browser-sdk';
import type {RunEffectScope} from '../src/channels/run-effect-scope';
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async()=>({directoryOwnerId:'10000000-0000-0000-0000-000000000002',custodyDigest:'b'.repeat(64)})})}));
registerCommonBrowserSdk(commonBrowserMeteredFixtureLoader);
afterEach(()=>{vi.unstubAllGlobals();});
const ownerId='prn_10000000000000000000000000000002',API_KEY='bb_FICTIONAL_API_KEY',SIGNING='FICTIONAL_SIGNING_KEY';
function fixture(keys=true){
 commonBrowserFixture.reset();
 const rows=new Map<string,any>([['do_name','runtime-owner'],['telegram_subject','81102']]);let alarm:number|null=null;
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>rows.set(key,structuredClone(value)),list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix))},transactionSync:<T>(work:()=>T)=>work(),getAlarm:async()=>alarm,setAlarm:async(at:number)=>{alarm=at;}} as unknown as DurableObjectStorage;
 const vendor:{url:string;method:string;headers:Headers;body?:any}[]=[];
 vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input),method=init?.method??'GET';vendor.push({url,method,headers:new Headers(init?.headers),...(init?.body?{body:JSON.parse(String(init.body))}:{})});
  if(url==='https://api.browserbase.com/v1/sessions'&&method==='POST')return Response.json({id:'fixture-retained-provider',connectUrl:`wss://connect.browserbase.com/?signingKey=${SIGNING}`},{status:201});
  if(url==='https://api.browserbase.com/v1/sessions?status=RUNNING')return Response.json([{id:'fixture-retained-provider'}]);
  if(url==='https://api.browserbase.com/v1/sessions/fixture-retained-provider')return Response.json({id:'fixture-retained-provider',connectUrl:`wss://connect.browserbase.com/?signingKey=${SIGNING}`});
  if(url.startsWith('https://connect.browserbase.com/'))return new Response(null,{status:200});
  return new Response('unexpected',{status:500});
 });
 const cloudflare={fetch:vi.fn(async()=>new Response('{}'))},now=Date.now();
 const env={WALDO_ENVIRONMENT:'staging',BROWSER:cloudflare,...(keys?{BROWSERBASE_API_KEY:API_KEY,BROWSERBASE_PROJECT_ID:'fictional-project'}:{}),OWNER_DO:{idFromName:(name:string)=>({toString:()=>name==='runtime-owner'?'physical-owner':'foreign'})}} as never;
 const scope:RunEffectScope={runId:'run-1',attempt:'run-1',deadline:now+60000,signal:new AbortController().signal,admit:vi.fn(),commit:work=>work()};
 const runtime=ownerBrowserRuntime({env,storage,actualDoId:'physical-owner',activeScope:()=>scope});
 const ctx={authenticatedUserId:ownerId,turnId:'turn-1',toolCallId:'call-1',runScope:scope,egressAllowlist:['*']} as never;
 const fallback={name:'browse_page',handle:vi.fn()} as never,actFallback={name:'browse_act',handle:vi.fn()} as never;
 return {rows,vendor,cloudflare,runtime,ctx,read:(args:object)=>runtime.read(fallback).handle({url:'https://example.com/a',instruction:'Read the page',...args} as never,ctx) as Promise<any>,act:(args:object)=>runtime.act(actFallback).handle({url:'https://example.com/a',task:'Continue',max_actions:1,...args} as never,ctx) as Promise<any>};
}
const held=(rows:Map<string,any>)=>[...rows].filter(([key])=>key.startsWith('common-browser:')&&key!=='common-browser:due').map(([,row])=>row).filter(row=>row?.session);

it('an escalated browse_page runs on the Browserbase binding, metered at its rate, and never touches the Cloudflare binding',async()=>{
 const f=fixture(),first=await f.read({retain_session:true,escalate:'blocked'});
 expect(first).toMatchObject({ok:true,data:{session_handle:expect.any(String)}});
 const create=f.vendor.filter(call=>call.url==='https://api.browserbase.com/v1/sessions');
 expect(create).toHaveLength(1);expect(create[0]!.headers.get('x-bb-api-key')).toBe(API_KEY);
 expect(create[0]!.body).toMatchObject({projectId:'fictional-project',keepAlive:true});expect(create[0]!.body.timeout).toBeGreaterThan(600);
 expect(held(f.rows).map(row=>row.session.provider)).toEqual(['browserbase_cdp']);
 const upgrades=f.vendor.filter(call=>call.headers.get('upgrade')==='websocket');
 expect(upgrades.length).toBeGreaterThan(0);expect(upgrades.every(call=>call.url.startsWith('https://connect.browserbase.com/'))).toBe(true);
 expect(f.rows.get('owner-public-browser-spend:v2').reservations).toEqual([expect.objectContaining({rateMicrousdPerHour:120_000,settled:false})]);
 expect(await f.act({session_handle:first.data.session_handle,command:{operation:'read'}})).toMatchObject({ok:true});
 expect(f.cloudflare.fetch).not.toHaveBeenCalled();expect(JSON.stringify([...f.rows])).not.toContain(SIGNING);
 expect(await f.act({session_handle:first.data.session_handle,command:{operation:'cancel'}})).toMatchObject({ok:true});
 expect(f.cloudflare.fetch).not.toHaveBeenCalled();
});
it('without Browserbase keys an escalation is refused typed and nothing is allocated',async()=>{
 const f=fixture(false),refused=await f.read({retain_session:true,escalate:'verification_challenge'});
 expect(refused).toMatchObject({ok:false});expect(JSON.stringify(refused)).toContain('escalation_unavailable');
 expect(commonBrowserFixture.allocations).toBe(0);expect(f.vendor).toHaveLength(0);expect(held(f.rows)).toHaveLength(0);
});
it('an escalation asked while a standard session is open is refused typed, never quietly kept on the standard browser',async()=>{
 const f=fixture(),standard=await f.read({retain_session:true});expect(standard).toMatchObject({ok:true});
 for(const args of [{retain_session:true,escalate:'login'},{session_handle:standard.data.session_handle,escalate:'login'}]){
  const refused=await f.read(args);expect(refused).toMatchObject({ok:false});expect(JSON.stringify(refused)).toContain('escalation_needs_new_session');
 }
 expect(f.vendor).toHaveLength(0);expect(held(f.rows).map(row=>row.session.provider)).toEqual(['cloudflare_playwright']);
});
