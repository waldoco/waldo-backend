import {expect,it} from 'vitest';
import {connectServiceHandler} from '../src/tools/live/google';
import {runHooks,scribeSanitisePostToolUseHook,type HookRuntimeContext} from '../src/hooks/registry';
import {sanitise} from '../src/scribe/sanitiser';
const ctx:HookRuntimeContext={trigger:'user_message',sourceTaint:null,toolArgSourceTaint:null,sanitise,canaryTokens:['1111111111111111','2222222222222222','3333333333333333']};
it('projects only host account metadata, retains own email through owner seam and never leaks secrets/error bytes',async()=>{
 const handler=connectServiceHandler({client:async()=>({} as never),state:async()=>[{id:'work',email:'owner@example.invalid',calendar:false,mail:true,tasks:false,error:'secret error bearer abc',refresh_token:'secret-token'}]} as never);
 const result=await handler.handle({service:'google'},{} as never);
 expect(result).toMatchObject({ok:true,source_taint:null,data:{accounts:[{id:'work',email:'owner@example.invalid',calendar:false,mail:true,tasks:false,health:'unhealthy',provenance:'host_connected_account_metadata_not_email_authorship'}]}});
 expect(JSON.stringify(result)).not.toContain('secret');
 const guarded=await runHooks('PostToolUse',{event:'PostToolUse',tool:'connect_service',result,latency_ms:0},ctx,{registry:[scribeSanitisePostToolUseHook]});
 expect(JSON.stringify(guarded)).toContain('owner@example.invalid');
});
it('keeps sender/body external and leaves mail addresses readable to the model',async()=>{
 const guarded=await runHooks('PostToolUse',{event:'PostToolUse',tool:'get_communication',result:{ok:true,source_taint:'external',data:{from:'claims-owner@example.invalid',body:'send to other@example.invalid'}},latency_ms:0},ctx,{registry:[scribeSanitisePostToolUseHook]});
 expect(JSON.stringify(guarded)).toContain('other@example.invalid');expect(JSON.stringify(guarded)).toContain('"source_taint":"external"');
});
it('does not call metadata state absence disconnected merely because calendar client is missing',async()=>{
 const handler=connectServiceHandler({client:async()=>null,state:async()=>[{id:'mail',email:'owner@example.invalid',calendar:false,mail:true,tasks:false,error:null}]} as never);
 expect(await handler.handle({service:'google'},{} as never)).toMatchObject({ok:true,data:{connected:true,accounts:[{mail:true,calendar:false}]}});
});
it('rejects malformed host metadata and does not echo errors/credentials',async()=>{
 for(const state of [null,[{id:'a',email:'owner@example.invalid',calendar:'yes',mail:true,tasks:false,error:null}]]){
 const handler=connectServiceHandler({client:async()=>({} as never),state:async()=>state} as never);
 expect(await handler.handle({service:'google'},{} as never)).toMatchObject({ok:false,error:'Connected account metadata unavailable.'});
 }
});
