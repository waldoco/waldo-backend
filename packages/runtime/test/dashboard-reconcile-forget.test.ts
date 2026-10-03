import {env,runInDurableObject} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import {claimStore} from '../src/memory/claims';
import {TelegramFinalOutbox,FINAL_OUTBOX_KEY} from '../src/channels/telegram-final-outbox';
it.each([false,true])('node forget cleans source-final stores and reports write failure: %s',async(fail)=>{
 const name='console-forget-reconcile-'+crypto.randomUUID();const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
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
   expect(await runtime.act({action:'node.forget',id:String(node.id),value:''})).toBe(fail?'node.forget.incomplete':true);
   const rows=new TelegramFinalOutbox(state.storage.kv).records();expect(rows.find(r=>r.id==='prep')!.payload.text).not.toContain(node.label);
   if(!fail)expect(rows.find(r=>r.id==='mail')!.payload.text).not.toContain(node.label);
  }finally{spy.mockRestore();}
 });
});
