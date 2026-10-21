import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {buildSessionState} from '@waldo/contracts';
import {googleProxy} from '../src/connectors/connections';
import {readDriveHandler} from '../src/tools/live/drive';
import {dispatchTool} from '../src/tools/dispatcher';
import {sanitise} from '../src/scribe/sanitiser';
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

const runtimeRead=async(args:unknown)=>{
 const proxy=googleProxy({SUPABASE_PROJECT_URL:'https://edge.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-key',WALDO_ROUTER_HMAC_SECRET:cfg.WALDO_ROUTER_HMAC_SECRET},async(raw,init)=>serve(new Request(raw,init)))!;
 const handler=readDriveHandler({client:async()=>proxy.client('owner','conn')},true);
 return dispatchTool({id:'drive-wire',name:'read_drive',args},{authenticatedUserId:'owner',turnId:'drive-turn',trigger:'user_message',session:buildSessionState({trigger:'user_message',canary_tokens:['1111111111111111','2222222222222222','3333333333333333'],started_at:1}),hasApproval:()=>false,sourceTaint:null,toolArgSourceTaint:null,sanitise},{handlers:[handler]});
};
it.each(['recent','search','get'])('actual dispatcher→Core handler→signed GoogleProxy→Edge→HTTP %s metadata read',async action=>{
 const f=fixture(undefined,200,action==='get'?{id:'f'.repeat(12),name:'Report',mimeType:'text/plain',contentSnippet:'PRIVATE_CANARY'}:undefined);
 const result=await runtimeRead({action,...(action==='search'?{name_contains:'Report'}:action==='get'?{file_id:'f'.repeat(12)}:{})});
 expect(result).toMatchObject({ok:true,source_taint:'external'});expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');expect(f.hops).toEqual(['proxy_access','token','drive','proxy_health']);
});
it.each([401,403])('actual wire provider %i maps meaningfully with external taint and no false consent',async status=>{
 const f=fixture(undefined,status,{error:{message:'PRIVATE_CANARY',errors:status===403?[{reason:'accessNotConfigured'}]:[]}});
 const result=await runtimeRead({action:'recent'});
 expect(result).toMatchObject(status===401?{ok:false,code:'auth_failed',connect:{reason:'reauth_needed',feature:'drive'},source_taint:'external'}:{ok:false,code:'rejected',source_taint:'external'});
 if(status===403){expect(result).not.toHaveProperty('connect');expect(result).toMatchObject({error:expect.stringContaining('drive_service_disabled')});}
 expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');expect(f.hops).toEqual(['proxy_access','token','drive']);
});

it('actual content rail denies metadata-only grants before refresh',async()=>{
 const f=fixture(['https://www.googleapis.com/auth/drive.metadata.readonly']);
 const r=await serve(await signed({...input,method:'driveReadFileContent',args:[{fileId:'document_123456',expectedModifiedTime:'2026-10-03T10:00:00Z'}]}));
 expect(await r.json()).toMatchObject({error:{status:403,message:'drive_scope_missing'}});expect(f.hops).toEqual(['proxy_access']);
});
it('proxy client exposes the bound account identity on metadata receipts',async()=>{
 const proxy=googleProxy({SUPABASE_PROJECT_URL:'https://edge.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-key',WALDO_ROUTER_HMAC_SECRET:cfg.WALDO_ROUTER_HMAC_SECRET},async(raw,init)=>serve(new Request(raw,init)))!;
 expect(proxy.client('owner','conn').account).toEqual({connection_id:'conn',email:null});
});
it('actual dispatcher to signed proxy reads actual Docs body with no result ledger or content logs',async()=>{
 const f=fixture();const original=fetch;const marker='Actual fixture document content';const at='2026-10-03T10:00:00Z';const id='document_123456';let metadataReads=0;
 vi.stubGlobal('fetch',vi.fn(async(raw:RequestInfo|URL,init?:RequestInit)=>{
  const u=new URL(String(raw));if(u.hostname==='www.googleapis.com'){f.hops.push('drive-content');if(u.searchParams.has('fields')){metadataReads++;return Response.json({id,name:'Plan',mimeType:'application/vnd.google-apps.document',modifiedTime:at,version:'17',capabilities:{canDownload:true}});}return new Response(marker,{headers:{'content-type':'text/plain'}});}return original(raw,init);
 }));
 const proxy=googleProxy({SUPABASE_PROJECT_URL:'https://edge.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-key',WALDO_ROUTER_HMAC_SECRET:cfg.WALDO_ROUTER_HMAC_SECRET},async(raw,init)=>serve(new Request(raw,init)))!;
 const handler=readDriveHandler({client:async()=>proxy.client('owner','conn')},true,true);
 const result=await dispatchTool({id:'content-wire',name:'read_drive',args:{action:'content',file_id:id,connection_id:'conn',expected_modified_time:at}},{authenticatedUserId:'owner',turnId:'content-turn',trigger:'user_message',session:buildSessionState({trigger:'user_message',canary_tokens:['1111111111111111','2222222222222222','3333333333333333'],started_at:1}),hasApproval:()=>false,sourceTaint:null,toolArgSourceTaint:null,sanitise},{handlers:[handler]});
 expect(result).toMatchObject({ok:true,source_taint:'external',data:{text:marker,account:{connection_id:'conn'},truncated:false}});expect(metadataReads).toBe(2);expect(JSON.stringify(f.log.mock.calls)).not.toContain(marker);expect(f.hops).not.toContain('proxy_idem_claim');expect(f.hops).not.toContain('proxy_idem_store');
});
it.each(['1111111111111111'])('unsafe document content stays external and is blocked: %s',async body=>{
 const f=fixture();const original=fetch;const at='2026-10-03T10:00:00Z';const id='document_123456';
 vi.stubGlobal('fetch',vi.fn(async(raw:RequestInfo|URL,init?:RequestInit)=>{const u=new URL(String(raw));if(u.hostname==='www.googleapis.com')return u.searchParams.has('fields')?Response.json({id,name:'Plan',mimeType:'text/plain',modifiedTime:at,version:'17',capabilities:{canDownload:true}}):new Response(body,{headers:{'content-type':'text/plain'}});return original(raw,init);}));
 const proxy=googleProxy({SUPABASE_PROJECT_URL:'https://edge.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-key',WALDO_ROUTER_HMAC_SECRET:cfg.WALDO_ROUTER_HMAC_SECRET},async(raw,init)=>serve(new Request(raw,init)))!;
 const h=readDriveHandler({client:async()=>proxy.client('owner','conn')},true,true);
 const result=await dispatchTool({id:'injection-wire',name:'read_drive',args:{action:'content',file_id:id,connection_id:'conn',expected_modified_time:at}},{authenticatedUserId:'owner',turnId:'content-turn',trigger:'user_message',session:buildSessionState({trigger:'user_message',canary_tokens:['1111111111111111','2222222222222222','3333333333333333'],started_at:1}),hasApproval:()=>false,sourceTaint:null,toolArgSourceTaint:null,sanitise},{handlers:[h]});
 expect(result.ok).toBe(false);expect(result).toMatchObject({code:'forbidden',error:'Google Drive content failed safety checks.'});expect(f.hops).not.toContain('proxy_idem_store');
});

it.each([{do_name:'foreign'},{connection:'foreign'},{}])('content foreign/revoked grants fail before provider: %j',async change=>{
 const f=fixture(undefined,200,undefined,Object.keys(change).length>0);const result=await serve(await signed({...input,...change,method:'driveReadFileContent',args:[{fileId:'document_123456',expectedModifiedTime:'2026-10-03T10:00:00Z'}]}));
 expect(await result.json()).toMatchObject({error:{status:401}});expect(f.hops).toEqual(['proxy_access']);
});
it('unsigned content request never accesses grant or provider',async()=>{const f=fixture();const result=await serve(new Request('https://edge.invalid',{method:'POST',body:JSON.stringify({...input,method:'driveReadFileContent',args:[{fileId:'document_123456',expectedModifiedTime:'2026-10-03T10:00:00Z'}]})}));expect(await result.json()).toMatchObject({error:{status:401}});expect(f.hops).toEqual([]);});
