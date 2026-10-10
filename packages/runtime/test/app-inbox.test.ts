import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { AppInbox } from '../src/channels/app-inbox';
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
