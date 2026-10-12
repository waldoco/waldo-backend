import { describe, expect, it, vi } from 'vitest';
import { adminRead, adminAction } from '../src/channels/dashboard-admin';
import { consoleAuth } from '../src/identity/console-auth';
import { routerSignature } from '../src/identity/owner-directory';
const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
const json = (v: unknown) => new Response(JSON.stringify(v));
const request = (action: string, csrf = 'csrf') => new Request('https://w.test/console/action', {method:'POST',headers:{accept:'application/json'},body:new URLSearchParams({action,csrf,value:'New@test.invalid',id:'invite-id'})});
describe('dashboard admin existing handlers', () => {
  it('returns a private 404 for non-admin without any rows or csrf', async () => {
    const fetcher=vi.fn(async()=>json(null));
    const response=await adminRead(consoleAuth(env,fetcher as typeof fetch)!, 'owner', 'csrf');
    expect(response.status).toBe(404); expect(await response.text()).not.toContain('csrf');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('reuses signed create with hashed code, returns code once only after success', async () => {
    const fetcher=vi.fn(async(_input: RequestInfo | URL, _init?: RequestInit)=>json(true));
    const response=await adminAction(request('invite.create'), 'csrf', consoleAuth(env,fetcher as typeof fetch,()=>1790000000000)!, 'owner');
    expect(response.status).toBe(200);
    const receipt=await response.json() as {code:string;message:string;link:string};
    expect(receipt.code).toMatch(/^[A-Z2-9]+$/);
    const link = new URL(receipt.link);
    expect(link.pathname).toBe('/console/signup');
    expect(link.search).toBe('');
    expect(new URLSearchParams(link.hash.slice(1)).get('invite')).toBe(receipt.code);
    expect(new URLSearchParams(link.hash.slice(1)).get('email')).toBe('new@test.invalid');
    expect(receipt.message).toContain('Copy it now and send it yourself. Waldo did not email anyone.');
    const args=JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(args.p_code_hash).toMatch(/^[a-f0-9]{64}$/); expect(args.p_code_hash).not.toBe(receipt.code);
    expect(args.p_sig).toBe(await routerSignature('router',1790000000,`invite.owner.new@test.invalid.${args.p_code_hash}`));
  });
  it('rejects invalid csrf without invoking RPC and keeps refused/stale actions failed', async () => {
    const fetcher=vi.fn(async()=>json(false)); const auth=consoleAuth(env,fetcher as typeof fetch)!;
    expect((await adminAction(request('invite.create','wrong'),'csrf',auth,'owner')).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    const failed=await adminAction(request('invite.create'),'csrf',auth,'owner');
    expect(failed.status).toBe(409); expect(await failed.text()).not.toContain('"code"');
    const stale=await adminAction(request('invite.revoke'),'csrf',auth,'owner');
    expect(stale.status).toBe(409);
  });
  it('reuses signed revoke and never returns a code or delivery claim',async()=>{
    const fetcher=vi.fn(async(_input: RequestInfo | URL, _init?: RequestInit)=>json(true));
    const response=await adminAction(request('invite.revoke'),'csrf',consoleAuth(env,fetcher as typeof fetch)!,'owner');
    expect(await response.json()).toEqual({message:'Invite revoked. Copy it now and send it yourself. Waldo did not email anyone.'});
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('admin_revoke');
  });
});

describe('actual owner DO admin route',()=>{
 it('keeps session isolation, JSON dispatch and CSRF ahead of signed writes',async()=>{
  const {env:bindings}=await import('cloudflare:workers');const {runInDurableObject}=await import('cloudflare:test');
  const {consoleAccess}=await import('../src/channels/console');
  const stub=bindings.TELEGRAM_OWNER_DO!.get(bindings.TELEGRAM_OWNER_DO!.idFromName('admin-json-test'));
  const other=bindings.TELEGRAM_OWNER_DO!.get(bindings.TELEGRAM_OWNER_DO!.idFromName('admin-json-other'));
  const token=await runInDurableObject(stub,(_instance,state)=>consoleAccess(state.storage).grant());
  const cookie=`waldo_console=${token}`;
  expect((await other.fetch('https://w.test/console/admin',{headers:{cookie,accept:'application/json'}})).status).toBe(401);
  await runInDurableObject(stub,async(instance,state)=>{
   const host=instance as unknown as {env:Record<string,unknown>;fetch:(r:Request)=>Promise<Response>};
   Object.assign(host.env,env);state.storage.kv.put('do_name','admin-json-test');
   const session=await consoleAccess(state.storage).session(token);
   const original=globalThis.fetch;const calls:RequestInit[]=[];
   globalThis.fetch=async(_input,init)=>{calls.push(init!);return json(calls.length===1?{owners:[],invites:[]}:true);};
   try{
    const read=await host.fetch(new Request('https://w.test/console/admin?owner=other',{headers:{cookie,accept:'application/json'}}));
    expect(read.status).toBe(200);expect((await read.json() as {csrf:string}).csrf).toBe(session!.csrf);
    expect(JSON.parse(String(calls[0]?.body)).p_do_name).toBe('admin-json-test');
    const post=(csrf:string)=>host.fetch(new Request('https://w.test/console/action',{method:'POST',headers:{cookie,accept:'application/json'},body:new URLSearchParams({action:'invite.create',csrf,value:'real-handler@test.invalid'})}));
    expect((await post('wrong')).status).toBe(403);expect(calls).toHaveLength(1);
    const created=await post(session!.csrf);expect(created.status).toBe(200);expect(await created.json()).toHaveProperty('code');expect(calls).toHaveLength(2);
    const revoked=await host.fetch(new Request('https://w.test/console/action',{method:'POST',headers:{cookie,accept:'application/json'},body:new URLSearchParams({action:'invite.revoke',csrf:session!.csrf,id:'hash-id'})}));
    expect(revoked.status).toBe(200);expect(calls).toHaveLength(3);expect(JSON.parse(String(calls[2]?.body)).p_invite).toBe('hash-id');
   }finally{globalThis.fetch=original;}
  });
 });
});

describe('malformed admin action',()=>{
 it('returns a structured invalid-action response for malformed multipart without a write',async()=>{
  const fetcher=vi.fn(async()=>json(true));
  const response=await adminAction(new Request('https://w.test/console/action',{method:'POST',headers:{'content-type':'multipart/form-data'},body:'broken'}),'csrf',consoleAuth(env,fetcher as typeof fetch)!,'owner');
  expect(response.status).toBe(400);expect(fetcher).not.toHaveBeenCalled();expect(await response.json()).toEqual({error:'invalid_action'});
 });
});
