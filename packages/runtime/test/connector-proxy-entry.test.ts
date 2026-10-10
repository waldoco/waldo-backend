import {afterEach,beforeAll,afterAll,expect,it,vi} from 'vitest';
import {routerSignature} from '../src/identity/owner-directory';
let serve:(request:Request)=>Promise<Response>;
const cfg:Record<string,string>={SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'fictional-service',WALDO_ROUTER_HMAC_SECRET:'fictional-router',GOOGLE_CLIENT_ID:'fictional-client',GOOGLE_CLIENT_SECRET:'fictional-secret'};
beforeAll(async()=>{
 vi.stubGlobal('Deno',{env:{get:(name:string)=>cfg[name]},serve:(handler:typeof serve)=>{serve=handler;}});
 await import('../../../supabase/functions/connector-proxy/index.ts');
});
afterEach(()=>{vi.restoreAllMocks();});
afterAll(()=>{vi.unstubAllGlobals();});
const request=async(body:unknown,at=Math.floor(Date.now()/1000))=>{
 const raw=JSON.stringify(body);const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 return new Request('https://edge.invalid',{method:'POST',body:raw,headers:{'x-waldo-at':String(at),'x-waldo-sig':await routerSignature(cfg.WALDO_ROUTER_HMAC_SECRET!,at,`proxy.${digest}`)}});
};
const fixture=()=>{
 const rows=new Map<string,{digest:string;result?:unknown;done?:boolean}>();const hops:string[]=[];let effects=0;let lost=false;let scopes:unknown=['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.compose','https://www.googleapis.com/auth/calendar.events'];let healthFail=false;let revoked=false;let active=true;let providerError='';
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);const args=url.startsWith('https://db.invalid/')?JSON.parse(String(init?.body??'{}')):{};const fn=url.split('/').at(-1)!;hops.push(fn);
  if(fn==='proxy_access')return Response.json(args.p_connection==='conn'&&args.p_do_name==='owner'&&!revoked&&active?[{secret:'fictional-refresh',scopes}]:[]);
  if(fn==='proxy_secret')return Response.json(args.p_connection==='conn'&&args.p_do_name==='owner'&&!revoked&&active? 'fictional-refresh':null);
  if(fn==='proxy_idem_claim'){
   if(args.p_connection!=='conn'||args.p_do_name!=='owner')return Response.json(null);
   const key=args.p_key;const prior=rows.get(key);if(!prior){rows.set(key,{digest:args.p_digest});return Response.json({state:'new'});}return Response.json(prior.digest!==args.p_digest?{state:'conflict'}:prior.done?{state:'done',result:prior.result}:{state:'pending'});
  }
  if(fn==='proxy_idem_store'){rows.get(args.p_key)!.result=args.p_result;rows.get(args.p_key)!.done=true;return Response.json(true);}
  if(fn==='proxy_health')return healthFail?new Response('failure',{status:503}):Response.json(true);
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'fictional-access'});
  if(url==='https://fixture.googleapis.com/mcp'||url==='https://drivemcp.googleapis.com/mcp/v1'){
   const rpc=JSON.parse(String(init?.body));if(rpc.method==='initialize')return Response.json({result:{protocolVersion:'2025-06-18'}});
   if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
   effects++;if(lost)throw new Error('synthetic response loss');if(providerError)return Response.json({result:{isError:true,content:[{type:'text',text:providerError}]}});return Response.json({result:{content:[{type:'text',text:'synthetic result'}]}});
  }
  if(url==='https://www.googleapis.com/calendar/v3/freeBusy'){const payload=JSON.parse(String(init?.body));return Response.json({timeMin:payload.timeMin,timeMax:payload.timeMax,calendars:Object.fromEntries(payload.items.map((item:{id:string})=>[item.id,{busy:[]}]))});}
  if(url.includes('www.googleapis.com/calendar/')){effects++;if(lost)throw new Error('synthetic response loss');return init?.method==='DELETE'?new Response(null,{status:204}):Response.json({id:'event-one',summary:'fixture',start:{dateTime:'2026-10-01T00:00:00Z'},end:{dateTime:'2026-10-01T01:00:00Z'}});}
  if(url.includes('gmail.googleapis.com')){effects++;if(lost)throw new Error('synthetic response loss');return Response.json({id:'provider-one'});}
  throw new Error('unexpected fictional transport');
 }));return{hops,rows,effects:()=>effects,lose:()=>{lost=true;},scope:(value:unknown)=>{scopes=value;},healthFail:()=>{healthFail=true;},revoke:()=>{revoked=true;},suspend:()=>{active=false;},providerError:(text:string)=>{providerError=text;}};
};
const body={do_name:'owner',op:'call',connection:'conn',method:'sendRaw',args:['ZmljdGlvbmFs'],intent_id:'approval:one'};
it('real signed entry claims before provider and replays stored receipt without second dispatch',async()=>{
 const f=fixture();const first=await serve(await request(body));expect(await first.json()).toEqual({data:{message_id:'provider-one'}});expect(f.hops.indexOf('proxy_idem_claim')).toBeLessThan(f.hops.indexOf('send'));
 const repeat=await serve(await request(body));expect(await repeat.json()).toEqual({data:{message_id:'provider-one'}});expect(f.effects()).toBe(1);
 const changed=await serve(await request({...body,args:['b3RoZXI=']}));expect(await changed.json()).toMatchObject({error:{message:'intent_conflict'}});expect(f.effects()).toBe(1);
});
it('real entry retains pending on lost provider response; repeat and foreign connection never dispatch',async()=>{
 const f=fixture();f.lose();expect(await(await serve(await request(body))).json()).toMatchObject({error:{message:'intent_pending'}});
 expect(await(await serve(await request(body))).json()).toMatchObject({error:{message:'intent_pending'}});expect(f.effects()).toBe(1);
 await serve(await request({...body,connection:'foreign',intent_id:'approval:foreign'}));expect(f.effects()).toBe(1);
});
it('missing intent and unsigned request never mutate provider',async()=>{
 const f=fixture();const {intent_id,...missing}=body;void intent_id;
 expect(await(await serve(await request(missing))).json()).toMatchObject({error:{message:'intent_required'}});
 await serve(new Request('https://edge.invalid',{method:'POST',body:JSON.stringify(body)}));expect(f.effects()).toBe(0);
});
it('real mutation requires explicit stored scope; null/empty/read-only never dispatch',async()=>{
 for(const scopes of [null,[],['https://www.googleapis.com/auth/gmail.readonly']]){
  const f=fixture();f.scope(scopes);expect(await(await serve(await request(body))).json()).toMatchObject({error:{message:'intent_unavailable'}});expect(f.effects()).toBe(0);expect(f.rows.size).toBe(0);
 }
});
it('receipt returned after provider success is not invalidated by later health telemetry failure',async()=>{
 const f=fixture();f.healthFail();expect(await(await serve(await request(body))).json()).toEqual({data:{message_id:'provider-one'}});expect(f.effects()).toBe(1);
 expect(await(await serve(await request(body))).json()).toEqual({data:{message_id:'provider-one'}});expect(f.effects()).toBe(1);
});
it('draft and every calendar mutation claim before dispatch and settled replay never repeats',async()=>{
 for(const [method,args] of [
  ['draft',[{to:['fictional@test.invalid'],subject:'fixture',body:'fixture'}]],
  ['createEvent',[{title:'fixture',start:'2026-10-01T00:00:00Z',end:'2026-10-01T01:00:00Z'}]],
  ['moveEvent',['event-one','2026-10-01T00:00:00Z','2026-10-01T01:00:00Z']],
  ['cancelEvent',['event-one']],
 ] as const){
  const f=fixture();const input={...body,method,args,intent_id:`approval:${method}`};
  const first=await(await serve(await request(input))).json();expect(first).toHaveProperty('data');
  expect(await(await serve(await request(input))).json()).toEqual(first);expect(f.effects()).toBe(1);expect(f.hops.indexOf('proxy_idem_claim')).toBeLessThan(f.hops.indexOf('token'));
 }
});
it('effect-bearing MCP uses the same durable intent rail and foreign replay stays blocked',async()=>{
 const f=fixture();const input={do_name:'owner',op:'mcp_call',connection:'conn',server_url:'https://fixture.googleapis.com/mcp',tool:'synthetic_write',args:[{value:'fixture'}],intent_id:'approval:mcp'};
 const first=await(await serve(await request(input))).json();expect(first).toMatchObject({data:[{type:'text',text:'synthetic result'}]});
 expect(await(await serve(await request(input))).json()).toEqual(first);expect(f.effects()).toBe(1);expect(f.hops.filter(h=>h==='token')).toHaveLength(1);expect(f.hops.indexOf('proxy_idem_claim')).toBeLessThan(f.hops.indexOf('token'));
 expect(await(await serve(await request({...input,args:[{value:'changed'}]}))).json()).toMatchObject({error:{message:'intent_conflict'}});expect(f.effects()).toBe(1);
});

it('every mutation retains an unknown result and never dispatches again after synthetic loss',async()=>{
 const calls=[
  {...body,method:'draft',args:[{to:['fictional@test.invalid'],subject:'fixture',body:'fixture'}]},
  {...body,method:'createEvent',args:[{title:'fixture',start:'2026-10-01T00:00:00Z',end:'2026-10-01T01:00:00Z'}]},
  {...body,method:'moveEvent',args:['event-one','2026-10-01T00:00:00Z','2026-10-01T01:00:00Z']},
  {...body,method:'cancelEvent',args:['event-one']},
  {do_name:'owner',op:'mcp_call',connection:'conn',server_url:'https://fixture.googleapis.com/mcp',tool:'synthetic_write',args:[{}],intent_id:'approval:mcp'},
 ];
 for(const input of calls){const f=fixture();f.lose();
  expect(await(await serve(await request(input))).json()).toMatchObject({error:{message:'intent_pending'}});
  expect(await(await serve(await request(input))).json()).toMatchObject({error:{message:'intent_pending'}});expect(f.effects()).toBe(1);
 }
});

it('lost-response intent retains uncertainty when its pinned grant is later revoked or loses scope',async()=>{
 for(const change of ['revoke','scope'] as const){const f=fixture();f.lose();
  expect(await(await serve(await request(body))).json()).toMatchObject({error:{message:'intent_pending'}});
  if(change==='revoke')f.revoke();else f.scope([]);
  expect(await(await serve(await request(body))).json()).toMatchObject({error:{message:'intent_unavailable'}});expect(f.effects()).toBe(1);
 }
});

it('actual signed freebusy entry requires provider-compatible scope, uses owner access and never an effect intent',async()=>{
 const input={do_name:'owner',op:'call',connection:'conn',method:'freeBusy',args:['2026-10-01T00:00:00Z','2026-10-01T01:00:00Z',['primary'],'Asia/Kolkata']};
 for(const scopes of [null,[],['https://www.googleapis.com/auth/calendar.events']]){const f=fixture();f.scope(scopes);expect(await(await serve(await request(input))).json()).toMatchObject({error:{status:403,message:'insufficient scopes'}});expect(f.hops).not.toContain('token');}
 for(const scope of ['calendar.events.freebusy','calendar.freebusy','calendar.readonly','calendar']){const f=fixture();f.scope([`https://www.googleapis.com/auth/${scope}`]);expect(await(await serve(await request(input))).json()).toMatchObject({data:{calendars:{primary:{busy:[]}}}});expect(f.hops).toContain('proxy_access');expect(f.hops).not.toContain('proxy_idem_claim');expect(f.effects()).toBe(0);}
 const f=fixture();f.scope(['https://www.googleapis.com/auth/calendar.events.freebusy']);expect(await(await serve(await request({...input,connection:'foreign'}))).json()).toMatchObject({error:{status:401}});expect(f.hops).not.toContain('token');
});

const readBody = async () => ({do_name:'owner',op:'mcp_call',connection:'conn',server_url:'https://drivemcp.googleapis.com/mcp/v1',tool:'search_files',args:[{query:'fictional'}],intent_id:`mcpread:${'a'.repeat(64)}`,read_only:true});
it('bounded signed Drive metadata read dispatches without persisting a result or claiming an effect',async()=>{
 const f=fixture();f.scope(['https://www.googleapis.com/auth/drive.readonly']);const input=await readBody();
 expect(await(await serve(await request(input))).json()).toMatchObject({data:[{type:'text',text:'synthetic result'}]});
 expect(f.rows.size).toBe(0);expect(f.hops).not.toContain('proxy_idem_claim');expect(f.hops).not.toContain('proxy_idem_store');expect(f.hops).toContain('proxy_access');
});

it('bounded read rejects revoked, foreign and inactive grants before token or provider use',async()=>{
 for(const mode of ['revoke','foreign','inactive'] as const){
  const f=fixture();f.scope(['https://www.googleapis.com/auth/drive.readonly']);let input=await readBody();
  if(mode==='revoke')f.revoke();if(mode==='inactive')f.suspend();if(mode==='foreign')input={...input,do_name:'foreign'};
  expect(await(await serve(await request(input))).json()).toMatchObject({error:{message:'intent_unavailable'}});
  expect(f.hops).not.toContain('token');expect(f.effects()).toBe(0);expect(f.rows.size).toBe(0);
 }
});
it('independently authorized metadata observations repeat without stored result replay',async()=>{
 const f=fixture();f.scope(['https://www.googleapis.com/auth/drive.readonly']);const input=await readBody();
 await serve(await request(input));await serve(await request(input));expect(f.effects()).toBe(2);expect(f.rows.size).toBe(0);
 await serve(await request({...input,args:[{query:'changed'}]}));expect(f.effects()).toBe(3);expect(f.rows.size).toBe(0);
 f.revoke();expect(await(await serve(await request(input))).json()).toMatchObject({error:{message:'intent_unavailable'}});expect(f.effects()).toBe(3);
});
it('unsupported flagged reads reject before both transport and result ledger; ordinary effects retain ledger',async()=>{
 for(const kind of ['tool','content','server','approval','malformed'] as const){
  const f=fixture();const input=await readBody();
  const call=kind==='tool'?{...input,tool:'synthetic_write'}:kind==='content'?{...input,tool:'read_file_content'}:kind==='server'?{...input,server_url:'https://fixture.googleapis.com/mcp'}:kind==='approval'?{...input,intent_id:'approval:mcp'}:{...input,intent_id:'mcpread:not-a-host-id'};
  expect(await(await serve(await request(call))).json()).toMatchObject({error:{message:'mcp_read_rejected'}});expect(f.hops).toEqual([]);expect(f.rows.size).toBe(0);
 }
 for(const flag of [undefined,false]){const f=fixture();const input=await readBody();expect(await(await serve(await request({...input,read_only:flag}))).json()).toHaveProperty('data');expect(f.hops).toContain('proxy_idem_claim');expect(f.hops).toContain('proxy_idem_store');}
});
it('bounded metadata requires explicit readonly scope and signed admission',async()=>{
 for(const scope of [null,[],['https://www.googleapis.com/auth/gmail.readonly']]){
  const f=fixture();f.scope(scope);expect(await(await serve(await request(await readBody()))).json()).toMatchObject({error:{status:403,message:'insufficient scopes'}});expect(f.hops).not.toContain('token');expect(f.rows.size).toBe(0);
 }
 const f=fixture();await serve(new Request('https://edge.invalid',{method:'POST',body:JSON.stringify(await readBody())}));expect(f.hops).toEqual([]);
});

it('stale or far-future signed read requests are rejected before grant or provider access',async()=>{
 const f=fixture();const at=Math.floor(Date.now()/1000);
 for(const delta of [-301,301])expect(await(await serve(await request(await readBody(),at+delta))).json()).toMatchObject({error:{message:'unsigned proxy call'}});
 expect(f.hops).toEqual([]);expect(f.rows.size).toBe(0);
});
it('provider metadata error content is never persisted in read logs or returned as an opaque error',async()=>{
 const f=fixture();f.scope(['https://www.googleapis.com/auth/drive.readonly']);const canary='PRIVATE_METADATA_CANARY_726';f.providerError(canary);const logs=vi.spyOn(console,'log').mockImplementation(()=>{});
 const out=await(await serve(await request(await readBody()))).json();expect(out).toMatchObject({error:{message:'mcp_read_rejected'}});expect(JSON.stringify(out)).not.toContain(canary);expect(JSON.stringify(logs.mock.calls)).not.toContain(canary);expect(f.rows.size).toBe(0);
});
import {googleProxy} from '../src/connectors/connections';
import {buildSessionState} from '@waldo/contracts';
import {dispatchTool} from '../src/tools/dispatcher';
import {readMcpToolHandler} from '../src/tools/live/mcp';
import {sanitise} from '../src/scribe/sanitiser';
it('real dispatcher and signed googleProxy reach non-storing Edge metadata dispatch',async()=>{
 const f=fixture();f.scope(['https://www.googleapis.com/auth/drive.readonly']);
 const proxy=googleProxy({SUPABASE_PROJECT_URL:'https://edge.invalid',SUPABASE_PUBLISHABLE_KEY:'fictional-public',WALDO_ROUTER_HMAC_SECRET:cfg.WALDO_ROUTER_HMAC_SECRET!},async(input,init)=>serve(new Request(input,init)))!;
 const handlers=[readMcpToolHandler(JSON.stringify([{name:'drive',url:'https://drivemcp.googleapis.com/mcp/v1',auth:'google',requires:'drive',allow_tools:['search_files'],read_tools:['search_files']}]),{
  resolve:async()=>({mode:'proxy' as const,connection:'conn'}),
  proxy:(url,tool,args,connection,intent)=>proxy.mcpCall('owner',connection,url,tool,args,intent),
 },true)];
 const context={authenticatedUserId:'owner',turnId:'fixture-turn',trigger:'user_message' as const,session:buildSessionState({trigger:'user_message',canary_tokens:['1111111111111111','2222222222222222','3333333333333333'],started_at:1}),hasApproval:()=>false,sourceTaint:null,toolArgSourceTaint:null,sanitise};
 const out=await dispatchTool({id:'fixture-read-call',name:'read_mcp_tool',args:{server:'drive',tool:'search_files',args:{query:'fictional'}}},context,{handlers});
 expect(out).toMatchObject({ok:true,source_taint:'external',data:{output:[{type:'text',text:'synthetic result'}]}});
 expect(f.rows.size).toBe(0);expect(f.hops).toContain('proxy_access');expect(f.hops).not.toContain('proxy_idem_claim');expect(f.hops).not.toContain('proxy_idem_store');expect(f.effects()).toBe(1);
});
it('RPC, malformed provider JSON and OAuth errors never retain private provider content',async()=>{
 for(const mode of ['rpc','malformed','oauth'] as const){
  const f=fixture();f.scope(['https://www.googleapis.com/auth/drive.readonly']);const canary='PRIVATE_METADATA_CANARY_726';const provider=fetch;const healthBodies:string[]=[];
  if(mode==='oauth')f.healthFail();
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=String(input);if(url.endsWith('/proxy_health'))healthBodies.push(String(init?.body??''));
   if(mode==='oauth'&&url==='https://oauth2.googleapis.com/token')return Response.json({error:'invalid_grant',error_description:canary},{status:400});
   if(url==='https://drivemcp.googleapis.com/mcp/v1'&&JSON.parse(String(init?.body)).method==='tools/call'){
    if(mode==='rpc')return Response.json({error:{message:canary}});if(mode==='malformed')return new Response(canary);
   }
   return provider(input,init);
  }));
  const logs=vi.spyOn(console,'log').mockImplementation(()=>{});const out=await(await serve(await request(await readBody()))).json();
  expect(out).toMatchObject({error:{message:mode==='oauth'?'google_refresh_failed':'mcp_read_failed'}});expect(JSON.stringify({out,logs:logs.mock.calls,healthBodies})).not.toContain(canary);
  expect(f.rows.size).toBe(0);expect(f.hops).not.toContain('proxy_idem_claim');expect(f.hops).not.toContain('proxy_idem_store');
  if(mode==='oauth')expect(JSON.stringify(logs.mock.calls)).toContain('connector_proxy_health');logs.mockRestore();
 }
});
it('provider read authentication failures retain typed 401 and 403 without opaque provider data',async()=>{
 for(const status of [401,403]){
  const f=fixture();f.scope(['https://www.googleapis.com/auth/drive.readonly']);const provider=fetch;const canary='PRIVATE_AUTH_CANARY';
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>String(input)==='https://drivemcp.googleapis.com/mcp/v1'?new Response(canary,{status}):provider(input,init)));
  const logs=vi.spyOn(console,'log').mockImplementation(()=>{});const out=await(await serve(await request(await readBody()))).json();
  expect(out).toMatchObject({error:{status,message:status===401?'google_reauth_needed':'google_scope_missing'}});expect(JSON.stringify({out,logs:logs.mock.calls})).not.toContain(canary);expect(f.rows.size).toBe(0);expect(f.effects()).toBe(0);logs.mockRestore();
 }
});
const realSignedProxy=()=>googleProxy({SUPABASE_PROJECT_URL:'https://edge.invalid',SUPABASE_PUBLISHABLE_KEY:'fictional-public',WALDO_ROUTER_HMAC_SECRET:cfg.WALDO_ROUTER_HMAC_SECRET!},async(input,init)=>serve(new Request(input,init)))!;
const dispatchActualRead=async()=>{
 const proxy=realSignedProxy();const handlers=[readMcpToolHandler(JSON.stringify([{name:'drive',url:'https://drivemcp.googleapis.com/mcp/v1',auth:'google',requires:'drive',allow_tools:['search_files'],read_tools:['search_files']}]),{resolve:async()=>({mode:'proxy' as const,connection:'conn'}),proxy:(url,tool,args,connection,intent)=>proxy.mcpCall('owner',connection,url,tool,args,intent)},true)];
 return dispatchTool({id:'fixture-read-call',name:'read_mcp_tool',args:{server:'drive',tool:'search_files',args:{query:'fictional'}}},{authenticatedUserId:'owner',turnId:'fixture-turn',trigger:'user_message',session:buildSessionState({trigger:'user_message',canary_tokens:['1111111111111111','2222222222222222','3333333333333333'],started_at:1}),hasApproval:()=>false,sourceTaint:null,toolArgSourceTaint:null,sanitise},{handlers});
};
it('actual dispatcher-wire-Edge provider 401/403 reaches typed reconnect without storing read results',async()=>{
 for(const status of [401,403]){
  const f=fixture();f.scope(['https://www.googleapis.com/auth/drive.readonly']);const provider=fetch;
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>String(input)==='https://drivemcp.googleapis.com/mcp/v1'?new Response('PRIVATE_WIRE_AUTH_CANARY',{status}):provider(input,init)));
  const out=await dispatchActualRead();expect(out).toMatchObject({ok:false,code:'auth_failed',source_taint:'external',connect:{status:'auth_required',service:'google',reason:status===401?'reauth_needed':'scope_missing',feature:'drive'}});expect(JSON.stringify(out)).not.toContain('PRIVATE_WIRE_AUTH_CANARY');expect(f.rows.size).toBe(0);expect(f.effects()).toBe(0);
 }
});
it('actual signed wire read rejection is a stable non-auth 400, not a reconnect or intent-uncertainty error',async()=>{
 const f=fixture();f.scope(['https://www.googleapis.com/auth/drive.readonly']);f.providerError('PRIVATE_WIRE_REJECTION_CANARY');
 await expect(realSignedProxy().mcpCall('owner','conn','https://drivemcp.googleapis.com/mcp/v1','search_files',{}, {id:`mcpread:${'a'.repeat(64)}`,readOnly:true})).rejects.toMatchObject({status:400,message:'mcp_read_rejected'});expect(f.rows.size).toBe(0);
});

it('all three exact metadata tools skip storage and body tampering cannot change signed read authority',async()=>{
 for(const tool of ['list_recent_files','search_files','get_file_metadata']){
  const f=fixture();f.scope(['https://www.googleapis.com/auth/drive.readonly']);expect(await(await serve(await request({...await readBody(),tool}))).json()).toHaveProperty('data');expect(f.rows.size).toBe(0);expect(f.hops).not.toContain('proxy_idem_store');
 }
 const f=fixture();const input=await readBody();const signed=await request(input);
 for(const changed of [{...input,connection:'foreign'},{...input,args:[{query:'changed'}]},{...input,tool:'synthetic_write'},{...input,server_url:'https://fixture.googleapis.com/mcp'},{...input,read_only:false}]){
  const tampered=new Request('https://edge.invalid',{method:'POST',headers:signed.headers,body:JSON.stringify(changed)});expect(await(await serve(tampered)).json()).toMatchObject({error:{message:'unsigned proxy call'}});
 }
 expect(f.hops).toEqual([]);expect(f.rows.size).toBe(0);
});
it('structured Google tool rejection retains only actionable reason/status/service diagnostics',async()=>{
 const f=fixture();f.scope(['https://www.googleapis.com/auth/drive.readonly']);const provider=fetch;const canary='PRIVATE_DIAGNOSTIC_CANARY';
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input)==='https://drivemcp.googleapis.com/mcp/v1'&&JSON.parse(String(init?.body)).method==='tools/call')return Response.json({result:{isError:true,structuredContent:{error:{code:403,status:'PERMISSION_DENIED',message:canary,details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',domain:'googleapis.com',reason:'SERVICE_DISABLED',metadata:{service:'drivemcp.googleapis.com',consumer:canary,activationUrl:`https://evil.invalid/${canary}`}}]}},content:[{type:'text',text:canary}]}});
  return provider(input,init);
 }));
 const logs=vi.spyOn(console,'log').mockImplementation(()=>{});const out=await(await serve(await request(await readBody()))).json();
 expect(out).toMatchObject({error:{status:400,message:'mcp_read_rejected',provider_diagnostic:{stage:'tools/call',provider_status:'PERMISSION_DENIED',reason:'SERVICE_DISABLED',service:'drivemcp.googleapis.com'}}});
 expect(JSON.stringify(out)).not.toContain(canary);expect(JSON.stringify(logs.mock.calls)).not.toContain(canary);expect(JSON.stringify(logs.mock.calls)).toContain('SERVICE_DISABLED');expect(f.rows.size).toBe(0);
});

it.each([
 ['ACCESS_TOKEN_SCOPE_INSUFFICIENT','googleapis.com','ACCESS_TOKEN_SCOPE_INSUFFICIENT'],
 ['SERVICE_DISABLED','googleapis.com','SERVICE_DISABLED'],
 ['RATE_LIMIT_EXCEEDED','googleapis.com',undefined],
 ['SERVICE_DISABLED','foreign.example',undefined],
 ['ACCESS_TOKEN_SCOPE_INSUFFICIENT',undefined,undefined],
] as const)('signed REST read carries only allowlisted structured reason %s (%s)',async(reason,domain,expected)=>{
 const f=fixture(),provider=fetch;
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input).startsWith('https://tasks.googleapis.com/'))return Response.json({error:{code:403,message:reason,details:domain?[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',domain,reason}]:[]}},{status:403});
  return provider(input,init);
 }));
 const out=await(await serve(await request({do_name:'owner',op:'call',connection:'conn',method:'tasks',args:['todo',5]}))).json() as {error:{status:number;reason?:string}};
 expect(out.error.status).toBe(403);expect(out.error.reason).toBe(expected);
 expect(f.rows.size).toBe(0);expect(f.hops).not.toContain('proxy_idem_claim');expect(f.hops).not.toContain('proxy_idem_store');
});

it('token endpoint outage does not mark health or reconnect and the pinned MCP connection recovers', async () => {
 const f=fixture();f.scope(['https://www.googleapis.com/auth/drive.readonly']);const provider=fetch;let outage=true;const grants:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input).endsWith('/proxy_access'))grants.push(JSON.parse(String(init?.body)).p_connection);
  if(String(input)==='https://oauth2.googleapis.com/token'&&outage)return Response.json({error:'temporarily_unavailable'},{status:503});
  return provider(input,init);
 }));
 const out=await dispatchActualRead();expect(out).toMatchObject({ok:false});expect(out).not.toHaveProperty('connect');
 expect(f.hops).not.toContain('proxy_health');expect(f.effects()).toBe(0);expect(f.rows.size).toBe(0);
 outage=false;expect(await dispatchActualRead()).toMatchObject({ok:true});expect(grants).toEqual(['conn','conn']);expect(f.effects()).toBe(1);
});

const refreshCases = [
 {name:'revoked grant',status:400,error:'invalid_grant',expected:401},
 {name:'rate limit',status:429,error:'invalid_grant',expected:429},
 {name:'provider outage',status:503,error:'temporarily_unavailable',expected:503},
 {name:'HTML outage',status:502,error:null,expected:502},
 {name:'network',status:0,error:null,expected:502},
 {name:'timeout',status:0,error:'timeout',expected:502},
 {name:'client configuration',status:401,error:'invalid_client',expected:502},
 {name:'malformed success',status:200,error:null,expected:502},
 {name:'unknown OAuth failure',status:400,error:'PRIVATE_UNKNOWN_ERROR',expected:502},
];
it.each(['native','Drive','MCP'])('%s signed read classifies real refresh failures and recovers on the same grant', async lane => {
 for(const c of refreshCases){
  const f=fixture();f.scope(['https://www.googleapis.com/auth/drive.readonly','https://www.googleapis.com/auth/calendar.events']);const provider=fetch;let failing=true;const health:unknown[]=[];const connections:string[]=[];const refreshBodies:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=String(input);
   if(url.endsWith('/proxy_access'))connections.push(JSON.parse(String(init?.body)).p_connection);
   if(url.endsWith('/proxy_health'))health.push(JSON.parse(String(init?.body)));
   if(url==='https://oauth2.googleapis.com/token'){
    refreshBodies.push(String(init?.body));
    if(failing){
     if(!c.status)throw c.error==='timeout'?new DOMException('PRIVATE_TIMEOUT','TimeoutError'):new TypeError('PRIVATE_NETWORK');
     return c.error===null?new Response('PRIVATE_HTML',{status:c.status}):Response.json({error:c.error,error_description:'PRIVATE_DESCRIPTION'},{status:c.status});
    }
   }
   if(url.startsWith('https://www.googleapis.com/drive/v3/files'))return Response.json({files:[]});
   return provider(input,init);
  }));
  const input=lane==='MCP'?await readBody():{do_name:'owner',op:'call',connection:'conn',method:lane==='Drive'?'driveListFiles':'event',args:lane==='Drive'?[{}]:['event-one']};
  const logs=vi.spyOn(console,'log').mockImplementation(()=>{});
  const out=await(await serve(await request(input))).json();expect(out).toMatchObject({error:{status:c.expected}});
  expect(health).toEqual(c.expected===401?[{p_do_name:'owner',p_connection:'conn',p_error:'google_refresh_failed'}]:[]);
  expect(JSON.stringify({out,health,logs:logs.mock.calls})).not.toContain('PRIVATE_');expect(f.effects()).toBe(0);expect(f.rows.size).toBe(0);
  failing=false;expect(await(await serve(await request(input))).json()).toHaveProperty('data');
  expect(connections).toEqual(['conn','conn']);expect(refreshBodies).toHaveLength(2);expect(refreshBodies.every(value=>new URLSearchParams(value).get('refresh_token')==='fictional-refresh')).toBe(true);
  expect(health.at(-1)).toEqual({p_do_name:'owner',p_connection:'conn',p_error:''});logs.mockRestore();
 }
});
it('effect refresh outage retains pending custody and never retries provider after recovery', async () => {
 const f=fixture();const provider=fetch;let failing=true;
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>String(input)==='https://oauth2.googleapis.com/token'&&failing?Response.json({error:'temporarily_unavailable'},{status:503}):provider(input,init)));
 expect(await(await serve(await request(body))).json()).toMatchObject({error:{message:'intent_pending',status:503}});
 failing=false;expect(await(await serve(await request(body))).json()).toMatchObject({error:{message:'intent_pending'}});
 expect(f.effects()).toBe(0);expect(f.rows.size).toBe(1);expect(f.hops).not.toContain('proxy_idem_store');expect(f.hops).not.toContain('proxy_health');
});
