import {expect,it} from 'vitest';
import {ownerPrivateBrowserHost} from '../src/channels/owner-private-browser-host';
it('owner confirmation page shows exact registered scope and uses one-use JSON CSRF actions',async()=>{
 const rows=new Map<string,any>(),storage={kv:{get:(k:string)=>rows.get(k),put:(k:string,v:any)=>rows.set(k,v),delete:(k:string)=>rows.delete(k)},transactionSync:<T>(f:()=>T)=>f()} as unknown as DurableObjectStorage;
 const host=ownerPrivateBrowserHost({storage,environment:'staging',registration:{siteOrigin:'https://account.example',accountId:'Actual account <script>',expiresAt:Date.now()+600000,sitePolicy:{origins:['https://account.example'],cookieDomains:['account.example']},allowedDomains:['account.example']} as any,configuration:async()=>undefined,assertOwner:async()=>({directoryOwnerId:'10000000-0000-0000-0000-000000000001',custodyDigest:'synthetic'}),now:Date.now});
 const response=await host.control(new Request('https://owner.invalid/console/browser/saved',{headers:{accept:'text/html'}}),'owner-csrf');expect(response.headers.get('content-type')).toContain('text/html');const html=await response.text();expect(html).toContain('https://account.example');expect(html).toContain('Actual account &lt;script&gt;');expect(html).toContain('owner-csrf');expect(html).toContain('application/json');expect(html).toContain('sign_in');expect(html).toContain('revoke');expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");expect(html).not.toContain('value="Actual account <script>');
});
it('unconfigured private console is dark without resolving custody or contacting Vault',async()=>{
 const rows=new Map<string,any>(),storage={kv:{get:(k:string)=>rows.get(k),put:(k:string,v:any)=>rows.set(k,v),delete:(k:string)=>rows.delete(k)},transactionSync:<T>(f:()=>T)=>f()} as unknown as DurableObjectStorage;
 let checks=0;const host=ownerPrivateBrowserHost({storage,environment:'staging',configuration:async()=>undefined,assertOwner:async()=>{checks++;throw Error('No custody activation');},now:Date.now});
 expect((await host.control(new Request('https://owner.invalid/console/browser/saved'),'csrf')).status).toBe(404);expect(checks).toBe(0);
});
