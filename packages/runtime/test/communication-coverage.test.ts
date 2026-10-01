import {expect,it} from 'vitest';
import {googleHandlers} from '../src/tools/live/google';
import {getCommunicationArgsSchema} from '@waldo/contracts';
const clock={timezone:'Asia/Kolkata',now:()=>new Date('2026-10-01T08:00:00+05:30')};
const desk={propose:async()=>'',proposeSendEmail:async()=>'',record:()=>{}};
const messages=['2026-09-29T23:59:59Z','2026-09-30T01:00:00Z','2026-09-30T23:00:00Z','2026-10-01T02:30:00Z'].map((at,i)=>({id:`m${i}`,thread_id:`t${i}`,from:'notice@example.invalid',subject:'Notice',snippet:'untrusted notification',at}));
it('honors the upper date bound and labels the primary-inbox page as incomplete',async()=>{
 const calls:unknown[]=[];const handler=googleHandlers({client:async()=>({newMail:async(...args:unknown[])=>{calls.push(args);return messages;}} as never)},desk,clock).find(h=>h.name==='get_communication')!;
 const result=await handler.handle({date_range:{from:'2026-09-30T00:00:00Z',to:'2026-10-01T00:00:00Z'}} as never);
 expect(result).toMatchObject({ok:true,data:{from:'2026-09-30T00:00:00Z',to:'2026-10-01T00:00:00Z',timezone:'Asia/Kolkata',coverage:{scope:'inbox_primary_category',pagination:'unknown_not_returned_by_adapter',complete:false},messages:[messages[1],messages[2]]}});
 expect(calls).toHaveLength(1);
});
it('reports actual rolling-window instants, not today or all-account coverage',async()=>{
 const handler=googleHandlers({client:async()=>({newMail:async()=>[]} as never)},desk,clock).find(h=>h.name==='get_communication')!;
 const result=await handler.handle(getCommunicationArgsSchema.parse({}) as never);
 expect(result).toMatchObject({ok:true,data:{from:'2026-09-30T02:30:00.000Z',to:'2026-10-01T02:30:00.000Z',coverage:{complete:false,account_selection:'connected_adapter_account_not_all_accounts',retrieval_window:'rolling_24_hours'}}});
});
it('reports a truncated sampled page even when upper-bound filtering removes every row',async()=>{
 const handler=googleHandlers({client:async()=>({newMail:async()=>Array.from({length:10},()=>messages[3])} as never)},desk,clock).find(h=>h.name==='get_communication')!;
 const result=await handler.handle({date_range:{from:'2026-09-30T00:00:00Z',to:'2026-10-01T00:00:00Z'}} as never);
 expect(result).toMatchObject({ok:true,data:{messages:[],coverage:{complete:false,fetched_count:10,returned_count:0,page_limit:10,upper_bound_applied_after_page:true}}});
});
it('requests the exact bounded page and exposes provider pagination rather than assuming completeness',async()=>{
 const requests:unknown[]=[];
 const handler=googleHandlers({client:async()=>({mailPage:async(...args:unknown[])=>{requests.push(args);return {messages:[messages[1]],next_page_token:'page-2',result_size_estimate:17};}} as never)},desk,clock).find(h=>h.name==='get_communication')!;
 const args=getCommunicationArgsSchema.parse({date_range:{from:'2026-09-30T00:00:00Z',to:'2026-10-01T00:00:00Z'},limit:20,page_token:'page-1'});
 const result=await handler.handle(args as never);
 expect(requests).toEqual([['in:inbox category:primary after:1790726399 before:1790812800',20,'page-1']]);
 expect(result).toMatchObject({ok:true,data:{next_page_token:'page-2',result_size_estimate:17,coverage:{pagination:'provider_page',complete:false,upper_bound_applied_after_page:false,page_limit:20}}});
});
it('requires a pinned window for cursor continuation and keeps changed/invalid rows incomplete',async()=>{
 expect(getCommunicationArgsSchema.safeParse({page_token:'next'}).success).toBe(false);
 const handler=googleHandlers({client:async()=>({mailPage:async()=>({messages:[messages[3]],next_page_token:null,result_size_estimate:1})} as never)},desk,clock).find(h=>h.name==='get_communication')!;
 const result=await handler.handle({date_range:{from:'2026-09-30T00:00:00Z',to:'2026-10-01T00:00:00Z'}} as never);
 expect(result).toMatchObject({ok:true,data:{messages:[],coverage:{complete:false}}});
});
it.each(['2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.250Z'])('broadens lower provider second then includes exact requested boundary %s',async(from)=>{
 const at=Date.parse(from);const rows=[at-1,at,at+1,Date.parse('2026-09-30T00:00:01Z')].map((time,i)=>({...messages[1]!,id:`b${i}`,at:new Date(time).toISOString()}));
 const handler=googleHandlers({client:async()=>({mailPage:async(q:string)=>{
  const bound=Number(q.match(/after:(\d+)/)![1])*1000;
  return {messages:rows.filter(r=>Date.parse(r.at)>bound),next_page_token:null,result_size_estimate:4};
 }}) as never},desk,clock).find(h=>h.name==='get_communication')!;
 const result=await handler.handle({date_range:{from,to:'2026-09-30T00:00:01Z'}} as never);
 expect(result).toMatchObject({ok:true,data:{messages:[rows[1],rows[2]],coverage:{complete:false}}});
});
