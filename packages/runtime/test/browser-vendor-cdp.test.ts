import {expect,it} from 'vitest';
import {browserbaseVendor,cdpVendorBinding} from '../src/channels/browser-vendor-cdp';
// The requests the pinned @cloudflare/playwright SDK sends to a browser binding: allocate, list, devtools upgrade.
const acquire=async(binding:{fetch:typeof fetch},options:{keep_alive:number;guardrails?:unknown})=>{const response=await binding.fetch(`http://fake.host/v1/devtools/browser?keep_alive=${options.keep_alive}`,{method:'POST',...(options.guardrails?{headers:{'content-type':'application/json'},body:JSON.stringify({guardrails:options.guardrails})}:{})});const text=await response.text();if(response.status!==200)throw Error(`Unable to create new browser: code: ${response.status}: message: ${text}`);return JSON.parse(text);};
const sessions=async(binding:{fetch:typeof fetch})=>(await (await binding.fetch('http://fake.host/v1/sessions')).json() as {sessions:unknown[]}).sessions;
const SIGNING='FICTIONAL_SIGNING_KEY_CANARY',API_KEY='bb_FICTIONAL_API_KEY_CANARY';
const browserbase=()=>{
 const calls:{url:string;method:string;headers:Headers;body?:unknown}[]=[];let running=['bb-session-1'];
 const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input),method=init?.method??'GET',headers=new Headers(init?.headers);
  calls.push({url,method,headers,...(init?.body?{body:JSON.parse(String(init.body))}:{})});
  if(url==='https://api.browserbase.com/v1/sessions'&&method==='POST')return Response.json({id:'bb-session-2',status:'RUNNING',connectUrl:`wss://connect.browserbase.com/?signingKey=${SIGNING}`},{status:201});
  if(url==='https://api.browserbase.com/v1/sessions?status=RUNNING')return Response.json(running.map(id=>({id,status:'RUNNING'})));
  if(url==='https://api.browserbase.com/v1/sessions/bb-session-1')return Response.json({id:'bb-session-1',status:'RUNNING',connectUrl:`wss://connect.browserbase.com/?signingKey=${SIGNING}&session=1`});
  if(url==='https://api.browserbase.com/v1/sessions/bb-session-2'&&method==='POST'){running=running.filter(id=>id!=='bb-session-2');return Response.json({id:'bb-session-2',status:'COMPLETED'});}
  if(url.startsWith('https://connect.browserbase.com/'))return new Response('upgraded',{status:200,headers:{'x-upgrade-probe':'1'}});
  return new Response('not found',{status:404});
 };
 return {calls,fetcher,vendor:browserbaseVendor({apiKey:API_KEY,projectId:'fictional-project',fetcher})};
};
it('the pinned SDK allocates a Browserbase session through the binding, sized to the grant lifetime and kept alive across attaches',async()=>{
 const bb=browserbase(),binding=cdpVendorBinding(bb.vendor,bb.fetcher);
 expect(await acquire(binding ,{keep_alive:600_500})).toEqual({sessionId:'bb-session-2'});
 const create=bb.calls.find(call=>call.method==='POST')!;
 expect(create.headers.get('x-bb-api-key')).toBe(API_KEY);
 expect(create.body).toEqual({projectId:'fictional-project',keepAlive:true,timeout:601});
});
it('the session list is the vendor running list, so a released session reads as gone',async()=>{
 const bb=browserbase(),binding=cdpVendorBinding(bb.vendor,bb.fetcher);
 expect(await sessions(binding)).toEqual([{sessionId:'bb-session-1'}]);
 await acquire(binding ,{keep_alive:60_000});await bb.vendor.release('bb-session-2');
 expect((await sessions(binding)).map((row:any)=>row.sessionId)).not.toContain('bb-session-2');
});
it('the devtools upgrade goes to the session connect URL over https with the upgrade header, for a fresh or a reconstructed binding',async()=>{
 const bb=browserbase(),binding=cdpVendorBinding(bb.vendor,bb.fetcher);
 await acquire(binding ,{keep_alive:60_000});
 for(const id of ['bb-session-2','bb-session-1']){
  const upgraded=await binding.fetch(`http://fake.host/v1/devtools/browser/${id}?persistent=true`,{headers:{Upgrade:'websocket'}});
  expect(upgraded.headers.get('x-upgrade-probe')).toBe('1');
  const call=bb.calls.at(-1)!;expect(call.url.startsWith('https://connect.browserbase.com/')).toBe(true);expect(call.headers.get('upgrade')).toBe('websocket');
 }
});
it('fails closed: guardrails it cannot enforce, unknown paths and vendor failures, never echoing vendor text or keys',async()=>{
 const bb=browserbase(),binding=cdpVendorBinding(bb.vendor,bb.fetcher);
 await expect(acquire(binding ,{keep_alive:60_000,guardrails:{allowedDomains:['example.invalid']}})).rejects.toThrow(/code: 400/);
 expect(bb.calls).toHaveLength(0);
 expect((await binding.fetch('http://fake.host/v1/history')).status).toBe(404);
 const failing=cdpVendorBinding(browserbaseVendor({apiKey:API_KEY,projectId:'fictional-project',fetcher:async()=>new Response(`quota exceeded for ${API_KEY}`,{status:402})}));
 const refused=await failing.fetch('http://fake.host/v1/devtools/browser?keep_alive=60000',{method:'POST'});
 expect(refused.status).toBe(402);const text=await refused.text();expect(text).not.toContain(API_KEY);expect(text).not.toContain('quota');
 const missing=await binding.fetch('http://fake.host/v1/devtools/browser/bb-unknown',{headers:{Upgrade:'websocket'}});
 expect(missing.status).toBe(404);expect(await missing.text()).not.toContain(SIGNING);
});
