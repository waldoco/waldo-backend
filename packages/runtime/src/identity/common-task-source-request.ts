import { TASK_SOURCE_FAMILIES, type OwnerTaskInstruction, type TaskSourceFamily, type TaskSourceSnapshot } from '../channels/task-source-scope';
import { routerSignature } from './owner-directory';
import type { CommonMessageIngress } from './common-message-ingress';
export type CommonTaskSourceRequest = Readonly<{
  operation: 'current' | 'classify' | 'unresolved' | 'assert_same';
  ownerInput: OwnerTaskInstruction; defaults: readonly TaskSourceFamily[];
  raw?: string; expected?: TaskSourceSnapshot; signature: string;
}>;
const material = (ingress: CommonMessageIngress, request: Omit<CommonTaskSourceRequest,'signature'>) =>
  JSON.stringify(['common-task-source-v1',ingress.signature,request.operation,request.ownerInput,request.defaults,request.raw ?? null,request.expected ?? null]);
export async function signCommonTaskSourceRequest(secret: string, ingress: CommonMessageIngress, request: Omit<CommonTaskSourceRequest,'signature'>): Promise<CommonTaskSourceRequest> {
  return {...request,signature:await routerSignature(secret,ingress.at,material(ingress,request))};
}
export async function verifyCommonTaskSourceRequest(secret: string, ingress: CommonMessageIngress, request: CommonTaskSourceRequest) {
  if (!request || !['current','classify','unresolved','assert_same'].includes(request.operation)
    || request.ownerInput?.text !== ingress.text || typeof request.ownerInput.inputRef !== 'string' || request.ownerInput.inputRef.length > 128
    || !Array.isArray(request.defaults) || request.defaults.length > TASK_SOURCE_FAMILIES.length || new Set(request.defaults).size !== request.defaults.length || request.defaults.some(family => !TASK_SOURCE_FAMILIES.includes(family))
    || (request.ownerInput.quotedRanges ?? []).some(range => !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end > ingress.text.length)
    || request.raw !== undefined && (typeof request.raw !== 'string' || request.raw.length > 32768)
    || typeof request.signature !== 'string' || !/^[a-f0-9]{64}$/.test(request.signature)) throw Error('common task source request rejected');
  const expected=await routerSignature(secret,ingress.at,material(ingress,request));
  let difference=0;for(let i=0;i<expected.length;i++)difference|=expected.charCodeAt(i)^request.signature.charCodeAt(i);
  if(difference!==0)throw Error('common task source request rejected');
}
