import { describe, expect, it, vi } from 'vitest';
import { workspaceStore, type WorkspaceState, type WorkspaceHost, type OwnerBinding, LIMITS } from '../src/store';
const id = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const binding:OwnerBinding={ownerId:id(1),environment:'staging',namespace:'owner-do-staging',doName:'owner-name',doId:'opaque',stateVersion:1,mappingVersion:1};
const args=(operation=10,path='file.txt',bytes=new TextEncoder().encode('hello'))=>({path,bytes,mime:'text/plain',expected_revision:0,provenance:'agent_generated' as const,operation_id:id(operation)});
const fixture=()=>{
 let state:WorkspaceState={binding:null,files:[],bodies:[],operations:[]};
 const objects=new Map<string,Uint8Array>();let n=100;let active=true;
 const host: { -readonly [K in keyof WorkspaceHost]: WorkspaceHost[K] }={binding:{...binding},admit:vi.fn(async()=>({status:active?'ok':'rejected'})),metadata:{transaction(work){const next=structuredClone(state);const result=work(next);state=next;return result;}},bodies:{put:vi.fn(async(b,v)=>{objects.set(b.blob_id,v.slice());}),get:vi.fn(async b=>objects.get(b.blob_id)?.slice()??null),remove:vi.fn(async b=>{objects.delete(b.blob_id);})},now:()=>1000,newId:()=>id(n++)};
 return {host,objects,state:()=>state,suspend:()=>{active=false;}};
};
describe('retained byte store',()=>{
 it('retains named text and binary digest after reconstructed host store',async()=>{
 const f=fixture(),s=await workspaceStore(f.host);const m=await s.write(args());const next=await workspaceStore(f.host);
 expect((await next.read(m.file_id,1,0,8192)).text).toBe('hello');expect((await next.list()).files).toHaveLength(1);
 const bin=await next.write(args(11,'a.pdf',new Uint8Array([0,255,100])));expect((await next.export(bin.file_id,1)).bytes).toEqual(new Uint8Array([0,255,100]));
 await expect(next.read(bin.file_id,1,0,10)).rejects.toThrow('workspace_invalid');
 });
 it('atomically prevents duplicate body writes, stale revisions and changed operation replay',async()=>{
 const f=fixture(),s=await workspaceStore(f.host);const m=await s.write(args());expect(await s.write(args())).toEqual(m);expect(f.host.bodies.put).toHaveBeenCalledTimes(1);
 await expect(s.write(args(10,'different'))).rejects.toThrow('workspace_conflict');await expect(s.write(args(11))).rejects.toThrow('workspace_conflict');
 const updated=await s.write({...args(12),expected_revision:1,bytes:new TextEncoder().encode('new')});expect(updated.revision).toBe(2);expect((await s.read(m.file_id,1,0,10)).text).toBe('hello');expect((await s.read(m.file_id,2,0,10)).text).toBe('new');
 });
 it('rejects missing or wrong retained mapping before body access',async()=>{
 const f=fixture();f.host.binding={...binding,ownerId:'telegram:1'};await expect(workspaceStore(f.host)).rejects.toThrow('workspace_unavailable');expect(f.host.bodies.get).not.toHaveBeenCalled();
 const good=fixture();await workspaceStore(good.host);good.host.binding={...binding,ownerId:id(2)};await expect(workspaceStore(good.host)).rejects.toThrow('workspace_rejected');expect(good.host.bodies.put).not.toHaveBeenCalled();
 });
 it('failed host admission performs no metadata or R2 access',async()=>{
 const f=fixture();f.suspend();const tx=vi.spyOn(f.host.metadata,'transaction');await expect(workspaceStore(f.host)).rejects.toThrow('workspace_rejected');expect(tx).not.toHaveBeenCalled();expect(f.host.bodies.put).not.toHaveBeenCalled();
 });
 it('suspension during write holds pending body without publishing and restart reconciliation succeeds',async()=>{
 const f=fixture(),s=await workspaceStore(f.host);const original=f.host.bodies.put;f.host.bodies.put=vi.fn(async(b,v)=>{await original(b,v);f.suspend();});
 await expect(s.write(args())).rejects.toThrow('workspace_rejected');expect(f.state().files).toHaveLength(0);expect(f.state().operations[0]?.status).toBe('pending');
 f.host.admit=async()=>({status:'ok'});const resumed=await workspaceStore(f.host);expect((await resumed.reconcile(id(10))).revision).toBe(1);expect(f.host.bodies.put).toHaveBeenCalledTimes(1);
 });
 it('concurrent write reservation and quota are enforced before external body write',async()=>{
 const f=fixture(),s=await workspaceStore(f.host);let release!:()=>void;f.host.bodies.put=vi.fn(async(b,v)=>{await new Promise<void>(r=>release=r);f.objects.set(b.blob_id,v);});
 const first=s.write(args());await vi.waitFor(()=>expect(f.host.bodies.put).toHaveBeenCalledTimes(1));await expect(s.write(args(11,'other.txt'))).rejects.toThrow('workspace_pending');release();await first;
 await expect(s.write(args(12,'huge',new Uint8Array(LIMITS.fileBytes+1)))).rejects.toThrow('workspace_quota');expect(f.host.bodies.put).toHaveBeenCalledTimes(1);
 });
 it('failed body write never publishes and cannot blind-replay missing bytes',async()=>{
 const f=fixture(),s=await workspaceStore(f.host);f.host.bodies.put=vi.fn(async()=>{throw Error('private canary');});await expect(s.write(args())).rejects.toThrow('workspace_unavailable');expect(f.state().files).toHaveLength(0);
 await expect(s.write(args())).rejects.toThrow('workspace_unavailable');expect(f.host.bodies.put).toHaveBeenCalledTimes(1);
 });
 it('rejects path traversal, absolute paths, controls and normalization ambiguity',async()=>{
 const f=fixture(),s=await workspaceStore(f.host);for(const path of ['/abs','../x','a/../b','a//b','a\\b','C:/drive','e\u0301.txt','a\0b'])await expect(s.write(args(10,path))).rejects.toThrow('workspace_invalid');expect(f.host.bodies.put).not.toHaveBeenCalled();
 });
 it('respects UTF8 byte boundaries and refuses malformed offsets/tiny split reads',async()=>{
 const f=fixture(),s=await workspaceStore(f.host),m=await s.write(args(10,'emoji',new TextEncoder().encode('a😎b')));
 expect(await s.read(m.file_id,1,0,4)).toMatchObject({text:'a',next_offset:1,total_bytes:6,source_taint:'external'});expect((await s.read(m.file_id,1,1,4)).text).toBe('😎');await expect(s.read(m.file_id,1,2,4)).rejects.toThrow('workspace_invalid');await expect(s.read(m.file_id,1,1,1)).rejects.toThrow('workspace_invalid');
 });
 it('digest failure and out-of-owner file IDs never produce content',async()=>{
 const f=fixture(),s=await workspaceStore(f.host),m=await s.write(args());f.objects.set(f.state().bodies[0]!.blob_id,new TextEncoder().encode('wrong'));await expect(s.read(m.file_id,1,0,10)).rejects.toThrow('workspace_unavailable');await expect(s.read(id(9),1,0,10)).rejects.toThrow('workspace_not_found');
 });
 it('partial body deletion is visible, retains cleanup inventory/quota and retry confirms purge',async()=>{
 const f=fixture(),s=await workspaceStore(f.host),m=await s.write(args());f.host.bodies.remove=vi.fn(async()=>{throw Error('uncertain');});expect(await s.tombstone(m.file_id,1)).toEqual({status:'cleanup_pending'});expect(await s.stat(m.file_id)).toBeNull();expect(f.state().bodies).toHaveLength(1);await expect(s.write(args())).rejects.toThrow('workspace_not_found');f.host.bodies.remove=async b=>{f.objects.delete(b.blob_id);};expect(await s.tombstone(m.file_id,1)).toEqual({status:'purged'});expect(f.state().bodies).toHaveLength(0);
 });
 it('response loss after body put but before metadata commit leaves a recoverable reservation',async()=>{
 const f=fixture(),s=await workspaceStore(f.host);const transaction=f.host.metadata.transaction;let failCommit=true;f.host.metadata.transaction=(work)=>transaction(state=>{const result=work(state);if(state.files.length&&failCommit){failCommit=false;throw Error('commit-lost');}return result;});await expect(s.write(args())).rejects.toThrow('commit-lost');expect(f.state().files).toHaveLength(0);expect(f.state().operations[0]?.status).toBe('pending');expect((await s.reconcile(id(10))).revision).toBe(1);expect(f.host.bodies.put).toHaveBeenCalledTimes(1);
 });
 it('deadline does not erase pending reservation or replay uncertain put',async()=>{
 vi.useFakeTimers();try{const f=fixture(),s=await workspaceStore(f.host);f.host.bodies.put=vi.fn(async()=>new Promise<void>(()=>undefined));const pending=expect(s.write(args())).rejects.toThrow('workspace_unavailable');await vi.waitFor(()=>expect(f.host.bodies.put).toHaveBeenCalledTimes(1));await vi.advanceTimersByTimeAsync(60000);await pending;expect(f.state().operations[0]?.status).toBe('pending');expect(f.state().files).toHaveLength(0);await expect(s.write(args())).rejects.toThrow('workspace_unavailable');expect(f.host.bodies.put).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);}finally{vi.useRealTimers();}
 });
 it('old binary export carries the immutable revision MIME and digest, not latest metadata',async()=>{
 const f=fixture(),s=await workspaceStore(f.host),m=await s.write({...args(),mime:'application/pdf'});await s.write({...args(11),expected_revision:1,mime:'text/plain',bytes:new TextEncoder().encode('changed')});const old=await s.export(m.file_id,1);expect(old.meta.mime).toBe('application/pdf');expect(old.meta.sha256).toBe(m.sha256);expect(old.meta.byte_size).toBe(m.byte_size);
 });
 it('separate body and receipt caps include zero-byte operations, admit exact retries at cap',async()=>{
 const f=fixture(),s=await workspaceStore(f.host);let last:any;
 for(let i=0;i<500;i++)last=await s.write({...args(10000+i,'zero',new Uint8Array()),expected_revision:i});
 expect(f.state().bodies).toHaveLength(500);expect(f.state().operations).toHaveLength(500);expect(f.state().files).toHaveLength(1);
 await expect(s.write({...args(20000,'zero',new Uint8Array()),expected_revision:500})).rejects.toThrow('workspace_capacity');
 expect((await s.write({...args(10499,'zero',new Uint8Array()),expected_revision:499})).revision).toBe(500);
 expect(await s.tombstone(last.file_id,500)).toEqual({status:'purged'});expect(f.state().bodies).toHaveLength(0);expect(f.state().operations).toHaveLength(500);
 await expect(s.write({...args(20001,'new',new Uint8Array())})).rejects.toThrow('workspace_capacity');await expect(s.write({...args(10499,'zero',new Uint8Array()),expected_revision:499})).rejects.toThrow('workspace_not_found');
 });
 it('pending reservation consumes the last slot and existing recovery works at cap',async()=>{
 const f=fixture(),s=await workspaceStore(f.host);for(let i=0;i<499;i++)await s.write({...args(10000+i,'zero',new Uint8Array()),expected_revision:i});
 const original=f.host.bodies.put;f.host.bodies.put=vi.fn(async(b,v)=>{await original(b,v);f.suspend();});
 await expect(s.write({...args(10499,'zero',new Uint8Array()),expected_revision:499})).rejects.toThrow('workspace_rejected');expect(f.state().operations).toHaveLength(500);expect(f.state().bodies).toHaveLength(499);
 f.host.admit=async()=>({status:'ok'});const restart=await workspaceStore(f.host);expect((await restart.reconcile(id(10499))).revision).toBe(500);expect(f.state().bodies).toHaveLength(500);
 });
 it('binding map-version mismatch at construction never reaches bodies',async()=>{
 const f=fixture();await workspaceStore(f.host);f.host.binding={...binding,mappingVersion:2};await expect(workspaceStore(f.host)).rejects.toThrow('workspace_rejected');expect(f.host.bodies.get).not.toHaveBeenCalled();expect(f.host.bodies.put).not.toHaveBeenCalled();
 });
 it('revocation immediately before put preserves a pending reservation but sends no bytes',async()=>{
 const f=fixture(),s=await workspaceStore(f.host);let writes=0;f.host.admit=async(_b,a)=>({status:a==='write'&&++writes>1?'rejected':'ok'});await expect(s.write(args())).rejects.toThrow('workspace_rejected');expect(f.state().operations[0]?.status).toBe('pending');expect(f.host.bodies.put).not.toHaveBeenCalled();
 });
 it('read racing deletion cannot return already tombstoned content',async()=>{
 const f=fixture(),s=await workspaceStore(f.host),m=await s.write(args());let release!:()=>void;const original=f.host.bodies.get;f.host.bodies.get=vi.fn(async b=>{const bytes=await original(b);await new Promise<void>(r=>release=r);return bytes;});const read=s.read(m.file_id,1,0,10);await vi.waitFor(()=>expect(f.host.bodies.get).toHaveBeenCalledTimes(1));await s.tombstone(m.file_id,1);release();await expect(read).rejects.toThrow('workspace_not_found');
 });
});
