import {expect,it} from 'vitest';
import {signCommonMessageIngress} from '../src/identity/common-message-ingress';
import {signCommonTaskSourceRequest,verifyCommonTaskSourceRequest} from '../src/identity/common-task-source-request';
const secret='fictional-source-command';
const input={provider:'telegram' as const,subject:'81105',doName:'fixture',physicalDoId:'a'.repeat(64),occurrenceId:'fixture-one',text:'Only supplied notes',at:1790000000};
it('classification, default families, quoted spans and original input are signed together, not supplied by model tool args',async()=>{
 const ingress=await signCommonMessageIngress(secret,input);
 const request=await signCommonTaskSourceRequest(secret,ingress,{operation:'classify',ownerInput:{inputRef:'tg-1',text:input.text,quotedRanges:[{start:0,end:4}]},defaults:['workspace'],raw:'{"decision":"restrict","sources":[]}'});
 await expect(verifyCommonTaskSourceRequest(secret,ingress,request)).resolves.toBeUndefined();
 for(const changed of [{raw:'{"decision":"retain","sources":["mail"]}'},{defaults:['mail']},{ownerInput:{inputRef:'tg-1',text:input.text,quotedRanges:[]}}]){
  await expect(verifyCommonTaskSourceRequest(secret,ingress,{...request,...changed} as typeof request)).rejects.toThrow();
 }
 await expect(verifyCommonTaskSourceRequest(secret,ingress,{...request,ownerInput:{inputRef:'tg-1',text:'Different message'}})).rejects.toThrow();
});
