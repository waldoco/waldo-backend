import { APP_UPDATE_BASE } from './app-api';
import { APP_INBOX_DUE_KEY, persistAppInboxWake } from '../scheduler/alarm-slot';
import { ClosedRunError, type RunEffectScope } from './run-effect-scope';
import { sha256Hex, stableJson } from '../context-composer/canonical';
import { redactSecretUrls } from './egress-guard';

const PREFIX = 'app:inbox-record:';
// A finished row keeps its receipt, and so the idempotency of its client_message_id, for this long. After that a late
// retry of the same id is a new message. When the table is full the oldest finished rows go earlier, but never younger
// than the floor, so a flood cannot lock an owner out for the whole retention window and a recent retry still matches.
// Bounded per admit so one send never does unbounded storage work.
export const APP_INBOX_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const APP_INBOX_FLOOR_MS = 12 * 60 * 60_000;
const MAX_ROWS = 4096;
const PRUNE_PER_ADMIT = 512;
const finished = (row: AppInboxRecord) => row.state === 'completed' || row.state === 'interrupted' || row.state === 'revoked';
const closedAt = (row: AppInboxRecord) => row.closedAt ?? row.admittedAt;
export type AppInboxRecord = {
  id: string; updateId: number; clientId: string; digest: string; text: string;
  owner: string; sessionHash: string; conversationRef: string; admittedAt: number;
  state: 'admitted' | 'running' | 'completed' | 'interrupted' | 'revoked';
  attempt?: string; deadline?: number; closedAt?: number;
  closedReason?: 'interrupted' | 'session_revoked'; effectsUnconfirmed?: boolean;
};
const due = (rows: readonly AppInboxRecord[], now: number) => rows.some(row => row.state === 'admitted') ? now + 250 : null;
const clear = (row: AppInboxRecord) => { row.text = ''; };
// One durable writer: admitted payload, digest, sequence and alarm commit before ACK.
// A recovered running attempt is uncertain and never becomes runnable again.
export class AppInbox {
  constructor(private readonly storage: DurableObjectStorage, private readonly now = Date.now) {}
  records(): AppInboxRecord[] { return [...this.storage.kv.list<AppInboxRecord>({prefix:PREFIX})].map(([,row])=>row).sort((a,b)=>a.updateId-b.updateId); }
  receipt(owner: string, clientId: string) {
    const row=this.records().find(row=>row.owner===owner&&row.clientId===clientId);
    return row?{accepted:true as const,message_id:row.id,state:row.state,...(row.closedReason?{closed_reason:row.closedReason}:{}),...(row.effectsUnconfirmed!==undefined?{effects_unconfirmed:row.effectsUnconfirmed}:{})}:null;
  }
  async admit(owner:string,sessionHash:string,clientId:string,text:string,conversationRef:string,assertCurrent?:()=>void) {
    const digest=await sha256Hex(stableJson({text,conversationRef}));
    return this.storage.transaction(async txn=>{
      assertCurrent?.();
      const now=this.now();
      const evict=async(rows:AppInboxRecord[],olderThan:number)=>{
        const gone=rows.filter(row=>finished(row)&&closedAt(row)<olderThan).sort((a,b)=>closedAt(a)-closedAt(b)).slice(0,PRUNE_PER_ADMIT);
        for(const row of gone)await txn.delete(PREFIX+row.id);
        const ids=new Set(gone.map(row=>row.id));
        return rows.filter(row=>!ids.has(row.id));
      };
      let rows=await evict([...(await txn.list<AppInboxRecord>({prefix:PREFIX})).values()],now-APP_INBOX_RETENTION_MS);
      const previous=rows.find(row=>row.clientId===clientId);
      if(previous)return previous.owner===owner&&previous.digest===digest?{kind:'duplicate' as const,record:previous}:{kind:'conflict' as const};
      if(rows.length>=MAX_ROWS)rows=await evict(rows,now-APP_INBOX_FLOOR_MS);
      if(rows.length>=MAX_ROWS||rows.filter(row=>row.state==='admitted'||row.state==='running').length>=256)return {kind:'capacity' as const};
      const sequence=(await txn.get<number>('app_seq')??0)+1;
      const record:AppInboxRecord={id:`app-${APP_UPDATE_BASE+sequence}`,updateId:APP_UPDATE_BASE+sequence,clientId,digest,text:redactSecretUrls(text).text,owner,sessionHash,conversationRef,admittedAt:this.now(),state:'admitted'};
      assertCurrent?.();
      await txn.put({[PREFIX+record.id]:record,app_seq:sequence});
      await persistAppInboxWake(txn,this.now()+250);
      return {kind:'admitted' as const,record};
    });
  }
  recover(live:ReadonlySet<string>):void {
    this.storage.transactionSync(()=>{
      const rows=this.records();
      for(const row of rows)if(row.state==='running'&&!live.has(row.attempt??'')) {row.state='interrupted';row.closedReason='interrupted';row.effectsUnconfirmed=true;row.closedAt=this.now();clear(row);this.storage.kv.put(PREFIX+row.id,row);}
      this.storage.kv.put(APP_INBOX_DUE_KEY,due(rows,this.now()));
    });
  }
  // Signing out closes the session's admitted and running messages through the one durable writer. A running turn's
  // scope.admit() re-reads its row before every effect, so it stops at its next check; its effects are unconfirmed.
  revokeSession(sessionHash:string):number {
    return this.storage.transactionSync(()=>{
      let fenced=0;
      for(const row of this.records()){
        if(row.sessionHash!==sessionHash||(row.state!=='admitted'&&row.state!=='running'))continue;
        const ran=row.state==='running';
        row.state='revoked';row.closedReason='session_revoked';row.effectsUnconfirmed=ran;row.closedAt=this.now();clear(row);
        this.storage.kv.put(PREFIX+row.id,row);fenced+=1;
      }
      this.storage.kv.put(APP_INBOX_DUE_KEY,due(this.records(),this.now()));
      return fenced;
    });
  }
  claim(id:string,sessionCurrent:boolean):AppInboxRecord|null {
    return this.storage.transactionSync(()=>{
      const row=this.storage.kv.get<AppInboxRecord>(PREFIX+id);if(!row||row.state!=='admitted')return null;
      row.state=sessionCurrent?'running':'revoked';
      if(sessionCurrent){row.attempt=crypto.randomUUID();row.deadline=this.now()+15*60_000;}
      else{row.closedAt=this.now();row.closedReason='session_revoked';row.effectsUnconfirmed=false;clear(row);}
      this.storage.kv.put(PREFIX+id,row);this.storage.kv.put(APP_INBOX_DUE_KEY,due(this.records(),this.now()));
      return sessionCurrent?structuredClone(row):null;
    });
  }
  scope(record:AppInboxRecord,signal:AbortSignal):RunEffectScope {
    const admit=()=>{
      const row=this.storage.kv.get<AppInboxRecord>(PREFIX+record.id);
      if(signal.aborted||!row||row.state!=='running'||row.attempt!==record.attempt||row.owner!==record.owner||row.sessionHash!==record.sessionHash||row.digest!==record.digest||row.text!==record.text||row.conversationRef!==record.conversationRef||this.now()>=(record.deadline??0))throw new ClosedRunError();
    };
    return {runId:record.id,attempt:record.attempt!,deadline:record.deadline!,signal,admit,commit:work=>this.storage.transactionSync(()=>{admit();return work();})};
  }
  settle(record:AppInboxRecord,completed:boolean):void {
    this.storage.transactionSync(()=>{
      const row=this.storage.kv.get<AppInboxRecord>(PREFIX+record.id);if(!row||row.state!=='running'||row.attempt!==record.attempt)return;
      row.state=completed?'completed':'interrupted';row.closedAt=this.now();clear(row);
      if(!completed){row.closedReason='interrupted';row.effectsUnconfirmed=true;}
      this.storage.kv.put(PREFIX+row.id,row);this.storage.kv.put(APP_INBOX_DUE_KEY,due(this.records(),this.now()));
    });
  }
}
