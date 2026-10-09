import {it,expect,vi,afterEach} from 'vitest';
import {commonPublicBrowserConfiguration,type CommonPublicReadPolicy} from '../src/channels/common-public-browser-configuration';
import {commonStagingRegistration,COMMON_BROWSER_MONTH_CEILING_MICROUSD} from '../src/channels/common-staging-registration';
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

it('rotating policy reference cannot reset browser spending within the same billing month',async()=>{
 const f=fixture();const start=Date.parse('2026-10-08T12:00:00Z');
 const registrations=['period-trial-a','period-trial-b'].map(ref=>commonStagingRegistration({WALDO_ENVIRONMENT:'staging',COMMON_BROWSER_REGISTRATION:JSON.stringify({
  policy:{...f.policy,ref,createdAt:start-1000,expiresAt:start+600000,maxAllocations:2,maxReservedBrowserMs:960000,lifetimeMs:120000},
  billing:{cloudflareAccountId:'a'.repeat(32),conservativeWorstCase:true},
  spend:{limitMicrousd:10000000,maxCalls:100,validUntil:start+600000},
 })})!);
 expect(registrations[0]!.spend.allocationMicrousd).toBe(2090000);
 let error:unknown;let total=0;
 for(const reg of registrations){
  const config=commonPublicBrowserConfiguration({env:f.env,storage:f.storage,actualDoId:'physical',policy:reg.policy,loadSdk:commonBrowserFixtureLoader,spend:reg.spend,now:()=>start})!;
  for(let i=0;i<2;i++)try{
   const grant=await config.grant({...f.task,taskId:reg.policy.ref+':'+i},f.ownerId);await config.reserveAllocation(grant);total+=reg.spend.allocationMicrousd;
  }catch(e){error=e;}
 }
 expect(total,'browser allocations reserved in one month').toBeLessThanOrEqual(COMMON_BROWSER_MONTH_CEILING_MICROUSD);
 expect(error,'must deny allocation crossing the monthly ceiling').toBeDefined();
});
