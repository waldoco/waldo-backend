import { expect, it } from 'vitest';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';

it.each(['blood pressure 160/100.md','x'.repeat(5000)])('externally authored sensitive or rewritten filenames are withheld before actual owner provider admission',async(path)=>{
 const requests:LLMGatewayRequest[]=[];
 const gateway:LLMGatewayAdapter={complete:async request=>{requests.push(request);return {ok:true,data:{model:request.request.model,text:'Ready',input_tokens:1,output_tokens:1,cache_read_input_tokens:0,latency_ms:0}};}};
 const args:Parameters<typeof createOwnerResponder>=['fixture'];args[10]=gateway;
 args[21]={skills:{handlers:[],metadata:()=>'',prompt:async()=>'',assertProcedureCurrent:async()=>undefined,
  taskContext:async()=>JSON.stringify([{backend:'workspace',path,file_id:'host-identity',revision:1}])}};
 await createOwnerResponder(...args).respond({traceId:'health-path',conversationRef:'owner',surface:'telegram',text:'Hello',memoryWrites:false},(_hop,work)=>work());
 expect(requests).toHaveLength(1);expect(requests[0]!.request.system).not.toContain(path);
 expect(requests[0]!.request.system).toContain('withheld by the context safety gate');
});
