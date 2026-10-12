import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';

// The old fixture trusted an arbitrary do-name header. Real serving/restart proof
// now lives in app-basic-serving with signed account/session and physical routing.
it('unsigned app calls cannot boot or rebind an owner runtime', async () => {
  const name='app-chat-denial',stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(stub,async(_instance,state)=>{
    const owner=new TelegramOwnerDO(state,{...env,TELEGRAM_BOT_TOKEN:undefined,OPENAI_API_KEY:undefined});
    const request=(path:string,body?:object)=>new Request(`https://telegram-owner/app/v1${path}`,{method:body?'POST':'GET',headers:{'x-waldo-do-name':name,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    expect((await owner.fetch(request('/chat/main/messages',{client_message_id:'client-message-0001',text:'hello'}))).status).toBe(403);
    expect((await owner.fetch(request('/chat/main'))).status).toBe(403);
    expect(state.storage.kv.get('do_name')).toBeUndefined();
    expect(state.storage.kv.get('app_subject')).toBeUndefined();
    expect(state.storage.kv.get('app_seq')).toBeUndefined();
    expect([...state.storage.kv.list({prefix:'app:inbox-record:'})]).toHaveLength(0);
    (owner as any).ownerBrowser.stop();await (owner as any).ownerBrowser.maintain();await state.storage.deleteAlarm();
  });
});
