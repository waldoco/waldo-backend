import { env, runInDurableObject } from 'cloudflare:test';
import { expect,it } from 'vitest';
import type { DeviceBridgeDO } from '../src/devices/device-bridge-do';
import { DeviceCommandStore } from '../src/devices/command-store';
it('atomically enforces strict rolling notification caps and counts stable retries once',async()=>{
 const stub=env.DEVICE_BRIDGE_DO!.get(env.DEVICE_BRIDGE_DO!.idFromName('dev_notify_fixture')) as DurableObjectStub<DeviceBridgeDO>;
 await runInDurableObject(stub,(_instance,state)=>{
  const store=new DeviceCommandStore(state.storage);
  const input=(n:number)=>({owner_id:'owner_fixture',device_id:'dev_notify_fixture',request_id:`request_${n}`,class:'notify_local' as const,payload:{notification_id:`notification_${n}`,title:'Waldo status',body:'Status update',severity:'info' as const}});
  for(let n=0;n<5;n++) expect(store.enqueue(input(n),1000,['notify_local']).accepted).toBe(true);
  expect(store.enqueue(input(5),1059,['notify_local'])).toMatchObject({accepted:false,reason:'rate_limited'});
  expect(store.enqueue(input(0),1059,['notify_local'])).toMatchObject({accepted:true,duplicate:true});
  for(let n=5;n<20;n++) expect(store.enqueue(input(n),1000+Math.floor(n/5)*60,['notify_local']).accepted).toBe(true);
  expect(store.enqueue(input(20),1300,['notify_local'])).toMatchObject({accepted:false,reason:'rate_limited'});
  expect(store.list(100)).toHaveLength(20); store.cancelQueued(); expect(store.pending(1300)).toHaveLength(0);
 });
});
