import { expect, it, vi } from 'vitest';
import { signupPhoneProof } from '../src/identity/signup-phone-proof';
import type { SignupProgress } from '../src/identity/console-signup';
const progress: SignupProgress = {authUser:'00000000-0000-0000-0000-000000000001',emailVerified:true,csrf:'00000000-0000-0000-0000-000000000002',email:'one@test.invalid',inviteHash:'a'.repeat(64),phone:'+919876543210',expires:1800000900,phoneVerification:'not_configured',complete:false};
it('defaults to disabled without provider calls or database effects', async () => {
  const fetcher = vi.fn();
  const proof = signupPhoneProof({}, null, fetcher, () => 1800000000000);
  expect(await proof.start(progress)).toEqual({kind:'disabled'});
  expect(await proof.check(progress,'123456')).toEqual({kind:'disabled'});
  expect(await proof.cancel(progress)).toEqual({kind:'disabled'});
  expect(fetcher).not.toHaveBeenCalled();
});
const env={SUPABASE_PROJECT_URL:'https://db.test',SUPABASE_PUBLISHABLE_KEY:'synthetic-pub',WALDO_ROUTER_HMAC_SECRET:'synthetic-router'};
const service=`VA${'b'.repeat(32)}`,sid=`VE${'c'.repeat(32)}`;
const reference={service,sid,phone:progress.phone!};
const setup=(responses: unknown[])=>{
 const calls: {action:string,payload:Record<string,unknown>}[]=[];
 const fetcher=vi.fn(async (_input: RequestInfo | URL,init?:RequestInit)=>{
  const body=JSON.parse(String(init!.body));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.WALDO_ROUTER_HMAC_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const signature=Uint8Array.from(body.p_sig.match(/../g) as string[],b=>parseInt(b,16));
  expect(await crypto.subtle.verify('HMAC',key,signature,new TextEncoder().encode(`${body.p_at}.phoneproof.${body.p_action}.${body.p_payload}`))).toBe(true);
  calls.push({action:body.p_action,payload:JSON.parse(body.p_payload)});
  const result=responses.shift(); if(result instanceof Error)throw result;
  return Response.json(result);
 });
 const provider={service,start:vi.fn(async ()=>({kind:'pending' as const,reference})),check:vi.fn(async ()=>({kind:'approved' as const,reference}))};
 return {calls,fetcher,provider,proof:signupPhoneProof(env,provider,fetcher,()=>1800000000000)};
};
it('reserves send before provider and persists matching pending evidence without owner/session RPCs',async()=>{
 const s=setup([{kind:'reserved'},{kind:'pending'}]);
 s.provider.start.mockImplementation(async()=>{expect(s.calls.map(c=>c.action)).toEqual(['reserve_send']);return {kind:'pending',reference};});
 expect(await s.proof.start(progress)).toEqual({kind:'pending'});
 expect(s.calls.map(c=>c.action)).toEqual(['reserve_send','finish_send']);
 expect(s.calls[0]!.payload.operation).toBe(s.calls[1]!.payload.operation);
 expect(s.calls[1]!.payload).toMatchObject({authUser:progress.authUser,attempt:progress.csrf,inviteHash:progress.inviteHash,phone:progress.phone,service,sid});
});
it('approval requires durable finalization and never persists the entered code',async()=>{
 const s=setup([{kind:'reserved',reference},{kind:'approved'}]);
 expect(await s.proof.check(progress,'123456')).toEqual({kind:'approved'});
 expect(s.provider.check).toHaveBeenCalledWith(reference,'123456');
 expect(s.calls.map(c=>c.action)).toEqual(['reserve_check','finish_check']);
 expect(JSON.stringify(s.calls)).not.toContain('123456');
});
it.each(['denied','expired','throttled','unknown'])('reservation %s makes zero provider calls',async kind=>{
 const s=setup([{kind}]);expect(await s.proof.start(progress)).toEqual({kind});expect(s.provider.start).not.toHaveBeenCalled();
});
it('bad/expired/unverified continuation is denied before database or provider',async()=>{
 const s=setup([]);
 for(const p of [{...progress,emailVerified:false},{...progress,authUser:null},{...progress,expires:1800000000},{...progress,phone:'bad'},{...progress,csrf:'bad'}])expect(await s.proof.start(p)).toEqual({kind:'denied'});
 expect(await s.proof.check(progress,'wrong')).toEqual({kind:'denied'});
 expect(s.fetcher).not.toHaveBeenCalled();expect(s.provider.start).not.toHaveBeenCalled();expect(s.provider.check).not.toHaveBeenCalled();
});
it('database uncertainty before reservation sends nothing and after provider cannot approve',async()=>{
 const before=setup([new Error('private database details')]);
 expect(await before.proof.start(progress)).toEqual({kind:'unknown'});expect(before.provider.start).not.toHaveBeenCalled();
 const after=setup([{kind:'reserved',reference},new Error('private database details')]);
 expect(await after.proof.check(progress,'123456')).toEqual({kind:'unknown'});expect(after.provider.check).toHaveBeenCalledTimes(1);
});
it('unknown provider effects finalize as unknown once without retry',async()=>{
 const s=setup([{kind:'reserved'},{kind:'unknown'}]);s.provider.start.mockRejectedValueOnce(new Error('private-provider-body'));
 expect(await s.proof.start(progress)).toEqual({kind:'unknown'});
 expect(s.provider.start).toHaveBeenCalledTimes(1);expect(s.calls[1]!.payload).toMatchObject({outcome:'unknown',sid:''});
});
it('foreign store reference or provider result cannot be adopted',async()=>{
 const badStore=setup([{kind:'reserved',reference:{...reference,phone:'+14155550100'}}]);
 expect(await badStore.proof.check(progress,'123456')).toEqual({kind:'unknown'});expect(badStore.provider.check).not.toHaveBeenCalled();
 const badProvider=setup([{kind:'reserved',reference},{kind:'unknown'}]);
 badProvider.provider.check.mockResolvedValueOnce({kind:'approved',reference:{...reference,sid:`VE${'d'.repeat(32)}`}});
 expect(await badProvider.proof.check(progress,'123456')).toEqual({kind:'unknown'});expect(badProvider.calls[1]!.payload.outcome).toBe('unknown');
});
it('cancel changes only durable state without delivery or owner RPCs',async()=>{
 const s=setup([{kind:'canceled'}]);expect(await s.proof.cancel(progress)).toEqual({kind:'canceled'});
 expect(s.calls.map(c=>c.action)).toEqual(['cancel']);expect(s.provider.start).not.toHaveBeenCalled();expect(s.provider.check).not.toHaveBeenCalled();
});
it('allows durable cancellation after continuation expiry without new provider calls',async()=>{
 const s=setup([{kind:'canceled'}]);
 expect(await s.proof.cancel({...progress,expires:1799999999})).toEqual({kind:'canceled'});
 expect(s.calls.map(c=>c.action)).toEqual(['cancel']);
 expect(s.provider.start).not.toHaveBeenCalled();expect(s.provider.check).not.toHaveBeenCalled();
});
