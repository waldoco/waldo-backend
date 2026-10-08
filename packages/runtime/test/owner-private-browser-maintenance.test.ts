import { expect,it } from 'vitest';
import { ownerPrivateBrowserHost,privateBrowserRecordKey,PRIVATE_BROWSER_DUE } from '../src/channels/owner-private-browser-host';
import { PRIVATE_BROWSER_CONSENT_KEY,type PrivateBrowserConsent } from '../src/channels/browser-private-consent';
it('unresolved physical cleanup preserves local consent expiry retirement without another paid attempt',async()=>{
 const rows=new Map<string,any>(),storage={kv:{get:(k:string)=>rows.get(k),put:(k:string,v:any)=>rows.set(k,v),delete:(k:string)=>rows.delete(k),list:({prefix}:{prefix:string})=>new Map([...rows].filter(([k])=>k.startsWith(prefix)))},transactionSync:<T>(f:()=>T)=>f()} as unknown as DurableObjectStorage;
 let now=1000,configs=0;const approval:PrivateBrowserConsent={binding:{ownerId:'12345678-1234-1234-1234-123456789abc',environment:'staging',siteOrigin:'https://synthetic.example',accountId:'synthetic',generation:1},custodyDigest:'synthetic',expiresAt:2000,state:'approved',revision:'same'};
 const key=privateBrowserRecordKey(approval);rows.set(PRIVATE_BROWSER_CONSENT_KEY,approval);rows.set(key,{binding:approval.binding,expiresAt:approval.expiresAt,allocation:'observed',providerSessionId:'retained',allocationRef:'unchanged-spend',cleanupFailed:true});rows.set(`${key}/encrypted/state`,'synthetic-ciphertext');
 const host=ownerPrivateBrowserHost({storage,environment:'staging',configuration:async()=>{configs++;return undefined;},assertOwner:async()=>({directoryOwnerId:approval.binding.ownerId,custodyDigest:'synthetic'}),now:()=>now});
 await host.maintain();expect(rows.get(PRIVATE_BROWSER_DUE)).toBe(2000);expect(rows.has(`${key}/encrypted/state`)).toBe(true);
 now=2000;await host.maintain();expect(rows.get(PRIVATE_BROWSER_CONSENT_KEY).state).toBe('retiring');expect(rows.has(`${key}/encrypted/state`)).toBe(false);expect(rows.get(key)).toMatchObject({revoked:true,cleanupFailed:true,providerSessionId:'retained',allocationRef:'unchanged-spend'});expect(rows.get(PRIVATE_BROWSER_DUE)).toBe(null);expect(configs).toBe(0);
 await host.maintain();expect(configs).toBe(0);
});
