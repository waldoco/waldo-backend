import {afterEach,expect,it,vi} from 'vitest';
import {ownerBrowserRuntime} from '../src/channels/owner-browser-runtime';
import {registerCommonBrowserSdk} from '../src/channels/common-staging-registration';
import {commonSpendReservation} from '../src/channels/common-spend-reservation';
import {assertOwnerPublicBrowserCapacity,ownerPublicBrowserAccounting,ownerPublicBrowserDurationMicrousd,reserveOwnerPublicBrowser} from '../src/channels/owner-public-browser-spend';
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async()=>({directoryOwnerId:'10000000-0000-0000-0000-000000000002',custodyDigest:'b'.repeat(64)})})}));
const calls:string[]=[];let alive=false,cleanupConfirmed=true,clock=Date.now();
afterEach(()=>vi.restoreAllMocks());
registerCommonBrowserSdk(async()=>({
 acquire:async()=>{calls.push('acquire');alive=true;return {sessionId:'owned-public-read'};},
 connect:async()=>({newContext:async()=>({route:async()=>{},newPage:async()=>({mainFrame:()=>null,setDefaultTimeout(){},goto:async()=>({status:()=>200}),url:()=> 'https://example.com/menu',title:async()=> 'Menu',locator:()=>({innerText:async()=> 'Vegetarian pasta'})}),close:async()=>{}}),newBrowserCDPSession:async()=>({send:async()=>{calls.push('close');if(cleanupConfirmed)alive=false;}}),close:async()=>{}}),
 sessions:async()=>{clock+=4000;return alive?[{sessionId:'owned-public-read'}]:[];},endpointURLString:()=>'',
} as never));
function fixture(){
 calls.length=0;alive=false;cleanupConfirmed=true;clock=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>clock);const rows=new Map<string,any>([['do_name','public-owner'],['telegram_subject','81102']]);
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>{calls.push('reserve');rows.set(key,structuredClone(value));},list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix))},transactionSync:<T>(work:()=>T)=>{const before=structuredClone([...rows]);try{return work();}catch(cause){rows.clear();for(const [key,value] of before)rows.set(key,value);throw cause;}}} as unknown as DurableObjectStorage;
 const scope={runId:'public-run',attempt:'attempt',deadline:Date.now()+60000,signal:new AbortController().signal,admit(){},commit:<T>(work:()=>T)=>work()};
 const env={WALDO_ENVIRONMENT:'staging',BROWSER:{},TELEGRAM_OWNER_DO:{idFromName:()=>({toString:()=> 'physical'})}} as never;
 const runtime=ownerBrowserRuntime({env,storage,actualDoId:'physical',activeScope:()=>scope});
 const fallback={name:'browse_page',handle:vi.fn(()=>{throw Error('No paid alternative');})} as never;
 const args={provider:'cloudflare_playwright' as const,url:'https://example.com/menu',instruction:'Read menu'};
 const ctx={authenticatedUserId:'prn_10000000000000000000000000000002',runScope:scope,egressAllowlist:['*'],toolCallId:'read-1'};
 return {rows,storage,env,runtime,fallback,args,ctx,month:()=>`common-public-browser-month:${new Date(Date.now()).toISOString().slice(0,7)}`,advance:(ms:number)=>{clock+=ms;},reconstruct:()=>ownerBrowserRuntime({env,storage,actualDoId:'physical',activeScope:()=>scope}),read:(id='read-1')=>runtime.read(fallback).handle(args,{...ctx,toolCallId:id} as never)};
}
const expiredDeclaration=(limitMicrousd:number)=>JSON.stringify({policy:{ref:'expired',doName:'public-owner',subject:'81102',directoryOwnerId:'10000000-0000-0000-0000-000000000002',createdAt:1,expiresAt:2,allowedOrigins:['*'],maxAllocations:1,maxReservedBrowserMs:20000,lifetimeMs:10000,maxScreenshotBytes:1024},billing:{cloudflareAccountId:'a'.repeat(32),conservativeWorstCase:true},spend:{limitMicrousd,maxCalls:100,validUntil:2}});
it('ordinary owner Cloudflare read works without trial registration and reserves retained owner cost before acquire',async()=>{
 const f=fixture();f.ctx.authenticatedUserId='prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';const {read,rows}=f,result=await read();
 expect(result).toMatchObject({ok:true,data:{provider:'cloudflare_playwright',data:{text:'Vegetarian pasta'}}});
 expect(calls.indexOf('reserve')).toBeLessThan(calls.indexOf('acquire'));expect(calls).toContain('close');expect(alive).toBe(false);
 expect(rows.get(f.month())).toBe(100);
});
it('lower declared ceiling survives descriptor removal and constrains later registered funded calls atomically',async()=>{
 const f=fixture();(f.env as any).COMMON_BROWSER_REGISTRATION=expiredDeclaration(2091300);
 f.rows.set('owner-public-browser-spend:v1',{ownerId:f.ctx.authenticatedUserId,custodyDigest:'b'.repeat(64),limitMicrousd:20000000,reservedMicrousd:2090000,intents:['old']});f.rows.set(f.month(),2090000);
 expect(await f.read()).toMatchObject({ok:true});delete (f.env as any).COMMON_BROWSER_REGISTRATION;
 // A new calendar month cannot restore a lost total ceiling.
 f.advance(32*86400000);
 const snapshot=structuredClone([...f.rows]);expect(await f.read('read-2')).toMatchObject({ok:false});expect([...f.rows]).toEqual(snapshot);
 const ownerId='prn_10000000000000000000000000000002',ledger=commonSpendReservation(f.storage,{ref:'later-funded',ownerId,validUntil:Date.now()+60000,limitMicrousd:3000000,maxCalls:100},Date.now,()=>{},amount=>assertOwnerPublicBrowserCapacity(f.storage,ownerId,3000000,amount));
 expect(()=>ledger.reserve('model',1201)).toThrow('cost ceiling');expect(ledger.reserved()).toBe(0);expect([...f.rows]).toEqual(snapshot);
});
it('expired trial registration does not block normal reads or reset prior reservations',async()=>{
 const f=fixture();(f.env as any).COMMON_BROWSER_REGISTRATION=JSON.stringify({policy:{ref:'expired',doName:'public-owner',subject:'81102',directoryOwnerId:'10000000-0000-0000-0000-000000000002',createdAt:1,expiresAt:2,allowedOrigins:['*'],maxAllocations:1,maxReservedBrowserMs:20000,lifetimeMs:10000,maxScreenshotBytes:1024},billing:{cloudflareAccountId:'a'.repeat(32),conservativeWorstCase:true},spend:{limitMicrousd:10000000,maxCalls:100,validUntil:2}});
 const ownerId=f.ctx.authenticatedUserId;
 f.rows.set('common-spend:expired',{policy:{ref:'expired',ownerId,validUntil:2,limitMicrousd:10000000,maxCalls:100},reservedMicrousd:100,calls:[{id:'prior',upperBoundMicrousd:100}],cleanup:[]});
 const prior=structuredClone(f.rows.get('common-spend:expired'));
 expect(await f.read()).toMatchObject({ok:true});expect(f.rows.get('common-spend:expired')).toEqual(prior);
 expect(f.rows.has('common_owner_browser_registration_v1')).toBe(false);
});
it('reconstruction cannot replay settled intents; ordinary model turns remain ungated',async()=>{
 const f=fixture();expect(await f.read()).toMatchObject({ok:true});expect(await f.read('read-2')).toMatchObject({ok:true});
 const before=calls.filter(x=>x==='acquire').length,snapshot=structuredClone([...f.rows]);
 expect(await f.reconstruct().read(f.fallback).handle(f.args,{...f.ctx,toolCallId:'read-1'} as never)).toMatchObject({ok:false});expect(await f.read('read-1')).toMatchObject({ok:false});
 expect(calls.filter(x=>x==='acquire')).toHaveLength(before);expect([...f.rows]).toEqual(snapshot);
 expect(f.runtime.gateway()).toBeUndefined();
});
it.each(['foreign','corrupt','monthly','revoked','lower_ceiling'])('rejects %s retained authority/accounting before provider allocation',async kind=>{
 const f=fixture();
 if(kind==='foreign')f.rows.set('common-spend:old',{policy:{ownerId:'another-owner'}});
 if(kind==='corrupt')f.rows.set('owner-public-browser-spend:v1',{ownerId:f.ctx.authenticatedUserId,custodyDigest:'b'.repeat(64),reservedMicrousd:0,intents:['prior']});
 if(kind==='monthly')f.rows.set('common-public-browser-month:'+new Date().toISOString().slice(0,7),-1);
 if(kind==='revoked')f.rows.set('telegram_unlinked',true);
 if(kind==='lower_ceiling')(f.env as any).COMMON_BROWSER_REGISTRATION=expiredDeclaration(1249);
 const snapshot=structuredClone([...f.rows]);expect(await f.read()).toMatchObject({ok:false});expect(calls).not.toContain('acquire');expect([...f.rows]).toEqual(snapshot);
});

it('three sequential completed public reads do not exhaust a five dollar monthly allowance', async () => {
 const f=fixture();
 for(let i=0;i<3;i++) expect(await f.read(`useful-${i}`)).toMatchObject({ok:true});
 expect(f.rows.get('common-public-browser-month:'+new Date().toISOString().slice(0,7))).toBeLessThan(10000);
});

it('failed cleanup retains the full duration reserve and monthly exhaustion rejects before acquiring',async()=>{
 const f=fixture();cleanupConfirmed=false;
 expect(await f.read()).toMatchObject({ok:false,error:expect.stringContaining('cleanup is unconfirmed')});
 expect(f.rows.get(f.month())).toBe(1250);
 expect(ownerPublicBrowserAccounting(f.storage,f.ctx.authenticatedUserId,'b'.repeat(64))?.reservedMicrousd).toBe(1250);
 f.rows.set(f.month(),4999000);const snapshot=structuredClone([...f.rows]),before=calls.filter(x=>x==='acquire').length;
 expect(await f.read('read-2')).toMatchObject({ok:false});expect([...f.rows]).toEqual(snapshot);expect(calls.filter(x=>x==='acquire')).toHaveLength(before);
});
const reserve=(f:ReturnType<typeof fixture>,intent:string,declaredLimitMicrousd?:number)=>reserveOwnerPublicBrowser({storage:f.storage,ownerId:f.ctx.authenticatedUserId,custodyDigest:'b'.repeat(64),intent,reservedBrowserMs:50000,now:Date.now(),declaredLimitMicrousd,assertCurrent(){}});
it('duration estimates round upward without the registered worst-case envelope',()=>{
 expect(ownerPublicBrowserDurationMicrousd(50000)).toBe(1250);
 expect(ownerPublicBrowserDurationMicrousd(4001)).toBe(101);
 expect(ownerPublicBrowserDurationMicrousd(3600000)).toBe(90000);
 for(const bad of [-1,NaN,Infinity,0.1])expect(()=>ownerPublicBrowserDurationMicrousd(bad)).toThrow();
});
it('settlement is atomic, idempotent and tied to the original month, while keeping replay tombstones',()=>{
 const f=fixture(),first=reserve(f,'first'),second=reserve(f,'second'),month=f.month();
 expect(f.rows.get(month)).toBe(2500);f.advance(32*86400000);const currentMonth=f.month();f.rows.set(currentMonth,700);
 first.settle(4000);expect(f.rows.get(month)).toBe(1350);expect(f.rows.get(currentMonth)).toBe(700);
 const snapshot=structuredClone([...f.rows]);first.settle(4000);expect(()=>first.settle(0)).toThrow('settlement conflict');expect([...f.rows]).toEqual(snapshot);
 expect(()=>reserve(f,'first')).toThrow('prior effect');second.settle(8000);expect(f.rows.get(month)).toBe(300);
 expect(ownerPublicBrowserAccounting(f.storage,f.ctx.authenticatedUserId,'b'.repeat(64))).toMatchObject({reservedMicrousd:300,intents:['first','second']});
});
it.each(['owner','custody','intent','month','duration','month_total','amount'])('settlement rejects changed %s without touching retained costs',kind=>{
 const f=fixture(),held=reserve(f,'first'),row=f.rows.get('owner-public-browser-spend:v2');
 if(kind==='owner')row.ownerId='foreign';if(kind==='custody')row.custodyDigest='a'.repeat(64);
 if(kind==='intent')row.reservations[0].intent='other';if(kind==='month')row.reservations[0].month='2020-01';
 if(kind==='duration')row.reservations[0].reservedBrowserMs=1;if(kind==='month_total')f.rows.set(f.month(),0);
 if(kind==='amount')row.reservations[0].chargedMicrousd=0;
 const snapshot=structuredClone([...f.rows]);expect(()=>held.settle(4000)).toThrow();expect([...f.rows]).toEqual(snapshot);
});
it('storage failure rolls back settlement and a later retry settles exactly once',()=>{
 const f=fixture(),held=reserve(f,'first'),snapshot=structuredClone([...f.rows]);
 const put=f.storage.kv.put.bind(f.storage.kv);let fail=true;
 vi.spyOn(f.storage.kv,'put').mockImplementation(((key:string,value:unknown)=>{if(key===f.month()&&fail)throw Error('storage fault');return put(key,value);}) as typeof f.storage.kv.put);
 expect(()=>held.settle(4000)).toThrow('storage fault');expect([...f.rows]).toEqual(snapshot);
 fail=false;held.settle(4000);held.settle(4000);expect(f.rows.get(f.month())).toBe(100);
});
it('legacy charges and replay evidence survive new settlement without fabricating old refunds',()=>{
 const f=fixture(),legacy={ownerId:f.ctx.authenticatedUserId,custodyDigest:'b'.repeat(64),limitMicrousd:20000000,reservedMicrousd:2090000,intents:['old']};
 f.rows.set('owner-public-browser-spend:v1',structuredClone(legacy));f.rows.set(f.month(),2090000);
 const held=reserve(f,'new');held.settle(4000);
 expect(f.rows.get('owner-public-browser-spend:v1')).toEqual(legacy);expect(f.rows.get(f.month())).toBe(2090100);
 expect(ownerPublicBrowserAccounting(f.storage,f.ctx.authenticatedUserId,'b'.repeat(64))).toMatchObject({reservedMicrousd:2090100,intents:['old','new'],limitMicrousd:undefined});
 expect(()=>reserve(f,'old')).toThrow('prior effect');
});
it('lower legacy and common-spend ceilings remain binding',()=>{
 for(const kind of ['legacy','common-spend']){
  const f=fixture();
  if(kind==='legacy')f.rows.set('owner-public-browser-spend:v1',{ownerId:f.ctx.authenticatedUserId,custodyDigest:'b'.repeat(64),limitMicrousd:2091000,reservedMicrousd:2090000,intents:['old']});
  else f.rows.set('common-spend:old',{policy:{ref:'old',ownerId:f.ctx.authenticatedUserId,validUntil:2,limitMicrousd:2000,maxCalls:100},reservedMicrousd:1000,calls:[{id:'old',upperBoundMicrousd:1000}],cleanup:[]});
  const snapshot=structuredClone([...f.rows]);expect(()=>reserve(f,'new')).toThrow('cost ceiling');expect([...f.rows]).toEqual(snapshot);vi.restoreAllMocks();
 }
});
it('ordinary read accounting has no invented lifetime ceiling across calendar months',()=>{
 const f=fixture(),reservations=Array.from({length:16000},(_,i)=>({intent:`old-${i}`,month:`2025-0${Math.floor(i/4000)+1}`,reservedBrowserMs:50000,chargedMicrousd:1250,settled:false}));
 for(let month=1;month<=4;month++)f.rows.set(`common-public-browser-month:2025-0${month}`,5000000);
 f.rows.set('owner-public-browser-spend:v2',{ownerId:f.ctx.authenticatedUserId,custodyDigest:'b'.repeat(64),reservedMicrousd:20000000,reservations});
 reserve(f,'new');expect(f.rows.get(f.month())).toBe(1250);
 expect(ownerPublicBrowserAccounting(f.storage,f.ctx.authenticatedUserId,'b'.repeat(64))?.reservedMicrousd).toBe(20001250);
});

it('over-bound or invalid measured duration keeps the full unresolved reservation',()=>{
 const f=fixture(),held=reserve(f,'first'),snapshot=structuredClone([...f.rows]);
 for(const duration of [50001,100000,-1,NaN,0.1]){expect(()=>held.settle(duration)).toThrow();expect([...f.rows]).toEqual(snapshot);}
 expect(f.rows.get(f.month())).toBe(1250);expect(f.rows.get('owner-public-browser-spend:v2').reservations[0].settled).toBe(false);
});
