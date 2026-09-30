import { it, expect } from 'vitest';
import { prepareWithScribe } from '../src/scribe/prepare';
const guarded = (sender: string) => prepareWithScribe([{call:{call_id:'fixture',name:'get_communication',arguments:'{}'},output:JSON.stringify({messages:[{from:sender,subject:'Fixture status',snippet:'Cedar launch is ready for review.'}]})}],{safeParse:(v:unknown)=>({success:true as const,data:v})},'internal_context','external',['1111111111111111','2222222222222222','3333333333333333']);
it('fictional display-name sender survives current external scribe but email does not',()=>{
 const display=guarded('Fictional Cedar Sender');expect(display.ok).toBe(true);if(display.ok) expect(JSON.stringify(display.value)).toContain('Fictional Cedar Sender');
 const email=guarded('fictional-sender@example.invalid');expect(email.ok).toBe(true);if(email.ok) {expect(JSON.stringify(email.value)).toContain('[REDACTED_EMAIL]');expect(JSON.stringify(email.value)).not.toContain('fictional-sender@example.invalid');}
});
