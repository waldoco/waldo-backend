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
 const config=()=>commonPublicBrowserConfiguration({env,storage,actualDoId:'physical',policy,loadSdk:commonBrowserFixtureLoader,now:()=>now})!;
 return {config,env,storage,policy,rows,advance:()=>{now=100001;},changeAuthority:()=>{revision='2';},task:{taskId:'canonical-fixture-task',revision:1,sources:['web'] as const,ready:true,startRef:'fixture-input'},ownerId:'prn_10000000000000000000000000081106'};
};
it('absent policy/binding and production remain off without provider I/O',()=>{
 const f=fixture();expect(commonPublicBrowserConfiguration({env:f.env,storage:f.storage,actualDoId:'physical'})).toBeUndefined();
 expect(commonPublicBrowserConfiguration({env:{...f.env,WALDO_ENVIRONMENT:'production'},storage:f.storage,actualDoId:'physical',policy:f.policy,loadSdk:commonBrowserFixtureLoader})).toBeUndefined();
});
it('same task retains exact grant across reconstruction and reservation persists without refund',async()=>{
 const f=fixture(),grant=await f.config().grant(f.task,f.ownerId);await f.config().reserveAllocation(grant);
 expect(await f.config().grant({...f.task,revision:2},f.ownerId)).toEqual(grant);await f.config().assertGrantCurrent(grant);
 expect(f.rows.get('common-public-browser-usage:fixture-policy')).toMatchObject({allocations:1,reservedBrowserMs:120000});
 await expect(f.config().reserveAllocation(grant)).rejects.toThrow('allocation budget');
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
 const wider=commonPublicBrowserConfiguration({env:f.env,storage:f.storage,actualDoId:'physical',policy:{...f.policy,maxAllocations:2},loadSdk:commonBrowserFixtureLoader,now:()=>10000})!;
 await expect(wider.grant(f.task,f.ownerId)).rejects.toThrow('retained policy conflict');
});

it('malformed retained time counters and widened task grant cannot authorize I/O',async()=>{
 const f=fixture();const grant=await f.config().grant(f.task,f.ownerId),key='common-public-browser-usage:fixture-policy';
 const row=f.rows.get(key) as any;
 f.rows.set(key,{...row,allocations:1,reservedBrowserMs:0});await expect(f.config().reserveAllocation(grant)).rejects.toThrow('retained policy conflict');
 f.rows.set(key,{...row,taskGrants:[{...grant,allowedOrigins:['https://outside.fixture.invalid']}]});await expect(f.config().assertGrantCurrent(grant)).rejects.toThrow('retained policy conflict');
});

it('actual host directory admission principal passes the real supplier and distinct root ID does not',async()=>{
 const f=fixture();const {commonOwnerHost}=await import('../src/channels/common-owner-host');const {ownerMessageAdmission}=await import('../src/identity/owner-message-admission');const {commonOwnerAuthority}=await import('../src/identity/common-owner-authority');
 const host=commonOwnerHost({...f.env,COMMON_OWNER_TASKS:'1',WALDO_OWNER_DO_NAMESPACE:'fixture'},f.storage,'physical')!;
 const admission=await ownerMessageAdmission({lookup:host.lookup,scope:{runId:'fixture-run',attempt:'fixture-attempt',deadline:60000,signal:new AbortController().signal,admit:()=>{},commit:work=>work()},locator:{environment:'staging',namespace:'fixture',doName:f.policy.doName,doId:'physical'},actualDoId:'physical',expectedDoId:()=> 'physical',allowedDoNames:[f.policy.doName],provider:'telegram',subject:f.policy.subject,text:'Read public documentation.',occurrenceKey:'fixture-occurrence',occurredAt:9000,now:()=>10000});
 const principal=admission.invocation.verified_authority.principal_ref;
 const grant=await f.config().grant(f.task,principal);expect(grant.ownerId).toBe(principal);await f.config().reserveAllocation(grant);await admission.assertCurrent();expect(await f.config().grant(f.task,principal)).toEqual(grant);
 const root=await commonOwnerAuthority(f.env).resolve('telegram',f.policy.subject,f.policy.doName);expect(root!.ownerId).not.toBe(principal);await expect(f.config().grant(f.task,root!.ownerId)).rejects.toThrow('source unavailable');
});
