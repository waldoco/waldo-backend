import {expect,it,vi} from 'vitest';
import {ownerDirectory} from '../src/identity/owner-directory';
import {parseCodedSetup} from '../src/channels/telegram-link-command';
const env={SUPABASE_PROJECT_URL:'https://db.test',SUPABASE_PUBLISHABLE_KEY:'pub',WALDO_ROUTER_HMAC_SECRET:'router'};
const hash='a'.repeat(64);
it('keeps authoritative redeemed separate from later absent presence',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json('10000000-0000-0000-0000-00000000000a')).mockResolvedValueOnce(Response.json([]));
 const d=ownerDirectory(env,fetcher);expect(await d.redeemHashed!('telegram','42',hash)).toEqual({kind:'redeemed'});expect(await d.byPresence('telegram','42')).toBeNull();expect(fetcher).toHaveBeenCalledTimes(2);
});
it('null is rejected but exception is uncertain and never retried',async()=>{
 const rejected=vi.fn(async()=>Response.json(null));expect(await ownerDirectory(env,rejected).redeemHashed!('telegram','42',hash)).toEqual({kind:'rejected'});
 const failed=vi.fn(async()=>{throw new Error('lost response')});expect(await ownerDirectory(env,failed).redeemHashed!('telegram','42',hash)).toEqual({kind:'uncertain'});expect(failed).toHaveBeenCalledTimes(1);
});
it('passes only normalized hash and never performs an implicit route read',async()=>{
 const f=vi.fn(async()=>Response.json('10000000-0000-0000-0000-00000000000a'));await ownerDirectory(env,f).redeemHashed!('telegram','42',hash);expect(f).toHaveBeenCalledTimes(1);expect(JSON.parse(String((f.mock.calls[0] as unknown as [string,RequestInit])[1].body))).toMatchObject({p_code_hash:hash,p_provider:'telegram',p_subject:'42'});
});
it('coded setup accepts exact issuer format once and rejects groups/mismatch/extra terms',()=>{
 const message=(text:string)=>({update_id:1,message:{from:{id:42},chat:{id:42,type:'private'},text}});
 expect(parseCodedSetup(message(' /link abcdefgh23 '))).toMatchObject({subject:'42',updateId:1,code:'ABCDEFGH23'});
 for(const text of ['/start WRONG1','/link ABCDEFGH23 extra','/link I123456789','/link '+ 'A'.repeat(64000)])expect(parseCodedSetup(message(text))).toBeNull();
 expect(parseCodedSetup({...message('/start ABCDEFGH23'),message:{...message('/start ABCDEFGH23').message,chat:{id:-1,type:'group'}}})).toBeNull();
 expect(parseCodedSetup({...message('/link ABCDEFGH23'),update_id:-1})).toBeNull();
});

it('malformed nonempty RPC result is uncertain, not redeemed',async()=>{const f=vi.fn(async()=>Response.json('not-a-uuid'));expect(await ownerDirectory(env,f).redeemHashed!('telegram','42',hash)).toEqual({kind:'uncertain'})});
it('directory fetch has the same bounded abort signal as webhook admission',async()=>{let signal:AbortSignal|undefined;const f=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{signal=init?.signal as AbortSignal;throw Error('aborted')});expect(await ownerDirectory(env,f as typeof fetch).redeemHashed!('telegram','42',hash)).toEqual({kind:'uncertain'});expect(signal).toBeInstanceOf(AbortSignal)});
it('hung adapter times out at existing10sbound and redemption is uncertain exactly once',async()=>{
 const f=vi.fn(async()=>new Promise<Response>(()=>{}));const start=Date.now();expect(await ownerDirectory(env,f as typeof fetch).redeemHashed!('telegram','42',hash)).toEqual({kind:'uncertain'});expect(f).toHaveBeenCalledTimes(1);expect(Date.now()-start).toBeLessThan(12000);
},15000);
