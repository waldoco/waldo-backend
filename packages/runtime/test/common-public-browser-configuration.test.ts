import {it,expect,vi,afterEach} from 'vitest';
import {commonPublicBrowserConfiguration,type CommonPublicReadPolicy} from '../src/channels/common-public-browser-configuration';
import type {TelegramWebhookEnv} from '../src/channels/telegram-webhook';
import {commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
afterEach(()=>vi.unstubAllGlobals());
const fixture=()=>{
 let now=10000,revision='1';const rows=new Map<string,unknown>([['do_name','fixture-owner'],['telegram_subject','81106']]);
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>rows.set(key,structuredClone(value))},transactionSync:<T>(work:()=>T)=>work()} as unknown as DurableObjectStorage;
 const env={WALDO_ENVIRONMENT:'staging',BROWSER:{},SUPABASE_PROJECT_URL:'https://fixture-source.invalid',SUPABASE_PUBLISHABLE_KEY:'fictional',WALDO_ROUTER_HMAC_SECRET:'fictional-private',TELEGRAM_OWNER_DO:{idFromName:(name:string)=>({toString:()=>name==='fixture-owner'?'physical':'wrong'})}} as unknown as TelegramWebhookEnv;
 const policy:CommonPublicReadPolicy={ref:'fixture-policy',doName:'fixture-owner',subject:'81106',directoryOwnerId:'10000000-0000-0000-0000-000000081106',createdAt:9000,expiresAt:100000,allowedOrigins:['https://public-pages.fixture.invalid'],maxAllocations:1,maxReservedBrowserMs:120000,lifetimeMs:60000,maxScreenshotBytes:1024};
 vi.stubGlobal('fetch',async()=>Response.json({owner_id:policy.directoryOwnerId,auth_user_id:'30000000-0000-0000-0000-000000000006',presence_id:'20000000-0000-0000-0000-000000081106',do_name:policy.doName,provider:'telegram',subject:policy.subject,state_version:0,admission_revision:revision}));
 const spend={policy:{ref:'fictional-spend',ownerId:'prn_10000000000000000000000000081106',validUntil:100000,limitMicrousd:100,maxCalls:100},allocationMicrousd:1,quote:(kind:string)=>kind==='browser'?0:1};
 const config=()=>commonPublicBrowserConfiguration({env,storage,actualDoId:'physical',policy,loadSdk:commonBrowserFixtureLoader,spend,now:()=>now})!;
 return {config,env,storage,policy,spend,rows,advance:()=>{now=100001;},changeAuthority:()=>{revision='2';},task:{taskId:'canonical-fixture-task',revision:1,sources:['web'] as const,ready:true,startRef:'fixture-input'},ownerId:'prn_10000000000000000000000000081106'};
};
it('absent policy/binding and production remain off without provider I/O',()=>{
 const f=fixture();expect(commonPublicBrowserConfiguration({env:f.env,storage:f.storage,actualDoId:'physical'})).toBeUndefined();
 expect(commonPublicBrowserConfiguration({env:{...f.env,WALDO_ENVIRONMENT:'production'},storage:f.storage,actualDoId:'physical',policy:f.policy,loadSdk:commonBrowserFixtureLoader})).toBeUndefined();
});
it('same task retains exact grant across reconstruction and reservation persists without refund',async()=>{
 const f=fixture(),grant=await f.config().grant(f.task,f.ownerId);await f.config().reserveAllocation(grant);
 expect(await f.config().grant({...f.task,revision:2},f.ownerId)).toEqual(grant);await f.config().assertGrantCurrent(grant);
 expect(f.rows.get('common-public-browser-usage:fixture-policy')).toMatchObject({allocations:1,reservedBrowserMs:120000});
 await expect(f.config().reserveAllocation(grant)).rejects.toThrow('requires reconciliation');
 await expect(f.config().grant({...f.task,taskId:'another-task'},f.ownerId)).rejects.toThrow('task budget');
});
it('changed source/owner/authority/expiry and widened retained policy deny before allocation',async()=>{
 const f=fixture();await expect(f.config().grant({...f.task,sources:['workspace']},f.ownerId)).rejects.toThrow('source unavailable');
 await expect(f.config().grant(f.task,'another-owner')).rejects.toThrow('source unavailable');
 const grant=await f.config().grant(f.task,f.ownerId);f.changeAuthority();await expect(f.config().assertGrantCurrent(grant)).rejects.toThrow('authority changed');
 f.advance();await expect(f.config().reserveAllocation(grant)).rejects.toThrow('policy unavailable');
 expect((f.rows.get('common-public-browser-usage:fixture-policy') as any).allocations).toBe(0);
});
it('exact retained policy prevents resetting usage by changing limits or origins under same reference',async()=>{
 const f=fixture();await f.config().grant(f.task,f.ownerId);
 const wider=commonPublicBrowserConfiguration({env:f.env,storage:f.storage,actualDoId:'physical',policy:{...f.policy,maxAllocations:2},loadSdk:commonBrowserFixtureLoader,spend:f.spend,now:()=>10000})!;
 await expect(wider.grant(f.task,f.ownerId)).rejects.toThrow('retained policy conflict');
});

it('malformed retained time counters and widened task grant cannot authorize I/O',async()=>{
 const f=fixture();const grant=await f.config().grant(f.task,f.ownerId),key='common-public-browser-usage:fixture-policy';
 const row=f.rows.get(key) as any;
 f.rows.set(key,{...row,allocations:1,reservedBrowserMs:0});await expect(f.config().reserveAllocation(grant)).rejects.toThrow('retained policy conflict');
 f.rows.set(key,{...row,taskGrants:[{...grant,allowedOrigins:['https://outside.fixture.invalid']}]});await expect(f.config().assertGrantCurrent(grant)).rejects.toThrow('retained policy conflict');
});

it('verified directory owner principal passes the real supplier and distinct root ID does not',async()=>{
 const f=fixture();const {commonOwnerAuthority}=await import('../src/identity/common-owner-authority');
 const directory=commonOwnerAuthority(f.env),root=await directory.resolve('telegram',f.policy.subject,f.policy.doName);
 expect(root).not.toBeNull();
 const principal=`prn_${root!.directoryOwnerId.replaceAll('-','')}`;
 const grant=await f.config().grant(f.task,principal);expect(grant.ownerId).toBe(principal);await f.config().reserveAllocation(grant);await directory.assertCurrent(root!);expect(await f.config().grant(f.task,principal)).toEqual(grant);
 expect(root!.ownerId).not.toBe(principal);await expect(f.config().grant(f.task,root!.ownerId)).rejects.toThrow('source unavailable');
});

it('actual cleanup driver crosses pre-funded binding after expiry and stop without restoring acquire',async()=>{
 const f=fixture();let active=true,issued=0;
 (f.env as any).BROWSER={fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{
  issued++;const request=new Request(input,init),url=new URL(request.url);
  if(url.pathname==='/v1/sessions')return Response.json({sessions:active?[{sessionId:'retained-provider'}]:[]});
  return Response.json({});
 }} as never;
 const grant=await f.config().grant(f.task,f.ownerId);await f.config().reserveAllocation(grant);
 const session={id:'retained-browser',ownerId:f.ownerId,provider:'cloudflare_playwright',providerSessionId:'retained-provider',contextHandle:null,mode:'public',state:'active',generation:1,expiresAt:70000,updatedAt:10000};
 f.rows.set(`common-browser:${grant.taskId}`,{grant,session,tabs:[],allocation:'observed',cleanup:'pending'});
 f.advance();
 const config=f.config(),{cloudflareGeneralBrowser}=await import('../src/channels/cloudflare-general-browser');
 const loadSdk=async()=>({
  sessions:async(binding:any)=>(await (await binding.fetch('http://fake.host/v1/sessions')).json()).sessions,
  connect:async(binding:any,options:any)=>{
   await binding.fetch(`http://fake.host/v1/devtools/browser/${options.sessionId}?persistent=true`,{headers:{upgrade:'websocket'}});
   return {newBrowserCDPSession:async()=>({send:async(method:string)=>{expect(method).toBe('Browser.close');active=false;}}),close:async()=>{}};
  },
 });
 const driver=cloudflareGeneralBrowser({ownerId:f.ownerId,binding:config.binding,cleanupBinding:id=>config.cleanupBinding!(grant,id),loadSdk:loadSdk as never,now:()=>100001,deadline:()=>100001,admit:async()=>{throw Error('stopped');},authorizeRequest:async()=>false,maxScreenshotBytes:1024});
 await driver.terminate(session as never);expect(issued).toBe(3);expect(active).toBe(false);
 await expect(config.bindingForOperation!(grant,'new-action').fetch('http://fake.host/v1/devtools/browser',{method:'POST'})).rejects.toThrow('policy unavailable');
 await expect(driver.terminate(session as never)).rejects.toThrow('cleanup_unconfirmed');expect(issued).toBe(3);
 expect(()=>config.cleanupBinding!(grant,'another-provider')).toThrow('custody unavailable');
 expect(f.rows.get('common-spend:fictional-spend')).toMatchObject({reservedMicrousd:1,cleanup:[{issued:3,maxCalls:3}]});
});

it('reserves the allocation envelope once and refuses changed or unaffordable registration before acquire',async()=>{
 const f=fixture();f.spend.allocationMicrousd=80;
 const grant=await f.config().grant(f.task,f.ownerId);await f.config().reserveAllocation(grant);
 expect(f.rows.get('common-spend:fictional-spend')).toMatchObject({reservedMicrousd:80,cleanup:[{upperBoundMicrousd:80,maxCalls:3,issued:0}]});
 let calls=0;(f.env as any).BROWSER={fetch:async()=>{calls++;return Response.json({});}};
 await f.config().bindingForOperation!(grant,'funded-read').fetch('http://fake.host/v1/sessions');
 expect(calls).toBe(1);expect(f.rows.get('common-spend:fictional-spend')).toMatchObject({reservedMicrousd:80,calls:[{upperBoundMicrousd:0}]});
 f.spend.allocationMicrousd=81;expect(()=>f.config().bindingForOperation!(grant,'changed-read')).toThrow('retained policy conflict');
 const denied=fixture();denied.spend.allocationMicrousd=101;const deniedGrant=await denied.config().grant(denied.task,denied.ownerId);
 await expect(denied.config().reserveAllocation(deniedGrant)).rejects.toThrow('spend limit exceeded');
 expect(denied.rows.get('common-public-browser-usage:fixture-policy')).toMatchObject({allocations:0,reservedBrowserMs:0});
 expect(denied.rows.has('common-spend:fictional-spend')).toBe(false);
 const invalid=fixture();invalid.spend.quote=()=>1;expect(()=>invalid.config()).toThrow('allocation price registration invalid');
});

it('registered count witness reaches the metered model gateway with exact material',async()=>{
 const f=fixture();let seen:unknown;
 const spend={...f.spend,quote:(kind:'model'|'browser',request:unknown)=>{if(kind==='model')seen=request;return kind==='browser'?0:1;},countModel:async()=>42};
 const config=commonPublicBrowserConfiguration({env:f.env,storage:f.storage,actualDoId:'physical',policy:f.policy,loadSdk:commonBrowserFixtureLoader,spend,now:()=>10000})!;
 const gateway=config.meterGateway!({complete:async()=>({ok:true})} as never);
 const scope={runId:'fixture-run',attempt:'fixture-attempt',admit:()=>{}};
 expect(await gateway.complete({request:{max_tokens:5},runScope:scope} as never)).toEqual({ok:true});
 expect((seen as {countedInputTokens?:number}).countedInputTokens).toBe(42);
 expect(f.rows.get('common-spend:fictional-spend')).toMatchObject({reservedMicrousd:1,calls:[{upperBoundMicrousd:1}]});
});

it('one staging browser registration does not install its spend gate on another physical owner',()=>{
 const f=fixture();f.rows.set('do_name','another-owner');
 expect(f.config()).toBeUndefined();
 f.rows.set('do_name',f.policy.doName);f.rows.set('telegram_subject','81107');
 expect(f.config()).toBeUndefined();
 expect([...f.rows.keys()].some(key=>key.startsWith('common-spend:'))).toBe(false);
});
