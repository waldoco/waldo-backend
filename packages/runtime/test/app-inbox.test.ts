import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { AppInbox, APP_INBOX_RETENTION_MS, type AppInboxRecord } from '../src/channels/app-inbox';
import { APP_INBOX_DUE_KEY, rearmSharedAlarm } from '../src/scheduler/alarm-slot';

it('app payload and wake rollback together; successful admission preserves an earlier sibling wake',async()=>{
  const name=`app-inbox-atomic-${crypto.randomUUID()}`,stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(stub,async(_instance,state)=>{
    const storage=state.storage;
    const broken={transaction:<T>(work:(txn:DurableObjectTransaction)=>Promise<T>)=>storage.transaction(txn=>work(new Proxy(txn,{get(target,key){if(key==='getAlarm')return async()=>{throw Error('alarm storage fault');};const member=Reflect.get(target,key);return typeof member==='function'?member.bind(target):member;}})))} as unknown as DurableObjectStorage;
    await expect(new AppInbox(broken).admit(name,'a'.repeat(64),'atomic-client-0001','Original text','owner:prn_fixture')).rejects.toThrow('alarm storage fault');
    const inbox=new AppInbox(storage);expect(inbox.records()).toHaveLength(0);expect(await storage.get('app_seq')).toBeUndefined();expect(await storage.get(APP_INBOX_DUE_KEY)).toBeUndefined();
    const sibling=Date.now()+10_000;await storage.put('telegram_final_outbox_due_v1',sibling);await rearmSharedAlarm(storage,null,Date.now());
    const result=await inbox.admit(name,'a'.repeat(64),'atomic-client-0001','Original text','owner:prn_fixture');expect(result.kind).toBe('admitted');expect(await storage.getAlarm()).toBeLessThanOrEqual(sibling);
    const record=inbox.claim(inbox.records()[0]!.id,true)!;inbox.settle(record,true);await rearmSharedAlarm(storage,null,Date.now());expect(await storage.getAlarm()).toBe(sibling);
    await storage.deleteAlarm();
  });
});

const seed=(storage:DurableObjectStorage,id:string,state:AppInboxRecord['state'],at:number,clientId=`seed-client-${id}`)=>storage.kv.put(`app:inbox-record:${id}`,{id,updateId:1,clientId,digest:'d',text:'',owner:'o',sessionHash:'a'.repeat(64),conversationRef:'owner:prn_fixture',admittedAt:at,state,...(state==='completed'||state==='interrupted'||state==='revoked'?{closedAt:at}:{})} satisfies AppInboxRecord);

it('an owner whose inbox is full of old finished messages can still send',async()=>{
  const name=`app-inbox-prune-${crypto.randomUUID()}`,stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(stub,async(_instance,state)=>{
    const now=Date.now(),old=now-APP_INBOX_RETENTION_MS-60_000;
    for(let i=0;i<4096;i++)seed(state.storage,`app-old-${i}`,i%3===0?'completed':i%3===1?'interrupted':'revoked',old+i);
    const inbox=new AppInbox(state.storage,()=>now);
    const result=await inbox.admit(name,'b'.repeat(64),'fresh-client-0001','hello','owner:prn_fixture');
    expect(result.kind).toBe('admitted');
    expect(inbox.records().length).toBeLessThan(4096);
  });
});

it('a recent finished message keeps its receipt and a retry of it stays a duplicate',async()=>{
  const name=`app-inbox-keep-${crypto.randomUUID()}`,stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(stub,async(_instance,state)=>{
    const now=Date.now(),inbox=new AppInbox(state.storage,()=>now);
    const first=await inbox.admit(name,'b'.repeat(64),'keep-client-0001','same text','owner:prn_fixture');
    expect(first.kind).toBe('admitted');
    inbox.settle(inbox.claim(inbox.records()[0]!.id,true)!,true);
    for(let i=0;i<300;i++)seed(state.storage,`app-old-${i}`,'completed',now-APP_INBOX_RETENTION_MS-60_000-i);
    await inbox.admit(name,'b'.repeat(64),'other-client-0001','another','owner:prn_fixture');
    expect(inbox.receipt(name,'keep-client-0001')).toMatchObject({accepted:true,state:'completed'});
    expect((await inbox.admit(name,'b'.repeat(64),'keep-client-0001','same text','owner:prn_fixture')).kind).toBe('duplicate');
  });
});

it('never prunes a message that is still admitted or running, and still refuses past the cap',async()=>{
  const name=`app-inbox-active-${crypto.randomUUID()}`,stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(stub,async(_instance,state)=>{
    const now=Date.now(),old=now-APP_INBOX_RETENTION_MS-60_000;
    seed(state.storage,'app-live-admitted','admitted',old);seed(state.storage,'app-live-running','running',old);
    for(let i=0;i<4094;i++)seed(state.storage,`app-fresh-${i}`,'completed',now-1_000-i);
    const inbox=new AppInbox(state.storage,()=>now);
    expect((await inbox.admit(name,'b'.repeat(64),'cap-client-0001','x','owner:prn_fixture')).kind).toBe('capacity');
    const states=inbox.records().filter(row=>row.id.startsWith('app-live')).map(row=>row.state).sort();
    expect(states).toEqual(['admitted','running']);
  });
});
