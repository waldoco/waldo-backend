import {buildMemoryDestination,isMemoryItemId,isMemoryCursor,type MemoryListDestination} from './destinations';
import { SignInRequired } from './model';
export type MemoryStatus = { version: 1; state: 'available'|'partial'|'unavailable'; complete: boolean; unavailable_claim_count: number };
export type Claim = { id:string; kind:string; text:string; source:string; origin:string; status:string; evidence:{kind:'writer_note';text:string}; source_reference:{state:'unavailable'|'unverified';link:null}; recorded_at:string; writer_seen_count:number|null };
export type MemoryPage = MemoryStatus & { view:'claims';items:Claim[];page:{limit:number;returned:number;total:number;next_cursor:string|null} };
export type MemoryDetail = MemoryStatus & {view:'detail';kind:'claim';item:Claim};
export class MemoryReadError extends Error { constructor(public code:string) { super(code==='cursor_invalid'?'This page cursor is no longer usable. Restart the list.':code==='not_found'?'This saved item is no longer available. Return to the list.':code==='memory_unavailable'?'Memory storage is unavailable. Retry later.':'Memory could not load. Retry the protected read.'); } }
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const str=(v:unknown):v is string=>typeof v==='string';
const num=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const itemId=isMemoryItemId;
const nullable=(v:unknown):v is string|null=>v===null||isMemoryCursor(v);
const unsupported=()=>{throw new MemoryReadError('unsupported');};
function status(v:Record<string,unknown>):MemoryStatus {
 if(v.version!==1||!['available','partial','unavailable'].includes(String(v.state))||typeof v.complete!=='boolean'||!num(v.unavailable_claim_count)||!Array.isArray(v.actions)||v.actions.length) return unsupported();
 return {version:1,state:v.state as MemoryStatus['state'],complete:v.complete,unavailable_claim_count:v.unavailable_claim_count};
}
function claim(v:unknown):Claim {
 if(!obj(v)||!itemId(v.id)||!str(v.kind)||!str(v.text)||!str(v.source)||!str(v.origin)||!str(v.status)||!str(v.recorded_at)||!(v.writer_seen_count===null||num(v.writer_seen_count))||!obj(v.evidence)||v.evidence.kind!=='writer_note'||!str(v.evidence.text)||!obj(v.source_reference)||!['unavailable','unverified'].includes(String(v.source_reference.state))||v.source_reference.link!==null) return unsupported();
 return {id:v.id,kind:v.kind,text:v.text,source:v.source,origin:v.origin,status:v.status,recorded_at:v.recorded_at,writer_seen_count:v.writer_seen_count as number|null,evidence:{kind:'writer_note',text:v.evidence.text},source_reference:{state:v.source_reference.state as Claim['source_reference']['state'],link:null}};
}
export function readMemory(v:unknown):MemoryPage|MemoryDetail {
 if(!obj(v))return unsupported();const common=status(v);
 if(v.view==='claims') {
  if(!Array.isArray(v.items)||!obj(v.page)||!num(v.page.limit)||v.page.limit<1||!num(v.page.returned)||v.page.returned!==v.items.length||!num(v.page.total)||v.page.total<v.items.length||!nullable(v.page.next_cursor))return unsupported();
  return {...common,view:'claims',items:v.items.map(claim),page:{limit:v.page.limit,returned:v.page.returned,total:v.page.total,next_cursor:v.page.next_cursor}};
 }
 if(v.view==='detail'&&v.kind==='claim')return {...common,view:'detail',kind:'claim',item:claim(v.item)};
 return unsupported();
}
export const MEMORY_URL='/console/dashboard/api/v1/memory';
export async function fetchMemory(params:URLSearchParams,signal?:AbortSignal) {
 const response=await fetch(`${MEMORY_URL}?${params}`,{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store',redirect:'error',signal});
 if(response.status===401)throw new SignInRequired();
 if(!response.ok){let error='unavailable';try{const v=await response.json();if(obj(v)&&str(v.error))error=v.error;}catch{}throw new MemoryReadError(error);}
 try{const data=readMemory(await response.json());if(data.view!==params.get('view')||(data.view==='detail'&&data.item.id!==params.get('id')))return unsupported();return data;}catch(e){if(e instanceof MemoryReadError)throw e;throw new MemoryReadError('unsupported');}
}
export const memoryItemLink=(view:'spots',id:string,returnTo?:MemoryListDestination)=>buildMemoryDestination({kind:'detail',view,id,...(returnTo?{returnTo}:{})});
