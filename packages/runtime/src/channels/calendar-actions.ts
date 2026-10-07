import type { ProposeCalendarChangeArgs } from '@waldo/contracts';
import { GoogleError, sha256Hex, type CalendarItem, type GoogleClient } from '../connectors/google';
import type { ProxyIntent } from '../connectors/proxy-intent';

type Row={id:string;status:string;payload_json:string;undo_json:string|null;decided_at:number|null};
export type CalendarProposal=ProposeCalendarChangeArgs & {connection_id:string;account_email:string;calendar_id:'primary';seen_etag?:string;provider_id:string;operation_tag:string;binding_digest:string};
type Operation={started_at?:number;phase:'apply'|'undo';target_id:string;before?:{start:string;end:string};applied_etag?:string;op?:'move'|'cancel';id?:string;start?:string;end?:string;confirmed_at?:number;delivered_at?:number;recovery_order?:number};
type Decision={toast:string;message:string};
const unknown:Decision={toast:'Outcome unknown',message:'The calendar outcome is not confirmed. Check the calendar or open the ledger to reconcile it; nothing was run again.'};
const binding=(p:CalendarProposal)=>{const {binding_digest:_,...bound}=p;return JSON.stringify(bound);};

// Existing owner ledger owns both the approval and its operation receipt. Recovery is read-only.
export const calendarActions=(sql:SqlStorage,deps:Readonly<{
 google(intent?:ProxyIntent,feature?:'calendar'|'mail',connectionId?:string,assertCurrent?:()=>Promise<void>):Promise<GoogleClient|null>;
 now():number;say(text:string,buttons?:[string,string][]):Promise<unknown>;describe(p:ProposeCalendarChangeArgs):string;
}>)=>{
 const row=(id:string)=>sql.exec<Row>('SELECT * FROM ledger WHERE id = ?',id).toArray()[0];
 const write=(id:string,status:string,op:Operation|null)=>sql.exec('UPDATE ledger SET status = ?, undo_json = ?, decided_at = ? WHERE id = ?',status,op?JSON.stringify(op):null,deps.now(),id);
 const pendingWrite=(id:string,status:string,op:Operation|null,expected:string,phase:'apply'|'undo')=>{
  sql.exec("UPDATE ledger SET status = ?, undo_json = ?, decided_at = ? WHERE id = ? AND undo_json = ? AND status IN (?, ?)",status,op?JSON.stringify(op):null,deps.now(),id,expected,phase==='apply'?'applying':'undoing',phase==='apply'?'uncertain':'undo_uncertain');
  return sql.exec<{changed:number}>('SELECT changes() AS changed').one().changed===1;
 };
 const clientFor=async(p:CalendarProposal,id:string,phase:'apply'|'undo',read=false)=>{
  const client=await deps.google(read?undefined:{id:`approval:${id}:${phase}`,requireRoute:true},'calendar',p.connection_id);
  if(!client||client.account?.connection_id!==p.connection_id||client.account.email!==p.account_email)throw new Error('The approved calendar account is unavailable. No other account was selected.');
  return client;
 };
 const present=async(client:GoogleClient,id:string):Promise<CalendarItem|null>=>{
  try{const event=await client.event(id);if(!event||event.id!==id)throw new Error('Calendar readback returned a different event');return event;}catch(error){if(error instanceof GoogleError&&[404,410].includes(error.status))return null;throw error;}
 };
 const receipt=(p:CalendarProposal,op:Operation):Decision=>op.phase==='undo'
  ?{toast:'Undone',message:`Undone: ${deps.describe(p)}.`}
  :{toast:'Done',message:`Done: ${deps.describe(p)} on ${p.account_email} (primary calendar).${op.op&&op.applied_etag?' Undo is available for 10 minutes.':" This one can't be safely undone from here."}`};
 const confirm=async(id:string,p:CalendarProposal,op:Operation,client:GoogleClient):Promise<Decision>=>{
  const expected=JSON.stringify(op);
  const event=await present(client,op.target_id);
  const cancelled=op.phase==='apply'?p.action==='cancel':p.action==='create';
  const start=op.phase==='undo'?op.before?.start:p.start;
  const end=op.phase==='undo'?op.before?.end:p.end;
  const confirmed=cancelled?event===null||event.status==='cancelled':!!event&&event.status!=='cancelled'&&event.operation_tag===`${p.operation_tag}:${op.phase}`&&Date.parse(event.start)===Date.parse(start??'')&&Date.parse(event.end)===Date.parse(end??'')&&(p.action!=='create'||event.title===p.title);
  if(!confirmed){pendingWrite(id,op.phase==='apply'?'uncertain':'undo_uncertain',op,expected,op.phase);return unknown;}
  op.confirmed_at=deps.now();
  return pendingWrite(id,op.phase==='apply'?'done':'undone',op,expected,op.phase)?receipt(p,op):unknown;
 };
 return {
  async prepare(p:ProposeCalendarChangeArgs,id:string,assertCurrent?:()=>Promise<void>):Promise<CalendarProposal>{
   await assertCurrent?.();
   if(p.calendar_id&&p.calendar_id!=='primary')throw new Error('Calendar changes only support the primary calendar');
   if(p.start&&p.end&&Date.parse(p.start)>=Date.parse(p.end))throw new Error('Calendar interval must advance');
   const client=await deps.google({id:`approval:${id}:apply`},'calendar',p.connection_id,assertCurrent);
   if(!client?.account?.connection_id||!client.account.email||(p.connection_id&&client.account.connection_id!==p.connection_id))throw new Error('Select a connected calendar account before proposing a change.');
   await assertCurrent?.();
   const before=p.event_id?await client.event(p.event_id):null;
   await assertCurrent?.();
   if(before&&(before.status==='cancelled'||!before.etag))throw new Error('The event is cancelled or its version is unavailable; no proposal was prepared.');
   const stored={...p,connection_id:client.account.connection_id,account_email:client.account.email,calendar_id:'primary' as const,...(before?{seen_etag:before.etag,title:before.title}:{}),provider_id:p.event_id??`a${(await sha256Hex(id)).slice(0,40)}`,operation_tag:id,binding_digest:''};
   stored.binding_digest=await sha256Hex(binding(stored));return stored;
  },
  async decide(id:string,phase:'apply'|'undo'):Promise<Decision>{
   const entry=row(id);if(!entry)return {toast:'Already handled.',message:'Already handled.'};
   const p=JSON.parse(entry.payload_json) as CalendarProposal;
   if(!p.connection_id||!p.binding_digest)return {toast:'Review required',message:'This legacy calendar approval has no frozen account. Check the calendar and ask for a fresh proposal.'};
   if(entry.status!==(phase==='apply'?'open':'done'))return unknown;
   const previous=entry.undo_json?JSON.parse(entry.undo_json) as Operation:null;
   if(phase==='undo'&&(!previous?.op||!previous.applied_etag))return {toast:"Can't be undone",message:'I cannot safely undo this because its applied calendar version is unavailable. Nothing was reversed.'};
   if(phase==='undo'&&(entry.decided_at===null||deps.now()-(previous?.started_at??entry.decided_at)>10*60_000))return {toast:'Too late to undo',message:'The 10-minute undo window has passed, so I left it as it is.'};
   // Consume approval before any asynchronous selection, validation, or provider call.
   sql.exec("UPDATE ledger SET status = ? WHERE id = ? AND status = ?",phase==='apply'?'applying':'undoing',id,entry.status);
   if(sql.exec<{changed:number}>('SELECT changes() AS changed').one().changed!==1)return unknown;
   let op:Operation={started_at:deps.now(),phase,target_id:p.provider_id,...(phase==='undo'&&previous?{before:previous.before}: {})};
   write(id,phase==='apply'?'applying':'undoing',op);
   let expectedRecord=JSON.stringify(op);
   let dispatched=false;
   try{
    if(await sha256Hex(binding(p))!==p.binding_digest){pendingWrite(id,'rejected',null,expectedRecord,phase);return {toast:'Review changed',message:'The stored calendar proposal changed after review. Nothing was applied; ask for a new proposal.'};}
    const client=await clientFor(p,id,phase);
    const before=phase==='apply'&&p.action==='create'?null:await client.event(p.provider_id);
    const expected=phase==='undo'?previous!.applied_etag:p.seen_etag;
    if(before&&(!expected||before.etag!==expected)){pendingWrite(id,phase==='apply'?'stale':'done',previous,expectedRecord,phase);return {toast:'The event changed',message:phase==='undo'?"The event changed after I applied this, so I didn't undo it. Your calendar was left as it is.":'The event changed after this proposal. Nothing was applied; ask for a fresh proposal.'};}
    if(phase==='apply'&&before)op.before={start:before.start,end:before.end};
    if(!pendingWrite(id,phase==='apply'?'applying':'undoing',op,expectedRecord,phase))return unknown;
    expectedRecord=JSON.stringify(op);
    dispatched=true;
    if(phase==='apply'&&p.action==='create'){
     const applied=await client.createEvent({id:p.provider_id,title:p.title!,start:p.start!,end:p.end!,operation_tag:`${p.operation_tag}:apply`});
     if(applied.id!==p.provider_id)throw new Error('Calendar returned a different event');
     op={...op,op:applied.etag?'cancel':undefined,id:applied.id,applied_etag:applied.etag};
    }else if((phase==='apply'&&p.action==='move')||(phase==='undo'&&p.action==='move')){
     const start=phase==='apply'?p.start!:previous!.before!.start,end=phase==='apply'?p.end!:previous!.before!.end;
     const applied=await client.moveEvent(p.provider_id,start,end,expected,`${p.operation_tag}:${phase}`);
     if(applied.id!==p.provider_id)throw new Error('Calendar returned a different event');
     op={...op,...(phase==='apply'&&applied.etag?{op:'move' as const,id:p.provider_id,start:before!.start,end:before!.end}:{}),applied_etag:applied.etag};
    }else await client.cancelEvent(p.provider_id,expected);
    if(!pendingWrite(id,phase==='apply'?'applying':'undoing',op,expectedRecord,phase))return unknown;
    expectedRecord=JSON.stringify(op);
    return await confirm(id,p,op,client);
   }catch(error){
    if(error instanceof GoogleError&&error.status===412){pendingWrite(id,phase==='apply'?'stale':'done',previous,expectedRecord,phase);return {toast:'The event changed',message:'The event changed before the conditional write. Nothing was overwritten or deleted.'};}
    if(!dispatched){pendingWrite(id,phase==='apply'?'rejected':'done',previous,expectedRecord,phase);return {toast:'Calendar unavailable',message:error instanceof Error?error.message:String(error)};}
    pendingWrite(id,phase==='apply'?'uncertain':'undo_uncertain',op,expectedRecord,phase);return unknown;
   }
  },
  delivered(id:string,phase:'apply'|'undo'){const entry=row(id);if(!entry?.undo_json)return;const op=JSON.parse(entry.undo_json) as Operation;if(op.phase===phase&&op.confirmed_at!==undefined){op.delivered_at=deps.now();sql.exec('UPDATE ledger SET undo_json = ? WHERE id = ? AND undo_json = ? AND status = ?',JSON.stringify(op),id,entry.undo_json,phase==='apply'?'done':'undone');}},
  async reconcile(){
   const rows=sql.exec<Row>("SELECT * FROM ledger WHERE kind = 'calendar_change' AND json_extract(payload_json, '$.connection_id') IS NOT NULL AND json_extract(undo_json, '$.phase') IS NOT NULL AND (status IN ('applying','uncertain','undoing','undo_uncertain') OR (status IN ('done','undone') AND json_extract(undo_json, '$.delivered_at') IS NULL)) ORDER BY COALESCE(json_extract(undo_json, '$.recovery_order'), 0), created_at LIMIT 8").toArray();
   for(const entry of rows){
    const p=JSON.parse(entry.payload_json) as CalendarProposal,op=JSON.parse(entry.undo_json!) as Operation;
    op.recovery_order=sql.exec<{n:number}>("SELECT COALESCE(MAX(json_extract(undo_json, '$.recovery_order')), 0) + 1 AS n FROM ledger WHERE kind = 'calendar_change'").one().n;
    sql.exec('UPDATE ledger SET undo_json = ? WHERE id = ? AND status = ? AND undo_json = ?',JSON.stringify(op),entry.id,entry.status,entry.undo_json);
    if(sql.exec<{changed:number}>('SELECT changes() AS changed').one().changed!==1)continue;
    try{
     if(await sha256Hex(binding(p))!==p.binding_digest)continue;
     let out=receipt(p,op);
     if(op.confirmed_at===undefined)out=await confirm(entry.id,p,op,await clientFor(p,entry.id,op.phase,true));
     if(out.toast==='Done'||out.toast==='Undone'){
      const expectedRecord=JSON.stringify(op),expectedStatus=op.phase==='apply'?'done':'undone';
      const current=row(entry.id);if(current?.status!==expectedStatus||current.undo_json!==expectedRecord)continue;
      const sent=await deps.say(out.message,out.toast==='Done'&&op.op&&op.applied_etag? [['Undo',`u:${entry.id}`]]:undefined);
      if(sent!=null){op.delivered_at=deps.now();sql.exec('UPDATE ledger SET undo_json = ? WHERE id = ? AND status = ? AND undo_json = ?',JSON.stringify(op),entry.id,expectedStatus,expectedRecord);}
     }
    }catch{/* Keep uncertainty and the same connection; reconciliation never dispatches a write. */}
   }
  },
 };
};
