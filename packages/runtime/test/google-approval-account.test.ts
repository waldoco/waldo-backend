import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { b64url, sha256Hex, type GoogleClient } from '../src/connectors/google';
it('keeps account visible in approval and routes the approved send and calendar effect to it',async()=>{
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('selected-google-account'));
 await runInDurableObject(stub,async(_instance,state)=>{
  const routes:unknown[]=[];const cards:string[]=[];let id=0;
  const desk=approvalDesk(state.storage.sql,{call:async(_method,args)=>{cards.push(String((args as {text?:string}).text));return {message_id:1};},owner:42,google:async(intent,feature,account)=>{routes.push([feature,account]);return {account:{connection_id:'work',email:'work@example.com'},sendRaw:async()=>({message_id:'m'}),createEvent:async()=>({id:'e',title:'Event',start:'2026-10-08T00:00:00Z',end:'2026-10-08T01:00:00Z'})} as unknown as GoogleClient;},newId:()=>String(++id),now:()=>1000,timezone:'UTC',log:()=>{}});
  const raw=b64url(new TextEncoder().encode('mime'));
  const email=await desk.proposeSendEmail({account:'work@example.com',to:['to@example.com'],subject:'Subject',body:'Body',raw,digest:await sha256Hex(raw),message_id:'<1@waldo>'});
  expect(cards.join('\n')).toContain('From: work@example.com');
  expect(desk.pending(1000).find(p=>p.id===email)?.review).toMatchObject({account:'work@example.com'});
  await desk.decide(email,'a','test');
  expect(routes).toContainEqual(['mail','work@example.com']);
  const calendar=await desk.propose({account:'work@example.com',action:'create',title:'Event',start:'2026-10-08T00:00:00Z' as never,end:'2026-10-08T01:00:00Z' as never,reason:'test'});
  expect(cards.join('\n')).toContain('work@example.com');
  await desk.decide(calendar,'a','test');
  expect(routes).toContainEqual(['calendar','work@example.com']);
 });
});
