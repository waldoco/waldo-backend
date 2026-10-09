import {expect,it,vi} from 'vitest';
import {generalPageState} from '../src/channels/general-browser-observation';
it('explicit one-time-code controls never export their value into agent DOM state',()=>{
 const node:any={tagName:'INPUT',type:'text',value:'FICTIONAL_OTP_CANARY',nodeType:1,parentElement:null,labels:[{innerText:'One time code'}],getBoundingClientRect:()=>({width:20,height:20}),matches:(selector:string)=>selector!==':disabled',getAttribute:(name:string)=>name==='autocomplete'?'one-time-code':null,hasAttribute:()=>false};
 const document:any={body:{innerText:'Account'},title:'Account',querySelectorAll:()=>[node]};node.getRootNode=()=>document;
 vi.stubGlobal('document',document);vi.stubGlobal('getComputedStyle',()=>({visibility:'visible',display:'block'}));vi.stubGlobal('location',{href:'https://fixture.invalid/account'});
 try{expect(generalPageState().elements[0]?.value).toBe('');expect(JSON.stringify(generalPageState())).not.toContain('FICTIONAL_OTP_CANARY');}finally{vi.unstubAllGlobals();}
});
