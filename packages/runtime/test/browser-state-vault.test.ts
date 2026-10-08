import {expect,it,vi} from 'vitest';
import {browserStateVault} from '../src/connectors/browser-state-vault';
import {routerSignature} from '../src/identity/owner-directory';
const scope={binding:{ownerId:'10000000-0000-0000-0000-000000000001',environment:'staging',siteOrigin:'https://account.example',accountId:'Actual',generation:1},consentRevision:'10000000-0000-0000-0000-000000000002',custodyDigest:'a'.repeat(64),expiresAt:Date.now()+600000,namespace:'fixture',doId:'physical',subject:'81101',sitePolicy:{origins:['https://account.example'],cookieDomains:['account.example']}};
it('direct Vault custody restores native state and pins revisions without persisting state in a DO',async()=>{
 let saved:string|null=null,revision=0;const env={SUPABASE_PROJECT_URL:'https://vault.invalid',SUPABASE_PUBLISHABLE_KEY:'synthetic-public',WALDO_ROUTER_HMAC_SECRET:'synthetic-router'};
 const network=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{expect(String(input)).toBe('https://vault.invalid/functions/v1/connector-proxy');const raw=String(init?.body),headers=new Headers(init?.headers),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(v=>v.toString(16).padStart(2,'0')).join('');expect(headers.get('x-waldo-sig')).toBe(await routerSignature('synthetic-router',Number(headers.get('x-waldo-at')),`proxy.${hash}`));expect(headers.get('content-type')).toBe('application/vnd.waldo.browser-state+json');const body=JSON.parse(raw);expect(body.scope).toEqual(scope);if(body.action==='save'){expect(body.expected_revision).toBe(revision);saved=body.state;revision++;return Response.json({data:{saved:true,revision}});}return Response.json({data:{state:saved,revision}});});
 const make=()=>browserStateVault({env,doName:'owner',scope,fetcher:network,assertCurrent:async()=>{}});
 const first=make();expect(await first.load()).toBe(null);await first.save(new TextEncoder().encode(JSON.stringify({cookies:[{domain:'account.example',value:'SYNTHETIC_AUTH'}],origins:[]})));
 const recreated=make();expect(new TextDecoder().decode((await recreated.load())!)).toContain('SYNTHETIC_AUTH');await recreated.save(new TextEncoder().encode(JSON.stringify({cookies:[],origins:[]})));expect(revision).toBe(2);
});
it('withdrawn owner prevents calls and lost save acknowledgements are not retried',async()=>{
 let active=true,calls=0;const network=vi.fn(async()=>{calls++;if(calls===1)return Response.json({data:{state:null,revision:0}});throw Error('Lost SYNTHETIC_AUTH');});
 const custody=browserStateVault({env:{SUPABASE_PROJECT_URL:'https://vault.invalid',SUPABASE_PUBLISHABLE_KEY:'synthetic',WALDO_ROUTER_HMAC_SECRET:'synthetic'},doName:'owner',scope,fetcher:network,assertCurrent:async()=>{if(!active)throw Error('Owner changed');}});
 await custody.load();await expect(custody.save(new TextEncoder().encode('{"cookies":[],"origins":[]}'))).rejects.toThrow('browser_state_unavailable');expect(calls).toBe(2);active=false;await expect(custody.load()).rejects.toThrow('browser_state_unavailable');expect(calls).toBe(2);
});

it('withdrawal during signing prevents persistence I/O',async()=>{
 let checks=0;const network=vi.fn();const custody=browserStateVault({env:{SUPABASE_PROJECT_URL:'https://vault.invalid',SUPABASE_PUBLISHABLE_KEY:'synthetic',WALDO_ROUTER_HMAC_SECRET:'synthetic'},doName:'owner',scope,fetcher:network,assertCurrent:async()=>{if(++checks===2)throw Error('withdrawn after signing');}});
 await expect(custody.load()).rejects.toThrow('browser_state_unavailable');expect(checks).toBe(2);expect(network).not.toHaveBeenCalled();
});

it('expiry during delayed load rejects restored native state',async()=>{
 let now=1000,arrive!:()=>void;const waiting=new Promise<void>(yes=>{arrive=yes;});const network=vi.fn(async()=>{await waiting;return Response.json({data:{state:'{"cookies":[],"origins":[]}',revision:1}});});
 const custody=browserStateVault({env:{SUPABASE_PROJECT_URL:'https://vault.invalid',SUPABASE_PUBLISHABLE_KEY:'synthetic',WALDO_ROUTER_HMAC_SECRET:'synthetic'},doName:'owner',scope:{...scope,expiresAt:2000},fetcher:network,now:()=>now,assertCurrent:async()=>{}});
 const load=custody.load();while(!network.mock.calls.length)await new Promise(yes=>setTimeout(yes,0));now=2000;arrive();await expect(load).rejects.toThrow('browser_state_unavailable');expect(network).toHaveBeenCalledTimes(1);
});
