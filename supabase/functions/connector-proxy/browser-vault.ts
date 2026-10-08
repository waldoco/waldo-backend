import { scopeBrowserState, type BrowserStateSitePolicy } from '../../../packages/runtime/src/channels/browser-state-site-scope.ts';
import { BROWSER_STATE_BYTES, BROWSER_STATE_WIRE_BYTES, type BrowserVaultScope } from '../../../packages/runtime/src/channels/browser-state-custody.ts';
export { BROWSER_STATE_WIRE_BYTES };
export class BrowserVaultError extends Error {constructor(){super('browser_state_unavailable');}}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,expected:string)=>Object.keys(v).sort().join(',')===expected;
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function validateBrowserVaultScope(value:unknown):asserts value is BrowserVaultScope {
 if(!record(value)||!keys(value,'binding,consentRevision,custodyDigest,doId,expiresAt,namespace,sitePolicy,subject')||!record(value.binding)||!keys(value.binding,'accountId,environment,generation,ownerId,siteOrigin'))throw new BrowserVaultError();
 const b=value.binding;
 if(!uuid(b.ownerId)||b.environment!=='staging'||typeof b.accountId!=='string'||!b.accountId||b.accountId.trim()!==b.accountId||b.accountId.length>200||/[\x00-\x1f\x7f]/.test(b.accountId)||!Number.isSafeInteger(b.generation)||Number(b.generation)<1||!uuid(value.consentRevision)||typeof value.custodyDigest!=='string'||!/^[0-9a-f]{64}$/.test(value.custodyDigest)||!Number.isSafeInteger(value.expiresAt)||Number(value.expiresAt)<1||typeof value.subject!=='string'||!/^\d{1,32}$/.test(value.subject)||[value.namespace,value.doId].some(v=>typeof v!=='string'||!v||v.length>240||/[\x00-\x1f\x7f]/.test(v)))throw new BrowserVaultError();
 try{const u=new URL(String(b.siteOrigin));if(u.protocol!=='https:'||u.origin!==b.siteOrigin||u.username||u.password||!record(value.sitePolicy)||!keys(value.sitePolicy,'cookieDomains,origins'))throw Error();scopeBrowserState({cookies:[],origins:[]},value.sitePolicy as BrowserStateSitePolicy);if(!(value.sitePolicy.origins as unknown[]).includes(b.siteOrigin)||new TextEncoder().encode(JSON.stringify(value)).length>8192)throw Error();}catch{throw new BrowserVaultError();}
}
export const browserVaultState=(state:unknown,scope:BrowserVaultScope):string=>{
 try{if(typeof state!=='string'||new TextEncoder().encode(state).length>BROWSER_STATE_BYTES)throw Error();const filtered=JSON.stringify(scopeBrowserState(JSON.parse(state),scope.sitePolicy));if(new TextEncoder().encode(filtered).length>BROWSER_STATE_BYTES)throw Error();return filtered;}catch{throw new BrowserVaultError();}
};
export async function browserVaultOperation(input:unknown,db:(fn:string,args:Record<string,unknown>,signal?:AbortSignal)=>Promise<unknown>,now=Date.now):Promise<unknown>{
 if(!record(input)||!['load','save','revoke'].includes(String(input.action))||!keys(input,input.action==='save'?'action,do_name,expected_revision,op,scope,state':'action,do_name,op,scope')||input.op!=='browser_state'||typeof input.do_name!=='string'||!input.do_name||input.do_name.length>240)throw new BrowserVaultError();
 validateBrowserVaultScope(input.scope);const scope=input.scope;
 if(input.action!=='revoke'&&now()>=scope.expiresAt)throw new BrowserVaultError();
 if(input.action==='save'&&(!Number.isSafeInteger(input.expected_revision)||Number(input.expected_revision)<0))throw new BrowserVaultError();
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const result=await Promise.race([db('proxy_browser_state',{p_do_name:input.do_name,p_scope:scope,p_action:input.action,p_state:input.action==='save'?browserVaultState(input.state,scope):null,p_expected_revision:input.action==='save'?input.expected_revision:null},controller.signal),new Promise<never>((_,no)=>{timer=setTimeout(()=>{controller.abort();no(new BrowserVaultError());},10000);})]);
  if(!record(result)||!Number.isSafeInteger(result.revision)||Number(result.revision)<0)throw new BrowserVaultError();
  if(input.action==='load'){if(!keys(result,'revision,state'))throw new BrowserVaultError();return {state:result.state===null?null:browserVaultState(result.state,scope),revision:result.revision};}
  if(!keys(result,input.action==='save'?'revision,saved':'revision,revoked')||result[input.action==='save'?'saved':'revoked']!==true)throw new BrowserVaultError();
  return result;
 }catch{throw new BrowserVaultError();}finally{clearTimeout(timer);}
}
