import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { DeviceBridgeDO } from '../src/devices/device-bridge-do';
import { DeviceCommandStore } from '../src/devices/command-store';
import { ackFrame, resultFrame } from '../src/devices/wire';
const input = (request_id: string) => ({ owner_id: 'owner_fixture', device_id: 'dev_commands_fixture', request_id, class: 'machine_state_query' as const, payload: { query_id: request_id, query_kind: 'session_status' as const } });
const setup = async (test: (store: DeviceCommandStore) => void) => {
 const stub=env.DEVICE_BRIDGE_DO!.get(env.DEVICE_BRIDGE_DO!.idFromName('dev_commands_fixture')) as DurableObjectStub<DeviceBridgeDO>;
 await runInDurableObject(stub, (_instance,state)=>test(new DeviceCommandStore(state.storage)));
};
it('queues stable command bytes, rejects conflicting retries and invalid TTL, and expires only undelivered work',async()=>setup(store=>{
 const first=store.enqueue(input('query_1'),1000,['machine_state_query']); expect(first.accepted).toBe(true);
 const retry=store.enqueue(input('query_1'),1001,['machine_state_query']); expect(retry).toMatchObject({accepted:true,duplicate:true});
 expect(store.enqueue({...input('query_1'),payload:{query_id:'query_1',query_kind:'attempt_status'}},1001,['machine_state_query'])).toMatchObject({accepted:false,reason:'idempotency_conflict'});
 expect(store.enqueue({...input('query_2'),ttl_seconds:86401},1000,['machine_state_query'])).toMatchObject({accepted:false});
 expect(store.pending(1001)).toHaveLength(1); expect(store.pending(4600)).toHaveLength(0); expect(store.list()[0]?.state).toBe('expired');
}));
it('retains minimal result identity and re-receipts after expiry without needing a volatile ack',async()=>setup(store=>{
 const queued=store.enqueue(input('query_late'),1000,['machine_state_query']); if(!queued.accepted)throw new Error('queue');
 const command=JSON.parse(store.pending(1001)[0]!.wire);
 const result={...signed('result'),command_id:command.command_id,revision:1,idempotency_key:command.idempotency_key,payload:{status:'answered',answer:{query_id:'query_late',query_kind:'session_status',state:'unknown'}}};
 expect(()=>store.acceptResult(result as never,'fingerprint',1001)).toThrow();
 store.markSent(command.command_id);
 const receipt=store.acceptResult(result as never,'fingerprint',100000); expect(receipt.payload.result_message_id).toBe(result.message_id);
 const duplicate=store.acceptResult(result as never,'fingerprint',200000); expect(duplicate.message_id).not.toBe(receipt.message_id);
 expect(()=>store.acceptResult(result as never,'changed',200001)).toThrow();
 expect(store.list()[0]).toMatchObject({state:'answered',result_state:'unknown'});
}));
it('strictly validates closed ack/result frame payloads and rejects wrong statuses',()=>{
 const ack={...signed('ack'),command_id:'cmd_1',revision:1,idempotency_key:'idem_1',payload:{state:'accepted'}};
 expect(ackFrame(ack)).not.toBeNull(); expect(ackFrame({...ack,payload:{state:'accepted',reason:'expired'}})).toBeNull();
 expect(resultFrame({...ack,type:'result',payload:{status:'answered',answer:{query_id:'q',query_kind:'session_status',state:'unknown'}}})).not.toBeNull();
 expect(resultFrame({...ack,type:'result',payload:{status:'answered',answer:{query_id:'q',query_kind:'session_status',state:'watching'}}})).toBeNull();
 expect(resultFrame({...ack,type:'result',payload:{status:'delivered',answer:{}}})).toBeNull();
});
function signed(type:string){return {contract_version:'0.2.3',type,message_id:'01ARZ3NDEKTSV4RRFFQ69G5FAX',device_id:'dev_commands_fixture',owner_id:'owner_fixture',timestamp:1000,nonce:'AAECAwQFBgcICQoLDA0ODw',signature:'A'.repeat(86)}}
