import {commonSpendReservation} from './common-spend-reservation';
import {COMMON_BROWSER_MONTH_CEILING_MICROUSD,COMMON_TEST_CEILING_MICROUSD} from './common-staging-registration';
import {commonCloudflareWorstCaseEnvelope} from './common-staging-price-envelope';
import {assertCommonPublicBrowserUsage} from './common-public-browser-configuration';
import {PUBLIC_READ_RESERVED_BROWSER_MS} from './cloudflare-public-read';

// Normal public reads share the existing owner/month browser counter. This is
// retained cost accounting, not a trial registration, renewal or new approval.
const KEY='owner-public-browser-spend:v1';
type Retained={ownerId:string;custodyDigest:string;limitMicrousd:number;reservedMicrousd:number;intents:readonly string[]};
export function ownerPublicBrowserAccounting(storage:Pick<DurableObjectStorage,'kv'>,ownerId:string,custodyDigest:string,bound:number):Retained|undefined{
 const prior=storage.kv.get<Retained>(KEY);
 if(prior&&(prior.ownerId!==ownerId||prior.custodyDigest!==custodyDigest||!Number.isSafeInteger(prior.reservedMicrousd)||prior.reservedMicrousd<0
  ||!Array.isArray(prior.intents)||new Set(prior.intents).size!==prior.intents.length||prior.intents.some(id=>typeof id!=='string'||!id||id.length>256)
  ||!Number.isSafeInteger(prior.limitMicrousd)||prior.limitMicrousd<1||prior.limitMicrousd>COMMON_TEST_CEILING_MICROUSD||prior.reservedMicrousd>prior.limitMicrousd
  ||prior.reservedMicrousd!==prior.intents.length*bound))throw Error('public browser retained cost conflict');
 return prior;
}
export function reserveOwnerPublicBrowser(options:Readonly<{
 storage:DurableObjectStorage;ownerId:string;custodyDigest:string;intent:string;reservedBrowserMs:number;now:number;declaredLimitMicrousd?:number;assertCurrent():void;
}>):void{
 const {storage,ownerId,custodyDigest,intent,now}=options;
 const bound=commonCloudflareWorstCaseEnvelope(options.reservedBrowserMs);
 if(!intent||intent.length>256||!Number.isSafeInteger(now)||!/^[a-f0-9]{64}$/.test(custodyDigest))throw Error('public browser reservation unavailable');
 storage.transactionSync(()=>{
  options.assertCurrent();
  const prior=ownerPublicBrowserAccounting(storage,ownerId,custodyDigest,bound);
  if(prior?.intents.includes(intent))throw Error('public browser prior effect requires reconciliation');
  let aggregate=prior?.reservedMicrousd??0,ceiling=prior?.limitMicrousd??COMMON_TEST_CEILING_MICROUSD;
  if(options.declaredLimitMicrousd!==undefined){
   if(!Number.isSafeInteger(options.declaredLimitMicrousd)||options.declaredLimitMicrousd<1||options.declaredLimitMicrousd>COMMON_TEST_CEILING_MICROUSD)throw Error('public browser retained ceiling conflict');
   ceiling=Math.min(ceiling,options.declaredLimitMicrousd);
  }
  for(const [key,row] of storage.kv.list<any>({prefix:'common-spend:'})){
   if(!row?.policy||row.policy.ownerId!==ownerId||key!==`common-spend:${row.policy.ref}`)throw Error('public browser retained owner conflict');
   aggregate+=commonSpendReservation(storage,row.policy,()=>now,()=>{}).reserved();
   ceiling=Math.min(ceiling,row.policy.limitMicrousd);
  }
  // Existing paid-test custody is never discarded or reinterpreted as fresh money.
  if([...storage.kv.list({prefix:'common-browser-acceptance:'})].length||[...storage.kv.list({prefix:'common-browser-acceptance-custody:'})].length)throw Error('public browser prior test requires reconciliation');
  for(const [key,row] of storage.kv.list<any>({prefix:'common-public-browser-usage:'})){
   if(!row?.policy||key!==`common-public-browser-usage:${row.policy.ref}`||row.custodyDigest!==custodyDigest
    ||`prn_${row.policy.directoryOwnerId?.toLowerCase().replaceAll('-','')}`!==ownerId)throw Error('public browser retained custody conflict');
   assertCommonPublicBrowserUsage(row,row.policy,row.allocationMicrousd);
  }
  for(const [,amount] of storage.kv.list<number>({prefix:'common-public-browser-month:'}))if(!Number.isSafeInteger(amount)||amount<0||amount>COMMON_BROWSER_MONTH_CEILING_MICROUSD)throw Error('public browser retained month conflict');
  const month=`common-public-browser-month:${new Date(now).toISOString().slice(0,7)}`,spent=storage.kv.get<number>(month)??0;
  if(!Number.isSafeInteger(aggregate)||aggregate+bound>ceiling||spent+bound>COMMON_BROWSER_MONTH_CEILING_MICROUSD)throw Error('public browser owner cost ceiling exceeded');
  storage.kv.put(KEY,{ownerId,custodyDigest,limitMicrousd:ceiling,reservedMicrousd:(prior?.reservedMicrousd??0)+bound,intents:[...(prior?.intents??[]),intent]} satisfies Retained);
  storage.kv.put(month,spent+bound);
 });
}
// Existing registration-funded allocations/model calls must also see normal
// browser reservations. Called atomically inside their existing spend ledger,
// never installed as a new gate on ordinary model turns.
export function assertOwnerPublicBrowserCapacity(storage:Pick<DurableObjectStorage,'kv'|'transactionSync'>,ownerId:string,limitMicrousd:number,additionalMicrousd:number):void{
 const raw=storage.kv.get<Retained>(KEY);if(!raw)return;
 const prior=ownerPublicBrowserAccounting(storage,ownerId,raw.custodyDigest,commonCloudflareWorstCaseEnvelope(PUBLIC_READ_RESERVED_BROWSER_MS))!;
 let aggregate=prior.reservedMicrousd,ceiling=Math.min(prior.limitMicrousd,limitMicrousd);
 for(const [key,row] of storage.kv.list<any>({prefix:'common-spend:'})){
  if(!row?.policy||row.policy.ownerId!==ownerId||key!==`common-spend:${row.policy.ref}`)throw Error('public browser retained owner conflict');
  aggregate+=commonSpendReservation(storage,row.policy,Date.now,()=>{}).reserved();ceiling=Math.min(ceiling,row.policy.limitMicrousd);
 }
 if(!Number.isSafeInteger(aggregate)||aggregate+additionalMicrousd>ceiling)throw Error('public browser owner cost ceiling exceeded');
}
