import {env} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import type {GoogleClient} from '../src/connectors/google';
const fixture=vi.hoisted(()=>({tools:[] as any[],messages:[] as string[],writes:0,event:null as any,lose:false,accounts:[] as string[]}));
vi.mock('../src/connectors/google',async load=>{const original=await load<typeof import('../src/connectors/google')>();return {...original,googleClient:(_app:unknown,_tokens:unknown,_fetch:unknown,_health:unknown,account:any)=>({account,
 event:async()=>{fixture.accounts.push(account.connection_id);if(!fixture.event)throw new original.GoogleError(410,'deleted');return fixture.event;},
 createEvent:async(input:any)=>{fixture.writes++;fixture.accounts.push(account.connection_id);fixture.event={...input,etag:'v1',all_day:false};if(fixture.lose)throw new Error('response lost');return fixture.event;},
 cancelEvent:async(_id:string,match?:string)=>{if(match!==fixture.event.etag)throw new original.GoogleError(412,'edited');fixture.writes++;fixture.event=null;},
 } as unknown as GoogleClient)};});
vi.mock('../src/channels/telegram-api',async load=>{const original=await load<typeof import('../src/channels/telegram-api')>();return {...original,createTelegramCaller:()=>async(method:string,payload:any)=>{if(method==='sendMessage')fixture.messages.push(payload.text);return {message_id:fixture.messages.length+1,chat:{id:payload.chat_id??7}};}};});
vi.mock('../src/channels/telegram-turn',async load=>{const original=await load<typeof import('../src/channels/telegram-turn')>();return {...original,createTelegramResponder:(...args:Parameters<typeof original.createTelegramResponder>)=>{fixture.tools=args[6] as any[];return original.createTelegramResponder(...args);}};});
const {TelegramOwnerDO}=await import('../src/channels/telegram-owner-do');
it.each(['confirmed','lost-response','revoked-scope','disconnected'] as const)('registered owner calendar handler, authenticated callback and ledger preserve %s custody',async mode=>{
 await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`calendar-action-${mode}`)),async(_instance,state)=>{
  fixture.tools=[];fixture.messages=[];fixture.writes=0;fixture.event=null;fixture.lose=mode==='lost-response';fixture.accounts=[];
  const name=`calendar-action-${mode}`,account={id:'local:owner@example.test',email:'owner@example.test',refresh_token:'fictional',scopes:['https://www.googleapis.com/auth/calendar.events']};
  state.storage.kv.put('do_name',name);state.storage.kv.put('telegram_subject','7');await state.storage.put('google:accounts',[account]);await state.storage.put('origin','https://fixture.invalid');
  const config={...env,WALDO_OWNER_TELEGRAM_ID:'7',WALDO_OWNER_TIMEZONE:'UTC',TELEGRAM_BOT_TOKEN:'7:fictional',OPENAI_API_KEY:'fictional',GOOGLE_CLIENT_ID:'fictional',GOOGLE_CLIENT_SECRET:'fictional'};
  let owner=new TelegramOwnerDO(state,config);let seq=1;
  const incoming=async(update:object)=>{expect((await owner.fetch(new Request('https://owner.invalid/turn',{method:'POST',body:JSON.stringify({update_id:seq++,...update})}))).status).toBe(200);};
  const ledger=()=>incoming({message:{message_id:seq,from:{id:7,is_bot:false},chat:{id:7,type:'private'},text:'/ledger'}});
  await ledger();
  const handler=fixture.tools.find(t=>t.name==='propose_calendar_change');expect(handler).toBeDefined();
  const result=await handler.handle({action:'create',connection_id:account.id,title:'Walk',start:'2030-01-01T12:00:00Z',end:'2030-01-01T13:00:00Z',reason:'Make time'});
  expect(result.ok).toBe(true);const id=result.data.proposal_id;expect(fixture.writes).toBe(0);
  if(mode==='revoked-scope'||mode==='disconnected'){
   await state.storage.put('google:accounts',[...(mode==='revoked-scope'?[{...account,scopes:[]}]:[]),{...account,id:'local:other@example.test',email:'other@example.test'}]);
  }
  const tap=(subject:number)=>incoming({callback_query:{id:`tap-${seq}`,from:{id:subject,is_bot:false},data:`a:${id}`,message:{message_id:1,chat:{id:7,type:'private'}}}});
  await tap(99);expect(fixture.writes).toBe(0);await tap(7);
  if(mode==='revoked-scope'||mode==='disconnected'){expect(fixture.writes).toBe(0);expect(fixture.messages.some(m=>m.startsWith('Done:'))).toBe(false);return;}
  expect(fixture.writes).toBe(1);
  owner=new TelegramOwnerDO(state,config);await ledger();await tap(7);expect(fixture.writes).toBe(1);
  expect(fixture.accounts.every(id=>id===account.id)).toBe(true);expect(fixture.messages.some(m=>m.startsWith('Done:'))).toBe(true);
  fixture.event={...fixture.event,etag:'owner-edited',title:'Owner edit'};
  await incoming({callback_query:{id:'undo',from:{id:7,is_bot:false},data:`u:${id}`}});expect(fixture.writes).toBe(1);expect(fixture.event.title).toBe('Owner edit');
 });
});
