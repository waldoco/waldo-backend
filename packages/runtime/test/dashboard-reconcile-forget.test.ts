import {env,runInDurableObject} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import {claimStore} from '../src/memory/claims';
import {TelegramFinalOutbox,FINAL_OUTBOX_KEY} from '../src/channels/telegram-final-outbox';
import {holdTopic} from './helpers/pending-topic';
it.each([false,true])('node forget cleans source-final stores at once, and the purge job retries a failed write: %s',async(fail)=>{
 const name='console-forget-reconcile-'+crypto.randomUUID();const stub=env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
 await runInDurableObject(stub,async(instance,state)=>{
  Object.assign((instance as unknown as {env:Record<string,unknown>}).env,{TELEGRAM_BOT_TOKEN:'123:synthetic',OPENAI_API_KEY:'synthetic-key'});state.storage.kv.put('do_name',name);
  const memory=claimStore(state.storage.sql,work=>state.storage.transactionSync(work));
  state.storage.sql.exec("INSERT INTO constellation_nodes(domain,label,summary,strength,status,first_seen,last_confirmed,supporting_spots) VALUES ('work','synthetic-forgotten-marker','synthetic',0.5,'active','now','now','[]')");
  const node=memory.nodes()[0]!;const outbox=new TelegramFinalOutbox(state.storage.kv);
  await outbox.enqueue({id:'mail',trace:'mail',payload:{chat_id:42,text:node.label},ownerSubject:'42',doName:name,mailFollowup:{loopId:'loop',due:'2026-10-03T10:00',sourceRef:'mail:test',timezone:'UTC',messageId:'msg'}});
  await outbox.enqueue({id:'prep',trace:'prep',payload:{chat_id:42,text:node.label},ownerSubject:'42',doName:name,calendarPrep:{eventId:'event',calendarId:'primary',connectionId:'account',start:'2026-10-04T10:00:00Z',occurrence:'2026-10-04T10:00:00Z',revision:null,sourceDigest:'synthetic-digest',timezone:'UTC'}});
  const original=state.storage.kv.put.bind(state.storage.kv);let failed=false;
  const spy=vi.spyOn(state.storage.kv,'put').mockImplementation((key,value)=>{if(fail&&!failed&&key===FINAL_OUTBOX_KEY){failed=true;throw new Error('synthetic KV failure');}return original(key,value);});
  try{
   const runtime=(instance as unknown as {setup():{act(input:{action:'node.forget',id:string,value:string}):Promise<boolean|string>}}).setup();
   expect(await runtime.act({action:'node.forget',id:String(node.id),value:''})).toBe(true);
   const job=(instance as unknown as {forgetPurgeJob():{run():Promise<{settled:number;pending:number}>}}).forgetPurgeJob();
   // The forget's own pass cleaned every store unless the write failed; the job settles what it left.
   expect(await job.run()).toEqual(fail?{settled:1,pending:0}:{settled:0,pending:0});
   const rows=new TelegramFinalOutbox(state.storage.kv).records();
   for(const id of ['prep','mail'])expect(rows.find(r=>r.id===id)!.payload.text).not.toContain(node.label);
   expect(memory.pendingTopics()).toEqual([]);
  }finally{spy.mockRestore();}
 });
});
const consoleOwner=(instance:unknown,state:DurableObjectState,name:string)=>{
 Object.assign((instance as {env:Record<string,unknown>}).env,{TELEGRAM_BOT_TOKEN:'123:synthetic',OPENAI_API_KEY:'synthetic-key'});state.storage.kv.put('do_name',name);
 const runtime=(instance as {setup():{act(input:{action:string,id:string,value:string}):Promise<boolean|string>;view(session:{token:string;csrf:string;expires:number},notice:null):Promise<{nodes:readonly {label:string}[];edges:readonly {relation:string}[]}>}}).setup();
 const job=(instance as {forgetPurgeJob():{run():Promise<{settled:number;pending:number}>}}).forgetPurgeJob();
 return {runtime,job,memory:claimStore(state.storage.sql,work=>state.storage.transactionSync(work))};
};
const pattern=(state:DurableObjectState,label:string,summary:string,support:readonly number[])=>state.storage.sql.exec("INSERT INTO constellation_nodes(domain,label,summary,strength,status,first_seen,last_confirmed,supporting_spots) VALUES ('habits',?,?,0.5,'active','now','now',?)",label,summary,JSON.stringify(support));
it('forgetting a pattern keeps the spots behind it, as the console tells the owner',async()=>{
 const name='console-node-forget-spots-'+crypto.randomUUID();
 await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)),async(instance,state)=>{
  const {runtime,job,memory}=consoleOwner(instance,state,name);
  memory.add({kind:'routine',text:'Does morning runs before work',evidence:'I run every morning before work',source:'stated',origin:'owner',source_ref:'owner, tg-1'},new Date().toISOString());
  pattern(state,'Morning runs','Runs early on weekdays',[memory.claims()[0]!.id]);
  expect(await runtime.act({action:'node.forget',id:String(memory.nodes()[0]!.id),value:''})).toBe(true);
  await job.run();
  expect(memory.nodes()).toEqual([]);
  expect(memory.allClaims().map(c=>c.text)).toEqual(['Does morning runs before work']);
  expect(memory.pendingTopics()).toEqual([]);
 });
});
it('forgetting a spot keeps another spot built from the same owner words, without those words',async()=>{
 const name='console-spot-forget-sibling-'+crypto.randomUUID();
 await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)),async(instance,state)=>{
  const {runtime,job,memory}=consoleOwner(instance,state,name);
  const quote='owner, tg-1: "I adopted Bruno last spring and he hides from storms"',at=new Date().toISOString();
  memory.add({kind:'fact',text:'Has a dog named Bruno',evidence:quote,source:'stated',origin:'owner',source_ref:'owner, tg-1'},at);
  memory.add({kind:'fact',text:'Bruno is afraid of storms',evidence:quote,source:'stated',origin:'owner',source_ref:'owner, tg-1'},at);
  const forgotten=memory.claims().find(c=>c.text==='Has a dog named Bruno')!;
  expect(await runtime.act({action:'spot.forget',id:String(forgotten.id),value:''})).toBe(true);
  await job.run();
  expect(memory.allClaims().map(c=>[c.text,c.evidence])).toEqual([['Bruno is afraid of storms','owner, tg-1: "[forgotten]"']]);
 });
});
it('the console shows the patterns and links a forget is not clearing, and leaves out the rest',async()=>{
 const name='console-graph-held-'+crypto.randomUUID();
 await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)),async(instance,state)=>{
  const {runtime,memory}=consoleOwner(instance,state,name);
  memory.add({kind:'routine',text:'Climbs on Thursdays',evidence:'climbs',source:'stated',origin:'owner',source_ref:'owner, tg-1'},new Date().toISOString());
  const support=[memory.claims()[0]!.id];
  for(const [label,summary] of [['Bluefin trips','Weekends at sea'],['Climbing','Weekly climbing'],['Bouldering','Indoor walls']])pattern(state,label!,summary!,support);
  const id=(label:string)=>memory.nodes().find(n=>n.label===label)!.id;
  state.storage.sql.exec("INSERT INTO constellation_edges(from_id,to_id,relation,strength) VALUES (?,?,'shares weekends',0.4),(?,?,'same gym',0.6)",id('Bluefin trips'),id('Climbing'),id('Climbing'),id('Bouldering'));
  holdTopic(state.storage.sql,'Bluefin',new Date().toISOString());
  const view=await runtime.view({token:'t',csrf:'t',expires:Date.now()+60_000},null);
  expect(view.nodes.map(n=>n.label).sort()).toEqual(['Bouldering','Climbing']);
  expect(view.edges.map(e=>e.relation)).toEqual(['same gym']);
 });
});
