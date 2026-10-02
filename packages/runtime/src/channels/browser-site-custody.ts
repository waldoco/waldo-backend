import {scopeBrowserState,type BrowserStateSitePolicy} from './browser-state-site-scope';
// Trusted-host wrapper, still unwired. Inner custody must enforce authentication,
// expiry/generation/key/ACL and allocation bounds before returning loaded bytes.
export function siteScopedCustody(inner:Readonly<{load():Promise<Uint8Array|null>;save(bytes:Uint8Array):Promise<void>}>,policy:BrowserStateSitePolicy,maxBytes:number){
 const invalid=():never=>{throw Error('browser_site_custody_invalid');};
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16_777_216)return invalid();
 const fixed={origins:[...policy.origins],cookieDomains:[...policy.cookieDomains]};
 scopeBrowserState({cookies:[],origins:[]},fixed);
 const typedPrototype=Object.getPrototypeOf(Uint8Array.prototype);
 const intrinsicLength=Object.getOwnPropertyDescriptor(typedPrototype,'byteLength')!.get!;
 const filter=(bytes:Uint8Array):Uint8Array=>{
  try{
   if(!(bytes instanceof Uint8Array)||Reflect.apply(intrinsicLength,bytes,[])>maxBytes)return invalid();
   // Native exact copy; no Buffer.slice alias or caller hook dispatch.
   const copy=new Uint8Array(bytes);
   const scoped=scopeBrowserState(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(copy)),fixed);
   const output=new TextEncoder().encode(JSON.stringify(scoped));
   if(output.byteLength>maxBytes)return invalid();
   return output;
  }catch{return invalid();}
 };
 // A save rejection may follow a committed write: never infer rollback or retry.
 // Filtering does not purge old blobs or prevent direct access to inner custody.
 return {load:async()=>{try{const bytes=await inner.load();return bytes===null?null:filter(bytes);}catch{return invalid();}},save:async(bytes:Uint8Array)=>{try{const scoped=filter(bytes);await inner.save(scoped);}catch{return invalid();}}};
}
