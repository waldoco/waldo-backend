import {expect,it} from 'vitest';
import {signCommonMessageIngress,verifyCommonMessageIngress} from '../src/identity/common-message-ingress';
const secret='fictional-common-ingress';
const input={provider:'telegram' as const,subject:'81105',doName:'fixture',physicalDoId:'a'.repeat(64),occurrenceId:'fixture-one',text:'Private supplied-data task',at:1790000000};
it('binds exact message bytes, issuer, occurrence and physical locator to signed ingress',async()=>{
 const signed=await signCommonMessageIngress(secret,input);
 await expect(verifyCommonMessageIngress(secret,signed,input.at*1000)).resolves.toBeUndefined();
 for(const changed of [{text:'Other task'},{subject:'81106'},{doName:'foreign'},{provider:'whatsapp'},{physicalDoId:'b'.repeat(64)},{occurrenceId:'other'}]) {
  await expect(verifyCommonMessageIngress(secret,{...signed,...changed} as typeof signed,input.at*1000)).rejects.toThrow('common message ingress rejected');
 }
});
it('no signing configuration or stale transport signature is admitted',async()=>{
 const signed=await signCommonMessageIngress(secret,input);
 await expect(verifyCommonMessageIngress(undefined,signed,input.at*1000)).rejects.toThrow();
 await expect(verifyCommonMessageIngress(secret,signed,(input.at+301)*1000)).rejects.toThrow();
 await expect(verifyCommonMessageIngress(secret,signed,(input.at-301)*1000)).rejects.toThrow();
});
