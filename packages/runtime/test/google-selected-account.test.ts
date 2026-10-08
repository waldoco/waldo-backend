import { expect, it } from 'vitest';
import { googleHandlers } from '../src/tools/live/google';
import { readDriveHandler } from '../src/tools/live/drive';
import { queryCalendarArgsSchema,getCommunicationArgsSchema,searchCommunicationArgsSchema,readThreadArgsSchema,getTasksArgsSchema,readDriveArgsSchema,queryAvailabilityArgsSchema,draftEmailArgsSchema,proposeCalendarChangeArgsSchema,proposeScheduleArgsSchema,writeSheetCellArgsSchema } from '@waldo/contracts';
const account={connection_id:'work',email:'work@example.com'};
const desk={propose:async()=>'',proposeSendEmail:async()=>'',record:()=>{}};
const clock={timezone:'UTC',now:()=>new Date('2026-10-08T00:00:00Z')};
it('Google schemas admit optional validated account email',()=>{
 const cases=[ [queryCalendarArgsSchema,{}],[getCommunicationArgsSchema,{}],[searchCommunicationArgsSchema,{query:'topic'}],[readThreadArgsSchema,{thread_id:'t'}],[getTasksArgsSchema,{}],[readDriveArgsSchema,{action:'recent'}],[queryAvailabilityArgsSchema,{date_range:{from:'2026-10-08T00:00:00Z',to:'2026-10-08T01:00:00Z'},duration_minutes:30}],[draftEmailArgsSchema,{to:['to@example.com'],subject:'s',body_markdown:'b'}],[proposeCalendarChangeArgsSchema,{action:'cancel',event_id:'e',reason:'r'}],[proposeScheduleArgsSchema,{attendees:['to@example.com'],duration_min:30,title:'t'}],[writeSheetCellArgsSchema,{sheet_id:'s',range:'A1',value:'x'}] ] as const;
 for(const [schema,args] of cases){expect(schema.safeParse({...args,account:account.email}).success).toBe(true);expect(schema.safeParse({...args,account:'invalid'}).success).toBe(false);}
});
it('routes selected mail account and stamps the actual selected account',async()=>{
 const calls:unknown[]=[];
 const handlers=googleHandlers({client:async(...args:unknown[])=>{calls.push(args);return {account,mailPage:async()=>({messages:[],next_page_token:null,result_size_estimate:0})} as never;}},desk,clock);
 const result=await handlers.find(h=>h.name==='search_communication')!.handle({query:'topic',limit:2,account:account.email} as never);
 expect(calls[0]).toEqual(['mail',undefined,undefined,account.email]);
 expect(result).toMatchObject({ok:true,data:{account}});
});
it('rejects wrong-account adapter instead of silently returning another mailbox',async()=>{
 const handler=googleHandlers({client:async()=>({account:{connection_id:'p',email:'personal@example.com'},mailPage:async()=>({messages:[],next_page_token:null})} as never)},desk,clock).find(h=>h.name==='search_communication')!;
 expect((await handler.handle({query:'topic',limit:2,account:account.email} as never)).ok).toBe(false);
});
it('routes Drive selection and always supplies an account receipt',async()=>{
 const calls:unknown[]=[];
 const handler=readDriveHandler({client:async(...args:unknown[])=>{calls.push(args);return {account,driveListFiles:async()=>({files:[],nextPageToken:null,incompleteSearch:false})} as never;}},true);
 expect(await handler.handle({action:'recent',page_size:2,account:account.email} as never,undefined as never)).toMatchObject({ok:true,data:{account}});
 expect(calls[0]).toEqual(['drive',undefined,undefined,account.email]);
});
it('binds selected sending account into the stored proposal and receipt',async()=>{
 let proposal:unknown;
 const handler=googleHandlers({client:async()=>({account} as never)},{...desk,proposeSendEmail:async(p)=>{proposal=p;return 'p';}},clock).find(h=>h.name==='send_email')!;
 const result=await handler.handle({to:['to@example.com'],subject:'subject',body_markdown:'body',account:account.email} as never);
 expect(proposal).toMatchObject({account:account.email});
 expect(result).toMatchObject({ok:true,data:{account}});
});
