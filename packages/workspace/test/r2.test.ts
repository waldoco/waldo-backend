import { expect, it, vi } from 'vitest';
import { r2Bodies } from '../src/r2';
import type { OwnerBinding, BodyRevision } from '../src/store';
const owner='00000000-0000-4000-8000-000000000001', file='00000000-0000-4000-8000-000000000002', blob='00000000-0000-4000-8000-000000000003';
const binding:OwnerBinding={ownerId:owner,environment:'staging',namespace:'owner/do',doName:'name',doId:'id',stateVersion:1,mappingVersion:1};
const body=(b=binding):BodyRevision=>({binding:b,file_id:file,blob_id:blob,revision:1,mime:'text/plain',provenance:'agent_generated',created_at:0,byte_size:1,sha256:'fixture'});
it('isolates same file/blob IDs across owners and environments in shared bucket',async()=>{
 const map=new Map<string,Uint8Array>();const bucket={put:async(k:string,v:Uint8Array)=>{map.set(k,v);},get:async(k:string)=>map.has(k)?{arrayBuffer:async()=>map.get(k)!.slice().buffer}:null,delete:async(k:string)=>{map.delete(k);}};const admit=async()=>({status:'ok' as const});
 const b={...binding,ownerId:'00000000-0000-4000-8000-000000000004'},c={...binding,environment:'production'};
 const a=await r2Bodies(bucket,binding,admit),bb=await r2Bodies(bucket,b,admit),cc=await r2Bodies(bucket,c,admit);
 await a.put(body(),new Uint8Array([1]));await bb.put(body(b),new Uint8Array([2]));await cc.put(body(c),new Uint8Array([3]));
 expect(await a.get(body())).toEqual(new Uint8Array([1]));expect(await bb.get(body(b))).toEqual(new Uint8Array([2]));expect(await cc.get(body(c))).toEqual(new Uint8Array([3]));expect(map.size).toBe(3);expect([...map.keys()][0]).toContain('/owner%2Fdo/');
 await expect(a.get(body(b))).rejects.toThrow('workspace_rejected');await expect(a.remove(body(c))).rejects.toThrow('workspace_rejected');expect(map.size).toBe(3);
});
it('fails closed on missing bucket and admission denial, with no storage calls',async()=>{
 const bucket={put:vi.fn(),get:vi.fn(),delete:vi.fn()};await expect(r2Bodies(undefined,binding,async()=>({status:'ok'}))).rejects.toThrow('workspace_unavailable');await expect(r2Bodies(bucket,binding,async()=>({status:'rejected'}))).rejects.toThrow('workspace_rejected');expect(bucket.put).not.toHaveBeenCalled();expect(bucket.get).not.toHaveBeenCalled();
});
it('does not derive keys from a wrong binding or locator map version',async()=>{
 const bucket={put:vi.fn(),get:vi.fn(),delete:vi.fn()};const a=await r2Bodies(bucket,binding,async()=>({status:'ok'}));for(const b of [{...binding,mappingVersion:2},{...binding,doId:'different'},{...binding,namespace:'other'}])await expect(a.get(body(b))).rejects.toThrow('workspace_rejected');expect(bucket.get).not.toHaveBeenCalled();
});
