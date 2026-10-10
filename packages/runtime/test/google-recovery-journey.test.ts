import { expect, it } from 'vitest';
import { googleClient } from '../src/connectors/google';

const app = { clientId: 'synthetic', clientSecret: 'synthetic', redirectUri: 'https://example.invalid' };
it('provider double: requires exact SENT metadata and intended thread rather than the first search hit', async () => {
  const reads: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); reads.push(url.pathname);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic' });
    if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'wrong' }, { id: 'exact' }] });
    return Response.json({ id: url.pathname.endsWith('/exact') ? 'exact' : 'wrong', threadId: 'intended', labelIds: ['SENT'], payload: { headers: [{ name: 'Message-ID', value: url.pathname.endsWith('/exact') ? '<frozen@example.invalid>' : '<other@example.invalid>' }] } });
  }) as typeof fetch;
  const client = googleClient(app, { refresh_token: 'synthetic' }, fetcher);
  expect(await client.findSentByMessageId('<frozen@example.invalid>', 'intended')).toMatchObject({ message_id: 'exact', thread_id: 'intended', rfc822_message_id: '<frozen@example.invalid>', label_ids: ['SENT'] });
  expect(reads.filter(p => /messages\//.test(p))).toHaveLength(2);
});

import { DatabaseSync } from 'node:sqlite';
import { approvalDesk, type EmailSendProposal } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { googleHandlers } from '../src/tools/live/google';
import { sendEmailArgsSchema, proposeCalendarChangeArgsSchema } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

// Labelled provider double: synthetic account + in-memory source of record. No network.
const journey = () => {
  const db = new DatabaseSync(':memory:');
  const sql = {exec(query: string, ...args: unknown[]) {
    const rows = db.prepare(query).all(...args as never[]);
    return {toArray:()=>rows,one:()=>rows[0], [Symbol.iterator]:()=>rows[Symbol.iterator]()};
  }} as unknown as SqlStorage;
  const kv = new Map<string, unknown>();
  const storage = {kv:{get:(key:string)=>structuredClone(kv.get(key)),put:(key:string,value:unknown)=>kv.set(key,structuredClone(value)),list:({prefix}:{prefix:string})=>new Map([...kv].filter(([k])=>k.startsWith(prefix)))},transactionSync:<T>(fn:()=>T)=>fn()} as unknown as DurableObjectStorage;
  let at = Date.parse('2026-10-10T08:00:00Z');
  const provider = {
    sent: undefined as {id:string;threadId:string;labelIds:string[];payload:{headers:{name:string;value:string}[]}} | undefined,
    event: {id:'event',summary:'Synthetic event',start:{date:'2026-10-11'} as Record<string,string>,end:{date:'2026-10-12'} as Record<string,string>,etag:'v1',status:'confirmed',extendedProperties:{private:{unrelated:'preserved'} as Record<string,string>}},
    readFail:false, loseSend:false, loseCalendar:false, wrongAccount:false,
    parentMessageId:'<parent@example.invalid>', references:'<root@example.invalid>', parentSubject:'Synthetic topic',
    writes: [] as {method:string;body:Record<string,any>;match:string|null}[], reads: [] as string[],
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if(url.hostname==='oauth2.googleapis.com') return Response.json({access_token:'synthetic'});
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method=init?.method??'GET';
    if(method!=='GET') provider.writes.push({method,body,match:new Headers(init?.headers).get('if-match')});
    else provider.reads.push(url.pathname);
    if(url.pathname.includes('/threads/')) return Response.json({id:'thread',messages:[{id:'parent',threadId:'thread',internalDate:'1791619200000',payload:{headers:[{name:'Subject',value:provider.parentSubject},{name:'Message-ID',value:provider.parentMessageId},{name:'References',value:provider.references}]}}]});
    if(url.pathname.endsWith('/messages/send')) {
      const mime=atob(body.raw.replace(/-/g,'+').replace(/_/g,'/'));
      provider.sent={id:'sent',threadId:body.threadId??'new-thread',labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:/Message-ID: ([^\r]+)/.exec(mime)![1]!}]}};
      if(provider.loseSend) { provider.readFail=true; throw Error('synthetic lost send response'); }
      return Response.json({id:'sent',threadId:provider.sent.threadId});
    }
    if(url.pathname.includes('/messages')) {
      if(provider.readFail) throw Error('synthetic unavailable metadata');
      return Response.json(url.pathname.endsWith('/messages') ? {messages:provider.sent?[{id:'sent'}]:[]} : provider.sent);
    }
    if(url.pathname.includes('/events')) {
      if(method==='GET') { if(provider.readFail) throw Error('synthetic unavailable calendar readback'); return Response.json(provider.event); }
      const match=new Headers(init?.headers).get('if-match');
      if(match && match!==provider.event.etag) return Response.json({error:{message:'synthetic stale version'}},{status:412});
      const endpoint=(value:Record<string,string>)=>Object.fromEntries(Object.entries(value).filter(([,v])=>v!==null));
      provider.event={...provider.event,...body,start:body.start?endpoint(body.start):provider.event.start,end:body.end?endpoint(body.end):provider.event.end,extendedProperties:{private:{...provider.event.extendedProperties.private,...body.extendedProperties?.private}},etag:`v${Number(provider.event.etag.slice(1))+1}`};
      if(provider.loseCalendar) {provider.readFail=true;throw Error('synthetic lost Calendar response');}
      return Response.json(provider.event);
    }
    throw Error('unregistered synthetic provider path');
  }) as typeof fetch;
  const account={connection_id:'synthetic-work',email:'work@example.invalid'};
  const client=()=>googleClient(app,{refresh_token:'synthetic'},fetcher,undefined,provider.wrongAccount?{...account,email:'other@example.invalid'}:account);
  const cards: string[]=[]; let sequence=0;
  const open = () => {
    const effects=ownerEffectLedger(storage,()=>at);
    const desk=approvalDesk(sql,{effects,owner:42,google:async()=>client(),call:async(_method,body)=>{cards.push(String((body as {text?:string}).text));return {message_id:1};},newId:()=>String(++sequence),now:()=>at,timezone:'UTC',log:()=>{}});
    const handlers=googleHandlers({client:async()=>client()},desk,{timezone:'UTC',now:()=>new Date(at)},undefined,effects);
    const invoke=async(name:string,args:unknown,turn='synthetic-turn')=>{
      const handler=handlers.find(h=>h.name===name)!;
      return handler.handle(handler.schema.parse(args) as never,{authenticatedUserId:'synthetic-owner',turnId:turn,toolCallId:'synthetic-call'} as ToolDispatcherContext) as Promise<any>;
    };
    return {desk,effects,invoke};
  };
  return {provider,cards,sql,open,advance:()=>{at+=24*60*60_000;},close:()=>db.close()};
};
const reply={account:'work@example.invalid',to:['recipient@example.invalid'],subject:'Re: Synthetic topic',body_markdown:'Synthetic approved reply',reply_to_thread_id:'thread',in_reply_to_msg_id:'parent'};
const move={account:'work@example.invalid',action:'move',event_id:'event',title:'Synthetic event',start:'2026-10-11T10:00:00Z',end:'2026-10-11T11:00:00Z',reason:'Synthetic change'};

it('registered Gmail reply journey: frozen provider headers, exact account/card/receipt, replay and response loss restart', async()=>{
 const j=journey();try{
  const first=j.open(); const proposed=await first.invoke('send_email',sendEmailArgsSchema.parse(reply)); expect(proposed.ok).toBe(true);
  const id=proposed.data.proposal_id;
  expect(j.provider.writes).toHaveLength(0);expect(j.cards[0]).toContain('From: work@example.invalid');
  const stored=j.sql.exec<{payload_json:string}>('SELECT payload_json FROM ledger WHERE id = ?',id).one();const ep=JSON.parse(stored.payload_json) as EmailSendProposal;
  const mime=atob(ep.raw.replace(/-/g,'+').replace(/_/g,'/'));
  expect(mime).toContain('In-Reply-To: <parent@example.invalid>\r\nReferences: <root@example.invalid> <parent@example.invalid>');
  expect((await first.invoke('send_email',reply)).data.proposal_id).toBe(id);
  j.provider.parentMessageId='<later@example.invalid>';j.provider.loseSend=true;
  expect((await first.desk.decide(id,'a','synthetic')).toast).toBe('Outcome unknown');
  expect(j.provider.writes).toHaveLength(1);expect(j.provider.writes[0]!.body.raw).toBe(ep.raw);
  expect(j.provider.writes[0]!.body.threadId).toBe('thread');
  j.provider.readFail=false;j.provider.loseSend=false;
  const restarted=j.open();expect((await restarted.desk.decide(id,'a','restart')).toast).toBe('Sent');
  expect((await restarted.desk.decide(id,'a','replay')).toast).toBe('Already handled.');expect(j.provider.writes).toHaveLength(1);
  expect(restarted.effects.get(`${ep.operation_ref}:apply`)?.receipt).toMatchObject({provider_id:'sent',result:{thread_id:'thread',rfc822_message_id:ep.message_id,label_ids:['SENT']}});
 }finally{j.close();}
});
it.each(['foreign parent','wrong subject','invalid parent header','invalid References','parent without thread'] as const)('reply rejection: %s before approval or mutation',async fault=>{
 const j=journey();try{const args={...reply};if(fault==='foreign parent')args.in_reply_to_msg_id='foreign';if(fault==='wrong subject')args.subject='Unrelated';if(fault==='invalid parent header')j.provider.parentMessageId='<parent@example.invalid>\r\nBcc: injected@example.invalid';if(fault==='invalid References')j.provider.references='malformed';if(fault==='parent without thread')delete (args as Partial<typeof args>).reply_to_thread_id;
 expect((await j.open().invoke('send_email',args)).ok).toBe(false);expect(j.cards).toHaveLength(0);expect(j.provider.writes).toHaveLength(0);
 }finally{j.close();}
});
it.each(['missing SENT','wrong Message-ID','wrong thread'] as const)('acknowledgement cannot complete Gmail with %s readback; recovery never resends',async fault=>{
 const j=journey();try{const f=j.open();const id=(await f.invoke('send_email',reply)).data.proposal_id;j.provider.loseSend=true;await f.desk.decide(id,'a','test');j.provider.readFail=false;
 if(fault==='missing SENT')j.provider.sent!.labelIds=['INBOX'];if(fault==='wrong Message-ID')j.provider.sent!.payload.headers[0]!.value='<other@example.invalid>';if(fault==='wrong thread')j.provider.sent!.threadId='other';
 expect((await j.open().desk.decide(id,'a','restart')).toast).toBe('Outcome unknown');expect(j.provider.writes).toHaveLength(1);
 }finally{j.close();}
});
it.each(['send_email','propose_calendar_change'] as const)('selected account rejection on approval: %s',async name=>{
 const j=journey();try{const f=j.open();const id=(await f.invoke(name,name==='send_email'?reply:move)).data.proposal_id;j.provider.wrongAccount=true;expect((await f.desk.decide(id,'a','test')).toast).toBe('Google is not connected');expect(j.provider.writes).toHaveLength(0);}finally{j.close();}
});
it('registered Calendar move/Undo: date-only original survives lost Undo response, restart and replay',async()=>{
 const j=journey();try{
  let f=j.open();const id=(await f.invoke('propose_calendar_change',proposeCalendarChangeArgsSchema.parse(move))).data.proposal_id;
  expect((await f.desk.decide(id,'a','test')).toast).toBe('Done');expect(j.provider.writes).toHaveLength(1);
  f=j.open();
  const applyMarker=j.provider.event.extendedProperties.private.waldoOperation;
  expect(j.provider.writes[0]).toMatchObject({match:'v1',body:{start:{dateTime:move.start,date:null},end:{dateTime:move.end,date:null}}});
  j.provider.loseCalendar=true;expect((await f.desk.decide(id,'u','undo')).toast).toBe('Outcome unknown');
  expect(j.provider.writes[1]).toMatchObject({match:'v2',body:{start:{date:'2026-10-11',dateTime:null},end:{date:'2026-10-12',dateTime:null}}});
  expect(j.provider.event.extendedProperties.private.waldoOperation).not.toBe(applyMarker);
  expect(j.provider.event.extendedProperties.private.unrelated).toBe('preserved');
  j.advance();j.provider.readFail=false;f=j.open();expect((await f.desk.decide(id,'u','restart')).toast).toBe('Undone');
  expect((await f.desk.decide(id,'u','replay')).toast).toBe('Already handled.');expect(j.provider.writes).toHaveLength(2);expect(j.provider.event.start).toEqual({date:'2026-10-11'});
 }finally{j.close();}
});
it.each(['marker missing','marker foreign','later edit'] as const)('Calendar uncertain apply rejects field-only confirmation: %s',async fault=>{
 const j=journey();try{const f=j.open();const id=(await f.invoke('propose_calendar_change',move)).data.proposal_id;j.provider.loseCalendar=true;await f.desk.decide(id,'a','test');j.provider.readFail=false;
 if(fault==='marker missing')delete (j.provider.event.extendedProperties.private as Record<string,string>).waldoOperation;
 if(fault==='marker foreign')(j.provider.event.extendedProperties.private as Record<string,string>).waldoOperation='foreign';
 if(fault==='later edit')j.provider.event.start={dateTime:'2026-10-11T12:00:00Z'};
 expect((await j.open().desk.decide(id,'a','restart')).toast).toBe('Outcome unknown');expect(j.provider.writes).toHaveLength(1);
 }finally{j.close();}
});
it('Calendar Undo fences later owner edits and never overwrites them',async()=>{
 const j=journey();try{const f=j.open();const id=(await f.invoke('propose_calendar_change',move)).data.proposal_id;expect((await f.desk.decide(id,'a','test')).toast).toBe('Done');j.provider.event.etag='v99';j.provider.event.start={dateTime:'2026-10-11T15:00:00Z'};j.provider.event.end={dateTime:'2026-10-11T16:00:00Z'};expect((await f.desk.decide(id,'u','test')).toast).toBe('The event changed');expect(j.provider.writes).toHaveLength(1);expect(j.provider.event.start).toEqual({dateTime:'2026-10-11T15:00:00Z'});}finally{j.close();}
});
it.each(['create','move'] as const)('lost %s apply response recovers a receipt without inventing Undo authority from a later ETag',async action=>{
 const j=journey();try{const f=j.open();const id=(await f.invoke('propose_calendar_change',{...move,action,...(action==='create'?{event_id:undefined}:{})})).data.proposal_id;j.provider.loseCalendar=true;await f.desk.decide(id,'a','test');j.provider.readFail=false;
 j.provider.event.etag='v99';j.provider.event.summary=action==='create'?move.title:'Later owner title';
 const reopened=j.open();expect((await reopened.desk.decide(id,'a','restart')).toast).toBe('Done');expect((await reopened.desk.decide(id,'u','test')).toast).toBe("Can't be undone");expect(j.provider.writes).toHaveLength(1);
 }finally{j.close();}
});
it('Calendar create has a stable ID and separate apply/Undo markers; lost Undo cancellation response reconciles its marked tombstone',async()=>{
 const j=journey();try{const f=j.open();const id=(await f.invoke('propose_calendar_change',{...move,action:'create',event_id:undefined})).data.proposal_id;expect((await f.desk.decide(id,'a','test')).toast).toBe('Done');
 const created=j.provider.writes[0]!.body;expect(created.id).toMatch(/^[a-f0-9]{64}$/);expect(created.extendedProperties.private.waldoOperation).toBe(created.id);
 j.provider.loseCalendar=true;expect((await f.desk.decide(id,'u','test')).toast).toBe('Outcome unknown');
 const cancelled=j.provider.writes[1]!;expect(cancelled).toMatchObject({method:'PATCH',match:'v2',body:{status:'cancelled'}});expect(cancelled.body.extendedProperties.private.waldoOperation).not.toBe(created.extendedProperties.private.waldoOperation);
 j.provider.readFail=false;expect((await j.open().desk.decide(id,'u','restart')).toast).toBe('Undone');expect(j.provider.writes).toHaveLength(2);
 }finally{j.close();}
});
it.each(['marker missing','restoration changed'] as const)('uncertain Calendar Undo stays read-only for %s',async fault=>{
 const j=journey();try{const f=j.open();const id=(await f.invoke('propose_calendar_change',move)).data.proposal_id;await f.desk.decide(id,'a','test');j.provider.loseCalendar=true;await f.desk.decide(id,'u','test');j.provider.readFail=false;
 if(fault==='marker missing')delete j.provider.event.extendedProperties.private.waldoOperation;
 else{j.provider.event.start={date:'2026-10-13'};j.provider.event.end={date:'2026-10-14'};j.provider.event.etag='v99';}
 expect((await j.open().desk.decide(id,'u','restart')).toast).toBe('Outcome unknown');expect(j.provider.writes).toHaveLength(2);
 }finally{j.close();}
});
it('Calendar cancellation requires its apply marker; a bare cancelled tombstone never confirms a lost response',async()=>{
 const j=journey();try{const f=j.open();const id=(await f.invoke('propose_calendar_change',{account:move.account,action:'cancel',event_id:'event',title:move.title,reason:move.reason})).data.proposal_id;j.provider.loseCalendar=true;await f.desk.decide(id,'a','test');j.provider.readFail=false;delete j.provider.event.extendedProperties.private.waldoOperation;
 expect((await j.open().desk.decide(id,'a','restart')).toast).toBe('Outcome unknown');expect(j.provider.writes).toHaveLength(1);
 }finally{j.close();}
});
it('Gmail acknowledgement followed by unavailable Sent metadata remains uncertain and replays read-only',async()=>{
 const j=journey();try{const f=j.open();const id=(await f.invoke('send_email',reply)).data.proposal_id;j.provider.readFail=true;
 expect((await f.desk.decide(id,'a','test')).toast).toBe('Outcome unknown');expect(j.provider.writes).toHaveLength(1);
 j.provider.readFail=false;expect((await j.open().desk.decide(id,'a','restart')).toast).toBe('Sent');expect(j.provider.writes).toHaveLength(1);
 }finally{j.close();}
});
it('frozen Gmail digest mismatch blocks the irreversible edge',async()=>{
 const j=journey();try{const f=j.open();const id=(await f.invoke('send_email',reply)).data.proposal_id;const row=j.sql.exec<{payload_json:string}>('SELECT payload_json FROM ledger WHERE id = ?',id).one();const payload=JSON.parse(row.payload_json);payload.raw='substitution';j.sql.exec('UPDATE ledger SET payload_json = ? WHERE id = ?',JSON.stringify(payload),id);
 expect((await f.desk.decide(id,'a','test')).toast).toBe('Email changed');expect(j.provider.writes).toHaveLength(0);
 }finally{j.close();}
});
