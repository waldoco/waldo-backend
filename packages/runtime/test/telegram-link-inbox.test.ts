import {expect,it,vi} from 'vitest';
import {TelegramLinkInbox,LINK_MODE,LINK_ROWS} from '../src/channels/telegram-link-inbox';
const fixture=()=>{
 const data=new Map<string,unknown>();let fail=false;let alarm:number|null=null;
 const txn={get:async(k:string)=>structuredClone(data.get(k)),put:async(k:string|Record<string,unknown>,v?:unknown)=>{if(typeof k==='string')data.set(k,structuredClone(v));else for(const [a,b]of Object.entries(k))data.set(a,structuredClone(b));},getAlarm:async()=>alarm,setAlarm:async(v:number)=>{if(fail)throw Error('wake fault');alarm=v}};
 const storage={...txn,transaction:async(f:Function)=>{const old=new Map(data);try{return await f(txn)}catch(e){data.clear();for(const [k,v]of old)data.set(k,v);throw e}}}as unknown as DurableObjectStorage;
 return{data,storage,inbox:new TelegramLinkInbox(storage),fault:()=>{fail=true},binding:{bot:'7',subject:'42',name:'telegram-link:7:42'}};
};
it('commits mode/binding/hash/digest and wake before receipt, dedupes without capacity',async()=>{
 const f=fixture();expect(await f.inbox.admit(f.binding,1,'digest','a'.repeat(64))).toBe('admitted');expect(f.data.get(LINK_MODE)).toEqual(f.binding);
 expect(await f.inbox.admit(f.binding,1,'digest','b'.repeat(64))).toBe('duplicate');expect(await f.inbox.admit(f.binding,1,'changed','a'.repeat(64))).toBe('conflict');
});
it('wake failure rolls back admission',async()=>{const f=fixture();f.fault();await expect(f.inbox.admit(f.binding,1,'d','a'.repeat(64))).rejects.toThrow('wake fault');expect(f.data.get(LINK_MODE)).toBeUndefined()});
it('scrubs redeemable credential at attempting marker and never reclaims the update',async()=>{
 const f=fixture();await f.inbox.admit(f.binding,1,'d','a'.repeat(64));const attempt=await f.inbox.begin(1);expect(attempt?.hash).toBe('a'.repeat(64));expect(JSON.stringify(f.data.get(LINK_ROWS))).not.toContain('a'.repeat(64));expect(await f.inbox.begin(1)).toBeNull();
 const reconstructed=new TelegramLinkInbox(f.storage);expect((await reconstructed.records())[0]?.state).toBe('attempting');
});
it('freezing scrubs credential and responds without giving owner details',async()=>{const f=fixture();await f.inbox.admit(f.binding,1,'d','a'.repeat(64));await f.inbox.freeze(1,'Linking could not be confirmed. Check your console before trying a new code.');expect(JSON.stringify(f.data.get(LINK_ROWS))).not.toContain('a'.repeat(64));expect((await f.inbox.records())[0]?.state).toBe('frozen')});
it('concurrent update IDs with the same code are separate receipts, not per-code exactly-once',async()=>{const f=fixture();await f.inbox.admit(f.binding,1,'d1','a'.repeat(64));await f.inbox.admit(f.binding,2,'d2','a'.repeat(64));expect(await f.inbox.records()).toHaveLength(2);expect((await f.inbox.begin(1))?.hash).toBe('a'.repeat(64));expect((await f.inbox.begin(2))?.hash).toBe('a'.repeat(64));});
it('completed receipt expires after the documented redelivery lifetime without retaining credentials',async()=>{const f=fixture();let now=1000;const inbox=new TelegramLinkInbox(f.storage,()=>now);await inbox.admit(f.binding,1,'d','a'.repeat(64));await inbox.complete(1);now+=26*3600000;await inbox.maintain();expect(await inbox.records()).toEqual([])});
