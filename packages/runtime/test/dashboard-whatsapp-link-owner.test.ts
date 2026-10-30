import {describe,it,expect,vi} from 'vitest';
import {env} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {consoleAccess} from '../src/channels/console';
import {CONTROLS_PATH} from '../src/channels/dashboard-controls';
import {CONTROL_ACTION_PATH} from '../src/channels/dashboard-control-actions';

const issued=vi.hoisted(()=>({provider:[] as string[],telegram:0,code:'ABCDEFGHJK' as string|null}));
vi.mock('../src/identity/console-auth',async load=>({...await load<typeof import('../src/identity/console-auth')>(),consoleAuth:()=>({
 issueProviderLinkCode:async(doName:string,provider:string)=>{issued.provider.push(`${doName}:${provider}`);return issued.code;},
 issueLinkCode:async()=>{issued.telegram++;return 'TELEGRAMCODE';},
 assertChannelPresence:async()=>false,saveSettings:async()=>true,listSessions:async()=>[],
})}));

const root='https://telegram-owner';
const headers=(token:string)=>({cookie:'waldo_console='+token});
const open=async(name:string)=>{
 const stub=env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
 const token=await runInDurableObject(stub,(instance,state)=>{Object.assign((instance as unknown as {env:Record<string,unknown>}).env,{TELEGRAM_BOT_TOKEN:'123:synthetic',OPENAI_API_KEY:'synthetic-key'});state.storage.kv.put('do_name',name);return consoleAccess(state.storage).grant();});
 const read=await stub.fetch(root+CONTROLS_PATH+'?view=connections',{headers:headers(token)});expect(read.status).toBe(200);
 const {csrf,revision}=await read.json() as {csrf:string;revision:string};
 const post=(request_id:string)=>stub.fetch(root+CONTROL_ACTION_PATH,{method:'POST',headers:{...headers(token),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,revision,view:'connections',action:'whatsapp.link',request_id})});
 return post;
};

describe('new console WhatsApp link',()=>{
 it('issues a WhatsApp-scoped code for this owner, never a Telegram code',async()=>{
  issued.provider.length=0;issued.telegram=0;issued.code='ABCDEFGHJK';
  const response=await (await open('wa-link-owner'))('wa-link-request-01');
  expect(response.status).toBe(200);
  const body=await response.json() as {receipt:{state:string;message:string};reveal:unknown};
  expect(body.receipt.state).toBe('recorded');expect(body.receipt.message).not.toContain('ABCDEFGHJK');
  expect(body.reveal).toEqual({kind:'link_code',value:'waldo ABCDEFGHJK'});
  expect(issued.provider).toEqual(['wa-link-owner:whatsapp']);expect(issued.telegram).toBe(0);
 });
 it('rejects honestly when no code could be issued',async()=>{
  issued.provider.length=0;issued.code=null;
  const response=await (await open('wa-link-owner-unavailable'))('wa-link-request-02');
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({receipt:{state:'rejected'}});
  expect(issued.provider).toEqual(['wa-link-owner-unavailable:whatsapp']);
 });
});
