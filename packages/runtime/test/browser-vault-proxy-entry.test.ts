import {beforeAll,afterAll,afterEach,expect,it,vi} from 'vitest';
import {routerSignature} from '../src/identity/owner-directory';
let serve:(request:Request)=>Promise<Response>;
const cfg:Record<string,string>={SUPABASE_URL:'https://vault.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',WALDO_ROUTER_HMAC_SECRET:'synthetic-router'};
const scope={binding:{ownerId:'10000000-0000-0000-0000-000000000001',environment:'staging',siteOrigin:'https://account.example',accountId:'CaseSensitive',generation:1},consentRevision:'10000000-0000-0000-0000-000000000002',custodyDigest:'a'.repeat(64),expiresAt:Date.now()+600000,namespace:'fixture',doId:'physical',subject:'81101',sitePolicy:{origins:['https://account.example'],cookieDomains:['account.example']}};
beforeAll(async()=>{vi.stubGlobal('Deno',{env:{get:(n:string)=>cfg[n]},serve:(fn:typeof serve)=>{serve=fn;}});await import('../../../supabase/functions/connector-proxy/index.ts');});
afterEach(()=>vi.restoreAllMocks());afterAll(()=>vi.unstubAllGlobals());
const signed=async(body:any,delta=0)=>{const raw=JSON.stringify(body),at=Math.floor(Date.now()/1000)+delta,hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(b=>b.toString(16).padStart(2,'0')).join('');return new Request('https://edge.invalid',{method:'POST',headers:{'content-type':'application/vnd.waldo.browser-state+json','x-waldo-at':String(at),'x-waldo-sig':await routerSignature(cfg.WALDO_ROUTER_HMAC_SECRET!,at,`proxy.${hash}`)},body:raw});};
it('signed browser state uses direct existing Vault custody without Google config, keys, or Google transport',async()=>{
 let state:string|null=null,revision=0;const calls:any[]=[];
 const network=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{expect(String(input)).toBe('https://vault.invalid/rest/v1/rpc/proxy_browser_state');expect(new Headers(init?.headers).get('apikey')).toBe('synthetic-service');const body=JSON.parse(String(init?.body));calls.push(body);expect(body.p_scope).toEqual(scope);if(body.p_action==='save'){state=body.p_state;revision++;return Response.json({revision,saved:true});}return Response.json({state,revision});});
 const native=JSON.stringify({cookies:[{domain:'account.example',name:'session',value:'SYNTHETIC_AUTH'}],origins:[]});
 const save=await serve(await signed({op:'browser_state',action:'save',do_name:'owner',scope,state:native,expected_revision:0}));expect(await save.json()).toMatchObject({data:{saved:true,revision:1}});
 const load=await serve(await signed({op:'browser_state',action:'load',do_name:'owner',scope}));expect(await load.json()).toMatchObject({data:{state:native,revision:1}});expect(calls).toHaveLength(2);expect(network).toHaveBeenCalledTimes(2);
});
it('unsigned, stale, expired and extra-field browser custody requests never reach Vault',async()=>{
 const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No network expected'));
 const body={op:'browser_state',action:'load',do_name:'owner',scope};
 for(const req of [new Request('https://edge.invalid',{method:'POST',headers:{'content-type':'application/vnd.waldo.browser-state+json'},body:JSON.stringify(body)}),await signed(body,-301),await signed({...body,scope:{...scope,expiresAt:Date.now()-1}}),await signed({...body,unexpected:'SYNTHETIC_AUTH'})]){expect(await(await serve(req)).json()).toHaveProperty('error');}
 expect(network).not.toHaveBeenCalled();
});
it('native state is filtered to approved site and provider failures never enter errors or logs',async()=>{
 const log=vi.spyOn(console,'log').mockImplementation(()=>{}),network=vi.spyOn(globalThis,'fetch').mockImplementation(async(_i,init)=>{const body=JSON.parse(String(init?.body));expect(JSON.parse(body.p_state).cookies).toEqual([]);throw Error('SYNTHETIC_AUTH database-detail');});
 const response=await serve(await signed({op:'browser_state',action:'save',do_name:'owner',scope,state:JSON.stringify({cookies:[{domain:'other.example',value:'SYNTHETIC_AUTH'}],origins:[]}),expected_revision:0}));
 expect(JSON.stringify(await response.json())).not.toContain('SYNTHETIC_AUTH');expect(JSON.stringify(log.mock.calls)).not.toContain('SYNTHETIC_AUTH');expect(network).toHaveBeenCalledTimes(1);
});
