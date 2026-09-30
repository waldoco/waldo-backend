// Synthetic provider custody. This is not a live provider or user permission.
// Only implemented effect families admit deltas. Unsupported taxonomy fails closed.
import { createHash } from 'node:crypto';
import type { SourceRow } from '../scenarios/isolated-source-world';
export type EffectKind='calendar.create'|'calendar.move'|'calendar.cancel'|'mail.draft'|'mail.send'|'watch.start'|'watch.stop'|'order.submit'|'order.cancel'|'refund.request'|'subscription.cancel'|'subscription.switch'|'executor.admit'|'capture.admit'|'preference.correct'|'responsibility.stop'|'consent.revoke'|'data.delete';
export type EffectRequest=Readonly<{owner_id:string;kind:EffectKind;target:string;payload:unknown;idempotency_key:string;approved_revision:string|null}>;
export type EffectReceipt=Readonly<{version:1;provenance:'synthetic_only';owner_id:string;kind:EffectKind;target:string;idempotency_key:string;payload_digest:string;state:'applied'|'rejected'|'unknown';provider_receipt_id:string|null;at:string;before_digest:string;after_digest:string}>;
export type SyntheticProviderStateV1=Readonly<{version:1;provenance:'synthetic_only';owner_id:string;families:Readonly<Record<string,readonly SourceRow[]>>;receipts:readonly EffectReceipt[]}>;
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const canonical=(value:unknown):unknown=>{
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number'&&Number.isFinite(value))return value;
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value))){
  const pairs=Object.keys(value).sort(compare).map(k=>[k,canonical((value as Record<string,unknown>)[k])]);
  return Object.fromEntries(pairs);
 }
 throw new Error('non-JSON provider state');
};
const digest=(value:unknown)=>`sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
export const providerStateDigest=(state:SyntheticProviderStateV1):string=>{
 const families:Record<string,readonly SourceRow[]>={};
 for(const [family,rows] of Object.entries(state.families)){
  if(new Set(rows.map(r=>r.id)).size!==rows.length||rows.some(r=>!r.id||r.owner_id!==state.owner_id))throw new Error('invalid owner provider rows');
  families[family]=[...rows].sort((a,b)=>compare(a.id,b.id));
 }
 return digest({version:state.version,provenance:state.provenance,owner_id:state.owner_id,families});
};
export const IMPLEMENTED_NATIVE_EFFECTS:readonly EffectKind[]=['calendar.create','calendar.move','calendar.cancel','mail.draft','mail.send'];
export class SyntheticProviderCustody {
 private states=new Map<string,SyntheticProviderStateV1>();
 private intents=new Map<string,{request:EffectRequest;receipt:EffectReceipt}>();
 constructor(initial:readonly SyntheticProviderStateV1[],private clock:()=>string){
  if(initial.length!==2||new Set(initial.map(s=>s.owner_id)).size!==2)throw new Error('two owner provider states required');
  for(const state of initial){if(!state.owner_id||state.version!==1||state.provenance!=='synthetic_only'||state.receipts.length)throw new Error('invalid initial provider state');providerStateDigest(state);this.states.set(state.owner_id,structuredClone(state));}
 }
 readback(owner:string):SyntheticProviderStateV1{const state=this.states.get(owner);if(!state)throw new Error('unknown provider owner');return structuredClone(state);}
 apply(request:EffectRequest,permitted:readonly EffectKind[]):EffectReceipt{
  const state=this.readback(request.owner_id);
  if(!request.target?.trim()||!request.idempotency_key?.trim())throw new Error('effect identity missing');
  const operation=`${request.owner_id}:${request.kind}:${request.idempotency_key}`;
  const previous=this.intents.get(operation);
  if(previous){if(digest(previous.request)!==digest(request))throw new Error('effect idempotency conflict');return structuredClone(previous.receipt);}
  if(!permitted.includes(request.kind))throw new Error('effect outside synthetic authority');
  if(!IMPLEMENTED_NATIVE_EFFECTS.includes(request.kind))throw new Error('effect readback unsupported');
  if(request.kind!=='mail.draft'&&!request.approved_revision?.trim())throw new Error('immutable synthetic approval missing');
  const payload=request.payload as Record<string,unknown>;
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('effect payload invalid');
  // Force all values through exact canonical serialization before any effect.
  digest(payload);const before=providerStateDigest(state);
  const families=structuredClone(state.families) as Record<string,SourceRow[]>;
  const calendar=families.calendar??[];
  const row=(id:string,fields:Record<string,unknown>):SourceRow=>({id,owner_id:request.owner_id,...fields});
  const text=(field:string)=>{const v=payload[field];if(typeof v!=='string'||!v.trim())throw new Error(`effect ${field} missing`);return v;};
  if(request.kind==='calendar.create'){
   const title=text('title'),start=text('start'),end=text('end');if(!Number.isFinite(Date.parse(start))||Date.parse(end)<=Date.parse(start))throw new Error('invalid event interval');
   if(calendar.some(r=>r.id===request.target))throw new Error('event target exists');
   families.calendar=[...calendar,row(request.target,{title,start,end,etag:request.approved_revision})];
  }else if(request.kind==='calendar.move'||request.kind==='calendar.cancel'){
   const found=calendar.find(r=>r.id===request.target);if(!found)throw new Error('event target missing');
   if(found.etag!==text('expected_etag'))throw new Error('event revision changed');
   if(request.kind==='calendar.cancel')families.calendar=calendar.filter(r=>r.id!==request.target);
   else{const start=text('start'),end=text('end');if(!Number.isFinite(Date.parse(start))||Date.parse(end)<=Date.parse(start))throw new Error('invalid event interval');
    families.calendar=calendar.map(r=>r.id===request.target?{...r,start,end,etag:request.approved_revision}:r);}
  }else{
   const recipient=text('recipient'),body=text('body'),subject=text('subject');
   const family=request.kind==='mail.draft'?'drafts':'sent';
   const rows=families[family]??[];if(rows.some(r=>r.id===request.target))throw new Error('mail target exists');
   families[family]=[...rows,row(request.target,{recipient,body,subject,attachment_digest:payload.attachment_digest??null,approved_revision:request.approved_revision})];
  }
  const next={...state,families};const after=providerStateDigest(next);
  const at=this.clock();if(!Number.isFinite(Date.parse(at)))throw new Error('provider clock invalid');
  const receipt:EffectReceipt={version:1,provenance:'synthetic_only',owner_id:request.owner_id,kind:request.kind,target:request.target,idempotency_key:request.idempotency_key,payload_digest:digest(request.payload),state:'applied',provider_receipt_id:`fixture-${createHash('sha256').update(operation).digest('hex')}`,at,before_digest:before,after_digest:after};
  this.states.set(request.owner_id,{...next,receipts:[...state.receipts,receipt]});this.intents.set(operation,{request:structuredClone(request),receipt});return structuredClone(receipt);
 }
 // A discarded/lost transport does not alter committed provider custody. Recover
 // the same intent directly; no second apply required and no forced rollback.
 intentReadback(owner:string,kind:EffectKind,key:string):EffectReceipt|null{return structuredClone(this.intents.get(`${owner}:${kind}:${key}`)?.receipt??null);}
}
