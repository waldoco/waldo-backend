import {describe,expect,it,vi} from 'vitest';
import {b64url,googleClient} from '../src/connectors/google';
import {googleHandlers} from '../src/tools/live/google';
import {readThreadArgsSchema} from '@waldo/contracts';
const app={clientId:'configured-client',clientSecret:'synthetic-secret',redirectUri:'https://waldo.example/oauth'};
const encode=(text:string)=>b64url(new TextEncoder().encode(text));
function fixture(){let body='x'.repeat(64000)+' The actual updated form deadline is December 9.',account={connection_id:'work',email:'work@example.test'};const calls:string[]=[];
 const message=()=>({id:'message-1',threadId:'thread-1',internalDate:'1791417600000',payload:{mimeType:'text/plain',headers:[{name:'From',value:'school@example.test'},{name:'Subject',value:'School form'}],body:{data:encode(body)}}});
 const fetcher=vi.fn(async(input:RequestInfo|URL)=>{const url=String(input);calls.push(url);return url.includes('oauth2')?Response.json({access_token:'synthetic-access'}):url.includes('/threads/')?Response.json({id:'thread-1',messages:[message()]}):Response.json(message());}) as typeof fetch;
 return {setBody:(value:string)=>{body=value;},client:googleClient(app,{refresh_token:'synthetic-refresh'},fetcher,undefined,account),calls,change:()=>{body+=' changed';},foreign:()=>googleClient(app,{refresh_token:'synthetic-other'},fetcher,undefined,{connection_id:'personal',email:'personal@example.test'})};}
describe('bounded Gmail body continuation and completeness',()=>{
 it('exposes the 32k prefix as incomplete and resumes the bound same-account body to the actual deadline',async()=>{const f=fixture(),first=(await f.client.threadPage!('thread-1',20)).messages[0]!;expect(first.body).toHaveLength(32000);expect(first.body_complete).toBe(false);expect(first.body_cursor).toBeTypeOf('string');let text=first.body,cursor=first.body_cursor!;
  for(let n=0;n<5;n++){const page=await f.client.messageBodyPage!('thread-1','message-1',cursor);expect(page.body_offset).toBe(text.length);text+=page.message.body;if(!page.next_cursor){expect(page.source_complete).toBe(true);break;}cursor=page.next_cursor;}
  expect(text).toContain('December 9');expect(text.length).toBe(first.body_total_chars);expect(f.calls.filter(url=>url.includes('/messages/'))).toHaveLength(2);
 });
 it('fences continuation after source body change and cross-account/thread/message substitution',async()=>{const f=fixture(),first=(await f.client.threadPage!('thread-1',20)).messages[0]!;
  await expect(f.foreign().messageBodyPage!('thread-1','message-1',first.body_cursor!)).rejects.toThrow('body cursor');
  await expect(f.client.messageBodyPage!('other-thread','message-1',first.body_cursor!)).rejects.toThrow();
  await expect(f.client.messageBodyPage!('thread-1','other-message',first.body_cursor!)).rejects.toThrow();
  f.change();await expect(f.client.messageBodyPage!('thread-1','message-1',first.body_cursor!)).rejects.toThrow('body cursor');
 });
 it('exposes explicit snippet/MIME incompleteness and never claims an unread attached text body is complete',async()=>{const fetcher=(async(input:RequestInfo|URL)=>String(input).includes('oauth2')?Response.json({access_token:'a'}):Response.json({id:'thread-1',messages:[{id:'m',threadId:'thread-1',snippet:'sample only',payload:{mimeType:'text/plain',body:{attachmentId:'external-text',size:10000}}}]})) as typeof fetch;
  const row=(await googleClient(app,{refresh_token:'synthetic-refresh'},fetcher).threadPage!('thread-1',20)).messages[0]!;expect(row).toMatchObject({body:'sample only',body_complete:false,body_scope:'inline_message_text'});expect(row.body_cursor).toBeUndefined();
 });
 it('registered read_thread exposes bounded body continuation and rejects ambiguous cursor schemas',async()=>{expect(readThreadArgsSchema.safeParse({thread_id:'t',body_cursor:'cursor'}).success).toBe(false);expect(readThreadArgsSchema.safeParse({thread_id:'t',message_id:'m',body_cursor:'cursor',cursor:'thread-page'}).success).toBe(false);
  const f=fixture(),handlers=googleHandlers({client:async()=>f.client},{propose:async()=>'',proposeSendEmail:async()=>'',record:()=>{}},{timezone:'UTC',now:()=>new Date()}),tool=handlers.find(row=>row.name==='read_thread')!;
  const first=await tool.handle(readThreadArgsSchema.parse({thread_id:'thread-1'}));expect(first).toMatchObject({ok:true,data:{coverage:{body_complete:false},messages:[{body_cursor:expect.any(String)}]}});
  const cursor=(first as any).data.messages[0].body_cursor,result=await tool.handle(readThreadArgsSchema.parse({thread_id:'thread-1',message_id:'message-1',body_cursor:cursor}));expect(result).toMatchObject({ok:true,data:{message_id:'message-1',body_offset:32000,coverage:{complete:false,page_exhausted:false},body_cursor:expect.any(String)}});
 });
});

it('keeps split verification artifacts within one quarantine boundary and rejects forged offsets inside them',async()=>{
 const f=fixture();f.setBody('x '.repeat(15996)+'Your login code is 123456. Current form deadline December 9.');
 const relay=vi.fn(async()=>true),tool=googleHandlers({client:async()=>f.client},{propose:async()=>'',proposeSendEmail:async()=>'',record:()=>{}},{timezone:'UTC',now:()=>new Date()},relay).find(row=>row.name==='read_thread')!;
 const first:any=await tool.handle(readThreadArgsSchema.parse({thread_id:'thread-1'}));expect(first.ok).toBe(true);expect(first.data.messages[0].body.length).toBeLessThan(32000);expect(first.data.messages[0].body).not.toContain('123');
 const cursor=first.data.messages[0].body_cursor,second:any=await tool.handle(readThreadArgsSchema.parse({thread_id:'thread-1',message_id:'message-1',body_cursor:cursor}));expect(second.ok).toBe(true);expect(JSON.stringify(second.data)).not.toContain('123456');expect(second.data.messages[0].body).toContain('Current form deadline December 9');expect(relay).toHaveBeenCalledWith('school@example.test',[{kind:'otp',value:'123456'}]);
 const decode=(value:string)=>JSON.parse(atob(value.replaceAll('-','+').replaceAll('_','/'))),bad={...decode(cursor),offset:32005};
 await expect(f.client.messageBodyPage!('thread-1','message-1',encode(JSON.stringify(bad)))).rejects.toThrow('unsafe artifact boundary');
});
