import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { claimStore } from '../src/memory/claims';
import { appMemoryCorrectionRequest, appMemoryCorrectionTargets, type AppMemoryCorrectionHost } from '../src/channels/app-memory';
import { appMemoryCorrectionReceiptV1Schema } from '../../contracts/src/app/memory';
import { RightsError } from '../src/rights/jobs';
const owner=()=>env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`memory-correction-${crypto.randomUUID()}`));
const request=(path:string,body?:unknown)=>new Request(`https://app.invalid${path}`,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const host=(state:DurableObjectState,live=()=>true):AppMemoryCorrectionHost=>({ownerRef:'canonical-auth-owner-a',scope:state.id.toString(),sessionHash:'a'.repeat(64),storage:state.storage.kv,store:claimStore(state.storage.sql,work=>state.storage.transactionSync(work)),now:()=>1_000_000,assertCurrent:async()=>{if(!live())throw new RightsError('rejected');},rateLimit:async()=>true,commit:work=>state.storage.transactionSync(()=>{if(!live()||state.storage.kv.get('rights:owner-lock'))throw new RightsError('rejected');return work();}),changed:vi.fn()});
const add=(h:AppMemoryCorrectionHost)=>h.store.add({kind:'preference',text:'I prefer mornings',source:'stated',origin:'owner',evidence:'I prefer mornings',source_ref:'owner, app-original-message'},'2026-10-10T00:00:00Z');
const args=async(h:AppMemoryCorrectionHost)=>{const target=(await appMemoryCorrectionTargets(h)).targets[0]!;return {operation_id:crypto.randomUUID(),claim_ref:target.claim_ref,expected_revision:target.revision,kind:'preference',text:'I prefer evenings'};};
const call=async(h:AppMemoryCorrectionHost,path:string,body?:unknown)=>(await appMemoryCorrectionRequest(request(path,body),h))!;
it('corrects actual owner-local claims atomically with canonical evidence and recovers one receipt after eviction',async()=>{
 const stub=owner();let submitted:Awaited<ReturnType<typeof args>>,saved:unknown;
 await runInDurableObject(stub,async(_instance,state)=>{
  const h=host(state);add(h);submitted=await args(h);
  saved=appMemoryCorrectionReceiptV1Schema.parse(await (await call(h,'/app/v1/memory/corrections',submitted)).json());
  const all=h.store.allClaims(),active=h.store.claims();expect(all).toHaveLength(2);expect(all[0]).toMatchObject({status:'superseded',valid_to:new Date(h.now()).toISOString()});expect(active).toHaveLength(1);
  expect(active[0]).toMatchObject({text:submitted.text,evidence:submitted.text,kind:'preference',source:'stated',origin:'owner',verification_status:'owner-grounded',supersedes_id:all[0]!.id});
  expect(active[0]!.source_ref).toBe(`owner, ${(saved as {occurrence_ref:string}).occurrence_ref}`);expect(h.changed).toHaveBeenCalledOnce();
  const duplicate=await call(h,'/app/v1/memory/corrections',submitted);expect(await duplicate.json()).toEqual(saved);expect(h.store.allClaims()).toHaveLength(2);
 });
 await evictDurableObject(stub);
 await runInDurableObject(stub,async(_instance,state)=>{
  const h=host(state);expect(await (await call(h,`/app/v1/memory/corrections/${submitted!.operation_id}`)).json()).toEqual(saved);
  expect(await (await call(h,'/app/v1/memory/corrections',submitted!)).json()).toEqual(saved);expect(h.store.allClaims()).toHaveLength(2);
  expect(await (await call(h,'/app/v1/memory/corrections/targets')).json()).toMatchObject({targets:[{claim_ref:(saved as {replacement_claim_ref:string}).replacement_claim_ref}]});
 });
});
it('refuses stale, substituted, other-owner and other-session correction authority',async()=>{
 await runInDurableObject(owner(),async(_instance,state)=>{
  const h=host(state);add(h);const input=await args(h);
  expect((await call(h,'/app/v1/memory/corrections',{...input,expected_revision:'b'.repeat(64)})).status).toBe(409);
  expect((await call(h,'/app/v1/memory/corrections',{...input,claim_ref:'other-do:claim:1'})).status).toBe(404);
  expect((await call({...h,ownerRef:'canonical-auth-owner-b'},'/app/v1/memory/corrections',input)).status).toBe(409);expect(h.store.allClaims()).toHaveLength(1);
  expect((await call(h,'/app/v1/memory/corrections',input)).status).toBe(200);
  expect((await call(h,'/app/v1/memory/corrections',{...input,text:'substituted'})).status).toBe(409);
  expect((await call({...h,sessionHash:'c'.repeat(64)},'/app/v1/memory/corrections',input)).status).toBe(403);
  expect((await call({...h,ownerRef:'canonical-auth-owner-b'},`/app/v1/memory/corrections/${input.operation_id}`)).status).toBe(403);expect(h.store.allClaims()).toHaveLength(2);
 });
});
it('checks the fresh claim inside commit and rejects revocation during asynchronous digest admission',async()=>{
 await runInDurableObject(owner(),async(_instance,state)=>{
  let live=true;const h=host(state,()=>live);add(h);const input=await args(h);
  const raced={...h,commit:<T>(work:()=>T)=>state.storage.transactionSync(()=>{state.storage.sql.exec('UPDATE claims SET text=? WHERE id=1','raced source');return work();})};
  expect((await call(raced,'/app/v1/memory/corrections',input)).status).toBe(409);expect(h.store.claims()[0]!.text).toBe('I prefer mornings');expect(h.store.allClaims()).toHaveLength(1);
  let checks=0;const revoked={...h,assertCurrent:async()=>{if(++checks===3)live=false;await h.assertCurrent();}};
  expect((await call(revoked,'/app/v1/memory/corrections',input)).status).toBe(403);expect(h.store.allClaims()).toHaveLength(1);
 });
});
it('rejects model provenance, origin attacks, forget barriers and partial transaction outcomes',async()=>{
 await runInDurableObject(owner(),async(_instance,state)=>{
  const h=host(state);add(h);const input=await args(h);
  for(const extra of [{source:'confirmed'},{origin:'owner'},{evidence_quote:'model assertion'},{aliases:['execute']}])expect((await call(h,'/app/v1/memory/corrections',{...input,...extra})).status).toBe(400);
  const cross=request('/app/v1/memory/corrections',input);cross.headers.set('origin','https://other.invalid');expect((await appMemoryCorrectionRequest(cross,h))!.status).toBe(403);
  h.store.barrier(input.text,'2026-10-10T00:00:00Z');expect((await call(h,'/app/v1/memory/corrections',input)).status).toBe(403);expect(h.store.allClaims()).toHaveLength(1);
  state.storage.sql.exec('DELETE FROM forget_barriers');
  const failed={...h,changed:()=>{throw Error('atomic epoch unavailable');}};expect((await call(failed,'/app/v1/memory/corrections',input)).status).toBe(503);expect(h.store.allClaims()).toHaveLength(1);expect((await call(h,`/app/v1/memory/corrections/${input.operation_id}`)).status).toBe(404);
  expect((await call(h,'/app/v1/memory/corrections',{...input,text:'😎'.repeat(4096)})).status).toBe(400);expect(h.store.allClaims()).toHaveLength(1);
 });
});
it('serializes concurrent corrections to the same revision and does not adopt a different-provenance twin',async()=>{
 await runInDurableObject(owner(),async(_instance,state)=>{
  const h=host(state);add(h);const input=await args(h);
  h.store.add({kind:'preference',text:input.text,source:'inferred',origin:'agent',evidence:'unconfirmed model output'},'2026-10-10T00:00:00Z');expect((await call(h,'/app/v1/memory/corrections',input)).status).toBe(409);expect(h.store.allClaims()).toHaveLength(2);
  h.store.forget(h.store.claims().find(claim=>claim.origin==='agent')!.id);
  const responses=await Promise.all([call(h,'/app/v1/memory/corrections',input),call(h,'/app/v1/memory/corrections',{...input,operation_id:crypto.randomUUID(),text:'Other explicit preference'})]);expect(responses.map(r=>r.status).sort()).toEqual([200,404]);expect(h.store.claims()).toHaveLength(1);expect(h.store.allClaims()).toHaveLength(2);
 });
});
