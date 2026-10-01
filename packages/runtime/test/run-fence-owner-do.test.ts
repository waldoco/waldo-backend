import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
const seen=vi.hoisted(()=>({sends:[] as unknown[],pause:false,entered:undefined as undefined|(()=>void),finish:undefined as undefined|((r:unknown)=>void)}));
vi.mock('../src/channels/telegram-api',async(load)=>({...await load<typeof import('../src/channels/telegram-api')>(),createTelegramCaller:()=>async(method:string,body:unknown)=>{if(method==='sendMessage')seen.sends.push(body);return method==='sendMessage'?{message_id:seen.sends.length,chat:{id:42}}:true;}}));
vi.mock('openai',()=>({default:class {responses={create:async(body:unknown)=>{
 const name=(body as {text?:{format?:{name:string}}}).text?.format?.name;
 if(seen.pause&&!name){seen.entered?.();return new Promise(r=>{seen.finish=r;});}
 return {id:'fixture',output_text:name==='claim_ops'?'{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}':name==='reaction'?'{"reaction":"👌"}':'fenced answer',output:[],usage:{input_tokens:1,output_tokens:1}};
}};}}));
const setup=async(name:string,work:(i:TelegramOwnerDO,s:DurableObjectState)=>Promise<void>)=>runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)),async(i,s)=>{await s.storage.put({telegram_subject:'42',do_name:name,origin:'https://fixture.invalid'});await work(i as TelegramOwnerDO,s);});
const admit=async(i:TelegramOwnerDO,s:DurableObjectState,id:number)=>{
 const {TelegramOwnerInbox}=await import('../src/channels/telegram-owner-inbox');const {persistInboxWake}=await import('../src/scheduler/alarm-slot');const inbox=new TelegramOwnerInbox(s.storage,persistInboxWake);
 await inbox.admit({bot:(env.TELEGRAM_BOT_TOKEN??'7:fixture').split(':')[0]!,subject:'42',doName:s.storage.kv.get<string>('do_name')!},id,JSON.stringify({update_id:id,message:{message_id:id,from:{id:42,is_bot:false},chat:{id:42,type:'private'},text:'hello'}}));return inbox;
};
it('actual DO commits success final and run closure atomically',async()=>{
 seen.pause=false;await setup('fence-do-success',async(i,s)=>{
  const inbox=await admit(i,s,1);await (i as unknown as {drainInbox():Promise<void>}).drainInbox();
  const row=(await inbox.records())[0]!;expect(row.state).toBe('awaiting_delivery');expect(row.closedAt).toBeTypeOf('number');
  const finals=s.storage.kv.get<import('../src/channels/telegram-final-outbox').FinalRecord[]>('telegram_final_outbox_v1')!;expect(finals).toHaveLength(1);expect(finals[0]?.inbox?.runId).toBe(row.runId);expect(finals[0]?.payload.text).toBe('fenced answer');
 });
});
it('actual DO stop closes before late completion and creates fixed host notice only',async()=>{
 seen.pause=true;await setup('fence-do-stop',async(i,s)=>{
  const inbox=await admit(i,s,2);let enter!:()=>void;const ready=new Promise<void>(r=>{enter=r;});seen.entered=enter;
  const running=(i as unknown as {drainInbox():Promise<void>}).drainInbox();await ready;
  const row=(await inbox.records())[0]!;
  (i as unknown as {closeRunAtomic(r:unknown,reason:string):void}).closeRunAtomic(row,'owner_stopped');
  (i as unknown as {activeAbort:AbortController}).activeAbort.abort();
  await running;seen.finish!({id:'late',output_text:'LATE_FORBIDDEN',output:[],usage:{input_tokens:1,output_tokens:1}});await new Promise(r=>setTimeout(r,25));
  const finals=s.storage.kv.get<import('../src/channels/telegram-final-outbox').FinalRecord[]>('telegram_final_outbox_v1')!;
  expect(finals).toHaveLength(1);expect(finals[0]?.id).toContain('failure:');expect(finals[0]?.payload.text).toBe('Stopped. In-flight changes may still finish.');expect(JSON.stringify(finals)).not.toContain('LATE_FORBIDDEN');expect(s.storage.kv.get('conv-leaf')).toBeUndefined();
 });seen.pause=false;
});
it('success wins a later stop race without a second failure notice',async()=>{
 seen.pause=false;await setup('fence-do-final-wins',async(i,s)=>{
  const inbox=await admit(i,s,3);await (i as unknown as {drainInbox():Promise<void>}).drainInbox();const row=(await inbox.records())[0]!;
  (i as unknown as {closeRunAtomic(r:unknown,reason:string):void}).closeRunAtomic(row,'owner_stopped');
  expect((await inbox.records())[0]?.reason).toBe('final_committed');expect((await inbox.records())[0]?.state).toBe('awaiting_delivery');
  expect(s.storage.kv.get<unknown[]>('telegram_final_outbox_v1')).toHaveLength(1);
 });
});
it('deadline uses the claim clock and late completion cannot publish',async()=>{
 seen.pause=true;await setup('fence-do-deadline',async(i,s)=>{
  const inbox=await admit(i,s,4);let enter!:()=>void;const ready=new Promise<void>(r=>{enter=r;});seen.entered=enter;
  const running=(i as unknown as {drainInbox():Promise<void>}).drainInbox();await ready;
  const row=(await inbox.records())[0]!;expect(row.deadline! - row.admittedAt).toBeLessThan(151000);
  const real=Date.now;Date.now=()=>row.deadline!+1;
  try {seen.finish!({id:'expired',output_text:'LATE_DEADLINE',output:[],usage:{input_tokens:1,output_tokens:1}});await running;}
  finally {Date.now=real;}
  expect((await inbox.records())[0]?.state).toBe('quarantined');expect(s.storage.kv.get('conv-leaf')).toBeUndefined();
  const finals=s.storage.kv.get<import('../src/channels/telegram-final-outbox').FinalRecord[]>('telegram_final_outbox_v1')!;expect(finals).toHaveLength(1);expect(finals[0]?.payload.text).toContain('In-flight changes may still finish');expect(JSON.stringify(finals)).not.toContain('LATE_DEADLINE');
 });seen.pause=false;
});
