import { routerSignature } from './owner-directory';
import type { PresenceProvider } from './owner-directory';
export type CommonMessageIngress = Readonly<{
 provider: PresenceProvider; subject: string; doName: string; physicalDoId: string;
 occurrenceId: string; text: string; at: number; signature: string;
}>;
export const commonMessageIngressMaterial = (input: Omit<CommonMessageIngress,'signature'>) =>
 JSON.stringify(['common-message-v1',input.provider,input.subject,input.doName,input.physicalDoId,input.occurrenceId,input.text]);
export async function signCommonMessageIngress(secret: string, input: Omit<CommonMessageIngress,'signature'>): Promise<CommonMessageIngress> {
 return {...input,signature:await routerSignature(secret,input.at,commonMessageIngressMaterial(input))};
}
export async function verifyCommonMessageIngress(secret: string | undefined, input: CommonMessageIngress, now: number) {
 if (!secret || !input || !['telegram','whatsapp'].includes(input.provider) || !/^\d{1,32}$/.test(input.subject)
  || typeof input.doName!=='string' || !input.doName || input.doName.length>240
  || typeof input.physicalDoId!=='string' || !/^[a-f0-9]{64}$/.test(input.physicalDoId)
  || typeof input.occurrenceId!=='string' || !input.occurrenceId || input.occurrenceId.length>240
  || typeof input.text!=='string' || !input.text.trim() || new TextEncoder().encode(input.text).byteLength>16384
  || !Number.isSafeInteger(input.at) || Math.abs(Math.floor(now/1000)-input.at)>300
  || typeof input.signature!=='string' || !/^[a-f0-9]{64}$/.test(input.signature)) throw Error('common message ingress rejected');
 const expected=await routerSignature(secret,input.at,commonMessageIngressMaterial(input));
 let difference=0;for(let i=0;i<expected.length;i++)difference|=expected.charCodeAt(i)^input.signature.charCodeAt(i);
 if(difference!==0)throw Error('common message ingress rejected');
}
