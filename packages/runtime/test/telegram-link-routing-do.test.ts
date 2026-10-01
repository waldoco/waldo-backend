import{env,runInDurableObject}from'cloudflare:test';import{expect,it,vi}from'vitest';import type{TelegramOwnerDO}from'../src/channels/telegram-owner-do';import{TelegramLinkInbox,LINK_MODE,LINK_ROWS}from'../src/channels/telegram-link-inbox';
it('actual routing object persists mode/wake and blocks console/grant/owner routes',async()=>{
 const bot=env.TELEGRAM_BOT_TOKEN!.split(':')[0]!;const subject='777777';const name=`telegram-link:${bot}:${subject}`;
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
 await runInDurableObject(stub,async(instance,state)=>{
  const d={bot,subject,name,id:1,digest:'d'.repeat(64),hash:'a'.repeat(64)};
  const req=()=>new Request('https://route/enqueue-link',{method:'POST',headers:{'x-waldo-inbox-secret':env.TELEGRAM_WEBHOOK_SECRET!},body:JSON.stringify(d)});
  expect((await(instance as TelegramOwnerDO).fetch(req())).status).toBe(200);expect(await state.storage.get(LINK_MODE)).toEqual({bot,subject,name});expect(await state.storage.getAlarm()).toBeTypeOf('number');
  expect((await(instance as TelegramOwnerDO).fetch(req())).status).toBe(200);expect(await state.storage.get<unknown[]>(LINK_ROWS)).toHaveLength(1);
  for(const path of ['/console','/grant-console','/enqueue','/'])expect((await(instance as TelegramOwnerDO).fetch(new Request('https://route'+path))).status).toBe(404);
  expect(await state.storage.get('telegram_subject')).toBeUndefined();expect(await state.storage.get('do_name')).toBeUndefined();expect(await state.storage.get('webhook_updates')).toBeUndefined();
  const store=new TelegramLinkInbox(state.storage);await store.begin(1);const reconstructed=new TelegramLinkInbox(state.storage);expect((await reconstructed.records())[0]?.state).toBe('attempting');expect((await reconstructed.records())[0]?.hash).toBeUndefined();
  await state.storage.deleteAlarm();
 });
});

const observed=vi.hoisted(()=>({redeem:0,sends:[]as unknown[]}));
vi.mock('../src/identity/owner-directory',async load=>({...await load<typeof import('../src/identity/owner-directory')>(),ownerDirectory:()=>({byPresence:async()=>null,redeemHashed:async()=>{observed.redeem++;return{kind:'rejected'}}})}));
vi.mock('../src/channels/telegram-api',async load=>({...await load<typeof import('../src/channels/telegram-api')>(),createTelegramCaller:()=>async(method:string,payload:any)=>{if(method!=='sendMessage')throw Error('owner setup provider call');observed.sends.push(payload);return{message_id:1,chat:{id:payload.chat_id}}}}));
it('reconstructed routing mode alarm uses frozen generic transport without owner setup or second redemption',async()=>{
 const bot=env.TELEGRAM_BOT_TOKEN!.split(':')[0]!;const subject='888888';const name=`telegram-link:${bot}:${subject}`;const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
 await runInDurableObject(stub,async(instance,state)=>{
  const inbox=new TelegramLinkInbox(state.storage);await inbox.admit({bot,subject,name},2,'d'.repeat(64),'a'.repeat(64));
  await(instance as TelegramOwnerDO).alarm();expect(observed.redeem).toBe(1);await new Promise(r=>setTimeout(r,300));await(instance as TelegramOwnerDO).alarm();expect(observed.sends).toHaveLength(1);expect(observed.sends[0]).toMatchObject({chat_id:Number(subject),text:'That code did not work. Get a new one from your console.'});
  await(instance as TelegramOwnerDO).alarm();expect(observed.redeem).toBe(1);expect(observed.sends).toHaveLength(1);expect((await inbox.records())[0]?.hash).toBeUndefined();
  expect(await state.storage.get('do_name')).toBeUndefined();expect(await state.storage.get('webhook_updates')).toBeUndefined();expect(await state.storage.get('telegram_subject')).toBeUndefined();
  await state.storage.deleteAlarm();
 });
});
it('actual storage freeze-second-transaction cut keeps hash scrubbed and restart never redeems',async()=>{
 const bot=env.TELEGRAM_BOT_TOKEN!.split(':')[0]!;const subject='999991';const name=`telegram-link:${bot}:${subject}`;const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
 await runInDurableObject(stub,async(instance,state)=>{
  const inbox=new TelegramLinkInbox(state.storage);await inbox.admit({bot,subject,name},3,'d'.repeat(64),'a'.repeat(64));await inbox.begin(3);
  let count=0;const broken={get:state.storage.get.bind(state.storage),transaction:async(work:any)=>{if(++count===2)throw Error('second freeze storage cut');return state.storage.transaction(work)}}as unknown as DurableObjectStorage;
  await expect(new TelegramLinkInbox(broken).freeze(3,'must not persist')).rejects.toThrow('second freeze');expect((await inbox.records())[0]?.hash).toBeUndefined();expect((await inbox.records())[0]?.state).toBe('attempting');
  const before=observed.redeem;await(instance as TelegramOwnerDO).alarm();expect(observed.redeem).toBe(before);expect((await inbox.records())[0]?.state).toBe('completed');
  expect(JSON.stringify(state.storage.kv.get('telegram_final_outbox_v1'))).toContain('could not be confirmed');
  await state.storage.deleteAlarm();
 });
});
it('real persisted attempts representing committed/lost RPC and crashed-before-RPC both recover conservatively',async()=>{
 const bot=env.TELEGRAM_BOT_TOKEN!.split(':')[0]!;const subject='999992';const name=`telegram-link:${bot}:${subject}`;const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
 await runInDurableObject(stub,async(instance,state)=>{
  const inbox=new TelegramLinkInbox(state.storage);for(const id of [4,5]){await inbox.admit({bot,subject,name},id,String(id),'a'.repeat(64));await inbox.begin(id);}
  const before=observed.redeem;await(instance as TelegramOwnerDO).alarm();await(instance as TelegramOwnerDO).alarm();expect(observed.redeem).toBe(before);expect((await inbox.records()).every(r=>r.hash===undefined&&r.state==='completed')).toBe(true);
  const finals=state.storage.kv.get<any[]>('telegram_final_outbox_v1')!;expect(finals).toHaveLength(2);expect(finals.every(r=>r.payload.text.includes('could not be confirmed'))).toBe(true);await state.storage.deleteAlarm();
 });
});
it('expired frozen reply and bot replacement never send or redeem',async()=>{
 const bot=env.TELEGRAM_BOT_TOKEN!.split(':')[0]!;const subject='999993';const name=`telegram-link:${bot}:${subject}`;const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
 await runInDurableObject(stub,async(instance,state)=>{
  const inbox=new TelegramLinkInbox(state.storage);await inbox.admit({bot,subject,name},6,'d'.repeat(64),'a'.repeat(64));await inbox.freeze(6,'generic expired');
  const rows=await inbox.records();rows[0]!.frozenAt=Date.now()-6*60_000;await state.storage.put(LINK_ROWS,rows);
  const sent=observed.sends.length;const redeem=observed.redeem;await(instance as TelegramOwnerDO).alarm();await new Promise(r=>setTimeout(r,300));await(instance as TelegramOwnerDO).alarm();expect(observed.sends).toHaveLength(sent);expect(observed.redeem).toBe(redeem);
  await state.storage.put(LINK_MODE,{bot:'8',subject,name});await inbox.admit({bot:'8',subject,name},7,'d7','b'.repeat(64));await(instance as TelegramOwnerDO).alarm();expect(observed.redeem).toBe(redeem);expect(observed.sends).toHaveLength(sent);expect((await inbox.records()).find(r=>r.id===7)?.hash).toBeUndefined();await state.storage.deleteAlarm();
 });
});
it('saturated outbox still drains and transfers a frozen receipt without repeating redemption',async()=>{
 const bot=env.TELEGRAM_BOT_TOKEN!.split(':')[0]!;const subject='999994';const name=`telegram-link:${bot}:${subject}`;const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
 await runInDurableObject(stub,async(instance,state)=>{
  const inbox=new TelegramLinkInbox(state.storage);await inbox.admit({bot,subject,name},8,'d8','a'.repeat(64));await inbox.freeze(8,'frozen retained');
  const now=Date.now();await state.storage.put('telegram_final_outbox_v1',Array.from({length:256},(_,i)=>({id:'old'+i,trace:'fixture',payload:{chat_id:Number(subject),text:'old generic'},digest:'d'+i,bot,ownerSubject:subject,doName:name,status:'pending',dueAt:now-1,createdAt:now,attempts:0})));
  const sent=observed.sends.length;const redeem=observed.redeem;await(instance as TelegramOwnerDO).alarm();expect(observed.sends).toHaveLength(sent+1);expect(observed.redeem).toBe(redeem);expect((await inbox.records())[0]?.state).toBe('completed');expect(state.storage.kv.get<any[]>('telegram_final_outbox_v1')!.some(r=>r.payload.text==='frozen retained')).toBe(true);expect(await state.storage.getAlarm()).toBeTypeOf('number');await state.storage.deleteAlarm();
 });
});
