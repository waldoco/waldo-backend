import { describe, expect, it, vi } from 'vitest';
import { buildSessionState } from '@waldo/contracts';
import { ClosedRunError, type RunEffectScope } from '../src/channels/run-effect-scope';
import { runToolLoop } from '../src/conversation/tool-loop';
import { getContextHandler } from '../src/tools/live/get-context';
import { resolveRunLoopAdapters } from '../src/run-loop/adapters';
const state=vi.hoisted(()=>({entered:undefined as undefined|(()=>void),finish:undefined as undefined|((value:unknown)=>void)}));
vi.mock('openai',()=>({default:class {responses={create:async(body:unknown)=>{
 const b=body as {input?:unknown};if(JSON.stringify(b.input).includes('DELAYED_OLD')) {state.entered?.();return new Promise(r=>{state.finish=r;});}
 return {id:'mock',output_text:'new reply',output:[],usage:{input_tokens:1,output_tokens:1}};
}};}}));
const {createOwnerResponder}=await import('../src/channels/owner-turn');
const scope=()=>{let live=true;const controller=new AbortController();const capability:RunEffectScope={runId:crypto.randomUUID(),attempt:crypto.randomUUID(),deadline:Date.now()+150000,signal:controller.signal,admit(){if(!live)throw new ClosedRunError();},commit(work){this.admit();return work();}};return {capability,close(){live=false;controller.abort();}};};
const time=<T>(_h:string,w:()=>Promise<T>)=>w();
describe('run-local responder fence',()=>{
 it('closed delayed model result does not save history or replace a new run reply',async()=>{
  const entries:unknown[]=[];const responder=createOwnerResponder('fixture',{load:async()=>({entries:[],leafId:null}),save:async rows=>{entries.push(...rows);}});
  const oldScope=scope();const newScope=scope();let entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});state.entered=entered;
  const old=responder.respond({traceId:'old',conversationRef:'owner',surface:'telegram',text:'DELAYED_OLD',memoryWrites:false,runScope:oldScope.capability},time);
  const caught=old.catch(e=>e);await ready;oldScope.close();
  expect(await responder.respond({traceId:'new',conversationRef:'owner',surface:'telegram',text:'hello',memoryWrites:false,runScope:newScope.capability},time)).toBe('new reply');
  state.finish!({id:'late',output_text:'late old reply',output:[],usage:{input_tokens:1,output_tokens:1}});
  expect(await caught).toBeInstanceOf(ClosedRunError);expect(JSON.stringify(entries)).toContain('new reply');expect(JSON.stringify(entries)).not.toContain('late old reply');expect(JSON.stringify(entries)).not.toContain('DELAYED_OLD');
 });
 it('tool loop refuses dispatch returned by a model after closure',async()=>{
  const f=scope();const handler=getContextHandler({timezone:'UTC',now:()=>new Date()});const handle=vi.fn(handler.handle);const a=resolveRunLoopAdapters({WALDO_ENV:'local'});const canaries=['0123456789abcdef','fedcba9876543210','0011223344556677'];
  await expect(runToolLoop({handlers:[{...handler,handle}],maxSteps:2,ctx:{authenticatedUserId:'owner',trigger:'user_message',sourceTaint:null,toolArgSourceTaint:null,canaryTokens:canaries,sanitise:a.safety.sanitise,medicalGate:a.safety.medicalGate,session:buildSessionState({trigger:'user_message',canary_tokens:canaries,started_at:0}),runScope:f.capability},step:async()=>{f.close();return {text:'',tool_calls:[{call_id:'late',name:'get_context',arguments:'{}'}]};}})).rejects.toBeInstanceOf(ClosedRunError);expect(handle).not.toHaveBeenCalled();
 });
});
