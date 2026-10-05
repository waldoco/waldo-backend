import { env, runInDurableObject } from 'cloudflare:test';
import { expect,it } from 'vitest';
import type { DeviceBridgeDO } from '../src/devices/device-bridge-do';
import { DeviceCommandStore } from '../src/devices/command-store';
it('atomically enforces strict rolling notification caps and counts stable retries once',async()=>{
 const stub=env.DEVICE_BRIDGE_DO!.get(env.DEVICE_BRIDGE_DO!.idFromName('dev_notify_fixture')) as DurableObjectStub<DeviceBridgeDO>;
 await runInDurableObject(stub,async (_instance,state)=>{
  const store=new DeviceCommandStore(state.storage);
  const input=(n:number)=>({owner_id:'owner_fixture',device_id:'dev_notify_fixture',request_id:`request_${n}`,class:'notify_local' as const,payload:{notification_id:`notification_${n}`,title:'Waldo status',body:'Status update',severity:'info' as const}});
  for(let n=0;n<5;n++) expect((await store.enqueue(input(n),1000,['notify_local'])).accepted).toBe(true);
  expect(await store.enqueue(input(5),1059,['notify_local'])).toMatchObject({accepted:false,reason:'rate_limited'});
  expect(await store.enqueue(input(0),1059,['notify_local'])).toMatchObject({accepted:true,duplicate:true});
  for(let n=5;n<20;n++) expect((await store.enqueue(input(n),1000+Math.floor(n/5)*60,['notify_local'])).accepted).toBe(true);
  expect(await store.enqueue(input(20),1300,['notify_local'])).toMatchObject({accepted:false,reason:'rate_limited'});
  expect(store.list(100)).toHaveLength(20); store.cancelQueued(); expect(store.pending(1300)).toHaveLength(0);
 });
});
it.each([['info'], { value:'info' }, null, 1, true].map(value => [value]))('rejects nonstring notification severities %#',async severity=>{
 const stub=env.DEVICE_BRIDGE_DO!.get(env.DEVICE_BRIDGE_DO!.idFromName('dev_notify_shape_fixture')) as DurableObjectStub<DeviceBridgeDO>;
 await runInDurableObject(stub,async(_instance,state)=>{
  const store=new DeviceCommandStore(state.storage);
  const result=await store.enqueue({owner_id:'owner_fixture',device_id:'dev_notify_shape_fixture',request_id:'shape_fixture',class:'notify_local',payload:{notification_id:'shape_notification',title:'Waldo status',body:'Status update',severity}} as never,1000,['notify_local']);
  expect(result).toMatchObject({accepted:false,reason:'invalid_shape'}); expect(store.list()).toHaveLength(0);
 });
});
it('refuses changing a notification retry request ID instead of issuing an untracked successful alias',async()=>{
 const stub=env.DEVICE_BRIDGE_DO!.get(env.DEVICE_BRIDGE_DO!.idFromName('dev_notify_request_fixture')) as DurableObjectStub<DeviceBridgeDO>;
 await runInDurableObject(stub,async(_instance,state)=>{
  const store=new DeviceCommandStore(state.storage);
  const input=(request_id:string,notification_id:string)=>({owner_id:'owner_fixture',device_id:'dev_notify_request_fixture',request_id,class:'notify_local' as const,payload:{notification_id,title:'Waldo status',body:'Status update',severity:'info' as const}});
  expect(await store.enqueue(input('request_a','notification_n'),1000,['notify_local'])).toMatchObject({accepted:true,duplicate:false});
  expect(await store.enqueue(input('request_b','notification_n'),1001,['notify_local'])).toMatchObject({accepted:false,reason:'idempotency_conflict'});
  expect(await store.enqueue(input('request_b','notification_m'),1002,['notify_local'])).toMatchObject({accepted:true,duplicate:false});
  expect(store.list()).toHaveLength(2);
 });
});
