import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {routerSignature} from '../src/identity/owner-directory';
let serve:(r:Request)=>Promise<Response>;
const cfg:Record<string,string>={SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',WALDO_ROUTER_HMAC_SECRET:'fixture-router',GOOGLE_CLIENT_ID:'fixture-client',GOOGLE_CLIENT_SECRET:'fixture-secret'};
beforeAll(async()=>{vi.stubGlobal('Deno',{env:{get:(n:string)=>cfg[n]},serve:(h:typeof serve)=>{serve=h;}});await import('../../../supabase/functions/connector-proxy/index.ts');});
afterEach(()=>{vi.restoreAllMocks();});afterAll(()=>vi.unstubAllGlobals());
const signed=async(body:unknown)=>{const raw=JSON.stringify(body);const at=Math.floor(Date.now()/1000);const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(v=>v.toString(16).padStart(2,'0')).join('');return new Request('https://edge.invalid',{method:'POST',body:raw,headers:{'x-waldo-at':String(at),'x-waldo-sig':await routerSignature(cfg.WALDO_ROUTER_HMAC_SECRET!,at,`proxy.${digest}`)}});};
const input={do_name:'owner',op:'call',connection:'conn',method:'driveListFiles',args:[{}]};
const fixture=(scope:unknown=['https://www.googleapis.com/auth/drive.readonly'],status=200,provider:unknown={files:[{id:'f',name:'Report',mimeType:'text/plain',contentSnippet:'PRIVATE_CANARY'}]},active=true)=>{
 const hops:string[]=[];const log=vi.spyOn(console,'log').mockImplementation(()=>{});
 vi.stubGlobal('fetch',vi.fn(async(raw:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(raw);if(url.startsWith('https://db.invalid/')){
   const fn=url.split('/').at(-1)!;hops.push(fn);const body=JSON.parse(String(init?.body??'{}'));
   if(fn==='proxy_access')return Response.json(active&&body.p_do_name==='owner'&&body.p_connection==='conn'?[{secret:'fixture-refresh',scopes:scope}]:[]);
   if(fn==='proxy_health')return Response.json(true);
   throw new Error('unexpected DB path: '+fn);
  }
  if(url==='https://oauth2.googleapis.com/token'){hops.push('token');return Response.json({access_token:'fixture-access'});}
  if(url.startsWith('https://www.googleapis.com/drive/v3/files')){hops.push('drive');return Response.json(provider,{status});}
  throw new Error('unexpected HTTP path');
 }));
 return {hops,log};
};
it.each(['driveListFiles','driveSearchFiles','driveGetFileMetadata'])('signed actual Edge %s returns projected metadata with no ledger',async method=>{
 const f=fixture(undefined,200,method==='driveGetFileMetadata'?{id:'f',name:'Report',mimeType:'text/plain',description:'PRIVATE_CANARY'}:undefined);
 const args=method==='driveSearchFiles'?{nameContains:'Report'}:method==='driveGetFileMetadata'?{fileId:'f'}:{};
 const response=await serve(await signed({...input,method,args:[args]}));expect(response.status).toBe(200);expect(JSON.stringify(await response.json())).not.toContain('PRIVATE_CANARY');expect(f.hops).toEqual(['proxy_access','token','drive','proxy_health']);
});
it('existing metadata-only scope works while absent scopes reject before token',async()=>{
 const f=fixture(['https://www.googleapis.com/auth/drive.metadata.readonly']);expect((await serve(await signed(input))).status).toBe(200);expect(f.hops).toContain('drive');
 for(const s of [null,[],['https://www.googleapis.com/auth/gmail.readonly']]){const f=fixture(s);const r=await serve(await signed(input));expect(await r.json()).toMatchObject({error:{message:'drive_scope_missing'}});expect(f.hops).toEqual(['proxy_access']);}
});
it('foreign or revoked grant and unsigned calls never touch token or provider',async()=>{
 for(const body of [{...input,connection:'foreign'},{...input,do_name:'foreign'}]){const f=fixture();expect(await (await serve(await signed(body))).json()).toMatchObject({error:{status:401}});expect(f.hops).toEqual(['proxy_access']);}
 const f=fixture(undefined,200,undefined,false);expect(await (await serve(await signed(input))).json()).toMatchObject({error:{status:401}});expect(f.hops).toEqual(['proxy_access']);
 const g=fixture();expect(await (await serve(new Request('https://edge.invalid',{method:'POST',body:JSON.stringify(input)}))).json()).toMatchObject({error:{status:401}});expect(g.hops).toEqual([]);
});
it('forged content arguments and arity reject without token or result persistence',async()=>{
 for(const args of [[{alt:'media'}],[{fileId:'f'},'extra'],[]]){const f=fixture();const r=await serve(await signed({...input,args}));expect(await r.json()).toMatchObject({error:{status:400,message:'drive_invalid_request'}});expect(f.hops).toEqual(['proxy_access']);}
});
it.each([401,403])('provider %i remains typed, redacted and no result or private log',async status=>{
 const f=fixture(undefined,status,{error:{message:'PRIVATE_CANARY'}});const r=await serve(await signed(input));expect(await r.json()).toEqual({error:{status,message:status===401?'drive_auth_failed':'drive_access_denied'}});expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_CANARY');expect(f.hops).toEqual(['proxy_access','token','drive']);
});
it('structured API-disabled 403 is actionable without claiming scope failure',async()=>{
 const f=fixture(undefined,403,{error:{message:'PRIVATE_CANARY',errors:[{reason:'accessNotConfigured'}]}});const r=await serve(await signed(input));expect(await r.json()).toEqual({error:{status:403,message:'drive_service_disabled'}});expect(JSON.stringify(f.log.mock.calls)).toContain('drive_service_disabled');expect(f.hops).toEqual(['proxy_access','token','drive']);
});
