import {it,expect,vi} from 'vitest';
const calls=vi.hoisted(()=>({writer:0}));
vi.mock('openai',()=>({default:class {responses={create:async(body:unknown)=>{
 const writer=(body as {text?:{format?:{type:string}}}).text?.format?.type==='json_schema';if(writer)calls.writer++;
 return {id:'fixture',output_text:writer?'{}':'pong',output:[],usage:{input_tokens:1,output_tokens:1,input_tokens_details:{cached_tokens:0}}};
}};}}));
const {createOwnerResponder}=await import('../src/channels/owner-turn');
const memory={claims:()=>[],recall:()=>[],nodes:()=>[],edges:()=>[],barriers:()=>[],beginSettle:()=>{},endSettle:()=>{},settle:()=>{},sweepInterruptedSettles:()=>0};
it('host-selected memoryWrites:false blocks writer independent of owner prose',async()=>{
 calls.writer=0;const pending:Promise<unknown>[]=[];const args:Parameters<typeof createOwnerResponder>=['fixture',undefined,memory as never];args[16]=work=>{pending.push(work);};
 const responder=createOwnerResponder(...args);expect(await responder.respond({traceId:'optout',conversationRef:'owner',surface:'telegram',text:'Synthetic hello',memoryWrites:false},(_name,work)=>work())).toBe('pong');await Promise.all(pending);expect(calls.writer).toBe(0);
});
it('default behavior remains model-driven and still runs writer',async()=>{
 calls.writer=0;const pending:Promise<unknown>[]=[];const args:Parameters<typeof createOwnerResponder>=['fixture',undefined,memory as never];args[16]=work=>{pending.push(work);};
 const responder=createOwnerResponder(...args);await responder.respond({traceId:'default',conversationRef:'owner',surface:'telegram',text:'No memory writes.'},(_name,work)=>work());await Promise.all(pending);expect(calls.writer).toBe(1);
});

it('captures host control before any awaited reply',async()=>{
 calls.writer=0;const pending:Promise<unknown>[]=[];const args:Parameters<typeof createOwnerResponder>=['fixture',undefined,memory as never];args[16]=work=>{pending.push(work);};
 const responder=createOwnerResponder(...args);const turn={traceId:'mutation',conversationRef:'owner',surface:'telegram',text:'Synthetic hello',memoryWrites:false};
 const replying=responder.respond(turn,(_name,work)=>work());turn.memoryWrites=true;await replying;await Promise.all(pending);expect(calls.writer).toBe(0);
});
