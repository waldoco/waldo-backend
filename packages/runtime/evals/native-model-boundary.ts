// Supervisor transport: actual response bytes/usage captured outside model context.
// No provider/Telegram/merchant traffic, redirects or uncapped retry admitted here.
import { parseResponseUsage, type UsageLine } from './usage-reconciliation';
export type NativeModelAttempt=Readonly<{sequence:number;status:number|null;response_id:string|null;usage:UsageLine|null;outcome:'pending'|'captured'|'http_error'|'invalid_response'|'transport_error'}>;
export const nativeModelBoundary=(network:typeof fetch,limits:Readonly<{max_attempts:number;timeout_ms:number;model:string;max_output_tokens:number;max_request_bytes:number;max_total_tokens:number}>)=>{
 // Spend ceiling in code: every admitted attempt reserves request bytes (tokens never exceed bytes) plus the output cap;
 // captured usage replaces the reservation, failed or unknown attempts keep it. Admission fails closed past max_total_tokens.
 for(const v of [limits.max_output_tokens,limits.max_request_bytes,limits.max_total_tokens])if(!Number.isSafeInteger(v)||v<1)throw new Error('invalid native model budget');
 if(!Number.isSafeInteger(limits.max_attempts)||limits.max_attempts<1||limits.max_attempts>48||!Number.isSafeInteger(limits.timeout_ms)||limits.timeout_ms<1||limits.timeout_ms>180000||!limits.model.trim())throw new Error('invalid native model bounds');
const attempts:NativeModelAttempt[]=[]; const reserved:number[]=[];
 const spent=()=>attempts.reduce((n,a,i)=>n+(a.usage?a.usage.input_tokens+a.usage.output_tokens:reserved[i]!),0);
 const pending=new Set<Promise<Response>>();
 const run=async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  const method=init?.method??(input instanceof Request?input.method:'GET');
  if(url.href!=='https://api.openai.com/v1/responses'||method!=='POST')throw new Error('native outbound destination denied');
  // Inputs must be visible request bodies, not opaque Request streams that evade model admission.
  if(typeof init?.body!=='string')throw new Error('native model request body unavailable');
  let body:{model?:unknown;max_output_tokens?:unknown};try{body=JSON.parse(init.body) as typeof body;}catch{throw new Error('native model request JSON invalid');}
  if(body.model!==limits.model)throw new Error('native model differs from approved roster');
  if(attempts.length>=limits.max_attempts)throw new Error('native model attempt budget exhausted');
  const bytes=new TextEncoder().encode(init.body).length;
  if(bytes>limits.max_request_bytes)throw new Error('native model request exceeds byte bound');
  if(body.max_output_tokens!==undefined&&(!Number.isSafeInteger(body.max_output_tokens)||(body.max_output_tokens as number)<1||(body.max_output_tokens as number)>limits.max_output_tokens))throw new Error('native model output cap exceeds bound');
  const reserve=bytes+limits.max_output_tokens;
  if(spent()+reserve>limits.max_total_tokens)throw new Error('native model token ceiling exhausted');
  if(body.max_output_tokens===undefined)init={...init,body:JSON.stringify({...body,max_output_tokens:limits.max_output_tokens})};
  const index=attempts.length;
  attempts.push({sequence:index+1,status:null,response_id:null,usage:null,outcome:'pending'});reserved.push(reserve);
  const controller=new AbortController();const priorSignal=init?.signal??(input instanceof Request?input.signal:undefined);
  const abort=()=>controller.abort();priorSignal?.addEventListener('abort',abort,{once:true});if(priorSignal?.aborted)abort();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   // Promise.race bounds even transports which ignore AbortSignal. Late responses never become accepted receipts.
   const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('native model timeout'));},limits.timeout_ms);});
   const response=await Promise.race([network(input,{...init,redirect:'manual',signal:controller.signal}),timeout]);
   attempts[index]={...attempts[index]!,status:response.status,outcome:'http_error'};
   if(response.status<200||response.status>=300)throw new Error('native model HTTP failure');
   try{
    const data:unknown=await Promise.race([response.clone().json(),timeout]);
    const usage=parseResponseUsage(data);
    if(usage.model!==limits.model)throw new Error('native response model differs from approved roster');
    attempts[index]={...attempts[index]!,response_id:usage.response_id,usage,outcome:'captured'};
   }catch{attempts[index]={...attempts[index]!,outcome:'invalid_response'};throw new Error('native model response receipt invalid');}
   return response;
  }catch{
   if(attempts[index]!.outcome==='pending')attempts[index]={...attempts[index]!,outcome:'transport_error'};
   throw new Error('native model attempt failed; restricted diagnostics only');
  }finally{if(timer!==undefined)clearTimeout(timer);priorSignal?.removeEventListener('abort',abort);}
 };
 const transport=((input:RequestInfo|URL,init?:RequestInit)=>{
  const work=run(input,init);pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work));return work;
 }) as typeof fetch;
 return {fetch:transport,receipts:()=>structuredClone(attempts),tokens_spent:spent,pending:()=>pending.size,settle:async()=>{while(pending.size)await Promise.allSettled([...pending]);}};
};
