import { routerSignature, hex, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { browserBoundedJson } from '../channels/browser-bounded-body';
import { scopeBrowserState } from '../channels/browser-state-site-scope';
import { BROWSER_STATE_BYTES, BROWSER_STATE_WIRE_BYTES, type BrowserVaultScope } from '../channels/browser-state-custody';
const unavailable=()=>Error('browser_state_unavailable');
// Native state exists transiently in the authorized host and browser. Only existing Vault persists it.
export function browserStateVault(options:Readonly<{env:OwnerDirectoryEnv;doName:string;scope:BrowserVaultScope;assertCurrent():Promise<void>;fetcher?:typeof fetch;now?:()=>number}>){
 const scope=JSON.parse(JSON.stringify(options.scope)) as BrowserVaultScope,now=options.now??Date.now,fetcher=options.fetcher??fetch;
 let revision:number|undefined;
 const post=async(action:'load'|'save'|'revoke',extra:Record<string,unknown>={})=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([(async()=>{
   await options.assertCurrent();if(action!=='revoke'&&now()>=scope.expiresAt)throw unavailable();controller.signal.throwIfAborted();
   const {SUPABASE_PROJECT_URL:base,SUPABASE_PUBLISHABLE_KEY:key,WALDO_ROUTER_HMAC_SECRET:secret}=options.env;if(!base||!key||!secret)throw unavailable();
   const raw=JSON.stringify({op:'browser_state',action,do_name:options.doName,scope,...extra}),at=Math.floor(now()/1000);
   const signature=await routerSignature(secret,at,`proxy.${hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))}`);await options.assertCurrent();if(action!=='revoke'&&now()>=scope.expiresAt)throw unavailable();controller.signal.throwIfAborted();
   const response=await fetcher(`${base}/functions/v1/connector-proxy`,{method:'POST',signal:controller.signal,headers:{apikey:key,'content-type':'application/vnd.waldo.browser-state+json','x-waldo-at':String(at),'x-waldo-sig':signature},body:raw});
   const packet=await browserBoundedJson(response,BROWSER_STATE_WIRE_BYTES) as {data?:Record<string,unknown>;error?:unknown};
   await options.assertCurrent();if(action!=='revoke'&&now()>=scope.expiresAt)throw unavailable();controller.signal.throwIfAborted();if(!response.ok||packet?.error||!packet?.data||!Number.isSafeInteger(packet.data.revision)||Number(packet.data.revision)<0)throw unavailable();return packet.data;
  })(),new Promise<never>((_,no)=>{timer=setTimeout(()=>{controller.abort();no(unavailable());},10000);})]);}catch{throw unavailable();}finally{clearTimeout(timer);}
 };
 return {
  async load():Promise<Uint8Array|null>{const data=await post('load');revision=Number(data.revision);if(data.state===null)return null;try{if(typeof data.state!=='string'||new TextEncoder().encode(data.state).length>BROWSER_STATE_BYTES)throw unavailable();return new TextEncoder().encode(JSON.stringify(scopeBrowserState(JSON.parse(data.state),scope.sitePolicy)));}catch{throw unavailable();}},
  async save(bytes:Uint8Array):Promise<void>{if(revision===undefined)throw unavailable();let state:string;try{const copy=new Uint8Array(bytes);if(copy.byteLength>BROWSER_STATE_BYTES)throw unavailable();state=JSON.stringify(scopeBrowserState(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(copy)),scope.sitePolicy));}catch{throw unavailable();}const data=await post('save',{state,expected_revision:revision});if(data.saved!==true||data.revision!==revision+1)throw unavailable();revision=Number(data.revision);},
  async revoke():Promise<void>{if((await post('revoke')).revoked!==true)throw unavailable();},
 };
}
