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
