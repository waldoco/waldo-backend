import {describe,it,expect,vi,beforeEach} from 'vitest';
import {env} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {consoleAccess,CONSOLE_ACTION_PATH} from '../src/channels/console';
import {CONTROLS_PATH} from '../src/channels/dashboard-controls';
import {CONTROL_ACTION_PATH} from '../src/channels/dashboard-control-actions';

// A fake owner directory: one WhatsApp presence per owner, the shape unlink_presence and presence_hint read.
const directory=vi.hoisted(()=>({linked:new Map<string,boolean>(),unavailable:new Set<string>(),refuse:new Set<string>(),unlinked:[] as string[],asserted:0}));
vi.mock('../src/identity/console-auth',async load=>({...await load<typeof import('../src/identity/console-auth')>(),consoleAuth:()=>({
 whatsAppHandleHint:async(doName:string)=>{if(directory.unavailable.has(doName))throw new Error('directory down');return directory.linked.get(doName)?'1111':null;},
 unlinkWhatsApp:async(doName:string)=>{directory.unlinked.push(doName);if(directory.refuse.has(doName)||!directory.linked.get(doName))return false;directory.linked.set(doName,false);return true;},
 issueLinkCode:async()=>null,assertChannelPresence:async(doName:string)=>{directory.asserted++;return directory.linked.get(doName)===true;},saveSettings:async()=>true,listSessions:async()=>[],
})}));

const root='https://telegram-owner';
const stubFor=(name:string)=>env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
const open=async(name:string,subject?:string)=>{
 const stub=stubFor(name);
 const token=await runInDurableObject(stub,(instance,state)=>{
  Object.assign((instance as unknown as {env:Record<string,unknown>}).env,{TELEGRAM_BOT_TOKEN:'123:synthetic',OPENAI_API_KEY:'synthetic-key',WHATSAPP_ACCESS_TOKEN:'synthetic-wa',WHATSAPP_PHONE_NUMBER_ID:'synthetic-phone'});
  state.storage.kv.put('do_name',name);if(subject)state.storage.kv.put('whatsapp_subject',subject);
  return consoleAccess(state.storage).grant();
 });
 const cookie={cookie:'waldo_console='+token};
 const read=async()=>{const r=await stub.fetch(root+CONTROLS_PATH+'?view=connections',{headers:cookie});expect(r.status).toBe(200);return await r.json() as {csrf:string;revision:string;data:{channels?:{channel:string;state:string}[]}};};
 const unlink=async(request_id:string)=>{const {csrf,revision}=await read();return stub.fetch(root+CONTROL_ACTION_PATH,{method:'POST',headers:{...cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,revision,view:'connections',action:'whatsapp.unlink',request_id})});};
 const classic=async()=>{const {csrf}=await read();return stub.fetch(root+CONSOLE_ACTION_PATH,{method:'POST',headers:{...cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,action:'whatsapp.unlink'}),redirect:'manual'});};
 const bound=()=>runInDurableObject(stub,(_i,state)=>state.storage.kv.get<string>('whatsapp_subject'));
 // One WhatsApp send through the owner runtime's gated caller. Callers hold one fetch mock for the whole test:
 // a cached runtime keeps the fetch it was built with, so a mock restored in between would let it reach the network.
 const send=()=>runInDurableObject(stub,async instance=>{await (instance as unknown as {setup(channel:string):{call(method:string,body:object):Promise<unknown>}}).setup('whatsapp').call('sendMessage',{chat_id:0,text:'synthetic'});});
 // One inbound text through the real admit path, which is what opens WhatsApp's 24-hour service window.
 // The turn it would start is stubbed out; the admission record and window bookkeeping still run.
 const inbound=(sender:string)=>runInDurableObject(stub,async instance=>{
  const live=instance as unknown as {turn():Promise<void>;whatsappInflight:Set<Promise<void>>};
  const turn=vi.spyOn(live,'turn').mockImplementation(async()=>undefined);
  try{
   const response=await instance.fetch(new Request(root+'/whatsapp-admit',{method:'POST',headers:{'x-waldo-whatsapp-subject':sender},
    body:JSON.stringify({messages:[{from:sender,id:'wamid.'+crypto.randomUUID(),timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'synthetic'}}]})}));
   expect(response.status).toBe(200);await Promise.all([...live.whatsappInflight]);
  }finally{turn.mockRestore();}
 });
 // Admission with no messages binds the subject without running a turn.
 const admit=(sender:string)=>stub.fetch(root+'/whatsapp-admit',{method:'POST',headers:{'x-waldo-whatsapp-subject':sender},body:JSON.stringify({messages:[]})});
 return {read,unlink,classic,bound,admit,send,inbound};
};
const whatsapp=(data:{channels?:{channel:string;state:string}[]})=>data.channels?.find(c=>c.channel==='whatsapp');

beforeEach(()=>{directory.linked.clear();directory.unavailable.clear();directory.refuse.clear();directory.unlinked.length=0;directory.asserted=0;});

describe('new console WhatsApp unlink',()=>{
 it('shows the link state from the directory, and unknown when the directory cannot answer',async()=>{
  directory.linked.set('wa-state-linked',true);directory.linked.set('wa-state-unlinked',false);directory.unavailable.add('wa-state-unknown');
  expect(whatsapp((await (await open('wa-state-linked','15550001111')).read()).data)).toEqual({channel:'whatsapp',state:'linked',masked_label:'Your WhatsApp'});
  expect(whatsapp((await (await open('wa-state-unlinked')).read()).data)).toEqual({channel:'whatsapp',state:'unlinked',masked_label:null});
  expect(whatsapp((await (await open('wa-state-unknown')).read()).data)).toBeUndefined();
 });
 it('unlinks this owner only, clears the bound sender, and lets a new number bind',async()=>{
  directory.linked.set('wa-unlink-a',true);directory.linked.set('wa-unlink-b',true);
  const a=await open('wa-unlink-a','15550001111'),b=await open('wa-unlink-b','15550002222');
  const response=await a.unlink('wa-unlink-request-01');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({receipt:{state:'recorded'}});
  expect(directory.unlinked).toEqual(['wa-unlink-a']);
  expect(await a.bound()).toBeUndefined();
  expect(whatsapp((await a.read()).data)?.state).toBe('unlinked');
  expect(await b.bound()).toBe('15550002222');expect(directory.linked.get('wa-unlink-b')).toBe(true);
  expect((await a.admit('15550003333')).status).toBe(200);
  expect(await a.bound()).toBe('15550003333');
 });
 it('stops sends to the old number without asking the directory once the bound sender is cleared',async()=>{
  directory.linked.set('wa-unlink-send',true);
  const owner=await open('wa-unlink-send','15550007777');
  const net=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({messages:[{id:'wamid.out'}]}));
  const sends=()=>net.mock.calls.filter(([input])=>String(input instanceof Request?input.url:input).endsWith('/messages')).length;
  try{
   await owner.inbound('15550007777');
   const asked=directory.asserted,before=sends();
   await owner.send();expect(sends()-before).toBe(1);expect(directory.asserted).toBe(asked+1);
   expect((await owner.unlink('wa-unlink-request-03')).status).toBe(200);
   await owner.send();expect(sends()-before).toBe(1);expect(directory.asserted).toBe(asked+1);
  }finally{net.mockRestore();}
 });
 it('refuses to unlink when WhatsApp is not linked or its state is unknown',async()=>{
  directory.linked.set('wa-refuse-unlinked',false);directory.unavailable.add('wa-refuse-unknown');
  for(const name of ['wa-refuse-unlinked','wa-refuse-unknown']){
   const owner=await open(name,'15550004444');
   const response=await owner.unlink('wa-refuse-request-01');
   expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'no_longer_eligible'});
   expect(await owner.bound()).toBe('15550004444');
  }
  expect(directory.unlinked).toEqual([]);
 });
 it('keeps the bound sender when the directory does not confirm the unlink',async()=>{
  directory.linked.set('wa-unlink-refused',true);directory.refuse.add('wa-unlink-refused');
  const owner=await open('wa-unlink-refused','15550005555');
  const response=await owner.unlink('wa-unlink-request-02');
  expect(response.status).toBe(409);expect(await response.json()).toMatchObject({receipt:{state:'rejected'}});
  expect(await owner.bound()).toBe('15550005555');
 });
 it('is never applied from the classic console',async()=>{
  directory.linked.set('wa-unlink-classic',true);
  const owner=await open('wa-unlink-classic','15550006666');
  const response=await owner.classic();
  expect(response.status).toBe(303);expect(response.headers.get('location')).toContain('m=invalid');
  expect(directory.unlinked).toEqual([]);expect(await owner.bound()).toBe('15550006666');
 });
});
