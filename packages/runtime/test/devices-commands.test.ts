import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { DeviceBridgeDO } from '../src/devices/device-bridge-do';
import { DeviceCommandStore } from '../src/devices/command-store';
import { ackFrame, resultFrame } from '../src/devices/wire';
const input = (request_id: string) => ({ owner_id: 'owner_fixture', device_id: 'dev_commands_fixture', request_id, class: 'machine_state_query' as const, payload: { query_id: request_id, query_kind: 'session_status' as const } });
const setup = async (test: (store: DeviceCommandStore) => void | Promise<void>) => {
 const stub=env.DEVICE_BRIDGE_DO!.get(env.DEVICE_BRIDGE_DO!.idFromName('dev_commands_fixture')) as DurableObjectStub<DeviceBridgeDO>;
 await runInDurableObject(stub, (_instance,state)=>test(new DeviceCommandStore(state.storage)));
};
it('queues stable command bytes, rejects conflicting retries and invalid TTL, and expires only undelivered work',async()=>setup(async store=>{
 const first=await store.enqueue(input('query_1'),1000,['machine_state_query']); expect(first.accepted).toBe(true);
 const retry=await store.enqueue(input('query_1'),1001,['machine_state_query']); expect(retry).toMatchObject({accepted:true,duplicate:true});
 expect(await store.enqueue({...input('query_1'),payload:{query_id:'query_1',query_kind:'attempt_status'}},1001,['machine_state_query'])).toMatchObject({accepted:false,reason:'idempotency_conflict'});
 expect(await store.enqueue({...input('query_2'),ttl_seconds:86401},1000,['machine_state_query'])).toMatchObject({accepted:false});
 expect(store.pending(1001)).toHaveLength(1); expect(store.pending(4600)).toHaveLength(0); expect(store.list()[0]?.state).toBe('expired');
}));
it('retains minimal result identity and re-receipts after expiry without needing a volatile ack',async()=>setup(async store=>{
 const queued=await store.enqueue(input('query_late'),1000,['machine_state_query']); if(!queued.accepted)throw new Error('queue');
 const command=JSON.parse(store.pending(1001)[0]!.wire);
 const result={...signed('result'),command_id:command.command_id,revision:1,idempotency_key:command.idempotency_key,payload:{status:'answered',answer:{query_id:'query_late',query_kind:'session_status',state:'unknown'}}};
 expect(()=>store.acceptResult(result as never,'fingerprint',1001)).toThrow();
 store.markSent(command.command_id);
 const receipt=store.acceptResult(result as never,'fingerprint',100000); expect(receipt.payload.result_message_id).toBe(result.message_id);
 const duplicate=store.acceptResult(result as never,'fingerprint',200000); expect(duplicate.message_id).not.toBe(receipt.message_id);
 expect(()=>store.acceptResult(result as never,'changed',200001)).toThrow();
 expect(store.list().find(row=>row.command_id===command.command_id)).toMatchObject({state:'answered',result_state:'unknown'});
}));
it('strictly validates closed ack/result frame payloads and rejects wrong statuses',()=>{
 const ack={...signed('ack'),command_id:'cmd_1',revision:1,idempotency_key:'idem_1',payload:{state:'accepted'}};
 expect(ackFrame(ack)).not.toBeNull(); expect(ackFrame({...ack,payload:{state:'accepted',reason:'expired'}})).toBeNull();
 expect(resultFrame({...ack,type:'result',payload:{status:'answered',answer:{query_id:'q',query_kind:'session_status',state:'unknown'}}})).not.toBeNull();
 expect(resultFrame({...ack,type:'result',payload:{status:'answered',answer:{query_id:'q',query_kind:'session_status',state:'watching'}}})).toBeNull();
 expect(resultFrame({...ack,type:'result',payload:{status:'delivered',answer:{}}})).toBeNull();
});
function signed(type:string){return {contract_version:'0.2.3',type,message_id:'01ARZ3NDEKTSV4RRFFQ69G5FAX',device_id:'dev_commands_fixture',owner_id:'owner_fixture',timestamp:1000,nonce:'AAECAwQFBgcICQoLDA0ODw',signature:'A'.repeat(86)}}
it('reconciles a possibly delivered expired command through the same bytes and volatile expired ack', async()=>setup(async store=>{
 const queued=await store.enqueue({...input('query_unknown_delivery'),ttl_seconds:1},300000,['machine_state_query']); if(!queued.accepted)throw new Error('queue');
 const first=store.pending(300000).find(row=>row.command_id===queued.command_id)!; const command=JSON.parse(first.wire);
 store.markSent(command.command_id);
 expect(store.pending(300002).find(row=>row.command_id===command.command_id)?.wire).toBe(first.wire);
 expect(store.hasInFlight()).toBe(true);
 store.acceptAck({...signed('ack'),command_id:command.command_id,revision:1,idempotency_key:command.idempotency_key,payload:{state:'expired',reason:'expired'}} as never);
 expect(store.hasInFlight()).toBe(false);
 expect(store.list().find(row=>row.command_id===command.command_id)?.state).toBe('expired');
}));
it.each([['invalid_shape'], { value: 'invalid_shape' }, null, 1, true].map(value => [value]))('rejects nonstring ack reasons %#', value=>{
 expect(ackFrame({...signed('ack'),command_id:'cmd_1',revision:1,idempotency_key:'idem_1',payload:{state:'rejected',reason:value}})).toBeNull();
});
it.each([['idle'], { value: 'idle' }, null, 1, true].map(value => [value]))('rejects nonstring query answer labels %#', value=>{
 expect(resultFrame({...signed('result'),command_id:'cmd_1',revision:1,idempotency_key:'idem_1',payload:{status:'answered',answer:{query_id:'query_1',query_kind:'session_status',state:value}}})).toBeNull();
});
it.each([['processing_failed'], { value: 'processing_failed' }, null, 1, true].map(value => [value]))('rejects nonstring failed result reasons %#', value=>{
 expect(resultFrame({...signed('result'),command_id:'cmd_1',revision:1,idempotency_key:'idem_1',payload:{status:'failed',reason:value}})).toBeNull();
});
it('receipts a first durable result after volatile expired ack and TTL plus replay horizon, but never for undelivered or rejected work',async()=>setup(async store=>{
 const queued=await store.enqueue({...input('query_after_expired_ack'),ttl_seconds:1},400000,['machine_state_query']); if(!queued.accepted)throw new Error('queue');
 const command=JSON.parse(store.pending(400000).find(row=>row.command_id===queued.command_id)!.wire);
 store.markSent(command.command_id,'generation_fixture');
 const reference={...signed('result'),message_id:'01ARZ3NDEKTSV4RRFFQ69G5FA0',command_id:command.command_id,revision:1,idempotency_key:command.idempotency_key};
 store.acceptAck({...reference,type:'ack',payload:{state:'expired',reason:'expired'}} as never);
 const result={...reference,payload:{status:'answered',answer:{query_id:'query_after_expired_ack',query_kind:'session_status',state:'unknown'}}};
 const first=store.acceptResult(result as never,'late-fingerprint',400302);
 expect(first.payload.result_message_id).toBe(result.message_id);
 const duplicate=store.acceptResult(result as never,'late-fingerprint',500000); expect(duplicate.message_id).not.toBe(first.message_id);
 expect(store.list().find(row=>row.command_id===command.command_id)).toMatchObject({state:'answered',result_state:'unknown'});
 for(const [id,rejected] of [['query_never_sent',false],['query_rejected',true]] as const){
  const enqueue=await store.enqueue({...input(id),ttl_seconds:1},600000,['machine_state_query']); if(!enqueue.accepted)throw new Error('queue');
  const pending=JSON.parse(store.pending(600000).find(row=>row.command_id===enqueue.command_id)!.wire);
  const invalid={...signed('result'),command_id:pending.command_id,revision:1,idempotency_key:pending.idempotency_key,payload:{status:'answered',answer:{query_id:id,query_kind:'session_status',state:'unknown'}}};
  if(rejected){store.markSent(pending.command_id,'generation_fixture'); store.acceptAck({...invalid,type:'ack',payload:{state:'rejected',reason:'invalid_shape'}} as never);}
  else store.pending(600002);
  expect(()=>store.acceptResult(invalid as never,`fingerprint_${id}`,600302)).toThrow();
 }
}));
it('rejects acknowledgements and results for expired queued work that never reached delivery',async()=>setup(async store=>{
 const queued=await store.enqueue({...input('query_expired_never_delivered'),ttl_seconds:1},700000,['machine_state_query']); if(!queued.accepted)throw new Error('queue');
 const command=JSON.parse(store.pending(700000).find(row=>row.command_id===queued.command_id)!.wire); store.pending(700002);
 const reference={...signed('ack'),command_id:command.command_id,revision:1,idempotency_key:command.idempotency_key};
 expect(()=>store.acceptAck({...reference,payload:{state:'accepted'}} as never)).toThrow('invalid_shape');
 expect(()=>store.acceptResult({...reference,type:'result',payload:{status:'answered',answer:{query_id:'query_expired_never_delivered',query_kind:'session_status',state:'unknown'}}} as never,'fingerprint',700302)).toThrow('invalid_shape');
}));
