import { describe, expect, it } from 'vitest';
import { artifactDelivery, artifactPage, ARTIFACT_PATH } from '../src/channels/artifact-delivery';
import type { ArtifactBook, ReadResult } from '../src/channels/artifacts';
const row: ReadResult = { meta: { id:'art:test',name:'<script>x</script>',kind:'document',revision:1,byte_size:6,r2_key:'private-key',provenance:'tool',taint:'external',created_at:0,updated_at:0 },text:'<img src=x onerror=alert(1)>\n- [ ] Drink water',total_chars:51,next_offset:null };
const book = (result: ReadResult|null=row) => ({ read:async()=>result } as unknown as ArtifactBook);
describe('private artifact delivery',()=>{
 it('returns a host-generated owner-authenticated route only after durable readback',async()=>{
  expect(await artifactDelivery(book(),async()=> 'https://staging.invalid',true)(row.meta)).toEqual({status:'owner_link',url:'https://staging.invalid/console/artifacts/art%3Atest',audience:'owner_authenticated'});
 });
 it('fails closed for absent durable store, absent/invalid origin and missing body',async()=>{
  for(const [origin,durable,result] of [[null,true,row],['https://bad.invalid/path',true,row],['https://staging.invalid',false,row],['https://staging.invalid',true,null]] as const){
   expect(await artifactDelivery(book(result),async()=>origin,durable)(row.meta)).toEqual({status:'saved_internal',url:null,audience:'unverified'});
  }
 });
 it('does not accept a mismatched revision readback',async()=>{
  expect((await artifactDelivery(book({...row,meta:{...row.meta,revision:2}}),async()=> 'https://staging.invalid',true)(row.meta)).url).toBeNull();
 });
 it('renders only escaped content with no active HTML, no-store and restrictive policy',async()=>{
  const response=await artifactPage(new Request(`https://staging.invalid${ARTIFACT_PATH}/art%3Atest`),book());
  expect(response?.status).toBe(200); const html=await response!.text();
  expect(html).toContain('&#60;img'); expect(html).not.toContain('<img');expect(html).not.toContain('private-key');
  expect(response!.headers.get('cache-control')).toBe('no-store');expect(response!.headers.get('content-security-policy')).toContain("default-src 'none'");
 });
 it('refuses missing bodies, malformed IDs and writes without leaking metadata',async()=>{
  expect((await artifactPage(new Request(`https://staging.invalid${ARTIFACT_PATH}/art%3Atest`),book(null)))?.status).toBe(404);
  expect((await artifactPage(new Request(`https://staging.invalid${ARTIFACT_PATH}/%FF`),book()))?.status).toBe(404);
  expect((await artifactPage(new Request(`https://staging.invalid${ARTIFACT_PATH}/art%3Atest`,{method:'POST'}),book()))?.status).toBe(405);
  expect(await artifactPage(new Request('https://staging.invalid/console/other'),book())).toBeNull();
 });
});

import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { artifactBook, r2ArtifactBodies } from '../src/channels/artifacts';
import { consoleAccess, CONSOLE_COOKIE } from '../src/channels/console';
it('real DO console requires its session and does not read another owner artifact',async()=>{
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`artifact-owner-${crypto.randomUUID()}`)) as DurableObjectStub<TelegramOwnerDO>;
 const other=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`artifact-other-${crypto.randomUUID()}`)) as DurableObjectStub<TelegramOwnerDO>;
 const state=await runInDurableObject(stub,async(_i,s)=>{
  const book=artifactBook(s.storage.sql,r2ArtifactBodies(env.ARTIFACTS!,s.id.toString()),{timezone:'UTC',now:()=>new Date()},()=> 'integration');
  const meta=await book.create({name:'Private',kind:'document',body_markdown:'Owner-only body'},'test');
  return {id:meta.id,token:await consoleAccess(s.storage).grant()};
 });
 const url=`https://fixture.invalid${ARTIFACT_PATH}/${encodeURIComponent(state.id)}`;
 expect((await stub.fetch(url)).status).toBe(401);
 const own=await stub.fetch(url,{headers:{cookie:`${CONSOLE_COOKIE}=${state.token}`}});
 expect(own.status).toBe(200);expect(await own.text()).toContain('Owner-only body');
 expect((await other.fetch(url,{headers:{cookie:`${CONSOLE_COOKIE}=${state.token}`}})).status).toBe(401);
 const otherToken=await runInDurableObject(other,async(_i,s)=>consoleAccess(s.storage).grant());
 expect((await other.fetch(url,{headers:{cookie:`${CONSOLE_COOKIE}=${otherToken}`}})).status).toBe(404);
});
