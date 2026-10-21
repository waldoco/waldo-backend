// Unwired trusted-host state boundary. A domain roster is not same-site account proof.
// Call before restore AND save, under authenticated owner/site/account admission.
export type BrowserStateSitePolicy=Readonly<{origins:readonly string[];cookieDomains:readonly string[]}>;
const invalid=():never=>{throw Error('browser_state_scope_invalid');};
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const domain=(value:unknown):value is string=>typeof value==='string'&&/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
const origin=(value:unknown):value is string=>{if(typeof value!=='string')return false;try{const u=new URL(value);return u.protocol==='https:'&&u.origin===value&&!u.username&&!u.password;}catch{return false;}};
// Copy only native JSON data descriptors. Never invoke getters/toJSON, and bound traversal.
const snapshot=(input:unknown):unknown=>{
 let nodes=0;const active=new Set<object>();
 const copy=(value:unknown,depth:number):unknown=>{
  if(++nodes>100_000||depth>32)return invalid();
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:invalid();
  if(typeof value!=='object'||(!Array.isArray(value)&&!record(value))||active.has(value))return invalid();
  active.add(value);const out:unknown[]|Record<string,unknown>=Array.isArray(value)?[]:{};
  if(Array.isArray(value)&&value.length>100_000)return invalid();
  for(const key of Reflect.ownKeys(value)){
   if(Array.isArray(value)&&key==='length')continue;
   const d=Object.getOwnPropertyDescriptor(value,key);
   if(typeof key!=='string'||!d||!('value' in d)||!d.enumerable)return invalid();
   if(Array.isArray(value)&&! /^(0|[1-9][0-9]*)$/.test(key))return invalid();
   Object.defineProperty(out,key,{value:copy(d.value,depth+1),enumerable:true,writable:true,configurable:true});
  }
  if(Array.isArray(value)&&Object.keys(out).length!==value.length)return invalid();
  active.delete(value);return out;
 };return copy(input,0);
};
export function scopeBrowserState(state:unknown,policy:BrowserStateSitePolicy):Readonly<{cookies:readonly Record<string,unknown>[];origins:readonly Record<string,unknown>[]}>{
 state=snapshot(state);
 policy=snapshot(policy) as BrowserStateSitePolicy;
 if(!policy.origins.length||policy.origins.length>50||policy.cookieDomains.length>50||policy.origins.some(x=>!origin(x))||policy.cookieDomains.some(x=>!domain(x)))invalid();
 if(!record(state))return invalid();
 if(Object.keys(state).some(k=>k!=='cookies'&&k!=='origins')||!Array.isArray(state.cookies)||!Array.isArray(state.origins)||state.cookies.length>3000||state.origins.length>50)return invalid();
 const cookies:Record<string,unknown>[]=[];const origins:Record<string,unknown>[]=[];
 for(const row of state.cookies){if(!record(row)||typeof row.domain!=='string')return invalid();const d=row.domain.startsWith('.')?row.domain.slice(1):row.domain;if(!domain(d))invalid();if(policy.cookieDomains.includes(d))cookies.push(row);}
 for(const row of state.origins){if(!record(row)||!origin(row.origin))return invalid();if(policy.origins.includes(row.origin))origins.push(row);}
 // Native JSON state only. Output never goes to model replies/logs/tool payloads.
 return {cookies,origins};
}
