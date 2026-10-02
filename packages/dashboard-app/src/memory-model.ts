import { SignInRequired } from './model';
export type MemoryStatus = { version: 1; state: 'available'|'partial'|'unavailable'; complete: boolean; unavailable_claim_count: number };
export type Claim = { id:string; kind:string; text:string; source:string; origin:string; status:string; evidence:{kind:'writer_note';text:string}; source_reference:{state:'unavailable'|'unverified';link:null}; recorded_at:string; writer_seen_count:number|null };
export type Interpretation = { id:string; type:'interpretation';label:string;summary:string;domain:string;stored_status:string;recorded_active_at:string;estimate:number|null;support:{claim_ids:string[];unavailable_count:number;independent_observations:'unverified'} };
export type Association = {from:string;to:string;relation:string;state:'unverified_association';estimate:number|null};
export type MemoryPage = MemoryStatus & { view:'claims'|'interpretations';items:(Claim|Interpretation)[];page:{limit:number;returned:number;total:number;next_cursor:string|null} };
export type MemoryDetail = MemoryStatus & ({view:'detail';kind:'claim';item:Claim;linked_interpretation_ids:string[]}|{view:'detail';kind:'interpretation';item:Interpretation;support_claim_ids:string[];support_unavailable_count:number});
export type MemoryPattern = MemoryStatus & {view:'pattern';center:Interpretation;nodes:Interpretation[];associations:Association[];showing:{nodes:number;of_nodes:number;links:number;of_links:number};truncated:boolean;omitted_links:number;expand:{next_cursor:string|null;links_capped:boolean;capped_links_recoverable:false;capped_links:number}};
export class MemoryReadError extends Error { constructor(public code:string) { super(code==='cursor_invalid'?'This page cursor is no longer usable. Restart the list.':code==='not_found'?'This saved item is no longer available. Return to the list.':code==='memory_unavailable'?'Memory storage is unavailable. Retry later.':'Memory could not load. Retry the protected read.'); } }
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const str=(v:unknown):v is string=>typeof v==='string';
const num=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const nullable=(v:unknown):v is string|null=>v===null||str(v);
const estimate=(v:unknown):v is number|null=>v===null||(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1);
const refs=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(x=>str(x)&&!!x);
const unsupported=()=>{throw new MemoryReadError('unsupported');};
function status(v:Record<string,unknown>):MemoryStatus {
 if(v.version!==1||!['available','partial','unavailable'].includes(String(v.state))||typeof v.complete!=='boolean'||!num(v.unavailable_claim_count)||!Array.isArray(v.actions)||v.actions.length) return unsupported();
 return {version:1,state:v.state as MemoryStatus['state'],complete:v.complete,unavailable_claim_count:v.unavailable_claim_count};
}
function claim(v:unknown):Claim {
 if(!obj(v)||!str(v.id)||!v.id||!str(v.kind)||!str(v.text)||!str(v.source)||!str(v.origin)||!str(v.status)||!str(v.recorded_at)||!(v.writer_seen_count===null||num(v.writer_seen_count))||!obj(v.evidence)||v.evidence.kind!=='writer_note'||!str(v.evidence.text)||!obj(v.source_reference)||!['unavailable','unverified'].includes(String(v.source_reference.state))||v.source_reference.link!==null) return unsupported();
 return {id:v.id,kind:v.kind,text:v.text,source:v.source,origin:v.origin,status:v.status,recorded_at:v.recorded_at,writer_seen_count:v.writer_seen_count as number|null,evidence:{kind:'writer_note',text:v.evidence.text},source_reference:{state:v.source_reference.state as Claim['source_reference']['state'],link:null}};
}
function interpretation(v:unknown):Interpretation {
 if(!obj(v)||!str(v.id)||!v.id||v.type!=='interpretation'||!str(v.label)||!str(v.summary)||!str(v.domain)||!str(v.stored_status)||!str(v.recorded_active_at)||!estimate(v.estimate)||v.estimate_kind!=='uncalibrated_model_estimate'||!obj(v.support)||!refs(v.support.claim_ids)||!num(v.support.unavailable_count)||v.support.independent_observations!=='unverified') return unsupported();
 return {id:v.id,type:'interpretation',label:v.label,summary:v.summary,domain:v.domain,stored_status:v.stored_status,recorded_active_at:v.recorded_active_at,estimate:v.estimate,support:{claim_ids:v.support.claim_ids,unavailable_count:v.support.unavailable_count,independent_observations:'unverified'}};
}
export function readMemory(v:unknown):MemoryPage|MemoryDetail|MemoryPattern {
 if(!obj(v))return unsupported();const common=status(v);
 if(v.view==='claims'||v.view==='interpretations') {
  if(!Array.isArray(v.items)||!obj(v.page)||!num(v.page.limit)||v.page.limit<1||!num(v.page.returned)||v.page.returned!==v.items.length||!num(v.page.total)||v.page.total<v.items.length||!nullable(v.page.next_cursor))return unsupported();
  return {...common,view:v.view,items:v.items.map(item=>v.view==='claims'?claim(item):interpretation(item)),page:{limit:v.page.limit,returned:v.page.returned,total:v.page.total,next_cursor:v.page.next_cursor}};
 }
 if(v.view==='detail') {
  if(v.kind==='claim'&&refs(v.linked_interpretation_ids))return {...common,view:'detail',kind:'claim',item:claim(v.item),linked_interpretation_ids:v.linked_interpretation_ids};
  if(v.kind==='interpretation'&&refs(v.support_claim_ids)&&num(v.support_unavailable_count))return {...common,view:'detail',kind:'interpretation',item:interpretation(v.item),support_claim_ids:v.support_claim_ids,support_unavailable_count:v.support_unavailable_count};
  return unsupported();
 }
 if(v.view==='pattern') {
  if(!Array.isArray(v.nodes)||!Array.isArray(v.associations)||!obj(v.showing)||!['nodes','of_nodes','links','of_links'].every(k=>num((v.showing as Record<string,unknown>)[k]))||v.showing.nodes!==v.nodes.length||v.showing.links!==v.associations.length||typeof v.truncated!=='boolean'||!num(v.omitted_links)||!obj(v.expand)||!nullable(v.expand.next_cursor)||typeof v.expand.links_capped!=='boolean'||v.expand.capped_links_recoverable!==false||!num(v.expand.capped_links))return unsupported();
  const center=interpretation(v.center),nodes=v.nodes.map(interpretation),ids=new Set([center.id,...nodes.map(n=>n.id)]);
  const associations=v.associations.map(a=>{if(!obj(a)||!str(a.from)||!str(a.to)||!ids.has(a.from)||!ids.has(a.to)||!str(a.relation)||a.state!=='unverified_association'||!estimate(a.estimate))return unsupported();return {from:a.from,to:a.to,relation:a.relation,state:'unverified_association' as const,estimate:a.estimate};});
  return {...common,view:'pattern',center,nodes,associations,showing:v.showing as MemoryPattern['showing'],truncated:v.truncated,omitted_links:v.omitted_links,expand:v.expand as MemoryPattern['expand']};
 }
 return unsupported();
}
export const MEMORY_URL='/console/dashboard/api/v1/memory';
export async function fetchMemory(params:URLSearchParams,signal?:AbortSignal) {
 const response=await fetch(`${MEMORY_URL}?${params}`,{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store',redirect:'error',signal});
 if(response.status===401)throw new SignInRequired();
 if(!response.ok){let error='unavailable';try{const v=await response.json();if(obj(v)&&str(v.error))error=v.error;}catch{}throw new MemoryReadError(error);}
 try{return readMemory(await response.json());}catch(e){if(e instanceof MemoryReadError)throw e;throw new MemoryReadError('unsupported');}
}
export const memoryItemLink=(view:'spots'|'constellation',id:string)=>`#/memory/${view}?id=${encodeURIComponent(id)}`;
