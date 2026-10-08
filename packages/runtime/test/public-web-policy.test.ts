import {it,expect} from 'vitest';
import {isPublicWebUrl} from '../src/channels/public-web-policy';
import {commonBrowserHost,type CommonBrowserGrant} from '../src/channels/common-browser-host';
import {commonBrowserFixture,commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
it('allows ordinary public pages on any host',()=>{
 for(const u of ['https://example.com/a','http://news.example.org/x?y=1','https://sub.deep.example.co.uk/'])expect(isPublicWebUrl(u)).toBe(true);
});
it('blocks private, loopback, link-local, metadata, internal names, credentials and odd schemes',()=>{
 for(const u of ['http://localhost/','http://127.0.0.1/','http://10.0.0.5/','http://172.16.3.4/','http://192.168.1.1/','http://169.254.169.254/latest','http://100.64.0.1/','http://0.0.0.0/','http://[::1]/','http://[fd00::1]/','http://2130706433/','http://0x7f.0.0.1/','http://printer/','http://db.internal/','http://a.local/','http://x.localhost/','https://user:pw@example.com/','ftp://example.com/','file:///etc/passwd','not a url'])expect(isPublicWebUrl(u),u).toBe(false);
});
it('public-web grant reads any public host, still rejects private targets before allocation',async()=>{
 commonBrowserFixture.reset();const rows=new Map<string,unknown>();
 const storage={kv:{get:(k:string)=>rows.get(k),put:(k:string,v:unknown)=>rows.set(k,structuredClone(v)),list:({prefix}:{prefix:string})=>[...rows].filter(([k])=>k.startsWith(prefix))},transactionSync:<T>(w:()=>T)=>w()} as never;
 const task={taskId:'t',revision:1,sources:['browser'] as const,ready:true,startRef:'o'};
 const grant:CommonBrowserGrant={ref:'g',ownerId:'o',taskId:'t',expiresAt:Date.now()+60000,allowedOrigins:['*'],maxScreenshotBytes:1024,lifetimeMs:60000};
 const config={binding:{} as never,loadSdk:commonBrowserFixtureLoader,grant:async()=>grant,reserveAllocation:async()=>{},assertGrantCurrent:async()=>{}};
 const host=commonBrowserHost({storage,config,ownerId:'o',source:()=>task,assertCurrent:async()=>{},deadline:()=>Date.now()+60000,now:Date.now});
 const ctx={authenticatedUserId:'o',assertTaskSourceCurrent:async()=>{}} as never;
 expect(await host.handler.handle({url:'http://169.254.169.254/latest',instruction:'x'},ctx)).toMatchObject({ok:false});expect(commonBrowserFixture.allocations).toBe(0);
 expect(await host.handler.handle({url:'https://any-public-site.example/a',instruction:'Read.'},ctx)).toMatchObject({ok:true});expect(commonBrowserFixture.allocations).toBe(1);
});
