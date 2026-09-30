// Supervisor transport: actual response bytes/usage captured outside model context.
// No provider/Telegram/merchant traffic, redirects or uncapped retry admitted here.
import { parseResponseUsage, type UsageLine } from './usage-reconciliation';
export type NativeModelAttempt=Readonly<{sequence:number;status:number|null;response_id:string|null;usage:UsageLine|null;outcome:'pending'|'captured'|'http_error'|'invalid_response'|'transport_error'}>;
export const nativeModelBoundary=(network:typeof fetch,limits:Readonly<{max_attempts:number;timeout_ms:number;model:string}>)=>{
 if(!Number.isSafeInteger(limits.max_attempts)||limits.max_attempts<1||limits.max_attempts>48||!Number.isSafeInteger(limits.timeout_ms)||limits.timeout_ms<1||limits.timeout_ms>180000||!limits.model.trim())throw new Error('invalid native model bounds');
 const attempts:NativeModelAttempt[]=[]; const pending=new Set<Promise<Response>>();
 const run=async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  const method=init?.method??(input instanceof Request?input.method:'GET');
  if(url.href!=='https://api.openai.com/v1/responses'||method!=='POST')throw new Error('native outbound destination denied');
  // Inputs must be visible request bodies, not opaque Request streams that evade model admission.
  if(typeof init?.body!=='string')throw new Error('native model request body unavailable');
  let body:{model?:unknown};try{body=JSON.parse(init.body) as typeof body;}catch{throw new Error('native model request JSON invalid');}
  if(body.model!==limits.model)throw new Error('native model differs from approved roster');
  if(attempts.length>=limits.max_attempts)throw new Error('native model attempt budget exhausted');
  const index=attempts.length;
  attempts.push({sequence:index+1,status:null,response_id:null,usage:null,outcome:'pending'});
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
 return {fetch:transport,receipts:()=>structuredClone(attempts),pending:()=>pending.size,settle:async()=>{while(pending.size)await Promise.allSettled([...pending]);}};
};
