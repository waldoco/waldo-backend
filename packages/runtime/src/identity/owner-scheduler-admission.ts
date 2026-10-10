import {acceptTrustedInvocation} from '@waldo/contracts';
import type {RunEffectScope} from '../channels/run-effect-scope';
import type {OwnerMessageAdmission} from './owner-message-admission';
import {OwnerAdmissionError} from './owner-message-admission';
import {sha256Hex,sha256Prefixed,stableJson} from '../context-composer/canonical';
export type OwnerSchedulerBinding = Readonly<{ownerId:string;ownerDoName:string;physicalDoId:string;ownerRevision:string;sourceRevision:string;scheduleRef:string;scheduleRevision:string;enabled:boolean}>;
export type OwnerSchedulerAdmissionOptions = Readonly<{
  // Private verified directory/scheduler/source-state lookup; never request/model supplied.
  scope:RunEffectScope;lookup():Promise<OwnerSchedulerBinding>;
  expectedOwnerDoName:string;expectedPhysicalDoId:string;occurrenceKey:string;occurredAt:number;
  intent:'run_patrol'|'evaluate_fetch';purpose:'personal_day'|'source_discovery'|'source_watch'|'source_delivery';now?():number;
}>;
const safe=(value:unknown,max=512):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\r\n\0]/.test(value);
const fields='enabled,ownerDoName,ownerId,ownerRevision,physicalDoId,scheduleRef,scheduleRevision,sourceRevision';
const freeze=(value:unknown):void=>{if(!value||typeof value!=='object')return;Object.values(value).forEach(freeze);Object.freeze(value);};
// Background checks hold canonical owner/source/schedule authority. Their input is runtime
// metadata, never a solicited owner statement, memory assertion or consequential-effect grant.
export async function ownerSchedulerAdmission(options:OwnerSchedulerAdmissionOptions):Promise<OwnerMessageAdmission> {
  const {scope,lookup,expectedOwnerDoName,expectedPhysicalDoId,occurrenceKey,occurredAt,intent,purpose}=options,now=options.now??Date.now,acceptedAt=now();
  const admit=()=>{scope.admit();if(scope.signal.aborted||!Number.isSafeInteger(scope.deadline)||now()>=scope.deadline)throw new OwnerAdmissionError('rejected');};
  admit();
  if(!safe(scope.runId)||!safe(scope.attempt)||!safe(expectedOwnerDoName)||!safe(expectedPhysicalDoId)||!safe(occurrenceKey)
    ||!['run_patrol','evaluate_fetch'].includes(intent)||!['personal_day','source_discovery','source_watch','source_delivery'].includes(purpose)
    ||!Number.isSafeInteger(acceptedAt)||!Number.isSafeInteger(occurredAt)||occurredAt<0||occurredAt>acceptedAt
    ||scope.deadline-acceptedAt>15*60000)throw new OwnerAdmissionError('rejected');
  const resolve=async()=>{
    admit();let raw:OwnerSchedulerBinding;
    try{raw=await lookup();}catch{admit();throw new OwnerAdmissionError('unavailable');}admit();
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.getPrototypeOf(raw)!==Object.prototype
      ||Object.getOwnPropertySymbols(raw).length||Object.values(Object.getOwnPropertyDescriptors(raw)).some(value=>!('value' in value))
      ||Object.getOwnPropertyNames(raw).sort().join(',')!==fields)throw new OwnerAdmissionError('rejected');
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(raw.ownerId)
      ||raw.ownerDoName!==expectedOwnerDoName||raw.physicalDoId!==expectedPhysicalDoId||raw.enabled!==true
      ||![raw.ownerRevision,raw.sourceRevision,raw.scheduleRef,raw.scheduleRevision].every(value=>safe(value,256)))throw new OwnerAdmissionError('rejected');
    return Object.freeze({...raw,ownerId:raw.ownerId.toLowerCase()});
  };
  const binding=await resolve();
  const assertCurrent=async()=>{const latest=await resolve();if(stableJson(latest)!==stableJson(binding))throw new OwnerAdmissionError('rejected');};
  const ownerHex=binding.ownerId.replaceAll('-',''),occurrence=await sha256Hex(stableJson([binding.ownerId,binding.ownerDoName,binding.physicalDoId,binding.scheduleRef,binding.scheduleRevision,occurrenceKey,intent,purpose]));
  const verification=await sha256Hex(stableJson(binding));
  const text=stableJson({source:'trusted_owner_scheduler',intent,purpose,schedule_ref:binding.scheduleRef,schedule_revision:binding.scheduleRevision,source_revision:binding.sourceRevision,occurrence_ref:`occ_${occurrence.slice(0,32)}`});
  const contentDigest=await sha256Prefixed(text);await assertCurrent();
  const accepted=acceptTrustedInvocation({admission_source:'trusted_scheduler',verified_authority:{principal_ref:`prn_${ownerHex}`,tenant_ref:`ten_${ownerHex}`,verification_ref:`ver_${verification.slice(0,32)}`},input_refs:[{input_ref:`inp_${occurrence.slice(0,32)}`,content_digest:contentDigest}],intent:{kind:intent},occurrence:{occurrence_ref:`occ_${occurrence.slice(0,32)}`,occurred_at:occurredAt},idempotency_ref:`idem_${occurrence.slice(0,32)}`,accepted_at:acceptedAt});
  if(!accepted.ok)throw new OwnerAdmissionError('rejected');freeze(accepted.value);
  const snapshotAt=now();if(!Number.isSafeInteger(snapshotAt)||snapshotAt<acceptedAt)throw new OwnerAdmissionError('rejected');admit();
  const input=Object.freeze({input_ref:accepted.value.input_refs[0]!.input_ref,content_digest:contentDigest,principal_ref:`prn_${ownerHex}`,tenant_ref:`ten_${ownerHex}`,text,
    source:Object.freeze({source_key:`owner-scheduler:${occurrence.slice(0,32)}`,source_kind:'runtime_metadata' as const,scope:'invocation' as const,source_taint:null,produced_at:occurredAt})});
  return Object.freeze({invocation:accepted.value,snapshot:Object.freeze({snapshot_ref:`snp_${crypto.randomUUID().replaceAll('-','')}`,snapshot_at:snapshotAt}),assertCurrent,readInput:async()=>{await assertCurrent();return input;}});
}
