import { routerSignature } from './owner-directory';
import type { CommonMessageIngress } from './common-message-ingress';
import type { TaskSourceSnapshot } from '../channels/task-source-scope';
import type { ExecutionBindingResolutionV04 } from '../coordinator/waldo-coordinator';
export type CommonExecutionRequest = Readonly<{
  operation: 'begin' | 'check' | 'settle' | 'provider_prepare' | 'provider_settle' | 'cancel'; source: TaskSourceSnapshot;
  binding: ExecutionBindingResolutionV04; tools: readonly string[];
  maxProviderTurns: number; maxDurationMs: number;
  providerCall?: Readonly<{ordinal:number;model:string;requestDigest:string;resultDigest?:string}>;
  result?: Readonly<{ref:string;digest:string}>; signature: string;
}>;
const material = (ingress: CommonMessageIngress, request: Omit<CommonExecutionRequest,'signature'>) =>
  JSON.stringify(['common-execution-v1',ingress.signature,request.operation,request.source,request.binding,request.tools,request.maxProviderTurns,request.maxDurationMs,request.result ?? null,request.providerCall ?? null]);
export async function signCommonExecutionRequest(secret:string,ingress:CommonMessageIngress,request:Omit<CommonExecutionRequest,'signature'>):Promise<CommonExecutionRequest>{
  return {...request,signature:await routerSignature(secret,ingress.at,material(ingress,request))};
}
export async function verifyCommonExecutionRequest(secret:string,ingress:CommonMessageIngress,request:CommonExecutionRequest){
  if(!request || !['begin','check','settle','provider_prepare','provider_settle','cancel'].includes(request.operation) || !Array.isArray(request.tools) || request.tools.length>32
    || new Set(request.tools).size!==request.tools.length || request.tools.some(tool=>typeof tool!=='string'||tool.length>128)
    || !Number.isSafeInteger(request.maxProviderTurns)||request.maxProviderTurns<1
    || !request.source || typeof request.source.taskId!=='string' || !Number.isSafeInteger(request.source.revision) || request.source.revision<1 || !Array.isArray(request.source.sources) || request.source.ready!==true
    || !Number.isSafeInteger(request.maxDurationMs)||request.maxDurationMs<1||request.maxDurationMs>600000
    || request.operation==='settle' && (!request.result || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.result.ref) || !/^sha256:[a-f0-9]{64}$/.test(request.result.digest))
    || request.operation!=='settle' && request.result!==undefined
    || request.operation.startsWith('provider_') && (!request.providerCall || !Number.isSafeInteger(request.providerCall.ordinal) || request.providerCall.ordinal<1 || !/^sha256:[a-f0-9]{64}$/.test(request.providerCall.requestDigest) || (typeof request.providerCall.model!=='string'||request.providerCall.model.length>128) || request.operation==='provider_settle' && !/^sha256:[a-f0-9]{64}$/.test(request.providerCall.resultDigest??''))
    || !request.operation.startsWith('provider_') && request.providerCall!==undefined
    || typeof request.signature!=='string'||!/^[a-f0-9]{64}$/.test(request.signature))throw Error('common execution request rejected');
  const expected=await routerSignature(secret,ingress.at,material(ingress,request));let difference=0;
  for(let i=0;i<expected.length;i++)difference|=expected.charCodeAt(i)^request.signature.charCodeAt(i);
  if(difference)throw Error('common execution request rejected');
}
