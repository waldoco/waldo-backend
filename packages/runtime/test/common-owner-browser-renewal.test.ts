import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { commonStagingRegistration } from '../src/channels/common-staging-registration';
import { commonOwnerBrowserRegistration } from '../src/channels/common-owner-browser-registration';
const authority=vi.hoisted(()=>({custody:'a'.repeat(64)}));
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async(_p:string,subject:string,doName:string)=>({directoryOwnerId:'10000000-0000-0000-0000-000000000001',custodyDigest:authority.custody,subject,doName})})}));
vi.mock('../src/channels/common-public-browser-configuration',async load=>({...await load<typeof import('../src/channels/common-public-browser-configuration')>(),commonPublicBrowserConfiguration:()=>({ownerId:'owner'})}));
beforeEach(()=>{authority.custody='a'.repeat(64);});
afterEach(()=>vi.restoreAllMocks());
function fixture(){
 const now=Date.now();
 const raw={scope:'verified_owners',policy:{ref:'renew',createdAt:now-10000,expiresAt:now+10000,allowedOrigins:['*'],maxAllocations:2,maxReservedBrowserMs:40000,lifetimeMs:10000,maxScreenshotBytes:1024},billing:{cloudflareAccountId:'a'.repeat(32),conservativeWorstCase:true},spend:{limitMicrousd:10000000,maxCalls:100,validUntil:now+10000}};
 const rows=new Map<string,any>([['do_name','owner'],['telegram_subject','1']]);
 const storage={kv:{get:(k:string)=>rows.get(k),put:(k:string,v:any)=>rows.set(k,structuredClone(v)),list:({prefix}:{prefix:string})=>[...rows].filter(([k])=>k.startsWith(prefix))},transactionSync:(fn:()=>any)=>{const prior=structuredClone([...rows]);try{return fn();}catch(e){rows.clear();for(const [k,v]of prior)rows.set(k,v);throw e;}}} as unknown as DurableObjectStorage;
 const env={WALDO_ENVIRONMENT:'staging',COMMON_BROWSER_REGISTRATION:JSON.stringify(raw),TELEGRAM_OWNER_DO:{idFromName:()=>({toString:()=> 'physical'})}} as never;
 const create=()=>commonOwnerBrowserRegistration({env,storage,actualDoId:'physical'});
 const extend=()=>{raw.policy.expiresAt+=10000;raw.spend.validUntil+=10000;(env as any).COMMON_BROWSER_REGISTRATION=JSON.stringify(raw);};
 return {rows,storage,raw,env,create,extend};
}
function usageFor(f:ReturnType<typeof fixture>){
 const policy=f.rows.get('common_owner_browser_registration_v1').registration.policy;
 const price=commonStagingRegistration({WALDO_ENVIRONMENT:'staging',COMMON_BROWSER_REGISTRATION:JSON.stringify(f.rows.get('common_owner_browser_registration_v1').registration)})!.spend.allocationMicrousd;
 return {policy,custodyDigest:authority.custody,allocationMicrousd:price,allocations:1,reservedBrowserMs:policy.lifetimeMs*2,taskGrants:[{ref:policy.ref,ownerId:`prn_${policy.directoryOwnerId.replaceAll('-','')}`,taskId:'old',expiresAt:policy.expiresAt,allowedOrigins:policy.allowedOrigins,lifetimeMs:policy.lifetimeMs,maxScreenshotBytes:policy.maxScreenshotBytes}]};
}
it('same-ref expiry renewal preserves every existing reservation, allocation, month total and expired grant',async()=>{
 const f=fixture();await f.create().configuration();
 const pinned=f.rows.get('common_owner_browser_registration_v1'),ref=pinned.registration.policy.ref;
 const usage=usageFor(f);
 const policy={ref,ownerId:'prn_10000000000000000000000000000001',validUntil:f.raw.spend.validUntil,limitMicrousd:10000000,maxCalls:100};
 const ledger={policy,reservedMicrousd:7,calls:[{id:'already-issued',upperBoundMicrousd:3}],cleanup:[{id:'old-cleanup',upperBoundMicrousd:4,maxCalls:3,issued:2}]};
 f.rows.set(`common-public-browser-usage:${ref}`,structuredClone(usage));f.rows.set(`common-spend:${ref}`,structuredClone(ledger));f.rows.set('common-public-browser-month:2026-10',7);
 f.rows.set('common-browser:old',{allocation:'observed',cleanup:'closed',session:{state:'ended',expiresAt:f.raw.policy.expiresAt}});
 vi.spyOn(Date,'now').mockReturnValue(f.raw.policy.expiresAt+5000);
 f.extend();await expect(f.create().configuration()).resolves.toMatchObject({ownerId:'owner'});
 expect(f.rows.get(`common-public-browser-usage:${ref}`)).toEqual({...usage,policy:{...usage.policy,expiresAt:f.raw.policy.expiresAt}});
 expect(f.rows.get(`common-spend:${ref}`)).toEqual({...ledger,policy:{...policy,validUntil:f.raw.spend.validUntil}});
 expect(f.rows.get('common-public-browser-month:2026-10')).toBe(7);
 expect(f.rows.get('common-browser:old').session.expiresAt).toBe(usage.taskGrants[0]!.expiresAt);
 const after=structuredClone([...f.rows]);await f.create().configuration();expect([...f.rows]).toEqual(after);
});

it.each(['active','starting','pending','failed_cleanup','unknown_allocation'])('renewal refuses %s session custody without modifying any row',async kind=>{
 const f=fixture();await f.create().configuration();
 f.rows.set('common-browser:retained',{allocation:kind==='unknown_allocation'?'prepared':'observed',cleanup:kind==='pending'?'pending':kind==='active'||kind==='starting'?undefined:'closed',cleanupFailed:kind==='failed_cleanup',session:{state:kind==='active'?'active':kind==='starting'?'starting':'ended'}});
 const before=structuredClone([...f.rows]);f.extend();await expect(f.create().configuration()).rejects.toThrow('confirmed cleanup');expect([...f.rows]).toEqual(before);
});
it.each(['ref','origins','cap','createdAt','billing','custody','shorter'])('renewal rejects changed %s without refilling allowance',async kind=>{
 const f=fixture();await f.create().configuration();const before=structuredClone([...f.rows]);f.extend();
 if(kind==='ref')f.raw.policy.ref='fresh';
 if(kind==='origins')f.raw.policy.allowedOrigins=['https://example.com'];
 if(kind==='cap')f.raw.spend.maxCalls++;
 if(kind==='createdAt')f.raw.policy.createdAt--;
 if(kind==='billing')f.raw.billing.cloudflareAccountId='b'.repeat(32);
 if(kind==='custody')authority.custody='b'.repeat(64);
 if(kind==='shorter')f.raw.spend.validUntil-=15000;
 (f.env as any).COMMON_BROWSER_REGISTRATION=JSON.stringify(f.raw);
 await expect(f.create().configuration()).rejects.toThrow('reconciliation');expect([...f.rows]).toEqual(before);
});
it('failed final pin write rolls back expiry changes to usage and spend together',async()=>{
 const f=fixture();await f.create().configuration();const pin=f.rows.get('common_owner_browser_registration_v1'),ref=pin.registration.policy.ref;
 f.rows.set(`common-public-browser-usage:${ref}`,{...usageFor(f),allocations:0,reservedBrowserMs:0,taskGrants:[]});
 f.rows.set(`common-spend:${ref}`,{policy:{ref,ownerId:'prn_10000000000000000000000000000001',validUntil:f.raw.spend.validUntil,limitMicrousd:10000000,maxCalls:100},reservedMicrousd:0,calls:[],cleanup:[]});
 const before=structuredClone([...f.rows]),put=f.storage.kv.put.bind(f.storage.kv);
 vi.spyOn(f.storage.kv,'put').mockImplementation(((key:string,value:any)=>{if(key==='common_owner_browser_registration_v1')throw Error('simulated storage failure');return put(key,value);}) as any);
 f.extend();await expect(f.create().configuration()).rejects.toThrow('simulated storage failure');expect([...f.rows]).toEqual(before);
});

const capsule=(f:ReturnType<typeof fixture>)=>({doName:'owner',subject:'1',directoryOwnerId:'10000000-0000-0000-0000-000000000001',expiresAt:f.raw.spend.validUntil,maxRuns:2,maxModelCalls:8,priorRuns:1,priorModelCalls:2,priorMicrousd:3});
it('first exact-owner acceptance attachment gates synchronously and pins immutable test history without a new ref',async()=>{
 const f=fixture();await f.create().configuration();const acceptance=capsule(f);
 (f.raw as any).acceptance=acceptance;(f.env as any).COMMON_BROWSER_REGISTRATION=JSON.stringify(f.raw);
 expect(f.create().acceptanceSelected).toBe(true);
 await f.create().configuration();
 expect(f.rows.get('common_owner_browser_registration_v1').registration.acceptance).toEqual(acceptance);
 const pinned=structuredClone([...f.rows]);
 (f.env as any).COMMON_BROWSER_REGISTRATION='';
 expect(f.create().acceptanceSelected).toBe(true);
 expect([...f.rows]).toEqual(pinned);
});

it.each(['allocation_count','reserved_time','price','grant_owner','grant_expiry','duplicate_grant','custody','policy'])('renewal refuses corrupt retained %s before mutation',async kind=>{
 const f=fixture();await f.create().configuration();const usage=usageFor(f);
 if(kind==='allocation_count')usage.allocations=3;
 if(kind==='reserved_time')usage.reservedBrowserMs++;
 if(kind==='price')usage.allocationMicrousd++;
 if(kind==='grant_owner')usage.taskGrants[0]!.ownerId='foreign';
 if(kind==='grant_expiry')usage.taskGrants[0]!.expiresAt++;
 if(kind==='duplicate_grant')usage.taskGrants.push(structuredClone(usage.taskGrants[0]!));
 if(kind==='custody')usage.custodyDigest='b'.repeat(64);
 if(kind==='policy')usage.policy={...usage.policy,maxAllocations:3};
 f.rows.set(`common-public-browser-usage:${usage.policy.ref}`,usage);const before=structuredClone([...f.rows]);f.extend();
 await expect(f.create().configuration()).rejects.toThrow();expect([...f.rows]).toEqual(before);
});

it('a capsule for another physical owner leaves ordinary selection ungated and is not derived into their registration',async()=>{
 const f=fixture();(f.raw as any).acceptance={...capsule(f),doName:'another-owner',subject:'2'};(f.env as any).COMMON_BROWSER_REGISTRATION=JSON.stringify(f.raw);
 const registration=f.create();expect(registration.acceptanceSelected).toBe(false);await registration.configuration();
 expect(f.rows.get('common_owner_browser_registration_v1').registration.acceptance).toBeUndefined();
});
it('an exact physical capsule with a different directory owner fails before pinning',async()=>{
 const f=fixture();(f.raw as any).acceptance={...capsule(f),directoryOwnerId:'20000000-0000-0000-0000-000000000002'};(f.env as any).COMMON_BROWSER_REGISTRATION=JSON.stringify(f.raw);
 expect(f.create().acceptanceSelected).toBe(true);await expect(f.create().configuration()).rejects.toThrow('acceptance owner unavailable');
 expect(f.rows.has('common_owner_browser_registration_v1')).toBe(false);
});
it.each(['expiry','prior_calls','removal'])('attached acceptance %s cannot be changed by later expiry renewal',async kind=>{
 const f=fixture();(f.raw as any).acceptance=capsule(f);(f.env as any).COMMON_BROWSER_REGISTRATION=JSON.stringify(f.raw);await f.create().configuration();
 const before=structuredClone([...f.rows]);f.extend();
 if(kind==='expiry')(f.raw as any).acceptance.expiresAt--;
 if(kind==='prior_calls')(f.raw as any).acceptance.priorModelCalls++;
 if(kind==='removal')delete (f.raw as any).acceptance;
 (f.env as any).COMMON_BROWSER_REGISTRATION=JSON.stringify(f.raw);
 await expect(f.create().configuration()).rejects.toThrow('reconciliation');expect([...f.rows]).toEqual(before);
});
it('later policy expiry renewal preserves the immutable earlier acceptance deadline',async()=>{
 const f=fixture();const acceptance=capsule(f);(f.raw as any).acceptance=acceptance;(f.env as any).COMMON_BROWSER_REGISTRATION=JSON.stringify(f.raw);await f.create().configuration();
 f.extend();await f.create().configuration();expect(f.rows.get('common_owner_browser_registration_v1').registration.acceptance).toEqual(acceptance);
});

it.each([-1,NaN,5000001])('renewal refuses invalid monthly total %s without changing history',async total=>{
 const f=fixture();await f.create().configuration();f.rows.set('common-public-browser-month:2026-10',total);const before=structuredClone([...f.rows]);f.extend();
 await expect(f.create().configuration()).rejects.toThrow();expect([...f.rows]).toEqual(before);
});
it('missing capsule identity cannot invoke physical lookup or select an ordinary owner',()=>{
 const f=fixture();f.rows.delete('do_name');f.rows.delete('telegram_subject');(f.raw as any).acceptance={};(f.env as any).COMMON_BROWSER_REGISTRATION=JSON.stringify(f.raw);
 const lookup=vi.spyOn((f.env as any).TELEGRAM_OWNER_DO,'idFromName').mockImplementation(()=>{throw Error('invalid physical lookup');});
 expect(f.create().acceptanceSelected).toBe(false);expect(lookup).not.toHaveBeenCalled();
});
