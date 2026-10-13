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

// Synthetic shapes only: a stub plain part, an HTML body held by attachmentId, an attached file before the body.
const thread = (payload: unknown, attachments: Record<string, string> = {}, calls: string[] = []) => googleClient(app, { refresh_token: 'r' }, (async (input: RequestInfo | URL) => {
 const url = String(input);
 calls.push(url);
 if (url.includes('oauth2')) return Response.json({ access_token: 'a' });
 const attachment = url.match(/\/messages\/m1\/attachments\/([^/?]+)$/)?.[1];
 if (attachment) return attachment in attachments ? Response.json({ size: attachments[attachment]!.length, data: encode(attachments[attachment]!) }) : new Response('{}', { status: 404 });
 return Response.json({ messages: [{ id: 'm1', internalDate: '1791417600000', snippet: 'Rs.4,500.00 debited from', payload }] });
}) as typeof fetch);
const stub = { mimeType: 'text/plain', body: { data: encode('This is an HTML email. Please use an HTML-capable client to view it.') } };
const alertHtml = '<table><tr><td>Rs.4,500.00 was debited from account **1234.</td></tr><tr><td>Not you? Call the number on your card.</td></tr></table>';
const bodyOf = async (client: ReturnType<typeof thread>) => { const [row] = (await client.threadPage!('t', 10, undefined, { fullBodies: true })).messages; return { body: row!.body, source: row!.body_source }; };

it('reads the last alternative that renders, so a stub plain part never hides the HTML body', async () => {
 expect(await bodyOf(thread({ mimeType: 'multipart/alternative', parts: [stub, { mimeType: 'text/html', body: { data: encode(alertHtml) } }] }))).toEqual({ body: 'Rs.4,500.00 was debited from account **1234.\nNot you? Call the number on your card.', source: 'html' });
});

it('falls back to an earlier alternative only when the last one renders empty', async () => {
 expect(await bodyOf(thread({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: encode('Plain only.') } }, { mimeType: 'text/html', body: { data: encode('<style>p{}</style>') } }] }))).toEqual({ body: 'Plain only.', source: 'plain' });
});

it('never takes an attached file as the body', async () => {
 const attached = { mimeType: 'text/plain', filename: 'invoice.txt', body: { data: encode('ATTACHED FILE') } };
 const disposed = { mimeType: 'text/html', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="page.html"' }], body: { data: encode('<p>ATTACHED PAGE</p>') } };
 expect(await bodyOf(thread({ mimeType: 'multipart/mixed', parts: [attached, disposed, { mimeType: 'multipart/alternative', parts: [stub, { mimeType: 'text/html', body: { data: encode('<p>The real body.</p>') } }] }] }))).toEqual({ body: 'The real body.', source: 'html' });
});

it('fetches a body Gmail holds by attachmentId, and only for the part it reads', async () => {
 const calls: string[] = [];
 const client = thread({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { attachmentId: 'plain1', size: 90_000 } }, { mimeType: 'text/html', body: { attachmentId: 'html1', size: 90_000 } }] }, { plain1: 'unused plain', html1: alertHtml }, calls);
 expect(await bodyOf(client)).toEqual({ body: 'Rs.4,500.00 was debited from account **1234.\nNot you? Call the number on your card.', source: 'html' });
 expect(calls.filter(url => url.includes('/attachments/'))).toEqual(['https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/attachments/html1']);
});

it('says when the body is only the snippet, or missing', async () => {
 expect(await bodyOf(thread({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { attachmentId: 'gone', size: 10 } }] }))).toEqual({ body: 'Rs.4,500.00 debited from', source: 'snippet' });
 const calls: string[] = [];
 expect(await bodyOf(thread({ mimeType: 'text/html', body: { attachmentId: 'huge', size: 5_000_000 } }, { huge: alertHtml }, calls))).toEqual({ body: 'Rs.4,500.00 debited from', source: 'snippet' });
 expect(calls.filter(url => url.includes('/attachments/'))).toEqual([]);
 const [empty] = (await googleClient(app, { refresh_token: 'r' }, (async (input: RequestInfo | URL) => String(input).includes('oauth2') ? Response.json({ access_token: 'a' }) : Response.json({ messages: [{ id: 'm1', internalDate: '1791417600000', payload: { mimeType: 'image/png' } }] })) as typeof fetch).threadPage!('t', 10, undefined, { fullBodies: true })).messages;
 expect({ body: empty!.body, source: empty!.body_source }).toEqual({ body: '', source: 'none' });
});

it('still relays a sign-in link that sits only in an HTML link target, and the model never sees it', async () => {
 const link = 'https://auth.example.com/auth/v1/verify?token=synthetic-token-7f3a&type=magiclink';
 for (const payload of [
  { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: encode(`Sign in: ${link}`) } }, { mimeType: 'text/html', body: { data: encode(`<p><a href="${link.replaceAll('&', '&amp;')}">Sign in</a> to continue.</p>`) } }] },
  { mimeType: 'text/html', body: { data: encode(`<p><a href="${link.replaceAll('&', '&amp;')}">Sign in</a> to continue.</p>`) } },
 ]) {
  const relays: unknown[] = [];
  const read = googleHandlers({ client: async () => thread(payload) }, { propose: async () => '', proposeSendEmail: async () => '', record: () => {} }, { timezone: 'UTC', now: () => new Date() }, async (from, artifacts) => { relays.push(artifacts); return true; }).find(h => h.name === 'read_thread')!;
  const result = await read.handle({ thread_id: 't', limit: 10 } as never);
  expect(relays).toEqual([[{ kind: 'magic_link', value: link }]]);
  expect(result).toMatchObject({ ok: true, data: { messages: [{ body: 'Sign in to continue.\n[magic_link artifact - sent to the owner in a separate message]', body_source: 'html', quarantined: ['magic_link'] }] } });
  expect(JSON.stringify(result)).not.toContain('synthetic-token');
  expect(JSON.stringify(result)).not.toContain('artifact_scan');
 }
});

it('fails the read when the network drops while fetching a body, instead of passing the snippet off as complete', async () => {
 const client = googleClient(app, { refresh_token: 'r' }, (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('oauth2')) return Response.json({ access_token: 'a' });
  if (url.includes('/attachments/')) throw new TypeError('network connection lost');
  return Response.json({ messages: [{ id: 'm1', internalDate: '1791417600000', snippet: 'preview', payload: { mimeType: 'text/html', body: { attachmentId: 'html1', size: 10 } } }] });
 }) as typeof fetch);
 await expect(client.threadPage!('t', 10, undefined, { fullBodies: true })).rejects.toThrow('network connection lost');
});

it('returns link targets only to a caller that asks for full bodies, so an older handler never passes them on', async () => {
 const client = thread({ mimeType: 'text/html', body: { data: encode('<p><a href="https://auth.example.com/auth/v1/verify?token=synthetic-token-7f3a">Sign in</a></p>') } });
 const [plain] = (await client.threadPage!('t', 10)).messages;
 expect(plain).not.toHaveProperty('artifact_scan');
 expect(JSON.stringify(await client.readThread('t', 10))).not.toContain('synthetic-token');
 expect((await client.threadPage!('t', 10, undefined, { fullBodies: true })).messages[0]).toMatchObject({ body: 'Sign in', artifact_scan: 'https://auth.example.com/auth/v1/verify?token=synthetic-token-7f3a' });
});

it('leaves a link target over 2,048 characters out of the scan, so one hostile link cannot stall extraction', async () => {
 const long = `https://example.com/${'https://a'.repeat(400)}`;
 const client = thread({ mimeType: 'text/html', body: { data: encode(`<p><a href="${long}">x</a> <a href="https://auth.example.com/auth/v1/verify?token=synthetic-token-7f3a">Sign in</a></p>`) } });
 expect((await client.threadPage!('t', 10, undefined, { fullBodies: true })).messages[0]!.artifact_scan).toBe('https://auth.example.com/auth/v1/verify?token=synthetic-token-7f3a');
});

it('resolving a reply parent reads headers only and fetches no held bodies', async () => {
 const calls: string[] = [];
 const client = thread({ mimeType: 'text/html', headers: [{ name: 'Message-ID', value: '<parent@example.invalid>' }, { name: 'Subject', value: 'Debit alert' }], body: { attachmentId: 'html1', size: 10 } }, { html1: alertHtml }, calls);
 const send = googleHandlers({ client: async () => client }, { propose: async () => '', proposeSendEmail: async () => 'p1', record: () => {} }, { timezone: 'UTC', now: () => new Date() }).find(h => h.name === 'send_email')!;
 const result = await send.handle({ to: ['recipient@example.invalid'], subject: 'Re: Debit alert', body_markdown: 'Thanks.', reply_to_thread_id: 't' } as never, { authenticatedUserId: 'owner', turnId: 'turn-1' } as never);
 expect(result).toMatchObject({ ok: true });
 expect(calls.some(url => url.includes('/threads/t'))).toBe(true);
 expect(calls.filter(url => url.includes('/attachments/'))).toEqual([]);
});
