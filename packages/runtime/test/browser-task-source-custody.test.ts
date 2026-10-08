import { it, expect } from 'vitest';
import { browserTaskSourceCustody } from '../src/channels/browser-task-source';
import type { BrowserSubmitProposal } from '../src/channels/approvals';
const payload = { continuation: { taskRef:'browser-task', proposalId:'proposal', scopeDigest:'scope' } } as BrowserSubmitProposal;
const fixture=()=>{
 const rows=new Map<string,unknown>();let source={taskId:'source-task',revision:1,sources:['web'],ready:true};
 const sql={exec:()=>({toArray:()=>[{task_id:source.taskId,revision:source.revision,sources_json:JSON.stringify(source.sources),ready:source.ready?1:0,start_ref:'input'}]})} as unknown as SqlStorage;
 const kv={get:<T>(key:string)=>structuredClone(rows.get(key)) as T,put:(key:string,value:unknown)=>{rows.set(key,structuredClone(value));}};
 let owner='owner-a';const custody=browserTaskSourceCustody(sql,kv,async()=>owner);
 return {rows,sql,kv,custody,setOwner:(value:string)=>{owner=value;},restrict:()=>{source={...source,revision:2,sources:['workspace'],ready:false};}};
};
it('rejects approval after durable source scope is restricted/closed',async()=>{
 const f=fixture();f.custody.capture(payload,'owner-a');const guard=f.custody.guard(payload);f.restrict();
 await expect(guard()).rejects.toThrow();
});
it('witness replacement during owner lookup must invalidate in-flight guard',async()=>{
 const f=fixture();let release!: (owner:string)=>void;
 const custody=browserTaskSourceCustody(f.sql,f.kv,()=>new Promise(resolve=>{release=resolve;}));
 custody.capture(payload,'owner-a');const checking=custody.guard(payload)();
 custody.capture({...payload,continuation:{...payload.continuation!,proposalId:'new-proposal'}},'owner-a');release('owner-a');
 await expect(checking).rejects.toThrow();
});
it('control: different current owner rejects before use',async()=>{
 const f=fixture();f.custody.capture(payload,'owner-a');f.setOwner('owner-b');await expect(f.custody.guard(payload)()).rejects.toThrow();
});
it('control: changed revoke marker during owner lookup rejects',async()=>{
 const f=fixture();let release!:(owner:string)=>void;
 const custody=browserTaskSourceCustody(f.sql,f.kv,()=>new Promise(resolve=>{release=resolve;}));custody.capture(payload,'owner-a');
 const checking=custody.guard(payload)();f.rows.set('browser_owner_task_revoked_v1','browser-task');release('owner-a');await expect(checking).rejects.toThrow();
});

import { browserTaskContinuity, type BrowserTaskStore } from '../src/channels/browser-task-continuity';
import { browserTaskApprovalBridge } from '../src/tools/live/browser-task';
import {fixtureDigest} from '../src/channels/public-fixture-browser';
import type {BrowserTaskCheckpoint} from '@waldo/contracts';
const taskFixture = () => {
  let row: unknown = null, lock: Promise<unknown> = Promise.resolve(), starts = 0, submits = 0, ends = 0, value = 'synthetic initial', now = 100, grant = true;
  const store: BrowserTaskStore = { exclusive: async work => { const next = lock.then(work); lock = next.catch(() => undefined); return next; }, load: async () => row === null ? null : structuredClone(row), save: async next => { row = structuredClone(next); } };
  const driver = { provider: 'cloudflare_playwright' as const, origin: 'https://fixture.example', pageUrl: 'https://fixture.example/form', runId: 'run-one', submitRef: '#submit', start: async () => { starts++; return 'private-provider-session'; }, navigate: async () => {}, inspect: async () => ({ url: 'https://fixture.example/form', stateDigest: await fixtureDigest({ value }), binding: { value } }), fill: async (_id: string, _field: string, next: string, _digest: string, before: () => Promise<void>) => { await before(); value = next; }, submit: async (_id: string, _digest: string, before: () => Promise<void>) => { await before(); submits++; }, verify: async (_digest: string) => null as { id: string; observed_at: string; source: 'controlled_fixture'; binding_digest: string } | null, end: async () => { ends++; } };
  const options = { enabled: true, ownerId: 'owner-a', taskId: 'run-one', manifestDigest: `sha256:${'a'.repeat(64)}`, store, driver, now: () => now, newId: () => crypto.randomUUID(), admit: async (): Promise<string | null> => grant ? 'host-current-grant' : null };
  return { options, driver, counts: () => ({ starts, submits, ends }), row: () => row as BrowserTaskCheckpoint, setTime: (next: number) => { now = next; }, revoke: () => { grant = false; } };
};

it('source restriction still permits a simulated approved submit through continuation bridge',async()=>{
 const source=fixture(),f=taskFixture();const task=browserTaskContinuity(f.options);
 await task.open('owner-a',10000);const prepared=await task.propose('owner-a');
 const proposed:BrowserSubmitProposal={url:prepared.url,request:prepared.request,approvalExpiresAt:prepared.approvalExpiresAt,action:{selector:prepared.actionRef,method:'click',description:'Submit'},binding:prepared.binding,steps:[],continuation:{version:1,taskRef:task.taskRef,proposalId:prepared.id,scopeDigest:prepared.scopeDigest}};
 source.custody.capture(proposed,'owner-a');source.restrict();
 const guard=source.custody.guard(proposed);
 const resumed=browserTaskContinuity({...f.options,admit:async()=>{await guard();return 'current-host-grant';}});
 const bridge=browserTaskApprovalBridge({ownerId:'owner-a',host:async()=>{await guard();return resumed;}});
 await bridge.submit(proposed,'reviewed-owner-approval');
 expect(f.counts().submits,'no final DOM action after source scope withdrawal').toBe(0);
});

import {browserOwnerHost,type BrowserOwnerGrantRequest} from '../src/channels/browser-owner-host';
function ownerHostFixture() {
  const rows = new Map<string, unknown>(); let alarm: number | null = null, starts = 0, now = 100;
  const storage = { get: async (key: string) => rows.get(key), put: async (key: string | Record<string, unknown>, value?: unknown) => { for (const [k, v] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) rows.set(k as string, structuredClone(v)); }, getAlarm: async () => alarm, setAlarm: async (value: number) => { alarm = value; } } as unknown as DurableObjectStorage;
  const binding = { owner_id: '10000000-0000-0000-0000-000000000001', presence_id: '20000000-0000-0000-0000-000000000001', do_name: 'physical-owner-a', provider: 'telegram' as const, subject: '81101', admission_revision: '1', state_version: 0 };
  const principal = 'prn_10000000000000000000000000000001';
  const driver = { provider: 'cloudflare_playwright' as const, origin: 'https://fixture.example', pageUrl: 'https://fixture.example/form', runId: 'run-one', submitRef: '#submit', start: async () => { starts++; return 'private-provider-id'; }, navigate: async () => {}, inspect: async () => ({ url: 'https://fixture.example/form', stateDigest: await fixtureDigest('synthetic'), binding: { value: 'synthetic' } }), fill: async (_id: string, _field: string, _value: string, _state: string, before: () => Promise<void>) => { await before(); }, submit: async (_id: string, _state: string, before: () => Promise<void>, _source?: () => Promise<void>, _assertCurrent?: () => void) => { await before(); }, verify: async () => null, end: async () => {} };
  const config = { enabled: true, binding, manifestDigest: `sha256:${'a'.repeat(64)}`, driver, lookup: async () => ({ ...binding }), grant: async (request: BrowserOwnerGrantRequest) => ({ ...request, ref: 'fresh-grant', expiresAt: now + 1000 }) };
  const options = { storage, physical: () => ({ doName: binding.do_name, subject: binding.subject, matches: true }), config, now: () => now, newId: () => crypto.randomUUID(), approved: () => false };
  return { options, rows, principal, driver, starts: () => starts, alarm: () => alarm, time: (value: number) => { now = value; } };
}

it('real owner-host submit still acts after durable source restriction using the new custody guard',async()=>{
 const f=ownerHostFixture(),source=fixture();let submits=0;
 f.options.approved=()=>true;f.driver.submit=async(_id,_state,before)=>{await before();submits++;};
 const coordinator=browserOwnerHost(f.options);const task=(await coordinator.resolve(f.principal))!;
 await task.read(f.principal);const p=await task.propose(f.principal);
 const payload:BrowserSubmitProposal={url:p.url,request:p.request,approvalExpiresAt:p.approvalExpiresAt,action:{selector:p.actionRef,method:'click',description:'Submit'},binding:p.binding,steps:[],continuation:{version:1,taskRef:task.taskRef,proposalId:p.id,scopeDigest:p.scopeDigest}};
 source.custody.capture(payload,'owner-a');source.restrict();
 const bridge=browserTaskApprovalBridge({ownerId:f.principal,host:async()=>coordinator.resolve(f.principal,source.custody.guard(payload))});
 await bridge.submit(payload,'reviewed-owner-approval');expect(submits).toBe(0);
});
it('witness replacement in final asynchronous source wait does not fence physical submit',async()=>{
 const f=ownerHostFixture(),source=fixture();let submits=0,replace=false;
 let payload:BrowserSubmitProposal;let custody:ReturnType<typeof browserTaskSourceCustody>;
 custody=browserTaskSourceCustody(source.sql,source.kv,async()=>{
  if(replace){replace=false;custody.capture({...payload,continuation:{...payload.continuation!,proposalId:'replacement-proposal'}},'owner-a');}
  return 'owner-a';
 });
 f.options.approved=()=>true;
 f.driver.submit=async(_id,_state,before,_source?,assertCurrent?)=>{
  await before();replace=true;
  await _source?.();assertCurrent?.();submits++;
 };
 const coordinator=browserOwnerHost(f.options),task=(await coordinator.resolve(f.principal))!;
 await task.read(f.principal);const p=await task.propose(f.principal);
 payload={url:p.url,request:p.request,approvalExpiresAt:p.approvalExpiresAt,action:{selector:p.actionRef,method:'click',description:'Submit'},binding:p.binding,steps:[],continuation:{version:1,taskRef:task.taskRef,proposalId:p.id,scopeDigest:p.scopeDigest}};
 custody.capture(payload,'owner-a');const bridge=browserTaskApprovalBridge({ownerId:f.principal,host:async()=>coordinator.resolve(f.principal,custody.guard(payload))});
 await bridge.submit(payload,'reviewed-owner-approval');expect(submits,'final DOM action must not run with replaced durable witness').toBe(0);
});
it('control: owner-host independently rejects an already-revoked run even if custody recaptures marker',async()=>{
 const f=ownerHostFixture(),source=fixture();let submits=0;
 f.options.approved=()=>true;f.driver.submit=async()=>{submits++;};
 const coordinator=browserOwnerHost(f.options),task=(await coordinator.resolve(f.principal))!;
 await task.read(f.principal);const p=await task.propose(f.principal);
 const payload:BrowserSubmitProposal={url:p.url,request:p.request,approvalExpiresAt:p.approvalExpiresAt,action:{selector:p.actionRef,method:'click',description:'Submit'},binding:p.binding,steps:[],continuation:{version:1,taskRef:task.taskRef,proposalId:p.id,scopeDigest:p.scopeDigest}};
 await coordinator.revoke();source.rows.set('browser_owner_task_revoked_v1','run-one');source.custody.capture(payload,'owner-a');
 const bridge=browserTaskApprovalBridge({ownerId:f.principal,host:async()=>coordinator.resolve(f.principal,source.custody.guard(payload))});
 expect(await bridge.submit(payload,'reviewed-owner-approval')).toMatchObject({status:'rejected'});expect(submits).toBe(0);
});
