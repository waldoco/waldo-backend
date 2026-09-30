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
const request=async(body:unknown)=>{
 const raw=JSON.stringify(body);const at=Math.floor(Date.now()/1000);const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 return new Request('https://edge.invalid',{method:'POST',body:raw,headers:{'x-waldo-at':String(at),'x-waldo-sig':await routerSignature(cfg.WALDO_ROUTER_HMAC_SECRET!,at,`proxy.${digest}`)}});
};
const fixture=()=>{
 const rows=new Map<string,{digest:string;result?:unknown;done?:boolean}>();const hops:string[]=[];let effects=0;let lost=false;let scopes:unknown=['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.compose','https://www.googleapis.com/auth/calendar.events'];let healthFail=false;
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);const args=url.startsWith('https://db.invalid/')?JSON.parse(String(init?.body??'{}')):{};const fn=url.split('/').at(-1)!;hops.push(fn);
  if(fn==='proxy_access')return Response.json(args.p_connection==='conn'?[{secret:'fictional-refresh',scopes}]:[]);
  if(fn==='proxy_secret')return Response.json(args.p_connection==='conn'? 'fictional-refresh':null);
  if(fn==='proxy_idem_claim'){
   if(args.p_connection!=='conn'||args.p_do_name!=='owner')return Response.json(null);
   const key=args.p_key;const prior=rows.get(key);if(!prior){rows.set(key,{digest:args.p_digest});return Response.json({state:'new'});}return Response.json(prior.digest!==args.p_digest?{state:'conflict'}:prior.done?{state:'done',result:prior.result}:{state:'pending'});
  }
  if(fn==='proxy_idem_store'){rows.get(args.p_key)!.result=args.p_result;rows.get(args.p_key)!.done=true;return Response.json(true);}
  if(fn==='proxy_health')return healthFail?new Response('failure',{status:503}):Response.json(true);
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'fictional-access'});
  if(url==='https://fixture.googleapis.com/mcp'){
   const rpc=JSON.parse(String(init?.body));if(rpc.method==='initialize')return Response.json({result:{protocolVersion:'2025-06-18'}});
   if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
   effects++;return Response.json({result:{content:[{type:'text',text:'synthetic result'}]}});
  }
  if(url.includes('www.googleapis.com/calendar/')){effects++;return init?.method==='DELETE'?new Response(null,{status:204}):Response.json({id:'event-one',summary:'fixture',start:{dateTime:'2026-10-01T00:00:00Z'},end:{dateTime:'2026-10-01T01:00:00Z'}});}
  if(url.includes('gmail.googleapis.com')){effects++;if(lost)throw new Error('synthetic response loss');return Response.json({id:'provider-one'});}
  throw new Error('unexpected fictional transport');
 }));return{hops,rows,effects:()=>effects,lose:()=>{lost=true;},scope:(value:unknown)=>{scopes=value;},healthFail:()=>{healthFail=true;}};
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
  const f=fixture();f.scope(scopes);expect(await(await serve(await request(body))).json()).toMatchObject({error:{status:403,message:'insufficient scopes'}});expect(f.effects()).toBe(0);expect(f.rows.size).toBe(0);
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
