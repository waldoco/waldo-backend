import {env} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {pinProxyIntentRoute} from '../src/connectors/proxy-intent-route';
it('durable owner intent routing resists health ordering, concurrent selection, missing account and rail drift',async()=>{
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('intent-routing'));
 await runInDurableObject(stub,async(_instance,state)=>{
  const a={id:'a',rail:'proxy' as const};const b={id:'b',rail:'proxy' as const};const intent={id:'approval:card:apply'};
  const select=(preferred:typeof a,candidates=[a,b])=>pinProxyIntentRoute(state.storage.sql,intent,'google:mail',candidates,preferred);
  expect(select(a)).toEqual(a);expect(select(b)).toEqual(a);
  expect(await Promise.all([Promise.resolve().then(()=>select(b)),Promise.resolve().then(()=>select(a))])).toEqual([a,a]);
  expect(()=>select(b,[b])).toThrow('intent_unavailable');
  expect(()=>pinProxyIntentRoute(state.storage.sql,intent,'google:mail',[{...a,rail:'local'}],undefined)).toThrow('intent_unavailable');
  expect(()=>pinProxyIntentRoute(state.storage.sql,intent,'google:calendar',[a,b],b)).toThrow('intent_conflict');
  expect(pinProxyIntentRoute(state.storage.sql,{id:'approval:next:apply'},'google:mail',[a,b],b)).toEqual(b);
  expect(pinProxyIntentRoute(state.storage.sql,{id:'approval:calendar:apply'},'google:calendar',[a,b],a)).toEqual(a);
  expect(pinProxyIntentRoute(state.storage.sql,{id:'approval:calendar:undo'},'google:calendar',[a,b],b)).toEqual(a);
  expect(pinProxyIntentRoute(state.storage.sql,{id:'approval:mcp:apply'},'mcp:google',[a,b],a)).toEqual(a);
  expect(pinProxyIntentRoute(state.storage.sql,{id:'approval:mcp:apply'},'mcp:google',[a,b],b)).toEqual(a);
 });
});
it('5001 read-only intents do not pin rows or break a later approval',async()=>{
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('intent-read-cap'));
 await runInDurableObject(stub,async(_instance,state)=>{
  const a={id:'a',rail:'proxy' as const};const b={id:'b',rail:'proxy' as const};
  for(let i=0;i<5001;i++)expect(pinProxyIntentRoute(state.storage.sql,{id:`mcpread:${i}`,readOnly:true},'mcp:google',[a,b],a)).toEqual(a);
  expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='proxy_intent_routes'").toArray().length===0||state.storage.sql.exec<{n:number}>('SELECT count(*) AS n FROM proxy_intent_routes').toArray()[0]!.n===0).toBe(true);
  expect(pinProxyIntentRoute(state.storage.sql,{id:'approval:after:apply'},'mcp:google',[a,b],b)).toEqual(b);
  expect(pinProxyIntentRoute(state.storage.sql,{id:'approval:after:apply'},'mcp:google',[a,b],a)).toEqual(b);
 });
});
it('readOnly is honored only for mcpread: ids and ignores requireRoute',async()=>{
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('intent-read-prefix'));
 await runInDurableObject(stub,async(_instance,state)=>{
  const a={id:'a',rail:'proxy' as const};const b={id:'b',rail:'proxy' as const};
  expect(pinProxyIntentRoute(state.storage.sql,{id:'mcpread:x',readOnly:true,requireRoute:true},'mcp:google',[a,b],a)).toEqual(a);
  expect(pinProxyIntentRoute(state.storage.sql,{id:'approval:y:apply',readOnly:true},'mcp:google',[a,b],a)).toEqual(a);
  expect(pinProxyIntentRoute(state.storage.sql,{id:'approval:y:apply',readOnly:true},'mcp:google',[a,b],b)).toEqual(a);
 });
});
import {approvalDesk} from '../src/channels/approvals';
import type {GoogleClient} from '../src/connectors/google';
it('calendar proposal read, apply and undo all retain account A after independent health reorder',async()=>{
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('intent-calendar-lineage'));
 await runInDurableObject(stub,async(_instance,state)=>{
  const a={id:'a',rail:'proxy' as const};const b={id:'b',rail:'proxy' as const};let preferred=a;const calls:string[]=[];let ids=0;
  const clients=(account:string)=>({event:async()=>{calls.push(`read:${account}`);return{id:'event',etag:'same',title:'fixture',start:'2026-10-01T00:00:00Z',end:'2026-10-01T01:00:00Z'};},moveEvent:async()=>{calls.push(`move:${account}`);},createEvent:async()=>{calls.push(`create:${account}`);return{id:'event'};},cancelEvent:async()=>{calls.push(`cancel:${account}`);}} as unknown as GoogleClient);
  const desk=approvalDesk(state.storage.sql,{call:async()=>({message_id:1}),owner:42,google:async(intent,feature)=>{const route=pinProxyIntentRoute(state.storage.sql,intent,`google:${feature??'calendar'}`,[a,b],preferred);return route?clients(route.id):null;},newId:()=>String(++ids),now:()=>1000,timezone:'UTC',log:()=>{}});
  const move=await desk.propose({action:'move',event_id:'event',title:'fixture',start:'2026-10-01T02:00:00Z',end:'2026-10-01T03:00:00Z',reason:'fixture'} as never);
  preferred=b;expect((await desk.decide(move,'a','fixture')).toast).toBe('Done');expect(calls).toContain('move:a');expect(calls).not.toContain('move:b');
  preferred=a;const create=await desk.propose({action:'create',title:'fixture',start:'2026-10-01T02:00:00Z',end:'2026-10-01T03:00:00Z',reason:'fixture'} as never);
  await desk.decide(create,'a','fixture');preferred=b;await desk.decide(create,'u','fixture');expect(calls).toContain('create:a');expect(calls).toContain('cancel:a');expect(calls).not.toContain('cancel:b');
 });
});
it('lost send cannot fall over to B when A disappears; desk keeps truthful unknown',async()=>{
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('intent-email-lineage'));
 await runInDurableObject(stub,async(_instance,state)=>{
  const a={id:'a',rail:'proxy' as const};const b={id:'b',rail:'proxy' as const};let candidates=[a,b];let preferred=a;let effects=0;let release:()=>void=()=>{};let began:()=>void=()=>{};
  const started=new Promise<void>(r=>{began=r;});const gate=new Promise<void>(r=>{release=r;});
  const client={sendRaw:async()=>{effects++;began();await gate;throw new ProxyIntentError('intent_pending');}} as unknown as GoogleClient;
  const desk=approvalDesk(state.storage.sql,{call:async()=>({message_id:1}),owner:42,google:async(intent)=>{const route=pinProxyIntentRoute(state.storage.sql,intent,'google:mail',candidates,preferred);return route?client:null;},newId:()=>String(1),now:()=>1000,timezone:'UTC',log:()=>{}});
  const raw='fixture';const id=await desk.proposeSendEmail({to:['fictional@test.invalid'],subject:'fixture',body:'fixture',message_id:'fixture',raw,digest:await sha256Hex(raw)});
  const first=desk.decide(id,'a','fixture');await started;candidates=[b];preferred=b;
  const repeat=await desk.decide(id,'a','fixture');expect(repeat.toast).toBe('Outcome unknown');expect(repeat.message).not.toContain('Nothing was delivered');release();await first;expect(effects).toBe(1);
 });
});
import {ProxyIntentError} from '../src/connectors/proxy-intent';
import {sha256Hex} from '../src/connectors/google';
