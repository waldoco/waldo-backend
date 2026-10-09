import {expect,it} from 'vitest';
import {PUBLIC_READ_RESERVED_BROWSER_MS} from '../src/channels/cloudflare-public-read';
import {COMMON_BROWSER_MONTH_CEILING_MICROUSD} from '../src/channels/common-staging-registration';
import {ownerPublicBrowserAccounting,ownerPublicBrowserDurationMicrousd,reserveOwnerPublicBrowser,settleOwnerPublicBrowser} from '../src/channels/owner-public-browser-spend';

const KEY='owner-public-browser-spend:v2',ownerId='prn_10000000000000000000000000000002',custodyDigest='b'.repeat(64);
const now=Date.parse('2026-10-09T10:00:00.000Z'),monthKey='common-public-browser-month:2026-10';
function fixture(initial:readonly (readonly [string,unknown])[]=[]){
 const rows=new Map<string,any>(structuredClone(initial));
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>rows.set(key,structuredClone(value)),list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix))},transactionSync:<T>(work:()=>T)=>{
  const before=structuredClone([...rows]);try{return work();}catch(cause){rows.clear();for(const [key,value] of before)rows.set(key,value);throw cause;}
 }} as unknown as DurableObjectStorage;
 const reserve=(intent:string,reservedBrowserMs:number,declaredLimitMicrousd?:number)=>reserveOwnerPublicBrowser({storage,ownerId,custodyDigest,intent,reservedBrowserMs,now,declaredLimitMicrousd,assertCurrent(){}});
 const settle=(intent:string,durationMs:number)=>settleOwnerPublicBrowser({storage,ownerId,custodyDigest,intent,durationMs});
 return {rows,storage,reserve,settle};
}

it('funds a retained session for its admitted duration beyond ten minutes',()=>{
 const f=fixture(),reservedBrowserMs=35*60_000+20_000,bound=ownerPublicBrowserDurationMicrousd(reservedBrowserMs);
 f.reserve('retained',reservedBrowserMs);
 expect(f.rows.get(KEY)).toMatchObject({ownerId,custodyDigest,reservedMicrousd:bound,reservations:[{intent:'retained',month:'2026-10',reservedBrowserMs,chargedMicrousd:bound,settled:false}]});
 expect(f.rows.get(monthKey)).toBe(bound);
 expect(ownerPublicBrowserAccounting(f.storage,ownerId,custodyDigest)).toMatchObject({reservedMicrousd:bound,intents:['retained']});
});

it('keeps the fixed one-shot duration and exact settlement unchanged',()=>{
 const f=fixture(),held=f.reserve('one-shot',PUBLIC_READ_RESERVED_BROWSER_MS);
 expect(f.rows.get(monthKey)).toBe(1250);held.settle(4000);
 expect(f.rows.get(monthKey)).toBe(100);
 expect(f.rows.get(KEY).reservations[0]).toMatchObject({reservedBrowserMs:50000,durationMs:4000,chargedMicrousd:100,settled:true});
});

it('settles the original month exactly after storage and runtime reconstruction without replay or refill',()=>{
 const f=fixture(),reservedBrowserMs=35*60_000+20_000,durationMs=31*60_000+1;
 f.reserve('retained',reservedBrowserMs);f.rows.set('common-public-browser-month:2026-11',750);
 const rebuilt=fixture([...f.rows]);rebuilt.settle('retained',durationMs);
 const charged=ownerPublicBrowserDurationMicrousd(durationMs);
 expect(rebuilt.rows.get(monthKey)).toBe(charged);expect(rebuilt.rows.get('common-public-browser-month:2026-11')).toBe(750);
 expect(ownerPublicBrowserAccounting(rebuilt.storage,ownerId,custodyDigest)).toMatchObject({reservedMicrousd:charged,intents:['retained']});
 const snapshot=structuredClone([...rebuilt.rows]);rebuilt.settle('retained',durationMs);
 expect(()=>rebuilt.settle('retained',0)).toThrow('settlement conflict');
 expect(()=>rebuilt.reserve('retained',reservedBrowserMs)).toThrow('prior effect');expect([...rebuilt.rows]).toEqual(snapshot);
});

it.each(['owner','custody','intent'])('restart settlement refuses mismatched %s without changing the hold',kind=>{
 const f=fixture();f.reserve('retained',PUBLIC_READ_RESERVED_BROWSER_MS);const snapshot=structuredClone([...f.rows]);
 expect(()=>settleOwnerPublicBrowser({storage:f.storage,ownerId:kind==='owner'?'prn_foreign':ownerId,custodyDigest:kind==='custody'?'a'.repeat(64):custodyDigest,intent:kind==='intent'?'foreign':'retained',durationMs:4000})).toThrow();
 expect([...f.rows]).toEqual(snapshot);
});

it('restart settlement leaves over-reserved or invalid measured duration unresolved',()=>{
 const f=fixture(),reservedBrowserMs=35*60_000+20_000;f.reserve('retained',reservedBrowserMs);const snapshot=structuredClone([...f.rows]);
 for(const durationMs of [reservedBrowserMs+1,-1,NaN,Infinity,0.1]){expect(()=>f.settle('retained',durationMs)).toThrow();expect([...f.rows]).toEqual(snapshot);}
 expect(f.rows.get(KEY).reservations[0].settled).toBe(false);
});

it.each([0,-1,0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])('refuses invalid reserved duration %s before mutating storage',reservedBrowserMs=>{
 const f=fixture();expect(()=>f.reserve('invalid',reservedBrowserMs)).toThrow();expect([...f.rows]).toEqual([]);
});

it('admits the smallest positive duration and applies the unchanged monthly ceiling to long holds',()=>{
 const f=fixture();f.reserve('minimum',1);expect(f.rows.get(monthKey)).toBe(1);
 const snapshot=structuredClone([...f.rows]);
 expect(()=>f.reserve('too-long',COMMON_BROWSER_MONTH_CEILING_MICROUSD*40)).toThrow('cost ceiling');expect([...f.rows]).toEqual(snapshot);
 expect(()=>f.reserve('largest-safe',Number.MAX_SAFE_INTEGER)).toThrow('cost ceiling');expect([...f.rows]).toEqual(snapshot);
});

it('retains prior trial charges and the lower lifetime ceiling while settling a long hold',()=>{
 const prior={policy:{ref:'expired',ownerId,validUntil:2,limitMicrousd:55000,maxCalls:100},reservedMicrousd:1000,calls:[{id:'old',upperBoundMicrousd:1000}],cleanup:[]};
 const f=fixture([['common-spend:expired',prior]]),reservedBrowserMs=35*60_000+20_000;
 f.reserve('retained',reservedBrowserMs);f.settle('retained',1000);
 expect(f.rows.get('common-spend:expired')).toEqual(prior);expect(f.rows.get(KEY)).toMatchObject({limitMicrousd:55000,reservedMicrousd:25});
 f.reserve('second',reservedBrowserMs);const snapshot=structuredClone([...f.rows]);
 expect(()=>f.reserve('third',reservedBrowserMs)).toThrow('cost ceiling');expect([...f.rows]).toEqual(snapshot);
});

it('restart settlement rolls back both accounting writes on failure and can retry exactly once',()=>{
 const f=fixture();f.reserve('retained',PUBLIC_READ_RESERVED_BROWSER_MS);const snapshot=structuredClone([...f.rows]),put=f.storage.kv.put.bind(f.storage.kv);
 let fail=true;f.storage.kv.put=((key:string,value:unknown)=>{if(key===monthKey&&fail)throw Error('storage fault');return put(key,value);}) as typeof f.storage.kv.put;
 expect(()=>f.settle('retained',4000)).toThrow('storage fault');expect([...f.rows]).toEqual(snapshot);
 fail=false;f.settle('retained',4000);f.settle('retained',4000);expect(f.rows.get(monthKey)).toBe(100);
});

it('refuses a long reservation when current owner admission fails without consuming money',()=>{
 const f=fixture(),snapshot=structuredClone([...f.rows]);
 expect(()=>reserveOwnerPublicBrowser({storage:f.storage,ownerId,custodyDigest,intent:'retained',reservedBrowserMs:35*60_000+20_000,now,assertCurrent(){throw Error('owner admission expired');}})).toThrow('owner admission expired');
 expect([...f.rows]).toEqual(snapshot);
});

it.each([0,-1,0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])('rejects malformed retained duration %s without rewriting the history',reservedBrowserMs=>{
 const f=fixture();f.reserve('one-shot',PUBLIC_READ_RESERVED_BROWSER_MS);f.rows.get(KEY).reservations[0].reservedBrowserMs=reservedBrowserMs;
 const snapshot=structuredClone([...f.rows]);
 expect(()=>ownerPublicBrowserAccounting(f.storage,ownerId,custodyDigest)).toThrow('retained cost conflict');
 expect(()=>f.settle('one-shot',4000)).toThrow('retained cost conflict');expect([...f.rows]).toEqual(snapshot);
});

it('the one-shot capability rejects a changed but otherwise valid reservation binding',()=>{
 const f=fixture(),held=f.reserve('one-shot',PUBLIC_READ_RESERVED_BROWSER_MS),row=f.rows.get(KEY);
 row.reservations[0].reservedBrowserMs=PUBLIC_READ_RESERVED_BROWSER_MS+1;
 row.reservations[0].chargedMicrousd=1251;row.reservedMicrousd=1251;f.rows.set(monthKey,1251);
 expect(ownerPublicBrowserAccounting(f.storage,ownerId,custodyDigest)?.reservedMicrousd).toBe(1251);
 const snapshot=structuredClone([...f.rows]);expect(()=>held.settle(4000)).toThrow('settlement conflict');expect([...f.rows]).toEqual(snapshot);
});
