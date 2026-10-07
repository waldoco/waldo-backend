import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { googleClient } from '../src/connectors/google';
import { googleHandlers } from '../src/tools/live/google';
import { commonOwnerTools } from '../src/channels/common-owner-tool-policy';

const account = { connection_id: 'fixture-owner-account', email: 'owner@example.test' };
const sql = () => {
 const db = new DatabaseSync(':memory:');
 return { exec(query: string, ...bindings: any[]) {
  const statement = db.prepare(query);
  const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
  return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
 }} as unknown as SqlStorage;
};
const ctx = { authenticatedUserId: 'fixture-owner', turnId: 'fixture-turn', toolCallId: 'fixture-call' } as never;
const args = { to: ['peer@example.test'], subject: 'Topic', body_markdown: 'Approved reply', reply_to_thread_id: 'thread-1', connection_id: account.connection_id };

it('registered common tools carry a thread reply through exact review, one send, provider readback and channel receipt', async () => {
 const requests: {url:string; init?:RequestInit}[] = [];
 const receipts: string[] = [];
 let readback = false;
 const client = googleClient({clientId:'fixture',clientSecret:'fixture',redirectUri:''},{refresh_token:'fixture'}, async (url,init) => {
  requests.push({url:String(url),init});
  if(String(url).includes('oauth2'))return Response.json({access_token:'fixture'});
  if(String(url).includes('/threads/'))return Response.json({messages:[{id:'original',payload:{headers:[{name:'From',value:'peer@example.test'},{name:'Subject',value:'Topic'},{name:'Message-ID',value:'<original@peer.test>'},{name:'References',value:'<ancestor@peer.test>'}],body:{data:btoa('Original mail')}}}]});
  if(String(url).endsWith('/drafts'))return Response.json({id:'draft-1',message:{id:'draft-msg',threadId:'thread-1'}});
  if(String(url).endsWith('/send')) { readback=true; return Response.json({id:'sent-1',threadId:'thread-1'}); }
  if(String(url).includes('/messages/sent-1?'))return Response.json({id:'sent-1',threadId:'thread-1',labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:Buffer.from(JSON.parse(String(requests.find(r=>r.url.endsWith('/send'))!.init!.body)).raw,'base64url').toString().split('Message-ID: ')[1]!.split('\r\n')[0]}]}});
  return Response.json({messages:readback?[{id:'sent-1'}]:[]});
 },undefined,account);
 const desk = approvalDesk(sql(),{owner:42,call:async(method,body)=>{if(method==='sendMessage')receipts.push((body as {text:string}).text);return {};},google:async()=>client,newId:()=> 'journey',now:()=>1000,timezone:'UTC',log:()=>{}});
 const handlers = googleHandlers({client:async()=>client},desk,{timezone:'UTC',now:()=>new Date(1000)});
 expect(commonOwnerTools({googleConnected:true,driveReads:false,publicSearch:false,browser:false})).toEqual(expect.arrayContaining(['read_thread','draft_email','send_email']));
 const thread=await handlers.find(h=>h.name==='read_thread')!.handle({thread_id:'thread-1',limit:10,connection_id:account.connection_id} as never,ctx);
 expect(thread).toMatchObject({ok:true,data:{account}});
 expect(await handlers.find(h=>h.name==='draft_email')!.handle(args as never,ctx)).toMatchObject({ok:true,data:{sent:false,draft_id:'draft-1',account}});
 const proposed=await handlers.find(h=>h.name==='send_email')!.handle(args as never,ctx);
 expect(proposed).toMatchObject({ok:true,data:{proposal_id:'pjourney',sent:false}});
 expect(requests.filter(r=>r.url.endsWith('/send'))).toHaveLength(0);
 await desk.callback({id:'tap',from:{id:42},data:'a:pjourney'},'fixture');
 expect(receipts.at(-1)).toContain('Gmail confirmed');
 const sent=requests.filter(r=>r.url.endsWith('/send'));
 expect(sent).toHaveLength(1);
 const payload=JSON.parse(String(sent[0]!.init!.body));
 expect(payload.threadId).toBe('thread-1');
 const mime=Buffer.from(payload.raw,'base64url').toString();
 expect(mime).toContain('In-Reply-To: <original@peer.test>');
 expect(mime).toContain('References: <ancestor@peer.test> <original@peer.test>');
 expect(receipts[0]).toContain('From: owner@example.test');
 await desk.callback({id:'tap-again',from:{id:42},data:'a:pjourney'},'fixture');
 expect(requests.filter(r=>r.url.endsWith('/send'))).toHaveLength(1);
});

import { b64url, buildMime, sha256Hex, googleAccountCandidates, GoogleError, GoogleMailAccountError, type GoogleClient } from '../src/connectors/google';
import { ProxyIntentError } from '../src/connectors/proxy-intent';
import { GOOGLE_FEATURE_SCOPES } from '../src/connectors/google';

const mailFixture = async (options: { sendError?: Error; found?: boolean; account?: typeof account; readError?: Error; deliveryError?: boolean; seenIds?: string[] } = {}) => {
 const storage=sql(); let sends=0, lookups=0, sequence=0, delivered=0;
 const client={account:options.account??account,sendRaw:async()=>{sends++;if(options.sendError)throw options.sendError;return {message_id:'sent-1'};},findSentByMessageId:async(messageId:string)=>{lookups++;options.seenIds?.push(messageId);if(options.readError)throw options.readError;return options.found??true;}} as unknown as GoogleClient;
 const deps={owner:42,call:async(method:string,body:object)=>{if(method==='sendMessage'&&(body as {text:string}).text.includes('Gmail confirmed')){if(options.deliveryError)throw new Error('fixture channel unavailable');delivered++;}return {};},google:async()=>client,newId:()=>String(++sequence),now:()=>1000,timezone:'UTC',log:()=>{}};
 const raw=b64url(new TextEncoder().encode(buildMime({to:['peer@example.test'],subject:'Topic',body:'First reply',messageId:'<fixture@waldo-send>'})));
 const payload={to:['peer@example.test'],subject:'Topic',body:'First reply',connection_id:account.connection_id,account_email:account.email,message_id:'<fixture@waldo-send>',raw,digest:await sha256Hex(raw)};
 const desk=approvalDesk(storage,deps),id=await desk.proposeSendEmail(payload);
 return {storage,deps,client,payload,desk,id,restart:()=>approvalDesk(storage,deps),counts:()=>({sends,lookups,delivered}),options};
};

it('concurrent approvals and desk recreation reconcile without repeating an external send',async()=>{
 const f=await mailFixture();
 await Promise.all([f.desk.decide(f.id,'a','tap1'),f.desk.decide(f.id,'a','tap2')]);
 expect(f.counts().sends).toBe(1);
 await f.restart().callback({id:'repeat',from:{id:42},data:`a:${f.id}`},'restart');
 expect(f.counts()).toMatchObject({sends:1,delivered:1});
 expect(f.storage.exec('SELECT * FROM email_send_receipts WHERE approval_id = ?',f.id).one()).toMatchObject({connection_id:account.connection_id,provider_message_id:'sent-1',confirmed_at:1000,channel_delivered_at:1000});
});

it.each([new Error('timeout after provider acceptance'),new ProxyIntentError('intent_pending')])('unknown send remains uncertain until provider confirmation after restart: %s',async sendError=>{
 const f=await mailFixture({sendError,found:false});
 const first=await f.desk.decide(f.id,'a','tap');
 expect(first).toMatchObject({toast:'Outcome unknown'});
 expect(first.message).not.toContain('Nothing was delivered');
 expect(f.storage.exec('SELECT status FROM ledger WHERE id = ?',f.id).one()).toEqual({status:'uncertain'});
 await f.restart().reconcileEmails();expect(f.counts().sends).toBe(1);expect(f.counts().delivered).toBe(0);
 f.options.found=true;
 await f.restart().reconcileEmails();
 expect(f.counts()).toMatchObject({sends:1,delivered:1});
 await f.restart().reconcileEmails();expect(f.counts()).toMatchObject({sends:1,delivered:1});
});

it('a provider acknowledgement followed by failed readback remains unknown',async()=>{
 const f=await mailFixture({readError:new Error('provider lookup outage')});
 expect((await f.desk.decide(f.id,'a','tap')).toast).toBe('Outcome unknown');
 expect(f.storage.exec('SELECT * FROM email_send_receipts WHERE approval_id = ?',f.id).one()).toMatchObject({provider_message_id:'sent-1',confirmed_at:null});
 delete f.options.readError;await f.restart().reconcileEmails();
 expect(f.counts()).toMatchObject({sends:1,delivered:1});
});

it('restart with a durable sending claim performs only readback, and lost channel receipt is delivered later',async()=>{
 const f=await mailFixture({deliveryError:true});
 await expect(f.desk.callback({id:'tap',from:{id:42},data:`a:${f.id}`},'tap')).rejects.toThrow('fixture channel unavailable');
 expect(f.counts()).toMatchObject({sends:1,delivered:0});
 f.options.deliveryError=false;await f.restart().reconcileEmails();
 expect(f.counts()).toMatchObject({sends:1,delivered:1});
 const crash=await mailFixture();
 crash.storage.exec("UPDATE ledger SET status = 'sending' WHERE id = ?",crash.id);
 crash.storage.exec('INSERT INTO email_send_receipts (approval_id,connection_id,message_id) VALUES (?,?,?)',crash.id,account.connection_id,crash.payload.message_id);
 await crash.restart().reconcileEmails();expect(crash.counts()).toMatchObject({sends:0,delivered:1});
});

it.each(['raw','body','to','thread_id','connection_id','account_email'])('changing approved %s fails closed before external IO',async field=>{
 const f=await mailFixture();
 const stored=JSON.parse((f.storage.exec('SELECT payload_json FROM ledger WHERE id = ?',f.id).one() as any).payload_json);
 stored[field]=field==='to'?['attacker@example.test']:'changed';
 f.storage.exec('UPDATE ledger SET payload_json = ? WHERE id = ?',JSON.stringify(stored),f.id);
 expect((await f.desk.decide(f.id,'a','tap')).toast).toBe('Email changed');
 expect(f.counts()).toMatchObject({sends:0,lookups:0});
});

it('wrong-account adapter cannot send or reconcile an approved email',async()=>{
 const f=await mailFixture({account:{connection_id:'another-owner-account',email:'another@example.test'}});
 expect((await f.desk.decide(f.id,'a','tap')).toast).toBe('Google is not connected');
 expect(f.counts()).toMatchObject({sends:0,lookups:0});
 f.storage.exec("UPDATE ledger SET status = 'uncertain' WHERE id = ?",f.id);
 await f.restart().reconcileEmails();expect(f.counts()).toMatchObject({sends:0,lookups:0});
});

it('Modify invalidates the old approval and only latest reviewed bytes send',async()=>{
 const f=await mailFixture();
 expect((await f.desk.decide(f.id,'e','modify')).toast).toBe('Tell me what to change');
 const raw=b64url(new TextEncoder().encode(buildMime({to:f.payload.to,subject:'Topic',body:'Latest reply',messageId:'<latest@waldo-send>'})));
 const fresh=await f.desk.proposeSendEmail({...f.payload,body:'Latest reply',raw,message_id:'<latest@waldo-send>',digest:await sha256Hex(raw)});
 expect((await f.desk.decide(f.id,'a','late tap')).toast).toBe('Already handled.');
 expect(f.counts().sends).toBe(0);
 expect((await f.desk.decide(fresh,'a','latest tap')).toast).toBe('Sent');expect(f.counts().sends).toBe(1);
});

it('non-owner callback cannot consume an approval',async()=>{
 const f=await mailFixture();await f.desk.callback({id:'intruder',from:{id:43},data:`a:${f.id}`},'intruder');
 expect(f.counts().sends).toBe(0);expect(f.storage.exec('SELECT status FROM ledger WHERE id = ?',f.id).one()).toEqual({status:'open'});
});

it('account selection does not fall through across accounts or revoked scopes',()=>{
 const accounts=[{id:'account-a',scopes:GOOGLE_FEATURE_SCOPES.mail},{id:'account-b',scopes:GOOGLE_FEATURE_SCOPES.mail}];
 expect(()=>googleAccountCandidates(accounts,'mail')).toThrow('Multiple');
 expect(googleAccountCandidates(accounts,'mail','account-a')).toEqual([accounts[0]]);
 expect(()=>googleAccountCandidates(accounts,'mail','missing')).toThrow('disconnected');
 expect(()=>googleAccountCandidates([{...accounts[0]!,scopes:[]},accounts[1]!],'mail','account-a')).toThrow('scopes');
});

it('scope failures offer the existing connect path while transient refresh stays retryable',async()=>{
 for(const error of [new GoogleMailAccountError('missing scopes','scope_missing'),new GoogleError(403,'insufficient','ACCESS_TOKEN_SCOPE_INSUFFICIENT'),new GoogleError(401,'revoked'),new GoogleError(503,'unavailable')]){
  const handlers=googleHandlers({client:async()=>{throw error;}},{propose:async()=>'',proposeSendEmail:async()=>'',record:()=>{}},{timezone:'UTC',now:()=>new Date()});
  const result=await handlers.find(h=>h.name==='read_thread')!.handle({thread_id:'thread',limit:1} as never,ctx);
  expect(result).toMatchObject({ok:false,code:error instanceof GoogleError&&error.status===503?'transient':'auth_failed'});
  if(error instanceof GoogleError&&error.status===503)expect(result).not.toHaveProperty('connect');
 }
});


import { taskSourceAllowed } from '../src/channels/task-source-scope';
import { SourceScopeStore, guardExternalReads } from '../src/tools/source-scope';
it('mail-only task admits reply primitives but explicit pasted-only denies their provider header reads',async()=>{
 const handlers=googleHandlers({client:async()=>{throw Error('must not read');}},{propose:async()=>'',proposeSendEmail:async()=>'',record:()=>{}},{timezone:'UTC',now:()=>new Date()});
 const snapshot={taskId:'fixture-task',revision:1,sources:['mail'],ready:true} as never;
 for(const name of ['read_thread','draft_email','send_email','connect_service']){
  const handler=handlers.find(h=>h.name===name);
  if(handler)expect(taskSourceAllowed(snapshot,handler,args)).toBe(true);
 }
 const store=new SourceScopeStore(sql());store.set('pasted_only',{trigger:'user_message',toolArgSourceTaint:null},1000);
 const guarded=guardExternalReads(store,handlers as never[]) as typeof handlers;
 for(const name of ['draft_email','send_email'])expect(await guarded.find(h=>h.name===name)!.handle(args as never,ctx)).toMatchObject({ok:false,code:'forbidden'});
});


it('completed delivered history cannot starve recovery of an older uncertain send',async()=>{
 const f=await mailFixture({sendError:new Error('response lost'),found:false});
 await f.desk.decide(f.id,'a','tap');
 for(let i=0;i<8;i++){
  const id=`later-${i}`;
  f.storage.exec("INSERT INTO ledger (id,kind,status,summary,payload_json,created_at,decided_at) VALUES (?,'email_send','done','later sent',?,2000,2000)",id,JSON.stringify(f.payload));
  f.storage.exec('INSERT INTO email_send_receipts (approval_id,connection_id,message_id,confirmed_at,channel_delivered_at) VALUES (?,?,?,2000,2000)',id,account.connection_id,f.payload.message_id);
 }
 f.options.found=true;await f.restart().reconcileEmails();
 expect(f.counts()).toMatchObject({sends:1,delivered:1});
 expect(f.storage.exec('SELECT status FROM ledger WHERE id = ?',f.id).one()).toEqual({status:'done'});
});

it.each([{id:'other',labelIds:['SENT'],message:'<fixture@waldo-send>',threadId:'thread'}, {id:'sent',labelIds:['INBOX'],message:'<fixture@waldo-send>',threadId:'thread'}, {id:'sent',labelIds:['SENT'],message:'<different@waldo-send>',threadId:'thread'}, {id:'sent',labelIds:['SENT'],message:'<fixture@waldo-send>',threadId:'wrong-thread'}])('provider readback must match message identity, SENT label and requested thread: %j',async found=>{
 const client=googleClient({clientId:'fixture',clientSecret:'fixture',redirectUri:''},{refresh_token:'fixture'},async url=>{
  if(String(url).includes('oauth2'))return Response.json({access_token:'fixture'});
  if(String(url).includes('/messages?'))return Response.json({messages:[{id:'sent'}]});
  return Response.json({...found,payload:{headers:[{name:'Message-ID',value:found.message}]}});
 });
 expect(await client.findSentByMessageId('<fixture@waldo-send>','thread')).toBe(false);
});


it('bounded recovery advances more than eight unresolved sends even with a fixed fixture clock',async()=>{
 const f=await mailFixture({found:false});
 await f.desk.decide(f.id,'a','tap');
 for(let i=0;i<10;i++){
  const id=`unresolved-${i}`,payload={...f.payload,message_id:`<backlog-${i}@waldo-send>`};
  const binding_digest=await sha256Hex(JSON.stringify(payload));
  f.storage.exec("INSERT INTO ledger (id,kind,status,summary,payload_json,created_at,decided_at) VALUES (?,'email_send','uncertain','Backlog fixture',?,1000,1000)",id,JSON.stringify({...payload,binding_digest}));
 }
 const seen:string[]=[];f.options.seenIds=seen;
 await f.restart().reconcileEmails();expect(seen).toHaveLength(8);
 await f.restart().reconcileEmails();expect(new Set(seen).size).toBe(11);
 expect(f.desk.ledger([])).toContain(`${f.id}: Gmail outcome unconfirmed`);
 expect(f.desk.ledger([])).toContain('unresolved-9: Gmail outcome unconfirmed');
 expect(f.counts().sends).toBe(1);
});
