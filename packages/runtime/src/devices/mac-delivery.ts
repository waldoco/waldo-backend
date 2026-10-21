import { canonicalJson } from './canonical-json';
import { identifier, record, exact, byteString } from './wire';
import { macResultPayload } from './mac-wire';
import { sha256Hex } from './signing';
export const MAC_FOLLOWUP_RETRY_MS = 60_000;
export const MAC_FOLLOWUP_UNDELIVERABLE_RETRY_MS = 15 * 60_000;
export type MacDelivery = {kind:'result'|'session_event';request_id:string;device_id:string;owner_id:string;payload:Record<string,unknown>};
export function macDelivery(value:unknown):value is MacDelivery {
 if(!record(value)||!exact(value,['kind','request_id','device_id','owner_id','payload'])||!identifier(value.request_id)||!identifier(value.device_id)||!identifier(value.owner_id)||!record(value.payload)||new TextEncoder().encode(canonicalJson(value)).length>8192)return false;
 const p=value.payload;
 return value.kind==='result' ? macResultPayload(p)||(p.status==='failed'&&exact(p,['status','reason'])&&p.reason==='processing_failed') : value.kind==='session_event'&&exact(p,['session_id','project','event'])&&identifier(p.session_id)&&byteString(p.project,1,128)&&['needs_input','blocked_on_tool','turn_finished','exited'].includes(String(p.event));
}
export function macInbox(storage:Pick<DurableObjectStorage,'sql'|'transactionSync'|'kv'>){
 const sql=storage.sql;sql.exec("CREATE TABLE IF NOT EXISTS mac_result_inbox(id TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending')");
 const rearm=()=>{const pending=sql.exec("SELECT id FROM mac_result_inbox WHERE state='pending' LIMIT 1").toArray().length;storage.kv.put('mac_results_due_v1',pending?Date.now()+250:null);};
 return {
  async admit(delivery:MacDelivery){
   const body=canonicalJson(delivery),digest=await sha256Hex(new TextEncoder().encode(body)),id=`${delivery.kind}:${delivery.request_id}`;
   return storage.transactionSync(()=>{
    const old=sql.exec<{digest:string}>('SELECT digest FROM mac_result_inbox WHERE id=?',id).toArray()[0];if(old)return old.digest===digest;
    if(Number(sql.exec('SELECT count(*) AS n FROM mac_result_inbox').one().n)>=100000)return false;
    sql.exec('INSERT INTO mac_result_inbox(id,digest,body) VALUES(?,?,?)',id,digest,body);storage.kv.put('mac_results_due_v1',Date.now()+250);return true;
   });
  },
  pending(){return sql.exec<{id:string;body:string}>("SELECT id,body FROM mac_result_inbox WHERE state='pending' ORDER BY rowid LIMIT 20").toArray();},
  finish(id:string){sql.exec("UPDATE mac_result_inbox SET state='finished' WHERE id=? AND state='pending'",id);rearm();},
  // Permanent: the row's device custody no longer resolves to this owner. Kept for audit, never retried.
  quarantine(id:string){sql.exec("UPDATE mac_result_inbox SET state='quarantined' WHERE id=? AND state='pending'",id);rearm();},
  // Transient failure: keep pending rows, but do not wake the alarm again before the backoff.
  retryLater(ms:number){storage.kv.put('mac_results_due_v1',Date.now()+ms);},
 };
}
export function macResultNotice(delivery:MacDelivery):string {
 const p=delivery.payload;
 if(delivery.kind==='session_event')return `Mac session ${String(p.session_id)} (${String(p.project)}): ${String(p.event)}. ${p.event==='blocked_on_tool'?'Owner input is required on the Mac.':''}`.trim();
 return `Mac request ${delivery.request_id}: ${String(p.status)}${p.status==='completed'?` (exit code ${String(p.exit_code)})`:''}.${p.status==='outcome_unknown'?' The command was not re-run.':p.status==='denied'||p.status==='expired'?' Nothing was started.':''}`;
}
