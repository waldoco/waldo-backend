import { linkCodeHash } from '../src/identity/owner-directory';
import { describe, expect, it, vi } from 'vitest';
import { appTranscriptPage, handleApp } from '../src/channels/app-api';
import type { ConsoleAuth } from '../src/identity/console-auth';

const SESSION = 'a'.repeat(32);
const CREDENTIAL = `owner-1.${SESSION}.sig`;

const fakeAuth = (over: Partial<ConsoleAuth> = {}) => {
  const calls: string[] = [];
  let revoked = false;
  const auth = {
    throttle: async () => true,
    sendCode: async (email: string) => { calls.push(`send:${email}`); return email === 'member@example.test'; },
    verify: async (email: string, code: string) => (email === 'member@example.test' && code === '123456' ? 'owner-1' : null),
    ownerAppCredential: async () => CREDENTIAL,
    readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null),
    listSessions: async () => revoked ? [] : [{session:await linkCodeHash(SESSION),created_at:new Date().toISOString(),last_seen_at:new Date().toISOString()}],
    revokeSession: async () => { calls.push('revoke'); revoked=true; return true; },
    ...over,
  } as unknown as ConsoleAuth;
  return { auth, calls };
};
const forwards: Request[] = [];
const env = () => ({
  TELEGRAM_OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async (r: Request) => { forwards.push(r); return Response.json({ forwarded: true }); } }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) },
  SUPABASE_PROJECT_URL:'https://directory.fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'fictional-public-key',WALDO_ROUTER_HMAC_SECRET:'fictional-router-secret-00000000000000000',
}) as never;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://w.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('app sign-in and main chat routes', () => {
  it('ignores paths outside /app/v1', async () => {
    expect(await handleApp(new Request('https://w.test/console'), env(), fakeAuth().auth)).toBeNull();
  });
  it('answers a code request the same for invited and unknown addresses', async () => {
    const { auth } = fakeAuth();
    const known = await handleApp(post('/app/v1/auth/code', { email: 'member@example.test' }), env(), auth);
    const unknown = await handleApp(post('/app/v1/auth/code', { email: 'stranger@example.test' }), env(), auth);
    expect([known!.status, await known!.json()]).toEqual([200, { ok: true }]);
    expect([unknown!.status, await unknown!.json()]).toEqual([200, { ok: true }]);
  });
  it('verifies a code into the console session artifact and labels the surface app', async () => {
    const response = await handleApp(post('/app/v1/auth/verify', { email: 'member@example.test', code: '123456' }), env(), fakeAuth().auth);
    expect(await response!.json()).toMatchObject({ state: 'active', credential: CREDENTIAL, surface: 'app' });
    expect(response!.headers.get('cache-control')).toBe('no-store');
  });
  it('says needs_invite for a wrong code without opening a session', async () => {
    const ownerAppCredential = vi.fn(async () => CREDENTIAL);
    const response = await handleApp(post('/app/v1/auth/verify', { email: 'member@example.test', code: '000000' }), env(), fakeAuth({ ownerAppCredential }).auth);
    expect(await response!.json()).toEqual({ state: 'needs_invite' });
    expect(ownerAppCredential).not.toHaveBeenCalled();
  });
  it('rejects without a valid credential, generically', async () => {
    const response = await handleApp(new Request('https://w.test/app/v1/session'), env(), fakeAuth().auth);
    expect([response!.status, await response!.json()]).toEqual([401, { error: 'unavailable' }]);
    const bad = await handleApp(new Request('https://w.test/app/v1/session', { headers: { authorization: 'Bearer not-a-real-credential-value' } }), env(), fakeAuth().auth);
    expect(bad!.status).toBe(401);
  });
  it('fails closed when the session check is unavailable', async () => {
    const readAppCredential = async () => { throw new Error('down'); };
    const response = await handleApp(new Request('https://w.test/app/v1/session', { headers: { authorization: `Bearer ${CREDENTIAL}` } }), env(), fakeAuth({ readAppCredential }).auth);
    expect(response!.status).toBe(503);
  });
  it('signs out by revoking exactly its own session', async () => {
    const { auth, calls } = fakeAuth();
    const push=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(0));
    const response = await handleApp(post('/app/v1/auth/signout', {}, { authorization: `Bearer ${CREDENTIAL}` }), env(), auth);
    push.mockRestore();
    expect(await response!.json()).toEqual({ result: 'revoked' });
    expect(calls).toContain('revoke');
  });
  it('forwards chat calls to the credential owner DO and never takes an owner id from the client', async () => {
    forwards.length = 0;
    const response = await handleApp(post('/app/v1/chat/main/messages', { client_message_id: 'c1', text: 'hi', owner: 'someone-else' }, { authorization: `Bearer ${CREDENTIAL}` }), env(), fakeAuth().auth);
    expect(await response!.json()).toEqual({ forwarded: true });
    expect(forwards[0]!.headers.get('x-waldo-do-name')).toBe('owner-1');
    expect(new URL(forwards[0]!.url).pathname).toBe('/app/v1/chat/main/messages');
  });
  it('rate limits chat sends per owner and fails closed without the limiter', async () => {
    const auth = fakeAuth().auth;
    const limited = { ...(env() as object), RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: false }) } } as never;
    const send = () => post('/app/v1/chat/main/messages', { client_message_id: 'client-msg-0001', text: 'hi' }, { authorization: `Bearer ${CREDENTIAL}` });
    expect((await handleApp(send(), limited, auth))!.status).toBe(429);
    const absent = { ...(env() as object), RESPONSIBILITY_RATE_LIMITER: undefined } as never;
    expect((await handleApp(send(), absent, auth))!.status).toBe(503);
  });
  it('rate limits protected reads before forwarding or exposing inventory', async () => {
    const auth=fakeAuth().auth,limited={...(env() as object),RESPONSIBILITY_RATE_LIMITER:{limit:async()=>({success:false})}} as never;
    for(const path of ['/session','/chat/main','/chat/main/messages/client-msg-0001','/controls?view=day','/actions/action-id-0001']) {
      expect((await handleApp(new Request(`https://w.test/app/v1${path}`,{headers:{authorization:`Bearer ${CREDENTIAL}`}}),limited,auth))!.status).toBe(429);
    }
  });
  it('forwards approval reads and decisions to the credential owner DO, with decisions in their own rate bucket', async () => {
    forwards.length = 0; const keys: string[] = [];
    const counted = { ...(env() as object), RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } } } as never;
    const auth = fakeAuth().auth, bearer = { authorization: `Bearer ${CREDENTIAL}` };
    expect(await (await handleApp(new Request('https://w.test/app/v1/approvals?state=open', { headers: bearer }), counted, auth))!.json()).toEqual({ forwarded: true });
    const decision = { approval_id: 'p1', action: 'approve', expected_digest: `sha256:${'a'.repeat(64)}`, request_id: 'decision-0001', owner: 'someone-else' };
    expect(await (await handleApp(post('/app/v1/approvals/decisions', decision, bearer), counted, auth))!.json()).toEqual({ forwarded: true });
    expect(forwards.map(r => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`)).toEqual(['GET /app/v1/approvals?state=open', 'POST /app/v1/approvals/decisions']);
    expect(forwards.map(r => r.headers.get('x-waldo-do-name'))).toEqual(['owner-1', 'owner-1']);
    expect(keys).toEqual(['app-read:owner-1', 'app-approval-decision:owner-1']);
    expect((await handleApp(post('/app/v1/approvals', {}, bearer), counted, auth))!.status).toBe(405);
    expect((await handleApp(new Request('https://w.test/app/v1/approvals/decisions', { headers: bearer }), counted, auth))!.status).toBe(405);
    const anonymous = await handleApp(post('/app/v1/approvals/decisions', decision), counted, auth);
    expect([anonymous!.status, await anonymous!.json()]).toEqual([401, { error: 'unavailable' }]);
    const limited = { ...(env() as object), RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: false }) } } as never;
    expect((await handleApp(post('/app/v1/approvals/decisions', decision, bearer), limited, auth))!.status).toBe(429);
    expect(forwards).toHaveLength(2);
  });
  it('rate limits sign-in attempts', async () => {
    const limited = { ...(env() as object), RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: false }) } } as never;
    const response = await handleApp(post('/app/v1/auth/code', { email: 'member@example.test' }), limited, fakeAuth().auth);
    expect(response!.status).toBe(429);
  });
});

describe('main chat transcript page', () => {
  const entry = (n: number, role: 'user' | 'assistant', surface = 'telegram') => ({ id: `e${n}`, ownerId: 'o', chatId: 'c', parentId: null, threadAnchorId: null, surface, modelPayload: `m${n}`, appPayload: `text ${n}`, modelProjection: { mode: 'include' as const }, role });
  const all = Array.from({ length: 5 }, (_, i) => entry(i, i % 2 === 0 ? 'user' : 'assistant', i < 2 ? 'telegram' : 'app'));
  it('returns newest first with the channel label and a cursor for older rows', () => {
    const page = appTranscriptPage(all, null, 2);
    expect(page.messages.map(m => m.text)).toEqual(['text 4', 'text 3']);
    expect(page.messages[0]).toMatchObject({ id: 'e4', role: 'user', channel: 'app', parent_id: null, parts: [{ type: 'text', text: 'text 4' }] });
    expect(page.next_cursor).toBe('before:e3');
    const older = appTranscriptPage(all, page.next_cursor, 10);
    expect(older.messages.map(m => m.text)).toEqual(['text 2', 'text 1', 'text 0']);
    expect(older.messages[2]!.channel).toBe('telegram');
    expect(older.next_cursor).toBeNull();
  });
  it('attaches the approval parts presented for a run to the assistant reply to that run', () => {
    const part: import('../src/channels/surfaces/app').AppApprovalPart = { type: 'approval', approval_id: 'p1', kind: 'calendar_change', review: 'Proposed: Walk', payload_digest: `sha256:${'b'.repeat(64)}`, actions: ['approve', 'edit', 'skip'], expires_at: Date.UTC(2026, 9, 10, 15), fallback_text: 'Walk' };
    const user = entry(10, 'user', 'app'), first = { ...entry(11, 'assistant', 'app'), parentId: 'e10' }, reply = { ...entry(12, 'assistant', 'app'), parentId: 'e10' };
    const asked: string[] = [];
    const page = appTranscriptPage([user, first, reply], null, 10, parentId => { asked.push(parentId); return parentId === 'e10' ? { live: [part], fallbacks: [part.fallback_text] } : { live: [], fallbacks: [] }; });
    expect(page.messages[0]!.parts).toEqual([{ type: 'text', text: 'text 12' }, part]);
    expect(page.messages[1]!.parts).toEqual([{ type: 'text', text: 'text 11' }]);
    expect(page.messages[2]!.parts).toEqual([{ type: 'text', text: 'text 10' }]);
    expect(asked).toEqual(['e10']);
  });
  it('gives a reply that carries an approval part readable text of its own, for readers that drop the part', () => {
    const part: import('../src/channels/surfaces/app').AppApprovalPart = { type: 'approval', approval_id: 'p2', kind: 'google_task_change', review: 'Google task change to review', payload_digest: `sha256:${'c'.repeat(64)}`, actions: ['approve', 'edit', 'skip'], expires_at: Date.UTC(2026, 9, 10, 15), fallback_text: 'update Google task “Buy milk” in Errands (me@example.com).' };
    const user = entry(20, 'user', 'app'), silent = { ...entry(21, 'assistant', 'app'), parentId: 'e20', appPayload: '  ' };
    const [reply] = appTranscriptPage([user, silent], null, 10, () => ({ live: [part], fallbacks: [part.fallback_text] })).messages;
    expect(reply).toMatchObject({ id: 'e21', text: part.fallback_text, parts: [{ type: 'text', text: part.fallback_text }, part] });
    const spoken = { ...silent, appPayload: 'I prepared the task change.' };
    expect(appTranscriptPage([user, spoken], null, 10, () => ({ live: [part], fallbacks: [part.fallback_text] })).messages[0]).toMatchObject({ text: 'I prepared the task change.', parts: [{ type: 'text', text: 'I prepared the task change.' }, part] });
    const decided = appTranscriptPage([user, silent], null, 10, () => ({ live: [], fallbacks: [part.fallback_text] })).messages[0]!;
    expect(decided).toEqual({ id: 'e21', role: 'assistant', text: part.fallback_text, parts: [{ type: 'text', text: part.fallback_text }], channel: 'app', parent_id: 'e20' });
  });
  it('skips rows with no role and treats a bad cursor as the start', () => {
    const { role: _role, ...bare } = entry(9, 'user');
    expect(appTranscriptPage([bare as never, ...all], 'zzz', 50).messages).toHaveLength(5);
  });
});


it('requires valid fresh inventory for session DTO and push-first verified signout',async()=>{
  const headers={authorization:`Bearer ${CREDENTIAL}`};
  const missing=fakeAuth({listSessions:async()=>[]}).auth;
  expect((await handleApp(new Request('https://w.test/app/v1/session',{headers}),env(),missing))!.status).toBe(503);
  const stillLive=fakeAuth({revokeSession:async()=>true}).auth;
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(0));
  try{expect((await handleApp(post('/app/v1/auth/signout',{},headers),env(),stillLive))!.status).toBe(503);}finally{fetcher.mockRestore();}
  const {auth,calls}=fakeAuth();
  const failedPush=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({revoked:true}));
  try{expect((await handleApp(post('/app/v1/auth/signout',{},headers),env(),auth))!.status).toBe(503);expect(calls).not.toContain('revoke');}finally{failedPush.mockRestore();}
});

it('fences again once the session is revoked, and a failed second fence does not fail the signout',async()=>{
  const {auth,calls}=fakeAuth();
  const owners={idFromName:(n:string)=>n,get:()=>({fetch:async()=>{calls.push('fence');return new Response('{}',{status:calls.filter(call=>call==='fence').length===1?200:503});}})};
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{calls.push('push');return Response.json(0);});
  try{
    const response=await handleApp(post('/app/v1/auth/signout',{},{authorization:`Bearer ${CREDENTIAL}`}),{...env() as object,TELEGRAM_OWNER_DO:owners} as never,auth);
    expect([response!.status,await response!.json()]).toEqual([200,{result:'revoked'}]);
    expect(calls).toEqual(['fence','push','revoke','fence']);
  }finally{fetcher.mockRestore();}
});

it('fences the session\'s in-flight work before revoking it, and revokes nothing when the fence cannot be placed',async()=>{
  const fences:Request[]=[];
  const owners=(status:number)=>({idFromName:(n:string)=>n,get:()=>({fetch:async(r:Request)=>{fences.push(r);return new Response('{}',{status});}})});
  const headers={authorization:`Bearer ${CREDENTIAL}`};
  const withOwners=(status:number)=>({...env() as object,TELEGRAM_OWNER_DO:owners(status)}) as never;
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json(0));
  try{
    const failing=fakeAuth();
    expect((await handleApp(post('/app/v1/auth/signout',{},headers),withOwners(503),failing.auth))!.status).toBe(503);
    expect(failing.calls).not.toContain('revoke');
    expect(fences).toHaveLength(1);
    const url=new URL(fences[0]!.url);expect(url.pathname).toBe('/app/v1/internal/session-fence');
    expect(fences[0]!.method).toBe('POST');
    expect(fences[0]!.headers.get('x-waldo-do-name')).toBe('owner-1');
    expect(fences[0]!.headers.get('x-waldo-app-session-hash')).toMatch(/^[a-f0-9]{64}$/);
    expect(fences[0]!.headers.get('x-waldo-fence-sig')).toMatch(/^[a-f0-9]{16,}$/);
  }finally{fetcher.mockRestore();}
});
