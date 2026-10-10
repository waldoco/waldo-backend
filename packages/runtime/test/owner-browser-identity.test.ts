import {expect,it,vi} from 'vitest';
import {canonicalOwnerBrowserIdentity,type CanonicalBrowserOwner} from '../src/channels/owner-browser-identity';

function fixture(){
 const rows=new Map<string,unknown>([['do_name','canonical-owner']]);
 let owner:CanonicalBrowserOwner|null={directoryOwnerId:'10000000-0000-0000-0000-000000000001',doName:'canonical-owner'};
 let session='app-session-one',authorized=true;
 const storage={kv:{get:(key:string)=>rows.get(key)}} as unknown as DurableObjectStorage;
 const check=vi.fn(async(expected:CanonicalBrowserOwner)=>{if(!authorized||JSON.stringify(expected)!==JSON.stringify(owner))throw Error('owner authority revoked');});
 const identity=canonicalOwnerBrowserIdentity({env:{TELEGRAM_OWNER_DO:{idFromName:(name:string)=>({toString:()=>name==='canonical-owner'?'physical-owner':'foreign'})} as never},storage,actualDoId:'physical-owner',snapshot:()=>owner,assertCurrent:check});
 return {identity,rows,check,changeSession:(next:string)=>{session=next;},setOwner:(next:CanonicalBrowserOwner|null)=>{owner=next;},revoke:()=>{authorized=false;},session:()=>session};
}
it('canonical browser custody belongs to one physical authenticated owner independently of surface/session linkage',async()=>{
 const f=fixture(),binding=f.identity.snapshot()!;
 const before=await f.identity.resolve(binding);
 f.rows.set('telegram_subject','81101');f.changeSession('whatsapp-session');
 f.rows.delete('telegram_subject');f.rows.set('telegram_unlinked',true);f.changeSession('app-session-two');
 expect(f.identity.snapshot()).toBe(binding);expect(await f.identity.resolve(binding)).toEqual(before);
 expect(before).toMatchObject({directoryOwnerId:'10000000-0000-0000-0000-000000000001',custodyDigest:expect.stringMatching(/^[a-f0-9]{64}$/)});
 expect(f.check).toHaveBeenCalled();
});
it('retained canonical custody does not authorize a revoked current app session',async()=>{
 const f=fixture(),binding=f.identity.snapshot()!;await f.identity.resolve(binding);f.revoke();
 await expect(f.identity.assertCurrent(binding)).rejects.toThrow();await expect(f.identity.resolve(binding)).rejects.toThrow();
});
it('another canonical owner cannot consume the old snapshot even on the same physical host',async()=>{
 const f=fixture(),binding=f.identity.snapshot()!;
 f.setOwner({directoryOwnerId:'20000000-0000-0000-0000-000000000001',doName:'canonical-owner'});
 await expect(f.identity.resolve(binding)).rejects.toThrow();expect(f.check).not.toHaveBeenCalled();
});
it.each(['lock','physical','no_owner'] as const)('a %s change invalidates an owner binding before current-authority I/O',async mode=>{
 const f=fixture(),binding=f.identity.snapshot()!;
 if(mode==='lock')f.rows.set('rights:owner-lock',{state:'pending'});
 if(mode==='physical')f.rows.set('do_name','other-owner');
 if(mode==='no_owner')f.setOwner(null);
 expect(f.identity.snapshot()).toBeNull();await expect(f.identity.assertCurrent(binding)).rejects.toThrow();expect(f.check).not.toHaveBeenCalled();
});
it('an owner replacement while current-authority I/O waits invalidates the old capability',async()=>{
 const f=fixture(),binding=f.identity.snapshot()!;let entered!:()=>void,release!:()=>void;
 const reached=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
 f.check.mockImplementationOnce(async()=>{entered();await gate;});
 const pending=f.identity.resolve(binding);await reached;
 f.setOwner({directoryOwnerId:'20000000-0000-0000-0000-000000000001',doName:'canonical-owner'});release();
 await expect(pending).rejects.toThrow();
});
it('custody digest changes for an independently authenticated physical owner and cannot cross owner storage',async()=>{
 const first=fixture(),one=await first.identity.resolve(first.identity.snapshot()!);
 const second=fixture();second.setOwner({directoryOwnerId:'20000000-0000-0000-0000-000000000001',doName:'canonical-owner'});
 const two=await second.identity.resolve(second.identity.snapshot()!);expect(two.custodyDigest).not.toBe(one.custodyDigest);
 await expect(second.identity.resolve(first.identity.snapshot()!)).rejects.toThrow();
});
