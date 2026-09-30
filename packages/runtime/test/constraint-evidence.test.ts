// Prompt contract regression only. This does not simulate or grade a live model.
import {it,expect} from 'vitest';
import {messagingSystemPrompt} from '../src/prompt/messaging-behavior';
it('requires independent checks before constrained recommendations',()=>{
 const prompt=messagingSystemPrompt([]);
 expect(prompt).toContain('check every option against every explicit constraint independently');
 expect(prompt).toContain('use the latest stated values');
 expect(prompt).toContain('do not carry over the verdict');
 expect(prompt).toContain('Verify arithmetic and time comparisons before answering');
});

import {vi} from 'vitest';
const captured=vi.hoisted(()=>({inputs:[] as unknown[]}));
vi.mock('openai',()=>({default:class { responses={create:async(input:unknown)=>{captured.inputs.push(input);return {id:'fixture',output_text:'fixture acknowledgement',output:[],usage:{input_tokens:1,output_tokens:1,input_tokens_details:{cached_tokens:0}}};}};}}));
const {createOwnerResponder}=await import('../src/channels/owner-turn');
it('real owner pipeline keeps swapped latest values and verification rule in provider input',async()=>{
 captured.inputs.length=0;
 const responder=createOwnerResponder('fixture-key');
 const time=<T>(_hop:string,work:()=>Promise<T>)=>work();
 await responder.respond({traceId:'old',conversationRef:'fixture',surface:'telegram',text:'Fictional old rows: A13000/19:00 B19000/17:00 C23000/16:00. Budget20000, arrive by18:00.'},time);
 const latest='Fictional changed rows: A22000/16:30 B18500/17:45 C19500/18:15. Budget20000, arrive by18:00.';
 await responder.respond({traceId:'new',conversationRef:'fixture',surface:'telegram',text:latest},time);
 const input=JSON.stringify(captured.inputs.at(-1));
 expect(input).toContain(latest);
 expect(input).toContain('check every option against every explicit constraint independently');
 expect(input).toContain('do not carry over the verdict');
 // Mock proves input fidelity and prompt presence, never correct model arithmetic.
});
