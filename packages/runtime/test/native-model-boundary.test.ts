import { expect,it,vi } from 'vitest';
import { nativeModelBoundary } from '../evals/native-model-boundary';
const limits={max_attempts:1,timeout_ms:30,model:'fixture-model',max_output_tokens:100,max_request_bytes:4096,max_total_tokens:5000};
const request={method:'POST',body:JSON.stringify({model:limits.model})};
const response=()=>new Response(JSON.stringify({id:'response1',model:limits.model,usage:{input_tokens:10,output_tokens:2,input_tokens_details:{cached_tokens:0}}}),{status:200});
it('captures token receipt, reserves attempts before awaits and denies foreign network/model',async()=>{
 const network=vi.fn(async()=>response());const b=nativeModelBoundary(network,limits);
 await expect(b.fetch('https://outside.invalid',request)).rejects.toThrow();
 await expect(b.fetch('https://api.openai.com/v1/responses',{...request,body:JSON.stringify({model:'foreign'})})).rejects.toThrow();
 expect(network).not.toHaveBeenCalled();expect(b.receipts()).toEqual([]);
 await b.fetch('https://api.openai.com/v1/responses',request);
 expect(b.receipts()[0]).toMatchObject({outcome:'captured',response_id:'response1',usage:{input_tokens:10,output_tokens:2}});
 await expect(b.fetch('https://api.openai.com/v1/responses',request)).rejects.toThrow('budget');expect(network).toHaveBeenCalledTimes(1);
});
it('counts failed attempts, denies redirect/invalid token shape and never leaks thrown secret text',async()=>{
 for(const network of [async()=>new Response('',{status:302}),async()=>new Response('{}'),async()=>{throw Error('SECRET');}]){
  const b=nativeModelBoundary(network as typeof fetch,limits);
  await expect(b.fetch('https://api.openai.com/v1/responses',request)).rejects.not.toThrow('SECRET');
  expect(b.receipts()).toHaveLength(1);expect(b.receipts()[0]?.outcome).not.toBe('captured');expect(JSON.stringify(b.receipts())).not.toContain('SECRET');
 }
});
it('bounds hung transport even if it ignores abort, counts concurrent attempts and clears settled tracking',async()=>{
 const network=vi.fn(()=>new Promise<Response>(()=>{}));const b=nativeModelBoundary(network as typeof fetch,limits);
 const first=b.fetch('https://api.openai.com/v1/responses',request);
 await expect(b.fetch('https://api.openai.com/v1/responses',request)).rejects.toThrow('budget');
 await expect(first).rejects.toThrow();await b.settle();expect(b.pending()).toBe(0);expect(network).toHaveBeenCalledTimes(1);
 expect(b.receipts()[0]?.outcome).toBe('transport_error');
});

it('refuses oversized requests, over-cap output and attempts past the token ceiling; injects the output cap',async()=>{
 const url='https://api.openai.com/v1/responses';
 const network=vi.fn(async()=>response());
 const b=nativeModelBoundary(network,{...limits,max_attempts:5,max_total_tokens:315,max_request_bytes:300});
 await expect(b.fetch(url,{method:'POST',body:JSON.stringify({model:limits.model,input:'x'.repeat(400)})})).rejects.toThrow();
 await expect(b.fetch(url,{method:'POST',body:JSON.stringify({model:limits.model,max_output_tokens:101})})).rejects.toThrow();
 expect(network).not.toHaveBeenCalled();
 await b.fetch(url,request);
 const sent=JSON.parse(String((network.mock.calls[0] as unknown as [unknown,RequestInit])[1].body)) as {max_output_tokens:number};
 expect(sent.max_output_tokens).toBe(100);
 expect(b.tokens_spent()).toBe(12);
 const big=JSON.stringify({model:limits.model,input:'y'.repeat(150)});
 await b.fetch(url,{method:'POST',body:big});await b.fetch(url,{method:'POST',body:big});
 await expect(b.fetch(url,{method:'POST',body:big})).rejects.toThrow();
 expect(network).toHaveBeenCalledTimes(3);
});
