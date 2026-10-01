import{env,runInDurableObject}from'cloudflare:test';import{expect,it}from'vitest';import type{TelegramOwnerDO}from'../src/channels/telegram-owner-do';import{TelegramLinkInbox,LINK_MODE,LINK_ROWS}from'../src/channels/telegram-link-inbox';
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
