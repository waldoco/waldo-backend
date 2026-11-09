import {expect,it} from 'vitest';
import {browserHandoffConsole} from '../src/channels/browser-handoff-console';
function fixture(){let minted=0,cancelled=0,allowed=true,current=true;
 const options={csrf:'fictional-csrf',ownerScope:'fictional-owner',limiter:{limit:async()=>({success:allowed})},assertConsole:async()=>{if(!current)throw Error('revoked');},status:async()=>({state:'pending',origin:'https://account.fixture.invalid:8443',reason:'Owner <login>',expiresAt:Date.now()+1000}),open:async()=>{minted++;return 'https://live.browser.run/ui/view?mode=tab&wss=FICTIONAL_BEARER';},cancel:async()=>{cancelled++;}};
 const request=(body='csrf=fictional-csrf&action=open',origin='https://fixture.invalid')=>new Request('https://fixture.invalid/console/browser-handoff',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body});
 return {options,request,minted:()=>minted,cancelled:()=>cancelled,rateLimit:()=>{allowed=false;},revoke:()=>{current=false;}};
}
it('GET preview neither mints a viewer nor exposes a bearer and escapes reason/origin',async()=>{
 const f=fixture(),res=await browserHandoffConsole(new Request('https://fixture.invalid/console/browser-handoff'),f.options),html=await res.text();
 expect(res.status).toBe(200);expect(f.minted()).toBe(0);expect(html).not.toContain('FICTIONAL_BEARER');expect(html).toContain('https://account.fixture.invalid:8443');expect(html).toContain('Owner &lt;login&gt;');expect(res.headers.get('cache-control')).toContain('no-store');expect(res.headers.get('referrer-policy')).toBe('no-referrer');
});
it('POST admission rejects origin, CSRF, duplicates, unsupported action and rate limit before minting',async()=>{
 const f=fixture();for(const request of [f.request(undefined,'https://attacker.invalid'),f.request('csrf=bad&action=open'),f.request('csrf=fictional-csrf&csrf=fictional-csrf&action=open'),f.request('csrf=fictional-csrf&action=unknown')])expect((await browserHandoffConsole(request,f.options)).status).toBeGreaterThanOrEqual(400);
 f.rateLimit();expect((await browserHandoffConsole(f.request(),f.options)).status).toBe(429);expect(f.minted()).toBe(0);
});
it('owner-authorized POST returns bearer only in private console HTML; revoked console does not',async()=>{
 const f=fixture();const res=await browserHandoffConsole(f.request(),f.options);expect(res.status).toBe(200);expect(await res.text()).toContain('src="https://live.browser.run/ui/view?mode=tab&amp;wss=FICTIONAL_BEARER"');expect(f.minted()).toBe(1);
 f.revoke();expect((await browserHandoffConsole(f.request(),f.options)).status).toBe(409);expect(f.minted()).toBe(1);
});
it('cancel uses the same POST admission without minting',async()=>{
 const f=fixture();expect((await browserHandoffConsole(f.request('csrf=fictional-csrf&action=cancel'),f.options)).status).toBe(200);expect(f.cancelled()).toBe(1);expect(f.minted()).toBe(0);
});
