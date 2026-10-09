import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {commonRuntimeReadiness} from '../src/channels/common-runtime-readiness';
import {commonStagingRegistration} from '../src/channels/common-staging-registration';
const proof=vi.hoisted(()=>({owner:'10000000-0000-0000-0000-000000000001',custody:'a'.repeat(64),present:true,checks:0,revokeAt:0,providerReady:true}));
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async()=>proof.present?{directoryOwnerId:proof.owner,custodyDigest:proof.custody}:null,assertCurrent:async()=>{if(++proof.checks===proof.revokeAt)throw Error('authority revoked');}})}));
vi.mock('../src/identity/owner-directory',()=>({signedRpc:()=>undefined}));
vi.mock('../src/channels/browser-public-read-configuration',()=>({cloudflareBrowserProviderReadiness:()=>proof.providerReady}));
beforeEach(()=>{proof.present=true;proof.checks=0;proof.revokeAt=0;proof.providerReady=true;});
afterEach(()=>vi.restoreAllMocks());
function fixture(){
 const now=Date.now(),rows=new Map<string,any>([['do_name','PRIVATE_NAME'],['telegram_subject','1']]);
 const raw={policy:{ref:'PRIVATE_REF',doName:'PRIVATE_NAME',subject:'1',directoryOwnerId:proof.owner,createdAt:now-20000,expiresAt:now-1000,allowedOrigins:['*'],maxAllocations:2,maxReservedBrowserMs:40000,lifetimeMs:10000,maxScreenshotBytes:1024},billing:{cloudflareAccountId:'a'.repeat(32),conservativeWorstCase:true},spend:{limitMicrousd:10000000,maxCalls:100,validUntil:now-1000}};
 const env={WALDO_ENVIRONMENT:'staging',COMMON_BROWSER_REGISTRATION:JSON.stringify(raw),BROWSER:{fetch:vi.fn(()=>{throw Error('provider forbidden');})},TELEGRAM_OWNER_DO:{idFromName:()=>({toString:()=> 'PRIVATE_PHYSICAL'})}} as any;
 const writes=vi.fn(()=>{throw Error('storage writes forbidden');});
 const storage={kv:{get:(key:string)=>rows.get(key),list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix)),put:writes},transactionSync:writes} as unknown as DurableObjectStorage;
 const registered=commonStagingRegistration(env)!;
 const ledger=(ref:string,reserved:number)=>({policy:{...registered.spend.policy,ref},reservedMicrousd:reserved,calls:[{id:'PRIVATE_CALL',upperBoundMicrousd:reserved}],cleanup:[]});
 rows.set('common-spend:PRIVATE_REF',ledger('PRIVATE_REF',7));rows.set('common-spend:PRIVATE_RETIRED',ledger('PRIVATE_RETIRED',5));
 rows.set('common-public-browser-usage:PRIVATE_REF',{policy:raw.policy,custodyDigest:proof.custody,allocationMicrousd:registered.spend.allocationMicrousd,allocations:1,reservedBrowserMs:20000,taskGrants:[{ref:raw.policy.ref,ownerId:registered.spend.policy.ownerId,taskId:'PRIVATE_TASK',expiresAt:raw.policy.expiresAt,allowedOrigins:raw.policy.allowedOrigins,lifetimeMs:10000,maxScreenshotBytes:1024}]});
 rows.set('common-public-browser-month:'+new Date(now).toISOString().slice(0,7),7);
 return {rows,raw,env,storage,writes,read:async()=>await(await commonRuntimeReadiness(env,storage,'PRIVATE_PHYSICAL',{limit:async()=>({success:true})} as RateLimit)).json() as any};
}
it('expired owner allowance remains readable without writes or provider I/O and aggregates every retained spend ref',async()=>{
 const f=fixture(),network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('network forbidden')),before=structuredClone([...f.rows]);
 const result=await f.read();expect(result.browser).toMatchObject({status:'expired',providerReady:true,registeredCapMicrousd:10000000,retainedReservedMicrousd:7,aggregateRetainedReservedMicrousd:12,remainingCurrentPolicyMicrousd:9999993,retainedAllocations:1,retainedReservedBrowserMs:20000,currentMonthReservedMicrousd:7,externalPriorUse:'unknown'});
 expect([...f.rows]).toEqual(before);expect(f.writes).not.toHaveBeenCalled();expect(f.env.BROWSER.fetch).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();
 for(const word of ['PRIVATE','10000000-','https://','providerSessionId','session_handle'])expect(JSON.stringify(result)).not.toContain(word);
});

function current(f:ReturnType<typeof fixture>){
 f.raw.policy.expiresAt=Date.now()+10000;f.raw.spend.validUntil=f.raw.policy.expiresAt;f.env.COMMON_BROWSER_REGISTRATION=JSON.stringify(f.raw);
 f.rows.get('common-spend:PRIVATE_REF').policy.validUntil=f.raw.spend.validUntil;
 f.rows.get('common-public-browser-usage:PRIVATE_REF').policy=structuredClone(f.raw.policy);
}
it.each(['spend','usage','month','foreign_owner'])('corrupt %s never publishes plausible remaining allowance',async kind=>{
 const f=fixture();
 if(kind==='spend')f.rows.get('common-spend:PRIVATE_REF').reservedMicrousd++;
 if(kind==='usage')f.rows.get('common-public-browser-usage:PRIVATE_REF').allocations++;
 if(kind==='month')f.rows.set('common-public-browser-month:'+new Date().toISOString().slice(0,7),-1);
 if(kind==='foreign_owner')f.rows.get('common-spend:PRIVATE_RETIRED').policy.ownerId='PRIVATE_FOREIGN';
 const before=structuredClone([...f.rows]);expect((await f.read()).browser).toMatchObject({status:'conflict',remainingCurrentPolicyMicrousd:null,aggregateRetainedReservedMicrousd:null});
 expect([...f.rows]).toEqual(before);expect(f.writes).not.toHaveBeenCalled();expect(f.env.BROWSER.fetch).not.toHaveBeenCalled();
});
it('missing current ledger and usage are unknown rather than a newly available full allowance',async()=>{
 const f=fixture();f.rows.delete('common-spend:PRIVATE_REF');f.rows.delete('common-public-browser-usage:PRIVATE_REF');
 expect((await f.read()).browser).toMatchObject({retainedReservedMicrousd:null,remainingCurrentPolicyMicrousd:null,retainedAllocations:null,aggregateRetainedReservedMicrousd:5,externalPriorUse:'unknown'});
 expect(f.writes).not.toHaveBeenCalled();
});
it('an absent registration is distinct from expired history and never hides older spend',async()=>{
 const f=fixture();f.env.COMMON_BROWSER_REGISTRATION='';
 expect((await f.read()).browser).toMatchObject({status:'unregistered',registeredCapMicrousd:null,remainingCurrentPolicyMicrousd:null,aggregateRetainedReservedMicrousd:12});
});
it('no executable provider is unverifiable even with an unexpired registered allowance',async()=>{
 const f=fixture();current(f);proof.providerReady=false;
 expect((await f.read()).browser).toMatchObject({status:'unverifiable',providerReady:false});expect(f.env.BROWSER.fetch).not.toHaveBeenCalled();expect(f.writes).not.toHaveBeenCalled();
});
it('retained allocation exhaustion is reported without resetting or dispatching',async()=>{
 const f=fixture();current(f);const usage=f.rows.get('common-public-browser-usage:PRIVATE_REF');usage.allocations=2;usage.reservedBrowserMs=40000;
 expect((await f.read()).browser).toMatchObject({status:'exhausted',retainedAllocations:2,remainingRegisteredAllocations:0});expect(f.writes).not.toHaveBeenCalled();
});
it.each(['directory_unlinked','physical_unlinked','final_revocation'])('%s suppresses browser allowance before publication',async kind=>{
 const f=fixture();if(kind==='directory_unlinked')proof.present=false;if(kind==='physical_unlinked')f.rows.set('telegram_unlinked',true);if(kind==='final_revocation')proof.revokeAt=2;
 expect((await f.read()).browser).toBeUndefined();expect(f.writes).not.toHaveBeenCalled();expect(f.env.BROWSER.fetch).not.toHaveBeenCalled();
});
it('registered prior test usage and retained gate counts are read without granting a fresh test',async()=>{
 const f=fixture();current(f);const acceptance={doName:f.raw.policy.doName,subject:f.raw.policy.subject,directoryOwnerId:proof.owner,expiresAt:f.raw.spend.validUntil,maxRuns:2,maxModelCalls:8,priorRuns:1,priorModelCalls:3,priorMicrousd:100};
 (f.raw as any).acceptance=acceptance;f.env.COMMON_BROWSER_REGISTRATION=JSON.stringify(f.raw);
 expect((await f.read()).browser).toMatchObject({status:'registered',remainingCurrentPolicyMicrousd:9999893,retainedTestGate:{remainingRuns:1,remainingModelCalls:5,registeredPriorMicrousd:100},externalPriorUse:'unknown'});
 expect(f.rows.has('common-browser-acceptance:PRIVATE_REF')).toBe(false);expect(f.writes).not.toHaveBeenCalled();
});
it('current automatic pin is checked against current owner and deployment without renewing it',async()=>{
 const f=fixture();const {doName,subject,directoryOwnerId,...policy}=f.raw.policy;
 const operator={scope:'verified_owners',policy,spend:f.raw.spend,billing:f.raw.billing};
 const descriptor={policy:{...policy,doName,subject,directoryOwnerId,ref:`${policy.ref}:owner:${directoryOwnerId}`},spend:f.raw.spend,billing:f.raw.billing};
 f.env.COMMON_BROWSER_REGISTRATION=JSON.stringify(operator);
 const ledger=f.rows.get('common-spend:PRIVATE_REF');f.rows.delete('common-spend:PRIVATE_REF');ledger.policy.ref=descriptor.policy.ref;f.rows.set('common-spend:'+descriptor.policy.ref,ledger);
 const usage=f.rows.get('common-public-browser-usage:PRIVATE_REF');f.rows.delete('common-public-browser-usage:PRIVATE_REF');usage.policy=descriptor.policy;usage.taskGrants[0].ref=descriptor.policy.ref;f.rows.set('common-public-browser-usage:'+descriptor.policy.ref,usage);
 const pin={operator:JSON.stringify(operator),custodyDigest:proof.custody,registration:descriptor};f.rows.set('common_owner_browser_registration_v1',pin);
 expect((await f.read()).browser).toMatchObject({status:'expired',retainedReservedMicrousd:7});
 pin.custodyDigest='b'.repeat(64);const before=structuredClone([...f.rows]);expect((await f.read()).browser).toMatchObject({status:'conflict',remainingCurrentPolicyMicrousd:null});expect([...f.rows]).toEqual(before);expect(f.writes).not.toHaveBeenCalled();
});
it('retained cleanup is summarized without exposing session identity or calling the provider',async()=>{
 const f=fixture();const ownerId='prn_'+proof.owner.replaceAll('-','');
 f.rows.set('common-browser:PRIVATE_TASK',{grant:{ownerId},cleanup:'pending',cleanupFailed:true,session:{id:'PRIVATE_SESSION',ownerId,provider:'cloudflare_playwright',providerSessionId:'PRIVATE_PROVIDER',contextHandle:null,mode:'public',state:'active',generation:1,expiresAt:Date.now()-1000,updatedAt:Date.now()}});
 const result=await f.read();expect(result.browser.retainedSessionCounts).toEqual({active:0,unresolved:0,pendingCleanup:0,failedCleanup:1,closed:0});expect(JSON.stringify(result)).not.toContain('PRIVATE');expect(f.env.BROWSER.fetch).not.toHaveBeenCalled();expect(f.writes).not.toHaveBeenCalled();
});
it.each(['rotated_ref','missing_capsule','changed_custody'])('retained acceptance %s cannot publish available allowance',async kind=>{
 const f=fixture();current(f);
 if(kind==='changed_custody') {
  (f.raw as any).acceptance={doName:f.raw.policy.doName,subject:f.raw.policy.subject,directoryOwnerId:proof.owner,expiresAt:f.raw.spend.validUntil,maxRuns:2,maxModelCalls:8,priorRuns:0,priorModelCalls:0,priorMicrousd:0};
  f.env.COMMON_BROWSER_REGISTRATION=JSON.stringify(f.raw);
 }
 f.rows.set(`common-browser-acceptance-custody:${kind==='rotated_ref'?'OTHER_REF':'PRIVATE_REF'}`,kind==='changed_custody'?'b'.repeat(64):proof.custody);
 const before=structuredClone([...f.rows]);
 expect((await f.read()).browser).toMatchObject({status:'conflict',remainingCurrentPolicyMicrousd:null,remainingRegisteredCapAfterAllRetainedRefsMicrousd:null});
 expect([...f.rows]).toEqual(before);expect(f.writes).not.toHaveBeenCalled();expect(f.env.BROWSER.fetch).not.toHaveBeenCalled();
});
