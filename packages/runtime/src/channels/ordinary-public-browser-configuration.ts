import type {BrowserSession} from '@waldo/contracts';
import type {BrowserWorker} from '@cloudflare/playwright';
import type {CommonBrowserConfiguration,CommonBrowserGrant} from './common-browser-host';
import type {CloudflareBrowserSdkLoader} from './public-fixture-browser';
import {reserveOwnerPublicBrowser,settleOwnerPublicBrowser} from './owner-public-browser-spend';
import {COMMON_TEST_CEILING_MICROUSD} from './common-staging-registration';

// Provider keep_alive bounds inactivity, never an active task's duration. One
// idle window permits an explicit owner reply; another covers failed cleanup.
const IDLE_MS=600_000,CLEANUP_MS=10_000;
const prefix='ordinary-public-browser-grant:';
type Custody={ownerId:string;custodyDigest:string};
type Retained={grant:CommonBrowserGrant;custody:Custody;startedAt?:number;intent?:string};
export function ordinaryPublicBrowserConfiguration(options:Readonly<{
 storage:DurableObjectStorage;binding:BrowserWorker;loadSdk:CloudflareBrowserSdkLoader;
 owner?:Custody;deadline?:number;declaredLimitMicrousd?:number;now():number;
 assertCurrent():Promise<void>;assertOwner():Promise<Custody>;
}>):CommonBrowserConfiguration & {ownerId:string;expiresAt:number;lifetimeMs:number}{
 const {storage}=options,now=options.now(),expiresAt=options.deadline===undefined?now:options.deadline+IDLE_MS;
 const read=(grant:CommonBrowserGrant)=>{
  const row=storage.kv.get<Retained>(prefix+grant.taskId);
  if(!row||JSON.stringify(row.grant)!==JSON.stringify(grant)||row.custody.ownerId!==grant.ownerId)throw Error('ordinary browser custody unavailable');
  return row;
 };
 const verify=async(grant:CommonBrowserGrant)=>{
  await options.assertCurrent();const owner=await options.assertOwner();await options.assertCurrent();
  const row=read(grant);if(JSON.stringify(owner)!==JSON.stringify(row.custody)||grant.expiresAt<=options.now())throw Error('ordinary browser owner changed');
 };
 const exact=(grant:CommonBrowserGrant,session:Pick<BrowserSession,'providerSessionId'>)=>{
  const row=read(grant),held=storage.kv.get<{grant:CommonBrowserGrant;session:BrowserSession}>(`common-browser:${grant.taskId}`);
  if(!row.intent||row.startedAt===undefined||!held||JSON.stringify(held.grant)!==JSON.stringify(grant)||held.session.providerSessionId!==session.providerSessionId||session.providerSessionId==='pending')throw Error('ordinary browser cleanup custody unavailable');
  return row;
 };
 return {
  ownerId:options.owner?.ownerId??'',expiresAt,lifetimeMs:expiresAt-now,
  retainInteractions:true,binding:options.binding,loadSdk:options.loadSdk,
  ownsGrant:grant=>storage.kv.get<Retained>(prefix+grant.taskId)?.grant.ref===grant.ref,
  cleanupBinding:(grant,providerSessionId)=>{exact(grant,{providerSessionId});return options.binding;},
  allocationClosed:async(grant,session,terminatedAt=options.now())=>{const row=exact(grant,session);if(!Number.isSafeInteger(terminatedAt)||terminatedAt<row.startedAt!||terminatedAt>options.now())throw Error('ordinary browser termination time invalid');settleOwnerPublicBrowser({storage,...row.custody,intent:row.intent!,durationMs:terminatedAt-row.startedAt!});},
  grant:async(task,ownerId)=>{
   await options.assertCurrent();const owner=await options.assertOwner();await options.assertCurrent();
   if(!options.owner||JSON.stringify(owner)!==JSON.stringify(options.owner)||owner.ownerId!==ownerId||!task.ready||!task.sources.some(source=>source==='browser'||source==='web'))throw Error('ordinary browser source unavailable');
   const retained=storage.kv.get<Retained>(prefix+task.taskId);if(retained){await verify(retained.grant);return retained.grant;}
   if(!Number.isSafeInteger(expiresAt)||!Number.isSafeInteger(options.deadline)||options.deadline!<=options.now())throw Error('ordinary browser run expired');
   const grant:CommonBrowserGrant={ref:`ordinary:${task.taskId}`,taskId:task.taskId,ownerId,expiresAt,allowedOrigins:['*'],maxScreenshotBytes:128*1024,lifetimeMs:expiresAt-options.now(),keepAliveMs:IDLE_MS};
   // The run and live directory supply admission; this is custody, not a trial
   // declaration. Funding occurs atomically before the first provider request.
   storage.kv.put(prefix+task.taskId,{grant,custody:owner} satisfies Retained);return grant;
  },
  assertGrantCurrent:verify,
  assertHandoffCurrent:async(grant)=>{
   const before=read(grant);const owner=await options.assertOwner();const after=read(grant);
   if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(owner)!==JSON.stringify(after.custody)||grant.expiresAt<=options.now()||!after.intent||after.startedAt===undefined)throw Error('ordinary browser handoff custody unavailable');
   const held=storage.kv.get<{session:BrowserSession}>(`common-browser:${grant.taskId}`);if(!held)throw Error('ordinary browser handoff session unavailable');exact(grant,held.session);
  },
  reserveAllocation:async(grant)=>{
   await verify(grant);const at=options.now(),row=read(grant),intent=`ordinary:${grant.taskId}`;
   if(row.startedAt!==undefined||row.intent!==undefined)throw Error('ordinary browser allocation requires reconciliation');
   storage.transactionSync(()=>{
    const limit=options.declaredLimitMicrousd;
    reserveOwnerPublicBrowser({storage,...row.custody,intent,reservedBrowserMs:grant.expiresAt-at+IDLE_MS+CLEANUP_MS,now:at,
     declaredLimitMicrousd:limit===undefined?undefined:Math.min(limit,COMMON_TEST_CEILING_MICROUSD),
     assertCurrent:()=>{if(options.now()>=grant.expiresAt||JSON.stringify(storage.kv.get(prefix+grant.taskId))!==JSON.stringify(row))throw Error('ordinary browser allocation changed');}});
    storage.kv.put(prefix+grant.taskId,{...row,startedAt:at,intent} satisfies Retained);
   });
  },
 };
}
