import {describe,it,expect} from 'vitest';
import {scopeBrowserState} from '../src/channels/browser-state-site-scope';
const policy={origins:['https://app.example.com'],cookieDomains:['app.example.com']};
const cookie=(domain:string)=>({name:'sid',value:'sensitive',domain,path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'});
describe('host-only site state filter, not account identity or egress',()=>{
 it('keeps exact admitted origin/IndexedDB and cookie domain, drops siblings',()=>{
 const indexedDB=[{name:'db',version:1,stores:[]}];
 expect(scopeBrowserState({cookies:[cookie('app.example.com'),cookie('.example.com'),cookie('evilapp.example.com')],origins:[{origin:'https://app.example.com',localStorage:[],indexedDB},{origin:'https://other.example.com',localStorage:[]}]},policy)).toEqual({cookies:[cookie('app.example.com')],origins:[{origin:'https://app.example.com',localStorage:[],indexedDB}]});
 });
 it('leading-dot cookie domain requires explicit parent domain admission',()=>expect(scopeBrowserState({cookies:[cookie('.example.com')],origins:[]},{origins:policy.origins,cookieDomains:['example.com']})).toEqual({cookies:[cookie('.example.com')],origins:[]}));
 it.each([null,{},[],{cookies:{},origins:[]},{cookies:[],origins:[{origin:'https://app.example.com/path'}]},{cookies:[cookie('')],origins:[]}])('rejects malformed state %j',state=>expect(()=>scopeBrowserState(state,policy)).toThrow('browser_state_scope_invalid'));
 it.each(['http://app.example.com','https://app.example.com/path','https://user@app.example.com','https://app.example.com:443'])('rejects noncanonical host origin %s',origin=>expect(()=>scopeBrowserState({cookies:[],origins:[]},{...policy,origins:[origin]})).toThrow());
 it('rejects serialization hooks and getters without invoking them',()=>{
 let touched=0;const hooked={...cookie('app.example.com'),toJSON(){touched++;return cookie('.evil.com');}};expect(()=>scopeBrowserState({cookies:[hooked],origins:[]},policy)).toThrow();
 const originHook={origin:'https://app.example.com',localStorage:[],toJSON(){touched++;return {origin:'https://evil.com',localStorage:[]};}};expect(()=>scopeBrowserState({cookies:[],origins:[originHook]},policy)).toThrow();
 const getter={...cookie('app.example.com')};Object.defineProperty(getter,'value',{get(){touched++;return 'bad';},enumerable:true});expect(()=>scopeBrowserState({cookies:[getter],origins:[]},policy)).toThrow();expect(touched).toBe(0);
 });
 it('output is detached from mutable input',()=>{const state={cookies:[cookie('app.example.com')],origins:[{origin:'https://app.example.com',localStorage:[{name:'key',value:'old'}]}]};const result=scopeBrowserState(state,policy);state.cookies[0]!.value='changed';state.origins[0]!.localStorage[0]!.value='changed';expect(JSON.stringify(result)).not.toContain('changed');});
 it('rejects unsupported top-level fields rather than persisting hidden state',()=>expect(()=>scopeBrowserState({cookies:[],origins:[],secret:'bad'},policy)).toThrow());
});
