import {env,runInDurableObject} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import {TelegramOwnerDO} from '../src/channels/telegram-owner-do';
vi.mock('../src/channels/telegram-api',async load=>({...await load<typeof import('../src/channels/telegram-api')>(),createTelegramCaller:()=>async(method:string)=>method==='getMe'?{username:'fictional_bot'}:true}));
import {consoleAccess,CONSOLE_COOKIE} from '../src/channels/console';
it('authenticated console has a dedicated non-minting handoff status route',async()=>{
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`handoff-console-${crypto.randomUUID()}`));
 const url='https://fixture.invalid/console/browser-handoff';
 expect((await stub.fetch(url)).status).toBe(401);
 const token=await runInDurableObject(stub,async(_instance,state)=>consoleAccess(state.storage).grant());
 const response=await runInDurableObject(stub,async(_instance,state)=>{state.storage.kv.put('do_name','fictional-owner');state.storage.kv.put('chat_id',1);return new TelegramOwnerDO(state,{...env,TELEGRAM_BOT_TOKEN:'12345:fictional',OPENAI_API_KEY:'fictional-key',TELEGRAM_WEBHOOK_SECRET:'fictional-secret'}).fetch(new Request(url,{headers:{cookie:`${CONSOLE_COOKIE}=${token}`}}));});
 expect(response.status).toBe(409);expect(response.headers.get('cache-control')).toContain('no-store');
 expect(await response.text()).not.toContain('live.browser.run');
});
