import {DatabaseSync} from 'node:sqlite';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createOwnerDayPlan,personalDayBounds} from '../src/channels/owner-day-plan';
import {APP_PERSONAL_MOMENTS_V1,appPersonalDayV1Schema,appPersonalDayQueryV1Schema} from '../../contracts/src/app/personal';
import type {GoogleClient} from '../src/connectors/google';
import type {SourceKey} from '../src/proactivity/types';
const at=Date.parse('2026-10-10T10:00:00Z'),databases:DatabaseSync[]=[];
afterEach(()=>databases.splice(0).forEach(db=>db.close()));
function fixture() {
  const db=new DatabaseSync(':memory:');databases.push(db);
  const sql={exec(query:string,...args:(string|number|null)[]){const rows=db.prepare(query).all(...args);return {toArray:()=>rows};}} as unknown as Pick<SqlStorage,'exec'>;
  const transaction=<T>(work:()=>T):T=>{db.exec('BEGIN');try{const value=work();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
  let epoch=1,owner='canonical-app-owner',allowed=true,taskTitle='Prepare school form',eventTitle='Project meeting',sourceRevision=1;
  const sources:SourceKey[]=[{source:'calendar',accountId:'work',collection:'team'},{source:'tasks',accountId:'work',collection:'projects'},{source:'tasks',accountId:'personal',collection:'family'}];
  const reads:{source:string;account:string;collection:string;token?:string}[]=[];
  const clients=new Map<string,GoogleClient>();
  for (const account of ['work','personal']) clients.set(account,{account:{connection_id:account,email:`${account}@example.test`},calendarPage:async(collection:string,_from:string,_to:string,_limit:number,_declined:boolean,token?:string)=>{reads.push({source:'calendar',account,collection,token});return {events:token?[{id:'second',title:'Lunch',start:'2026-10-10T12:00:00Z',end:'2026-10-10T12:30:00Z',all_day:false}]:[{id:'meeting',title:eventTitle,start:'2026-10-10T11:00:00Z',end:'2026-10-10T11:30:00Z',all_day:false}],next_page_token:token?null:'page-2',account:{connection_id:account,email:`${account}@example.test`}};},tasksPage:async(collection:string,_status:string,_limit:number,token?:string)=>{reads.push({source:'tasks',account,collection,token});return {tasks:[{id:`${collection}-task`,title:collection==='family'?taskTitle:'Write proposal',status:'todo',task_list_id:collection,notes:'Full relevant task instructions.',due:'2026-10-10T00:00:00Z'}],next_page_token:null,task_list_ids:[collection],account:{connection_id:account,email:`${account}@example.test`}};}} as unknown as GoogleClient);
  const prompt=vi.fn(async(_instruction:string,input:any,_schema:object,current:()=>Promise<void>)=>{await current();const refs=input.full_current_sources.map((row:any)=>row.source_ref);return JSON.stringify({overview:'Your meetings and family task leave a preparation window.',buffers:[{title:'Prepare the school form',start:at,end:at+30*60000,kind:'preparation',source_refs:refs}],moments:APP_PERSONAL_MOMENTS_V1.map(id=>({id,state:id==='heads_up'?'silent':'prepared',body:id==='heads_up'?'':`${id}: Current calendar and task preparation.`,source_refs:refs}))});});
  const enqueue=vi.fn(async()=>({state:'delivered' as const,receiptRef:'app-journal:exact-synthetic-message'}));
  const make=(inventoryCoverage?:Parameters<typeof createOwnerDayPlan>[0]['inventoryCoverage'])=>createOwnerDayPlan({inventoryCoverage,sql,ownerKey:'canonical-app-owner',accountRef:`acct_${'a'.repeat(64)}`,sourceRevision:()=>sourceRevision,now:()=>at,timezone:()=> 'UTC',transaction,assertCurrent:async()=>{if(owner!=='canonical-app-owner')throw new Error('owner revoked');},sources:async()=>allowed?sources:[],admit:async()=>({ownerKey:owner,epoch,regime:`grant:${epoch}`,available:allowed,connected:allowed}),google:{client:async(_feature,_intent,guard,email)=>{await guard?.();return clients.get(email!.split('@')[0]!)??null;}},accountEmail:async id=>`${id}@example.test`,facts:async()=>[],prompt,notificationEligible:async()=>allowed,enqueue});
  return {sql,make,prompt,enqueue,reads,clients,revoke:()=>{allowed=false;epoch++;},editTask:()=>{taskTitle='Owner corrected family obligation';},editEvent:()=>{eventTitle='Provider changed meeting';},changeOwner:()=>{owner='foreign-owner';},changeRevision:()=>{sourceRevision++;}};
}
describe('canonical personal day and authored six moments',()=>{
  it('projects complete paged calendar and both task accounts with no invented authored body',async()=>{
    const f=fixture(),value=await f.make().read();expect(appPersonalDayV1Schema.safeParse(value).success).toBe(true);
    expect(value.state).toBe('source_only');expect(value.events).toHaveLength(2);expect(value.tasks.map(row=>row.source_ref.account_ref).sort()).toEqual(['personal','work']);
    expect(value.coverage).toHaveLength(3);expect(value.coverage.every(row=>row.state==='complete')).toBe(true);expect(value.moments.every(row=>row.body===''&&row.state==='unavailable')).toBe(true);expect(f.prompt).not.toHaveBeenCalled();
    expect(f.reads.filter(row=>row.source==='calendar').map(row=>row.token)).toEqual([undefined,'page-2']);
  });
  it('authors all six source-backed experiences through actual model port and marks buffers proposed',async()=>{
    const f=fixture(),plan=await f.make().produce();expect(plan.state).toBe('prepared');expect(plan.moments.map(row=>row.id)).toEqual([...APP_PERSONAL_MOMENTS_V1]);expect(plan.buffers[0]!.authority).toBe('proposed');expect(plan.moments.every(row=>row.source_refs.length>0)).toBe(true);
    expect(JSON.stringify(f.prompt.mock.calls[0]![1])).toContain('Full relevant task instructions.');
    const stored=JSON.stringify(f.sql.exec('SELECT value FROM owner_personal_day').toArray());expect(stored).not.toContain('Full relevant task instructions.');
    expect((await f.make().read()).revision).toBe(1);expect((await f.make().produce()).revision).toBe(1);expect(f.prompt).toHaveBeenCalledTimes(1);
  });
  it('rejects invented source refs and source changes during model work without publishing a plan',async()=>{
    for(const mode of ['ref','source'] as const){const f=fixture(),original=f.prompt.getMockImplementation()!;
      f.prompt.mockImplementation(async(...args)=>{const raw=await original(...args);if(mode==='source'){f.editTask();return raw;}const value=JSON.parse(raw);value.moments[0].source_refs=['invented-ref'];return JSON.stringify(value);});
      await expect(f.make().produce()).rejects.toThrow();expect(f.sql.exec('SELECT value FROM owner_personal_day').toArray()).toEqual([]);expect(f.enqueue).not.toHaveBeenCalled();}
  });
  it('excludes retained authored source material after disconnect and rejects a foreign canonical owner',async()=>{
    const f=fixture();await f.make().produce();f.revoke();const value=await f.make().read();expect(value.events).toEqual([]);expect(value.tasks).toEqual([]);expect(value.overview).toBeNull();expect(value.moments.every(row=>!row.body)).toBe(true);
    const g=fixture();g.changeOwner();await expect(g.make().read()).rejects.toThrow('owner revoked');
  });
  it('holds a prepared moment after correction and records usable journal custody only from actual port receipt',async()=>{
    const f=fixture(),adapter=f.make();await adapter.produce();const result=await adapter.deliverMoment('brief');expect(result).toEqual({state:'delivered',receiptRef:'app-journal:exact-synthetic-message'});expect(f.enqueue).toHaveBeenCalledTimes(1);
    await adapter.deliverMoment('brief');expect(f.enqueue).toHaveBeenCalledTimes(1);f.editEvent();expect(await adapter.deliverMoment('window')).toEqual({state:'blocked'});expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it('preserves unknown delivery after restart and cannot resend an ambiguous physical attempt',async()=>{
    const f=fixture();f.enqueue.mockImplementation(async()=>{throw new Error('ACK lost');});const adapter=f.make();await adapter.produce();expect(await adapter.deliverMoment('brief')).toEqual({state:'unknown'});
    expect(await f.make().deliverMoment('brief')).toEqual({state:'unknown'});expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it('keeps independent healthy collections useful while an actual provider read is unavailable',async()=>{
    const f=fixture(),old=f.clients.get('work')!;f.clients.set('work',{...old,calendarPage:async()=>{throw new Error('provider down');}});
    const value=await f.make().read();expect(value.events).toEqual([]);expect(value.tasks).toHaveLength(2);expect(value.coverage.find(row=>row.source==='calendar')!.state).toBe('unavailable');expect(value.coverage.filter(row=>row.source==='tasks').every(row=>row.state==='complete')).toBe(true);
  });
  it('uses local date boundaries through DST and strict query/identity shape',()=>{
    const fall=personalDayBounds('2026-11-01','America/New_York'),spring=personalDayBounds('2026-03-08','America/New_York');expect(fall.to-fall.from).toBe(25*3600000);expect(spring.to-spring.from).toBe(23*3600000);
    expect(appPersonalDayQueryV1Schema.safeParse({day:'2026-02-30'}).success).toBe(false);expect(appPersonalDayQueryV1Schema.safeParse({day:'2026-10-10',owner_id:'other'}).success).toBe(false);
  });
});

it('exposes authenticated unknown collection coverage to the app and authorship instead of silently dropping a source account',async()=>{
 const f=fixture(),unknown={source:'calendar' as const,accountId:'second-work',collection:null,state:'unavailable' as const,reason:'collection_inventory_unavailable'};
 const plan=await f.make(()=>[unknown]).produce();expect(appPersonalDayV1Schema.safeParse(plan).success).toBe(true);
 expect(plan.coverage).toContainEqual({source:'calendar',account_ref:'second-work',collection_ref:null,from:Date.parse('2026-10-10T00:00:00Z'),to:Date.parse('2026-10-11T00:00:00Z'),state:'unavailable',reason:'collection_inventory_unavailable'});
 expect(f.prompt.mock.calls[0]![1].coverage).toEqual(plan.coverage);
});
