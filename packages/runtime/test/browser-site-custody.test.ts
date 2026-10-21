import {it,expect} from 'vitest';
import {siteScopedCustody} from '../src/channels/browser-site-custody';
const enc=new TextEncoder(),dec=new TextDecoder();
const policy={origins:['https://app.example.com'],cookieDomains:['app.example.com']};
const raw=enc.encode(JSON.stringify({cookies:[],origins:[{origin:'https://app.example.com',localStorage:[]},{origin:'https://evil.com',localStorage:[]}]}));
it('filters prior to restore and encrypted save path',async()=>{let saved:Uint8Array|undefined;const scoped=siteScopedCustody({load:async()=>raw,save:async b=>{saved=b;}},policy,4096);expect(dec.decode((await scoped.load())!)).not.toContain('evil');await scoped.save(raw);expect(dec.decode(saved!)).not.toContain('evil');});
it('rejects oversized load before parsing and oversized save before forwarding',async()=>{let saves=0;const scoped=siteScopedCustody({load:async()=>new Uint8Array(51),save:async()=>{saves++;}},policy,50);await expect(scoped.load()).rejects.toThrow();await expect(scoped.save(new Uint8Array(51))).rejects.toThrow();expect(saves).toBe(0);});
it('null remains absent',async()=>expect(await siteScopedCustody({load:async()=>null,save:async()=>{}},policy,50).load()).toBeNull());
it('rejects malformed UTF8 and JSON',async()=>{for(const bytes of [new Uint8Array([255]),enc.encode('{bad')])await expect(siteScopedCustody({load:async()=>bytes,save:async()=>{}},policy,50).load()).rejects.toThrow('browser_site_custody_invalid');});
it('snapshots policy at wrapper creation',async()=>{const mutable={origins:[...policy.origins],cookieDomains:[]};const scoped=siteScopedCustody({load:async()=>raw,save:async()=>{}},mutable,4096);mutable.origins[0]='https://evil.com';expect(dec.decode((await scoped.load())!)).not.toContain('evil');});
it.each([0,-1,NaN,Infinity,1.5,16_777_217])('rejects invalid host byte cap %s',n=>expect(()=>siteScopedCustody({load:async()=>null,save:async()=>{}},policy,n)).toThrow());

it('uses intrinsic size before allocation despite shadowed byteLength',async()=>{const bytes=enc.encode(' '.repeat(2000)+JSON.stringify({cookies:[],origins:[]}));Object.defineProperty(bytes,'byteLength',{value:1});let saves=0;const scoped=siteScopedCustody({load:async()=>bytes,save:async()=>{saves++;}},policy,50);await expect(scoped.load()).rejects.toThrow('browser_site_custody_invalid');await expect(scoped.save(bytes)).rejects.toThrow('browser_site_custody_invalid');expect(saves).toBe(0);});
it('does not invoke caller byteLength getter or leak its error',async()=>{let touched=0;const bytes=raw.slice();Object.defineProperty(bytes,'byteLength',{get(){touched++;throw Error('PRIVATE_STATE');}});const scoped=siteScopedCustody({load:async()=>bytes,save:async()=>{}},policy,4096);expect(dec.decode((await scoped.load())!)).not.toContain('evil');await scoped.save(bytes);expect(touched).toBe(0);});

it('sanitizes inner load/save errors without asserting rollback',async()=>{const scoped=siteScopedCustody({load:async()=>{throw Error('PRIVATE_LOAD');},save:async()=>{throw Error('PRIVATE_SAVE');}},policy,4096);await expect(scoped.load()).rejects.toThrow('browser_site_custody_invalid');await expect(scoped.save(raw)).rejects.toThrow('browser_site_custody_invalid');});
it('does not retry an inner save that commits before rejection',async()=>{let saves=0;let committed='';const scoped=siteScopedCustody({load:async()=>null,save:async bytes=>{saves++;committed=dec.decode(bytes);throw Error('lost acknowledgement');}},policy,4096);await expect(scoped.save(raw)).rejects.toThrow('browser_site_custody_invalid');expect(saves).toBe(1);expect(committed).toContain('app.example.com');expect(committed).not.toContain('evil');});
it('rejects a proxy typed-array receiver without leaking its trap',async()=>{const proxy=new Proxy(raw,{get(){throw Error('PRIVATE_PROXY');}});const scoped=siteScopedCustody({load:async()=>proxy,save:async()=>{}},policy,4096);await expect(scoped.load()).rejects.toThrow('browser_site_custody_invalid');});
it('exact Buffer view avoids unrelated backing bytes and input mutation after save call',async()=>{const backing=Buffer.concat([Buffer.from('BAD'),Buffer.from(raw),Buffer.from('BAD')]);const view=backing.subarray(3,backing.length-3);let saved='';const scoped=siteScopedCustody({load:async()=>view,save:async bytes=>{await Promise.resolve();saved=dec.decode(bytes);}},policy,4096);const saving=scoped.save(view);view.fill(65);await saving;expect(saved).toContain('app.example.com');expect(saved).not.toContain('evil');});
it('encrypted reconstruction retains only scoped bytes and honors revocation',async()=>{
 const {browserStateCustody}=await import('../src/channels/browser-state-custody');
 const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']) as CryptoKey;
 const binding={ownerId:'00000000-0000-4000-8000-000000000001',environment:'test',siteOrigin:'https://app.example.com',accountId:'synthetic',generation:1};
 const blobs=new Map<string,Uint8Array>();const store={get:async(k:string)=>blobs.get(k)??null,put:async(k:string,b:Uint8Array)=>{blobs.set(k,new Uint8Array(b));},remove:async(k:string)=>{blobs.delete(k);}};let admitted=true;
 const first=siteScopedCustody(await browserStateCustody(binding,key,store,async()=>admitted),policy,4096);await first.save(raw);
 expect(dec.decode([...blobs.values()][0]!)).not.toContain('app.example.com');
 const reconstructed=siteScopedCustody(await browserStateCustody(binding,key,store,async()=>admitted),policy,4096);
 const restored=dec.decode((await reconstructed.load())!);expect(restored).toContain('app.example.com');expect(restored).not.toContain('evil');
 admitted=false;await expect(reconstructed.load()).rejects.toThrow('browser_site_custody_invalid');await expect(reconstructed.save(raw)).rejects.toThrow('browser_site_custody_invalid');
});
