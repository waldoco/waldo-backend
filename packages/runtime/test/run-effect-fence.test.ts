import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { TelegramOwnerInbox, OWNER_INBOX_KEY } from '../src/channels/telegram-owner-inbox';
import { artifactBook } from '../src/channels/artifacts';
const binding = { bot: '7', subject: '42', doName: 'fenced-owner' };
const deferred = <T>() => { let resolve!: (v:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; };
it('atomic closed run cannot commit or reopen, including after restart', async()=>{
 await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('fence-atomic')), async(_i,state)=>{
  let now=1000;const persist=async(t:DurableObjectTransaction,rows:unknown,due:number|null)=>{await t.put(OWNER_INBOX_KEY,rows);await t.put('due',due);};
  const book=new TelegramOwnerInbox(state.storage,persist,()=>now);
  await book.admit(binding,1,'hello');const run=(await book.claim('7:telegram:1','a','r',2000))!;
  expect(await book.commitIfLive(run, t=>{void t.put('published','first');})).toBe(true);
  expect(await book.close(run,'deadline')).toBe(true);
  expect(await book.commitIfLive(run,t=>{void t.put('published','late');})).toBe(false);
  expect(await state.storage.get('published')).toBe('first');
  const restarted=new TelegramOwnerInbox(state.storage,persist,()=>now);
  expect(await restarted.commitIfLive(run,t=>{void t.put('published','restart');})).toBe(false);
  expect(await restarted.claim(run.id,'b','new',3000)).toBeNull();
 });
});
it('deadline and revoked binding refuse atomic commits',async()=>{
 await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('fence-deadline')),async(_i,state)=>{
  let now=1000;const book=new TelegramOwnerInbox(state.storage,async(t,r,d)=>{await t.put(OWNER_INBOX_KEY,r);await t.put('due',d);},()=>now);
  await book.admit(binding,1,'x');const run=(await book.claim('7:telegram:1','a','r',2000))!;now=2000;
  expect(await book.commitIfLive(run,t=>{void t.put('bad',true);})).toBe(false);
  now=1001;await state.storage.put('telegram_unlinked',true);
  expect(await book.commitIfLive(run,t=>{void t.put('bad',true);})).toBe(false);expect(await state.storage.get('bad')).toBeUndefined();
 });
});
it('a delayed same-revision body cannot overwrite the winning artifact',async()=>{
 await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('fence-artifact-race')),async(_i,state)=>{
  const data=new Map<string,string>();const pause=deferred<void>();const entered=deferred<void>();let delay=false;
  const bodies={get:async(k:string)=>data.get(k)??null,put:async(k:string,v:string)=>{if(delay&&v==='OLD'){entered.resolve();await pause.promise;}data.set(k,v);}};
  let n=0;const book=artifactBook(state.storage.sql,bodies,{timezone:'UTC',now:()=>new Date()},()=>`id${++n}`);
  const meta=await book.create({name:'race',kind:'document',body_markdown:'base'},'test');delay=true;
  const old=book.revise({artifact_id:meta.id,expected_revision:1,body_markdown:'OLD'},'old');await entered.promise;
  const winner=await book.revise({artifact_id:meta.id,expected_revision:1,body_markdown:'NEW'},'new');expect(winner.status).toBe('ok');
  pause.resolve();expect((await old).status).toBe('conflict');expect((await book.read(meta.id,0,100))?.text).toBe('NEW');expect(data.size).toBe(3);
 });
});
it('rollback on failed durable closure preserves the live claim and blocks false closure',async()=>{
 await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('fence-close-failure')),async(_i,state)=>{
  let fail=false;const book=new TelegramOwnerInbox(state.storage,async(t,r,d)=>{await t.put(OWNER_INBOX_KEY,r);if(fail)throw new Error('durable close failed');await t.put('due',d);},()=>1000);
  await book.admit(binding,1,'x');const run=(await book.claim('7:telegram:1','a','r',2000))!;fail=true;
  await expect(book.close(run,'deadline')).rejects.toThrow('durable close failed');
  expect((await book.records())[0]).toMatchObject({state:'claimed'});expect((await book.records())[0]?.closedAt).toBeUndefined();
 });
});
it('async commit callbacks are rejected and their transaction writes roll back',async()=>{
 await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('fence-async-reject')),async(_i,state)=>{
  const book=new TelegramOwnerInbox(state.storage,async(t,r,d)=>{await t.put(OWNER_INBOX_KEY,r);await t.put('due',d);},()=>1000);
  await book.admit(binding,1,'x');const run=(await book.claim('7:telegram:1','a','r',2000))!;
  await expect(book.commitIfLive(run,async t=>{void t.put('invalid',true);})).rejects.toThrow('must be synchronous');
  expect(await state.storage.get('invalid')).toBeUndefined();
 });
});
it('a late artifact body is an orphan and cannot publish metadata after close',async()=>{
 await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('fence-artifact-expiry')),async(_i,state)=>{
  let live=true;const {ClosedRunError}=await import('../src/channels/run-effect-scope');const data=new Map<string,string>();const pause=deferred<void>();const entered=deferred<void>();
  const scope={runId:'r',attempt:'a',deadline:2000,signal:new AbortController().signal,admit(){if(!live)throw new ClosedRunError();},commit<T>(w:()=>T){if(!live)throw new ClosedRunError();return state.storage.transactionSync(w);}};
  const book=artifactBook(state.storage.sql,{get:async k=>data.get(k)??null,put:async(k,v)=>{entered.resolve();await pause.promise;data.set(k,v);}},{timezone:'UTC',now:()=>new Date()},()=> 'orphan');
  const pending=book.create({name:'late',kind:'document',body_markdown:'ORPHAN'},'fixture',scope);const caught=pending.catch(e=>e);await entered.promise;live=false;pause.resolve();
  expect(await caught).toBeInstanceOf(ClosedRunError);expect(book.list()).toEqual([]);expect(data.size).toBe(1);
 });
});
