import {expect,it,vi} from 'vitest';
import {generalPageState} from '../src/channels/general-browser-observation';
type Control=Readonly<{tagName:string;type:string;attributes?:Readonly<Record<string,string>>;formMethod?:string;formAction?:string}>;
const observe=(form:{method:string;action:string}|undefined,controls:readonly Control[])=>{
 const nodes:any[]=[];
 const formNode=form&&{...form,elements:nodes};
 for(const control of controls)nodes.push({...control,value:'',nodeType:1,parentElement:null,labels:[],form:formNode,getBoundingClientRect:()=>({width:20,height:20}),matches:(selector:string)=>selector!==':disabled',getAttribute:(name:string)=>control.attributes?.[name]??null,hasAttribute:(name:string)=>name in (control.attributes??{})});
 const document:any={body:{innerText:'Search'},title:'Search',querySelectorAll:(selector:string)=>selector==='*'?nodes:[]};for(const node of nodes)node.getRootNode=()=>document;
 vi.stubGlobal('document',document);vi.stubGlobal('getComputedStyle',()=>({visibility:'visible',display:'block'}));vi.stubGlobal('location',{href:'https://fixture.invalid/'});
 try{return generalPageState().elements;}finally{vi.unstubAllGlobals();}
};
it('a field records the submission its Enter would make: the form default button overrides the form',()=>{
 const [field,button]=observe({method:'get',action:'https://fixture.invalid/search'},[{tagName:'INPUT',type:'search'},{tagName:'BUTTON',type:'submit',attributes:{formmethod:'post',formaction:'/save'},formMethod:'post',formAction:'https://fixture.invalid/save'}]);
 expect(field).toMatchObject({inForm:true,formMethod:'post',formAction:'https://fixture.invalid/save'});
 expect(button).toMatchObject({formMethod:'post',formAction:'https://fixture.invalid/save'});
});
it('a field in a form without a submit button records the form method and action, and a plain button never counts as the default',()=>{
 const [field]=observe({method:'get',action:'https://fixture.invalid/search'},[{tagName:'INPUT',type:'text'},{tagName:'BUTTON',type:'button',attributes:{formmethod:'post'},formMethod:'post'}]);
 expect(field).toMatchObject({formMethod:'get',formAction:'https://fixture.invalid/search'});
});
it('a submit button without overrides records its form, and a control outside a form records no submission',()=>{
 const [button]=observe({method:'post',action:'https://fixture.invalid/checkout'},[{tagName:'INPUT',type:'submit'}]);
 expect(button).toMatchObject({formMethod:'post',formAction:'https://fixture.invalid/checkout'});
 const [loose]=observe(undefined,[{tagName:'INPUT',type:'text'}]);
 expect(loose).not.toHaveProperty('formMethod');expect(loose).not.toHaveProperty('formAction');
});
