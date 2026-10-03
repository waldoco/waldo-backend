import { expect, it } from 'vitest';
import { googleClient } from '../src/connectors/google';
const app={clientId:'test',clientSecret:'fixture',redirectUri:'https://example.test/callback'};
const from='2026-11-01T00:00:00-04:00',to='2026-11-02T00:00:00-05:00';
it('returns provider continuation for an empty Calendar page and the selected calendar',async()=>{
 const urls:string[]=[];
 const fetcher=(async(input:RequestInfo|URL)=>{urls.push(String(input));return Response.json(String(input).includes('oauth2')?{access_token:'fixture'}:{kind:'calendar#events',items:[],nextPageToken:'next'});}) as typeof fetch;
 const client=googleClient(app,{refresh_token:'fixture'},fetcher);
 expect(typeof client.calendarPage).toBe('function');
 const page=await client.calendarPage('work@example.test',from,to,20,false);
 expect(page).toMatchObject({events:[],fetched_count:0,account:{connection_id:null,email:null}});
 expect(new URL(urls[1]!).pathname).toBe('/calendar/v3/calendars/work%40example.test/events');
});
it('rejects a continuation moved to another window or grant before provider I/O',async()=>{
 let reads=0;
 const fetcher=(async(input:RequestInfo|URL)=>{if(String(input).includes('oauth2'))return Response.json({access_token:'fixture'});reads++;return Response.json({kind:'calendar#events',items:[],nextPageToken:'next'});}) as typeof fetch;
 const client=googleClient(app,{refresh_token:'grant-one',email:'owner@example.test'},fetcher);
 const page=await client.calendarPage('primary',from,to,20,false);
 expect(page.next_page_token).not.toBe('next');
 await expect(client.calendarPage('primary','2026-11-01T01:00:00-04:00',to,20,false,page.next_page_token!)).rejects.toThrow('Calendar cursor');
 await expect(googleClient(app,{refresh_token:'grant-two'},fetcher).calendarPage('primary',from,to,20,false,page.next_page_token!)).rejects.toThrow('Calendar cursor');
 expect(reads).toBe(1);
});
it.each([{items:'broken'},{items:[{id:'bad',start:{},end:{}}]},{items:[],nextPageToken:''},{items:[],nextPageToken:'x'.repeat(2049)}])('fails closed on malformed Calendar page %j',async(data)=>{
 const fetcher=(async(input:RequestInfo|URL)=>Response.json(String(input).includes('oauth2')?{access_token:'fixture'}:{kind:'calendar#events',...data})) as typeof fetch;
 await expect(googleClient(app,{refresh_token:'fixture'},fetcher).calendarPage('primary',from,to,20,false)).rejects.toThrow('invalid Calendar page response');
});
import { googleHandlers } from '../src/tools/live/google';
import { queryCalendarArgsSchema, type QueryCalendarArgs } from '@waldo/contracts';
const clock={timezone:'America/New_York',now:()=>new Date('2026-10-02T12:00:00Z')};
const desk={propose:async()=>'',proposeSendEmail:async()=>'',record:()=>{}};
it('model receipt distinguishes a truncated first page from an exhausted continuation',async()=>{
 const fetcher=(async(input:RequestInfo|URL)=>{
  const url=String(input); if(url.includes('oauth2'))return Response.json({access_token:'fixture'});
  return Response.json({kind:'calendar#events',items:[],...(!new URL(url).searchParams.has('pageToken')?{nextPageToken:'next'}:{})});
 }) as typeof fetch;
 const client=googleClient(app,{refresh_token:'fixture',email:'owner@example.test'},fetcher);
 const handler=googleHandlers({client:async()=>client},desk,clock)[0]! as {handle(args:QueryCalendarArgs):Promise<unknown>};
 const args=queryCalendarArgsSchema.parse({date_range:{from,to},limit:20});
 const first=await handler.handle(args) as any;
 expect(first.data.coverage).toMatchObject({account:{connection_id:null,email:'owner@example.test'},calendar_id:'primary',complete:false,pagination:'provider_page',page_exhausted:false});
 expect(first.data.observed_at).toEqual(expect.any(String));
 const last=await handler.handle(queryCalendarArgsSchema.parse({...args,page_token:first.data.next_page_token})) as any;
 expect(last.data.coverage).toMatchObject({complete:false,page_exhausted:true,result_scope:'current_page'});
});
it('requires an explicit window for continuation and rejects a non-advancing Calendar window',()=>{
 expect(queryCalendarArgsSchema.safeParse({page_token:'cursor'}).success).toBe(false);
 expect(queryCalendarArgsSchema.safeParse({date_range:{from,to:from}}).success).toBe(false);
});
it('keeps all-day exclusive ends and DST offsets while excluding declined and cancelled events',async()=>{
 const events=[{id:'all',start:{date:'2026-11-01'},end:{date:'2026-11-02'}},{id:'dst',start:{dateTime:'2026-11-01T01:30:00-04:00'},end:{dateTime:'2026-11-01T01:30:00-05:00'}},{id:'declined',start:{date:'2026-11-01'},end:{date:'2026-11-02'},attendees:[{self:true,responseStatus:'declined'}]},{id:'cancel',status:'cancelled'}];
 const fetcher=(async(input:RequestInfo|URL)=>Response.json(String(input).includes('oauth2')?{access_token:'fixture'}:{kind:'calendar#events',items:events})) as typeof fetch;
 const client=googleClient(app,{refresh_token:'fixture'},fetcher);
 const page=await client.calendarPage('primary',from,to,20,false);
 expect(page.events.map(e=>e.id)).toEqual(['all','dst']);
 expect(page.events[0]).toMatchObject({all_day:true,start:'2026-11-01',end:'2026-11-02'});
 expect(page.events[1]).toMatchObject({start:'2026-11-01T01:30:00-04:00',end:'2026-11-01T01:30:00-05:00'});
 expect((await client.calendarPage('primary',from,to,20,true)).events.map(e=>e.id)).toEqual(['all','dst','declined']);
});
it.each([{start:{date:'2026-02-30'},end:{date:'2026-03-03'}},{start:{dateTime:'2026-02-30T00:00:00Z'},end:{dateTime:'2026-03-03T00:00:00Z'}},{start:{date:'2026-11-01',dateTime:from},end:{date:'2026-11-02'}}])('rejects ambiguous or impossible Calendar dates',async(range)=>{
 const fetcher=(async(input:RequestInfo|URL)=>Response.json(String(input).includes('oauth2')?{access_token:'fixture'}:{kind:'calendar#events',items:[{id:'event',...range}]})) as typeof fetch;
 await expect(googleClient(app,{refresh_token:'fixture'},fetcher).calendarPage('primary',from,to,20,false)).rejects.toThrow('invalid Calendar page response');
});
it('rejects cursor tampering and every immutable query/account mismatch before provider I/O',async()=>{
 let reads=0;
 const fetcher=(async(input:RequestInfo|URL)=>{if(String(input).includes('oauth2'))return Response.json({access_token:'fixture'});reads++;return Response.json({kind:'calendar#events',items:[],nextPageToken:'next'});}) as typeof fetch;
 const client=googleClient(app,{refresh_token:'fixture'},fetcher,undefined,{connection_id:'connection-one',email:null});
 const token=(await client.calendarPage('primary',from,to,20,false)).next_page_token!;
 expect(token.length).toBeLessThanOrEqual(4096);
 const requests=[client.calendarPage('other',from,to,20,false,token),client.calendarPage('primary',from,to,21,false,token),client.calendarPage('primary',from,to,20,true,token),client.calendarPage('primary',from,to,20,false,token+'x'),client.calendarPage('primary',from,to,20,false,'malformed'),client.calendarPage('primary',from,to,20,false,'x'.repeat(4097)),googleClient(app,{refresh_token:'fixture'},fetcher,undefined,{connection_id:'connection-two',email:null}).calendarPage('primary',from,to,20,false,token)];
 for(const request of requests)await expect(request).rejects.toThrow();
 expect(reads).toBe(1);
});
it('rejects correctly signed unsupported cursor versions and malformed payloads',async()=>{
 let reads=0;
 const fetcher=(async()=>{reads++;return Response.json({kind:'calendar#events',items:[]});}) as typeof fetch;
 const client=googleClient(app,{refresh_token:'fixture'},fetcher);
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('fixture'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 for(const payload of [{v:2,token:'next'},{v:1,token:''},{v:1,token:'next',extra:true},{v:1,token:'x'.repeat(2049)},null]){
  const body=btoa(JSON.stringify(payload)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const binding=JSON.stringify([null,'primary',from,to,20,false]);
  const sig=[...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${binding}.${body}`)))].map(v=>v.toString(16).padStart(2,'0')).join('');
  await expect(client.calendarPage('primary',from,to,20,false,`${body}.${sig}`)).rejects.toThrow('Calendar cursor');
 }
 expect(reads).toBe(0);
});
it('reports legacy unknown coverage and rejects continuation or nonprimary calendar',async()=>{
 const handler=googleHandlers({client:async()=>({events:async()=>[]} as never)},desk,clock)[0]! as {handle(args:QueryCalendarArgs):Promise<unknown>};
 const result=await handler.handle(queryCalendarArgsSchema.parse({date_range:{from,to}})) as any;
 expect(result.data.coverage).toMatchObject({account:{connection_id:null,email:null},complete:false,pagination:'unknown_not_returned_by_adapter'});
 for(const extra of [{page_token:'cursor'},{calendar_id:'work'}]){
  expect((await handler.handle(queryCalendarArgsSchema.parse({date_range:{from,to},...extra})) as any).ok).toBe(false);
 }
});
import { GOOGLE_METHODS, GoogleError } from '../src/connectors/google';
import { googleProxy } from '../src/connectors/connections';
it('exposes Calendar pagination through the shared proxy operation inventory and preserves wire arguments',async()=>{
 let body:any;
 const proxy=googleProxy({SUPABASE_PROJECT_URL:'https://example.test',SUPABASE_PUBLISHABLE_KEY:'fixture',WALDO_ROUTER_HMAC_SECRET:'fixture'} as never,(async(_input:RequestInfo|URL,init?:RequestInit)=>{body=JSON.parse(String(init?.body));return Response.json({data:{events:[],next_page_token:null,fetched_count:0,account:{connection_id:'conn',email:null},observed_at:clock.now().toISOString()}});}) as typeof fetch)!;
 expect(GOOGLE_METHODS).toContain('calendarPage');
 expect(Object.keys(proxy.client('owner','conn')).sort()).toEqual(['account', ...GOOGLE_METHODS].sort());
 expect(proxy.client('owner','conn').account).toEqual({connection_id:'conn',email:null});
 expect(GOOGLE_METHODS).not.toContain('account');
 await proxy.client('owner','conn').calendarPage!('primary',from,to,20,false);
 expect(body).toMatchObject({connection:'conn',method:'calendarPage',args:['primary',from,to,20,false]});
});
it('falls back on an unupgraded proxy only for a first primary Calendar page',async()=>{
 const handler=googleHandlers({client:async()=>({calendarPage:async()=>{throw new GoogleError(404,'unknown operation');},events:async()=>[]} as never)},desk,clock)[0]! as {handle(args:QueryCalendarArgs):Promise<unknown>};
 expect((await handler.handle(queryCalendarArgsSchema.parse({date_range:{from,to}})) as any).data.coverage.complete).toBe(false);
 for(const extra of [{page_token:'cursor'},{calendar_id:'work'}])expect((await handler.handle(queryCalendarArgsSchema.parse({date_range:{from,to},...extra})) as any).ok).toBe(false);
});
it('surfaces a revoked proxy grant as authentication failure without a fallback read',async()=>{
 let legacy=0;
 const handler=googleHandlers({client:async()=>({calendarPage:async()=>{throw new GoogleError(401,'connection unavailable');},events:async()=>{legacy++;return [];}} as never)},desk,clock)[0]! as {handle(args:QueryCalendarArgs):Promise<unknown>};
 expect(await handler.handle(queryCalendarArgsSchema.parse({date_range:{from,to},page_token:'cursor'}))).toMatchObject({ok:false,code:'auth_failed'});
 expect(legacy).toBe(0);
});
it.each([null,undefined,{events:[]},{events:'broken',next_page_token:null,fetched_count:0,account:{connection_id:null,email:null},observed_at:'invalid'},{events:[],next_page_token:null,fetched_count:-1,account:{connection_id:123,email:null},observed_at:clock.now().toISOString()}])('rejects malformed adapter receipts instead of claiming complete coverage',async(page)=>{
 let legacy=0;
 const handler=googleHandlers({client:async()=>({calendarPage:async()=>page,events:async()=>{legacy++;return [];}} as never)},desk,clock)[0]! as {handle(args:QueryCalendarArgs):Promise<unknown>};
 expect((await handler.handle(queryCalendarArgsSchema.parse({date_range:{from,to}})) as any).ok).toBe(false);
 expect(legacy).toBe(0);
});
it('reports the actual returned legacy event count',async()=>{
 const handler=googleHandlers({client:async()=>({events:async()=>[{id:'event',title:'Title',start:from,end:to,all_day:false}]} as never)},desk,clock)[0]! as {handle(args:QueryCalendarArgs):Promise<unknown>};
 expect((await handler.handle(queryCalendarArgsSchema.parse({date_range:{from,to}})) as any).data.coverage.returned_count).toBe(1);
});
it('rejects invalid normalized adapter event times before complete coverage is claimed',async()=>{
 const handler=googleHandlers({client:async()=>({calendarPage:async()=>({events:[{id:'event',title:'Title',start:'tomorrow',end:'later',all_day:false}],next_page_token:null,fetched_count:1,account:{connection_id:null,email:null},observed_at:clock.now().toISOString()})} as never)},desk,clock)[0]! as {handle(args:QueryCalendarArgs):Promise<unknown>};
 expect((await handler.handle(queryCalendarArgsSchema.parse({date_range:{from,to}})) as any).ok).toBe(false);
});
it('claims complete only for a validated exhausted initial page, including an empty one',async()=>{
 const client=googleClient(app,{refresh_token:'fixture'},(async(input:RequestInfo|URL)=>Response.json(String(input).includes('oauth2')?{access_token:'fixture'}:{kind:'calendar#events',items:[]})) as typeof fetch);
 const handler=googleHandlers({client:async()=>client},desk,clock)[0]! as {handle(args:QueryCalendarArgs):Promise<unknown>};
 expect((await handler.handle(queryCalendarArgsSchema.parse({date_range:{from,to}})) as any).data.coverage).toMatchObject({complete:true,page_exhausted:true,returned_count:0});
});
it('rejects non-instant provider request windows before network I/O',async()=>{
 let calls=0;
 const client=googleClient(app,{refresh_token:'fixture'},(async()=>{calls++;return Response.json({kind:'calendar#events',items:[]});}) as typeof fetch);
 await expect(client.calendarPage('primary','2026-11-01','2026-11-02',20,false)).rejects.toThrow('invalid Calendar page request');
 expect(calls).toBe(0);
});
it.each(['2026-02-30T00:00:00Z','2026-11-01T24:00:00Z','2026-11-01T00:00:00+24:00'])('rejects an impossible or out-of-range request instant %s',async(start)=>{
 const client=googleClient(app,{refresh_token:'fixture'},(async()=>{throw new Error('unexpected network I/O');}) as typeof fetch);
 await expect(client.calendarPage('primary',start,'2027-01-01T00:00:00Z',20,false)).rejects.toThrow('invalid Calendar page request');
});
it('accepts a valid leap-day request with an explicit offset',async()=>{
 const client=googleClient(app,{refresh_token:'fixture'},(async(input:RequestInfo|URL)=>Response.json(String(input).includes('oauth2')?{access_token:'fixture'}:{kind:'calendar#events',items:[]})) as typeof fetch);
 expect(await client.calendarPage('primary','2028-02-29T00:00:00+05:30','2028-03-01T00:00:00+05:30',20,false)).toMatchObject({events:[],next_page_token:null});
});
it.each([{error:{message:'upstream unavailable'}},{kind:'unexpected'},{kind:'calendar#events',error:{message:'upstream unavailable'}}])('does not claim an empty complete window from a provider error envelope',async(response)=>{
 const client=googleClient(app,{refresh_token:'fixture'},(async(input:RequestInfo|URL)=>Response.json(String(input).includes('oauth2')?{access_token:'fixture'}:response)) as typeof fetch);
 const handler=googleHandlers({client:async()=>client},desk,clock)[0]! as {handle(args:QueryCalendarArgs):Promise<unknown>};
 expect(await handler.handle(queryCalendarArgsSchema.parse({date_range:{from,to}}))).toMatchObject({ok:false});
});
