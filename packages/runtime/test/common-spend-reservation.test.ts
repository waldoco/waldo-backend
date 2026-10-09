import {expect,it} from 'vitest';
import {commonSpendReservation} from '../src/channels/common-spend-reservation';
const fixture=()=>{const rows=new Map<string,unknown>();const storage={kv:{get:<T>(key:string)=>structuredClone(rows.get(key)) as T,put:(key:string,value:unknown)=>rows.set(key,structuredClone(value))},transactionSync:<T>(work:()=>T)=>work()} as unknown as Pick<DurableObjectStorage,'kv'|'transactionSync'>;let at=1;return {storage,rows,now:()=>at,expire:()=>{at=100;}};};
const scope={runId:'fictional-run',attempt:'fictional-attempt',admit:()=>{}};
const policy={ref:'fictional-policy',ownerId:'fictional-owner',validUntil:100,limitMicrousd:10,maxCalls:10};
it('holds all costs before issue and refuses uncertain replay and new over-cap effects after reconstruction',()=>{
 const f=fixture();const first=commonSpendReservation(f.storage,policy,f.now,()=>{});first.reserve('provider-1',6);
 const recovered=commonSpendReservation(f.storage,policy,f.now,()=>{});expect(recovered.reserved()).toBe(6);
 expect(()=>recovered.reserve('provider-1',6)).toThrow(/reconciliation/);
 expect(()=>recovered.reserve('browser-2',5)).toThrow(/limit exceeded/);expect(recovered.reserved()).toBe(6);
 recovered.reserve('browser-2',4);expect(recovered.reserved()).toBe(10);
});
it('rejects policy widening, invalid price bounds, stale authority and expired grants without issuing',()=>{
 const f=fixture();const ledger=commonSpendReservation(f.storage,policy,f.now,()=>{});ledger.reserve('one',1);
 expect(()=>commonSpendReservation(f.storage,{...policy,limitMicrousd:20},f.now,()=>{}).reserve('two',1)).toThrow(/conflict/);
 expect(()=>ledger.reserve('two',NaN)).toThrow(/invalid/);
 expect(()=>commonSpendReservation(f.storage,policy,f.now,()=>{throw Error('owner revoked');}).reserve('two',1)).toThrow(/revoked/);
 f.expire();expect(()=>ledger.reserve('two',1)).toThrow(/expired/);expect(ledger.reserved()).toBe(1);
});
it('reserves every gateway fallback and provider binding call before effect, holding failures and cleanup cost',async()=>{
 const f=fixture();const {commonSpendCalls}=await import('../src/channels/common-spend-reservation');
 const ledger=commonSpendReservation(f.storage,{...policy,limitMicrousd:4},f.now,()=>{});let seq=0,issued=0;
 const calls=commonSpendCalls(ledger,()=>1);
 const gateway=calls.gateway({complete:async(_request:unknown)=>{expect(ledger.reserved()).toBeGreaterThan(issued);issued++;throw Error('uncertain');}});
 for(const model of ['fixture-primary','fixture-fallback'])await expect(gateway.complete({request:{model},runScope:scope})).rejects.toThrow('uncertain');
 const binding=calls.binding({fetch:async()=>{expect(ledger.reserved()).toBeGreaterThan(issued);issued++;return Response.json({});}},'fixture-operation');
 await binding.fetch();await binding.fetch();expect(issued).toBe(4);
 await expect(binding.fetch()).rejects.toThrow('limit exceeded');expect(issued).toBe(4);
});

it('pre-funded cleanup survives expiry, revocation and reconstruction but cannot allocate or reopen action calls',async()=>{
 const f=fixture();let stopped=false,issued=0,seq=0;
 const current=()=>{if(stopped)throw Error('stopped');};
 const ledger=commonSpendReservation(f.storage,policy,f.now,current);
 ledger.reserveCleanup('allocation-1',3,3,()=>{});
 f.expire();stopped=true;
 const recovered=commonSpendReservation(f.storage,policy,f.now,current);
 const {commonSpendCalls}=await import('../src/channels/common-spend-reservation');
 const calls=commonSpendCalls(recovered,()=>1);
 const raw={fetch:async(_input?:RequestInfo|URL,_init?:RequestInit)=>{issued++;return Response.json({sessions:[]});}};
 const cleanup=calls.cleanupBinding(raw,'allocation-1','retained-session');
 for(const [url,init] of [
  ['http://fake.host/v1/devtools/browser',{method:'POST'}],
  ['http://fake.host/v1/devtools/browser/other?persistent=true',{headers:{upgrade:'websocket'}}],
  ['https://outside.invalid/v1/sessions',undefined],
  ['http://fake.host/v1/sessions?extra=1',undefined],
 ] as const)await expect(cleanup.fetch(url,init)).rejects.toThrow('request rejected');
 expect(issued).toBe(0);
 await cleanup.fetch('http://fake.host/v1/sessions');
 await cleanup.fetch('http://fake.host/v1/devtools/browser/retained-session?persistent=true',{headers:{upgrade:'websocket'}});
 await cleanup.fetch('http://fake.host/v1/sessions');
 await expect(cleanup.fetch('http://fake.host/v1/sessions')).rejects.toThrow('allowance unavailable');
 await expect(calls.binding(raw,'fixture-operation').fetch('http://fake.host/v1/sessions')).rejects.toThrow('stopped');
 expect(()=>recovered.reserveCleanup('allocation-2',1,1,()=>{})).toThrow('stopped');
 expect(issued).toBe(3);expect(recovered.reserved()).toBe(3);
});
it('provider-shaped acquire and sessions cross the reservation binding and preserve prototype methods',async()=>{
 const f=fixture();const {commonSpendCalls}=await import('../src/channels/common-spend-reservation');
 let issued=0,seq=0;
 const ledger=commonSpendReservation(f.storage,policy,f.now,()=>{});
 const calls=commonSpendCalls(ledger,()=>2);
 const binding=calls.binding({fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{
  expect(ledger.reserved()).toBe((issued+1)*2);issued++;
  const request=new Request(input,init);
  return request.method==='POST'?Response.json({sessionId:'pinned-session'}):Response.json({sessions:[{sessionId:'pinned-session'}]});
 }},'fixture-operation');
 expect(await (await binding.fetch('http://fake.host/v1/devtools/browser?keep_alive=10000',{method:'POST'})).json()).toEqual({sessionId:'pinned-session'});
 expect(await (await binding.fetch('http://fake.host/v1/sessions')).json()).toEqual({sessions:[{sessionId:'pinned-session'}]});
 class Gateway{value=7;other(){return this.value;}async complete(_request:any){return this.value;}}
 const gateway=calls.gateway(new Gateway());expect(gateway.other()).toBe(7);expect(await gateway.complete({request:{},runScope:scope})).toBe(7);
 expect(ledger.reserved()).toBe(6);expect(issued).toBe(2);
});

it('unknown allocation identity cannot use or create cleanup, and uncertain cleanup retains slots',async()=>{
 const f=fixture();const ledger=commonSpendReservation(f.storage,policy,f.now,()=>{});
 const {commonSpendCalls}=await import('../src/channels/common-spend-reservation');
 const calls=commonSpendCalls(ledger,()=>1);let issued=0;
 const raw={fetch:async(_input?:RequestInfo|URL)=>{issued++;throw Error('uncertain');}};
 expect(()=>calls.cleanupBinding(raw,'no-obligation','pending')).toThrow('identity invalid');
 await expect(calls.cleanupBinding(raw,'no-obligation','retained').fetch('http://fake.host/v1/sessions')).rejects.toThrow('allowance unavailable');
 ledger.reserveCleanup('funded',1,1,()=>{});f.expire();
 await expect(calls.cleanupBinding(raw,'funded','retained').fetch('http://fake.host/v1/sessions')).rejects.toThrow('uncertain');
 await expect(calls.cleanupBinding(raw,'funded','retained').fetch('http://fake.host/v1/sessions')).rejects.toThrow('allowance unavailable');
 expect(issued).toBe(1);expect(ledger.reserved()).toBe(1);
});

it('cleanup slots and money are reserved before allocation and cannot borrow from action capacity',()=>{
 const f=fixture();const ledger=commonSpendReservation(f.storage,{...policy,maxCalls:3},f.now,()=>{});let allocated=0;
 expect(()=>ledger.reserveCleanup('too-much',11,3,()=>allocated++)).toThrow('limit exceeded');expect(allocated).toBe(0);
 ledger.reserveCleanup('exact',3,3,()=>allocated++);expect(allocated).toBe(1);
 expect(()=>ledger.reserve('action',0)).toThrow('call limit');
 expect(()=>ledger.reserveCleanup('again',0,1,()=>allocated++)).toThrow('call limit');expect(allocated).toBe(1);
 ledger.consumeCleanup('exact');expect(()=>ledger.reserve('action',0)).toThrow('call limit');
 const row=f.rows.get('common-spend:fictional-policy') as any;
 f.rows.set('common-spend:fictional-policy',{...row,cleanup:[{...row.cleanup[0],maxCalls:4}]});
 expect(()=>ledger.consumeCleanup('exact')).toThrow('ledger conflict');
});

it('reconstructed model wrapper refuses the same physical ordinal even with changed request bytes',async()=>{
 const f=fixture();const {commonSpendCalls}=await import('../src/channels/common-spend-reservation');let issued=0;
 const gateway={complete:async(_input:any)=>{issued++;throw Error('unknown model outcome');}};
 const first=commonSpendCalls(commonSpendReservation(f.storage,policy,f.now,()=>{}),()=>1);
 await expect(first.gateway(gateway).complete({runScope:scope,request:{model:'fixture-primary'}})).rejects.toThrow('unknown model outcome');
 const recovered=commonSpendCalls(commonSpendReservation(f.storage,policy,f.now,()=>{}),()=>1);
 await expect(recovered.gateway(gateway).complete({runScope:scope,request:{model:'changed-model'}})).rejects.toThrow('requires reconciliation');
 await expect(recovered.gateway(gateway).complete({runScope:scope,request:{model:'skip-to-next'}})).rejects.toThrow('history requires reconciliation');
 await expect(recovered.gateway(gateway).complete({request:{}})).rejects.toThrow('physical identity unavailable');
 expect(issued).toBe(1);
});

it('browser operation identity rejects changed or repeated issuance after reconstruction without skipping ahead',async()=>{
 const f=fixture();const {commonSpendCalls}=await import('../src/channels/common-spend-reservation');let issued=0;
 const raw={fetch:async(_input:RequestInfo|URL,_init?:RequestInit)=>{issued++;return Response.json({});}};
 const first=commonSpendCalls(commonSpendReservation(f.storage,policy,f.now,()=>{}),()=>1).binding(raw,'owner-task-tool-1');
 await first.fetch('http://fake.host/v1/devtools/browser',{method:'POST'});
 const recovered=commonSpendCalls(commonSpendReservation(f.storage,policy,f.now,()=>{}),()=>1).binding(raw,'owner-task-tool-1');
 await expect(recovered.fetch('http://fake.host/v1/devtools/browser/changed')).rejects.toThrow('requires reconciliation');
 await expect(recovered.fetch('http://fake.host/v1/sessions')).rejects.toThrow('history requires reconciliation');
 const next=commonSpendCalls(commonSpendReservation(f.storage,policy,f.now,()=>{}),()=>1).binding(raw,'owner-task-tool-2');
 await next.fetch('http://fake.host/v1/sessions');expect(issued).toBe(2);
});

it('exact count witness feeds the model quote and reconstruction conflicts regardless of changed count',async()=>{
 const f=fixture();const {commonSpendCalls}=await import('../src/channels/common-spend-reservation');
 const ledger=commonSpendReservation(f.storage,{...policy,limitMicrousd:1000},f.now,()=>{});
 let countedValue=100,quoted:unknown;
 const calls=commonSpendCalls(ledger,(kind,material)=>{if(kind==='model')quoted=material;return 7;},{countModel:async()=>countedValue});
 const gateway={complete:async(_request:unknown)=>{throw Error('uncertain outcome');}};
 await expect(calls.gateway(gateway).complete({request:{max_tokens:10},runScope:scope})).rejects.toThrow('uncertain outcome');
 expect((quoted as {countedInputTokens?:number}).countedInputTokens).toBe(100);
 const row=structuredClone(f.rows.get('common-spend:fictional-policy'));
 expect((row as {calls:{upperBoundMicrousd:number}[]}).calls[0]?.upperBoundMicrousd).toBe(7);
 // Reconstruction with a different counted value still conflicts on the retained
 // physical intent: no re-price, no second reservation, no replayed effect.
 countedValue=999;
 const recovered=commonSpendCalls(commonSpendReservation(f.storage,{...policy,limitMicrousd:1000},f.now,()=>{}),()=>9,{countModel:async()=>countedValue});
 await expect(recovered.gateway(gateway).complete({request:{max_tokens:10},runScope:scope})).rejects.toThrow('requires reconciliation');
 expect(f.rows.get('common-spend:fictional-policy')).toEqual(row);
});

it('invalid count witness refuses before any reservation and issues no effect',async()=>{
 const f=fixture();const {commonSpendCalls}=await import('../src/channels/common-spend-reservation');
 const ledger=commonSpendReservation(f.storage,{...policy,limitMicrousd:1000},f.now,()=>{});let issued=0;
 for(const bad of [NaN,-1,1_050_001,1.5]){
  const calls=commonSpendCalls(ledger,()=>7,{countModel:async()=>bad});
  const gateway={complete:async(_request:unknown)=>{issued++;return 'issued';}};
  await expect(calls.gateway(gateway).complete({request:{max_tokens:10},runScope:scope})).rejects.toThrow('count witness invalid');
 }
 expect(issued).toBe(0);expect(f.rows.has('common-spend:fictional-policy')).toBe(false);
});


it('gates the first model call, ninth physical request and third run across reconstruction without refund',async()=>{
 const f=fixture(),acceptance={expiresAt:100,maxRuns:2,maxModelCalls:8,priorRuns:0,priorModelCalls:0,priorMicrousd:0};
 const {commonSpendCalls}=await import('../src/channels/common-spend-reservation');let issued=0;
 const make=()=>commonSpendCalls(commonSpendReservation(f.storage,{...policy,maxCalls:30,limitMicrousd:100},f.now,()=>{},acceptance),()=>1).gateway({complete:async(_request:unknown)=>{issued++;return 'done';}});
 const first=make();
 await first.complete({runScope:scope,request:{}});expect(issued).toBe(1);
 await expect(make().complete({runScope:scope,request:{}})).rejects.toThrow(/reconciliation/);
 await first.complete({runScope:{...scope,runId:'second'},request:{}});
 await expect(first.complete({runScope:{...scope,runId:'third'},request:{}})).rejects.toThrow(/acceptance run limit/);
 for(let i=0;i<6;i++)await first.complete({runScope:scope,request:{}});
 await expect(first.complete({runScope:scope,request:{}})).rejects.toThrow(/acceptance model limit/);
 expect(issued).toBe(8);
});


it('audited prior attempts reduce the aggregate money and request allowance and cannot change after reconstruction',()=>{
 const f=fixture(),gate={expiresAt:100,maxRuns:2,maxModelCalls:8,priorRuns:1,priorModelCalls:7,priorMicrousd:8};
 const make=(acceptance=gate)=>commonSpendReservation(f.storage,policy,f.now,()=>{},acceptance);
 const ledger=make();ledger.reserve('model:first:1',1,'last-run');expect(ledger.reserved()).toBe(1);
 expect(()=>make().reserve('model:second:1',1,'last-run')).toThrow(/model limit/);
 expect(()=>make({...gate,priorModelCalls:0}).reserve('browser:next:1',0)).toThrow(/history conflict/);
 expect(()=>ledger.reserveCleanup('allocation',2,1,()=>{})).toThrow(/limit exceeded/);
 ledger.reserveCleanup('allocation',1,1,()=>{});f.expire();ledger.consumeCleanup('allocation');
 expect(()=>ledger.reserve('browser:next:1',0)).toThrow(/expired/);
});


it('concurrent physical requests atomically stop at the eighth reservation',async()=>{
 const f=fixture(),gate={expiresAt:100,maxRuns:2,maxModelCalls:8,priorRuns:0,priorModelCalls:0,priorMicrousd:0};let issued=0;
 const {commonSpendCalls}=await import('../src/channels/common-spend-reservation');
 const ledger=commonSpendReservation(f.storage,{...policy,maxCalls:30},f.now,()=>{},gate);
 const gateway=commonSpendCalls(ledger,()=>1).gateway({complete:async(_request:unknown)=>{issued++;return 'done';}});
 const results=await Promise.allSettled(Array.from({length:9},()=>gateway.complete({request:{},runScope:scope})));
 expect(results.filter(item=>item.status==='fulfilled')).toHaveLength(8);expect(results.filter(item=>item.status==='rejected')).toHaveLength(1);expect(issued).toBe(8);expect(ledger.reserved()).toBe(8);
});
