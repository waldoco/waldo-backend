import { expect, it } from 'vitest';
import { b64url, googleClient } from '../src/connectors/google';
import { googleHandlers } from '../src/tools/live/google';
import { readThreadArgsSchema, searchCommunicationArgsSchema } from '@waldo/contracts';
const app = { clientId: 'c', clientSecret: 's', redirectUri: 'https://example.invalid' };
const encode = (text: string) => b64url(new TextEncoder().encode(text));
const message = (id: string, payload: unknown) => ({ id, internalDate: '1791417600000', payload });
const fixture = (messages: unknown[]) => googleClient(app, { refresh_token: 'r', email: 'work@example.com' }, (async (input: RequestInfo | URL) => String(input).includes('oauth2') ? Response.json({ access_token: 'a' }) : Response.json({ messages })) as typeof fetch);
it('reads HTML-only MIME with entities, Unicode, block boundaries and no script/style content', async () => {
 const client = fixture([message('1', {mimeType:'text/html',body:{data:encode('<style>hide</style><p>Hello &amp; नमस्ते</p><p>next<br>line &#x1F642;</p><script>bad()</script>')}})]);
 const [row] = await client.readThread('thread', 10);
 expect(row!.body).toBe('Hello & नमस्ते\nnext\nline 🙂');
});
it('prefers nested plain text over HTML and preserves 32,000 body characters', async () => {
 const client = fixture([message('1',{mimeType:'multipart/alternative',parts:[{mimeType:'text/html',body:{data:encode('<p>wrong</p>')}},{mimeType:'multipart/mixed',parts:[{mimeType:'text/plain',body:{data:encode('x'.repeat(33000))}}]}]})]);
 expect((await client.readThread('t',10))[0]!.body).toHaveLength(32000);
});
it('exposes schema cursors and walks thread pages without dropping later messages', async () => {
 expect(searchCommunicationArgsSchema.safeParse({query:'topic',cursor:'next'}).success).toBe(true);
 expect(readThreadArgsSchema.safeParse({thread_id:'t',cursor:'next'}).success).toBe(true);
 const client = fixture([1,2,3].map(n=>message(String(n),{mimeType:'text/plain',body:{data:encode(`body ${n}`)}})));
 const handlers = googleHandlers({client:async()=>client},{propose:async()=>'',proposeSendEmail:async()=>'',record:()=>{}},{timezone:'UTC',now:()=>new Date()});
 const handler = handlers.find(h=>h.name==='read_thread')!;
 const first = await handler.handle({thread_id:'t',limit:2} as never);
 expect(first).toMatchObject({ok:true,data:{account:{email:'work@example.com'},messages:[{id:'1'},{id:'2'}],cursor:expect.any(String)}});
 const second = await handler.handle({thread_id:'t',limit:2,cursor:(first as any).data.cursor} as never);
 expect(second).toMatchObject({ok:true,data:{messages:[{id:'3'}],cursor:null}});
 const wrong = await handler.handle({thread_id:'other',limit:2,cursor:(first as any).data.cursor} as never);
 expect(wrong.ok).toBe(false);
});
it('search forwards provider continuation and includes account metadata',async()=>{
 const calls:unknown[]=[];
 const handler=googleHandlers({client:async()=>({account:{connection_id:'a',email:'work@example.com'},mailPage:async(...args:unknown[])=>{calls.push(args);return {messages:[],next_page_token:'next',result_size_estimate:10};}} as never)},{propose:async()=>'',proposeSendEmail:async()=>'',record:()=>{}},{timezone:'UTC',now:()=>new Date()}).find(h=>h.name==='search_communication')!;
 const result=await handler.handle({query:'topic',limit:2,cursor:'previous'} as never);
 expect(calls).toEqual([['topic',2,'previous']]);
 expect(result).toMatchObject({ok:true,data:{account:{email:'work@example.com'},cursor:'next'}});
});
it('supports detached readThread invocation used by connector-proxy',async()=>{
 const read = fixture([message('1',{mimeType:'text/plain',body:{data:encode('body')}})]).readThread;
 expect((await read('t',10))[0]!.body).toBe('body');
});
