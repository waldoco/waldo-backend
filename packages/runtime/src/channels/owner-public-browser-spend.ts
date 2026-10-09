import {commonSpendReservation} from './common-spend-reservation';
import {COMMON_BROWSER_MONTH_CEILING_MICROUSD,COMMON_TEST_CEILING_MICROUSD} from './common-staging-registration';
import {assertCommonPublicBrowserUsage} from './common-public-browser-configuration';
import type {PublicReadReservation} from './cloudflare-public-read';

const LEGACY_KEY='owner-public-browser-spend:v1',KEY='owner-public-browser-spend:v2';
// Frozen v1 charge: historical reservations never follow a new pricing formula.
const LEGACY_RESERVATION_MICROUSD=2_090_000;
// Frozen v1 format/default, not admission authority for a new test. Lower
// historical ceilings stay binding even when above today's admission maximum.
const LEGACY_DEFAULT_CEILING_MICROUSD=20_000_000;
type Accounting={ownerId:string;custodyDigest:string;limitMicrousd?:number;reservedMicrousd:number;intents:readonly string[]};
type Legacy=Accounting&{limitMicrousd:number};
type Reservation={intent:string;month:string;reservedBrowserMs:number;chargedMicrousd:number;settled:boolean;durationMs?:number};
type Retained=Omit<Accounting,'intents'>&{reservations:readonly Reservation[]};
const validIntent=(id:unknown):id is string=>typeof id==='string'&&id.length>0&&id.length<=256;
const validAmount=(amount:unknown):amount is number=>Number.isSafeInteger(amount)&&(amount as number)>=0;
const validReservedDuration=(duration:unknown):duration is number=>validAmount(duration)&&duration>0;
const lowerCeiling=(a:number|undefined,b:number|undefined)=>a===undefined?b:b===undefined?a:Math.min(a,b);
// Normal reads estimate browser duration at $0.09/hour, rounded up to microUSD.
// Account-level peak/rounding charges belong to the registered test envelope.
// https://developers.cloudflare.com/browser-run/pricing/
export function ownerPublicBrowserDurationMicrousd(durationMs:number):number{
 if(!Number.isSafeInteger(durationMs)||durationMs<0)throw Error('public browser duration invalid');
 return Number((BigInt(durationMs)*90_000n+3_600_000n-1n)/3_600_000n);
}
function retainedAccounting(storage:Pick<DurableObjectStorage,'kv'>,ownerId:string,custodyDigest:string){
 const legacy=storage.kv.get<Legacy>(LEGACY_KEY),current=storage.kv.get<Retained>(KEY);
 if(legacy&&(legacy.ownerId!==ownerId||legacy.custodyDigest!==custodyDigest||!validAmount(legacy.reservedMicrousd)
  ||!Array.isArray(legacy.intents)||legacy.intents.some(id=>!validIntent(id))||new Set(legacy.intents).size!==legacy.intents.length
  ||!Number.isSafeInteger(legacy.limitMicrousd)||legacy.limitMicrousd<1||legacy.limitMicrousd>LEGACY_DEFAULT_CEILING_MICROUSD
  ||legacy.reservedMicrousd>legacy.limitMicrousd||legacy.reservedMicrousd!==legacy.intents.length*LEGACY_RESERVATION_MICROUSD))throw Error('public browser retained cost conflict');
 if(current){
  if(current.ownerId!==ownerId||current.custodyDigest!==custodyDigest||!validAmount(current.reservedMicrousd)
   ||current.limitMicrousd!==undefined&&(!Number.isSafeInteger(current.limitMicrousd)||current.limitMicrousd<1)
   ||!Array.isArray(current.reservations))throw Error('public browser retained cost conflict');
  let sum=0;const intents=new Set(legacy?.intents??[]),months=new Map<string,number>();
  for(const item of current.reservations){
   if(!item||!validIntent(item.intent)||intents.has(item.intent)||typeof item.month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(item.month)
    ||!validReservedDuration(item.reservedBrowserMs)||!validAmount(item.chargedMicrousd)||typeof item.settled!=='boolean'
    ||item.chargedMicrousd>ownerPublicBrowserDurationMicrousd(item.reservedBrowserMs)
    ||!item.settled&&(item.durationMs!==undefined||item.chargedMicrousd!==ownerPublicBrowserDurationMicrousd(item.reservedBrowserMs))
    ||item.settled&&(!validAmount(item.durationMs)||item.durationMs>item.reservedBrowserMs||item.chargedMicrousd!==ownerPublicBrowserDurationMicrousd(item.durationMs)))throw Error('public browser retained cost conflict');
   intents.add(item.intent);sum+=item.chargedMicrousd;months.set(item.month,(months.get(item.month)??0)+item.chargedMicrousd);
  }
  for(const [month,total] of months){
   const spent=storage.kv.get<number>(`common-public-browser-month:${month}`);
   if(!validAmount(spent)||spent<total||spent>COMMON_BROWSER_MONTH_CEILING_MICROUSD)throw Error('public browser retained month conflict');
  }
  if(!Number.isSafeInteger(sum)||sum!==current.reservedMicrousd||current.limitMicrousd!==undefined&&sum>current.limitMicrousd)throw Error('public browser retained cost conflict');
 }
 return {legacy,current};
}
export function ownerPublicBrowserAccounting(storage:Pick<DurableObjectStorage,'kv'>,ownerId:string,custodyDigest:string):Accounting|undefined{
 const {legacy,current}=retainedAccounting(storage,ownerId,custodyDigest);if(!legacy&&!current)return;
 // v1's default $20 was not an owner ceiling. Preserve every prior charge and
 // replay tombstone, plus any lower retained ceiling; never invent old refunds.
 const limitMicrousd=lowerCeiling(legacy&&legacy.limitMicrousd<LEGACY_DEFAULT_CEILING_MICROUSD?legacy.limitMicrousd:undefined,current?.limitMicrousd);
 const reservedMicrousd=(legacy?.reservedMicrousd??0)+(current?.reservedMicrousd??0);
 if(!Number.isSafeInteger(reservedMicrousd)||limitMicrousd!==undefined&&reservedMicrousd>limitMicrousd)throw Error('public browser retained cost conflict');
 return {ownerId,custodyDigest,limitMicrousd,reservedMicrousd,intents:[...(legacy?.intents??[]),...(current?.reservations.map(item=>item.intent)??[])]};
}
export function reserveOwnerPublicBrowser(options:Readonly<{
 storage:DurableObjectStorage;ownerId:string;custodyDigest:string;intent:string;reservedBrowserMs:number;now:number;declaredLimitMicrousd?:number;assertCurrent():void;
}>):PublicReadReservation{
 const {storage,ownerId,custodyDigest,intent,now,reservedBrowserMs}=options;
 const bound=ownerPublicBrowserDurationMicrousd(reservedBrowserMs);
 if(!validIntent(intent)||!Number.isSafeInteger(now)||!/^[a-f0-9]{64}$/.test(custodyDigest)||!validReservedDuration(reservedBrowserMs))throw Error('public browser reservation unavailable');
 const month=new Date(now).toISOString().slice(0,7),monthKey=`common-public-browser-month:${month}`;
 storage.transactionSync(()=>{
  options.assertCurrent();
  const prior=ownerPublicBrowserAccounting(storage,ownerId,custodyDigest);
  if(prior?.intents.includes(intent))throw Error('public browser prior effect requires reconciliation');
  // Historical test declarations stay readable, but cannot restore old authority.
  let aggregate=prior?.reservedMicrousd??0,ceiling=prior?.limitMicrousd===undefined?undefined:Math.min(prior.limitMicrousd,COMMON_TEST_CEILING_MICROUSD);
  if(options.declaredLimitMicrousd!==undefined){
   if(!Number.isSafeInteger(options.declaredLimitMicrousd)||options.declaredLimitMicrousd<1||options.declaredLimitMicrousd>COMMON_TEST_CEILING_MICROUSD)throw Error('public browser retained ceiling conflict');
   ceiling=lowerCeiling(ceiling,options.declaredLimitMicrousd);
  }
  for(const [key,row] of storage.kv.list<any>({prefix:'common-spend:'})){
   if(!row?.policy||row.policy.ownerId!==ownerId||key!==`common-spend:${row.policy.ref}`)throw Error('public browser retained owner conflict');
   aggregate+=commonSpendReservation(storage,row.policy,()=>now,()=>{}).reserved();
   ceiling=lowerCeiling(ceiling,Math.min(row.policy.limitMicrousd,COMMON_TEST_CEILING_MICROUSD));
  }
  // Existing paid-test custody is never discarded or reinterpreted as fresh money.
  if([...storage.kv.list({prefix:'common-browser-acceptance:'})].length||[...storage.kv.list({prefix:'common-browser-acceptance-custody:'})].length)throw Error('public browser prior test requires reconciliation');
  for(const [key,row] of storage.kv.list<any>({prefix:'common-public-browser-usage:'})){
   if(!row?.policy||key!==`common-public-browser-usage:${row.policy.ref}`||row.custodyDigest!==custodyDigest
    ||`prn_${row.policy.directoryOwnerId?.toLowerCase().replaceAll('-','')}`!==ownerId)throw Error('public browser retained custody conflict');
   assertCommonPublicBrowserUsage(row,row.policy,row.allocationMicrousd);
  }
  for(const [,amount] of storage.kv.list<number>({prefix:'common-public-browser-month:'}))if(!validAmount(amount)||amount>COMMON_BROWSER_MONTH_CEILING_MICROUSD)throw Error('public browser retained month conflict');
  const spent=storage.kv.get<number>(monthKey)??0;
  if(!Number.isSafeInteger(aggregate+bound)||ceiling!==undefined&&aggregate+bound>ceiling||spent+bound>COMMON_BROWSER_MONTH_CEILING_MICROUSD)throw Error('public browser owner cost ceiling exceeded');
  const current=storage.kv.get<Retained>(KEY);
  storage.kv.put(KEY,{ownerId,custodyDigest,...(ceiling===undefined?{}:{limitMicrousd:ceiling}),reservedMicrousd:(current?.reservedMicrousd??0)+bound,
   reservations:[...(current?.reservations??[]),{intent,month,reservedBrowserMs,chargedMicrousd:bound,settled:false}]} satisfies Retained);
  storage.kv.put(monthKey,spent+bound);
 });
 return Object.freeze({settle:(durationMs:number)=>settleOwnerPublicBrowser({storage,ownerId,custodyDigest,intent,durationMs,expected:{month,reservedBrowserMs}})});
}
// The host calls settlement only after exact physical absence evidence. Its
// durable owner/custody/intent binding survives restart and run expiry; this
// accounting path never authorizes browser I/O or a new reservation.
export function settleOwnerPublicBrowser(options:Readonly<{
 storage:Pick<DurableObjectStorage,'kv'|'transactionSync'>;ownerId:string;custodyDigest:string;intent:string;durationMs:number;
 expected?:Readonly<Pick<Reservation,'month'|'reservedBrowserMs'>>;
}>):void{
 const {storage,ownerId,custodyDigest,intent,durationMs,expected}=options;
 const chargedMicrousd=ownerPublicBrowserDurationMicrousd(durationMs);
 if(!validIntent(intent)||!/^[a-f0-9]{64}$/.test(custodyDigest))throw Error('public browser settlement conflict');
 storage.transactionSync(()=>{
  const {current}=retainedAccounting(storage,ownerId,custodyDigest),item=current?.reservations.find(row=>row.intent===intent);
  if(!current||!item||expected&&(item.month!==expected.month||item.reservedBrowserMs!==expected.reservedBrowserMs))throw Error('public browser settlement conflict');
  // An over-bound duration stays unresolved, never capped into a false refund.
  if(durationMs>item.reservedBrowserMs)throw Error('public browser duration exceeds reservation');
  if(item.settled){if(item.durationMs!==durationMs)throw Error('public browser settlement conflict');return;}
  const monthKey=`common-public-browser-month:${item.month}`,spent=storage.kv.get<number>(monthKey),refund=item.chargedMicrousd-chargedMicrousd;
  const retainedMonth=current.reservations.filter(row=>row.month===item.month).reduce((sum,row)=>sum+row.chargedMicrousd,0);
  if(!validAmount(spent)||spent>COMMON_BROWSER_MONTH_CEILING_MICROUSD||spent<retainedMonth)throw Error('public browser retained month conflict');
  storage.kv.put(KEY,{...current,reservedMicrousd:current.reservedMicrousd-refund,
   reservations:current.reservations.map(row=>row.intent===intent?{...row,chargedMicrousd,settled:true,durationMs}:row)} satisfies Retained);
  storage.kv.put(monthKey,spent-refund);
 });
}
// Existing registration-funded allocations/model calls must also see normal
// browser reservations. Called atomically inside their existing spend ledger,
// never installed as a new gate on ordinary model turns.
export function assertOwnerPublicBrowserCapacity(storage:Pick<DurableObjectStorage,'kv'|'transactionSync'>,ownerId:string,limitMicrousd:number,additionalMicrousd:number):void{
 const raw=storage.kv.get<Accounting>(KEY)??storage.kv.get<Accounting>(LEGACY_KEY);if(!raw)return;
 const prior=ownerPublicBrowserAccounting(storage,ownerId,raw.custodyDigest)!;
 let aggregate=prior.reservedMicrousd,ceiling=lowerCeiling(prior.limitMicrousd,limitMicrousd)!;
 for(const [key,row] of storage.kv.list<any>({prefix:'common-spend:'})){
  if(!row?.policy||row.policy.ownerId!==ownerId||key!==`common-spend:${row.policy.ref}`)throw Error('public browser retained owner conflict');
  aggregate+=commonSpendReservation(storage,row.policy,Date.now,()=>{}).reserved();ceiling=Math.min(ceiling,row.policy.limitMicrousd);
 }
 if(!Number.isSafeInteger(aggregate+additionalMicrousd)||aggregate+additionalMicrousd>ceiling)throw Error('public browser owner cost ceiling exceeded');
}
