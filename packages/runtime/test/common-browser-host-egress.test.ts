import {expect,it,vi} from 'vitest';
import {commonBrowserHost,type CommonBrowserGrant} from '../src/channels/common-browser-host';
import {commonBrowserFixture,commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
const probe=vi.hoisted(()=>({authorize:undefined as undefined|((url:string,method:string)=>Promise<boolean>)}));
vi.mock('../src/channels/cloudflare-general-browser',async load=>{
 const actual=await load<typeof import('../src/channels/cloudflare-general-browser')>();
 return {...actual,cloudflareGeneralBrowser:(options:any)=>{probe.authorize=options.authorizeRequest;return actual.cloudflareGeneralBrowser(options);}};
});
it('the host lets its browser send only GET and HEAD to a granted public origin: a POST, PUT or off-grant request is refused',async()=>{
 commonBrowserFixture.reset();const rows=new Map<string,unknown>();
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>rows.set(key,structuredClone(value)),list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix))},transactionSync:<T>(work:()=>T)=>work()} as unknown as DurableObjectStorage;
 const grant:CommonBrowserGrant={ref:'egress-grant',ownerId:'fixture-owner',taskId:'egress-task',expiresAt:Date.now()+60000,allowedOrigins:['https://public-pages.fixture.invalid'],maxScreenshotBytes:1024,lifetimeMs:60000};
 const host=commonBrowserHost({storage,config:{retainInteractions:true,binding:{} as never,loadSdk:commonBrowserFixtureLoader,grant:async()=>grant,reserveAllocation:async()=>{},assertGrantCurrent:async()=>{}},ownerId:'fixture-owner',source:()=>({taskId:'egress-task',revision:1,sources:['browser'],ready:true,startRef:'fixture-owner'}),assertCurrent:async()=>{},deadline:()=>Date.now()+60000,now:Date.now});
 expect(await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read A.'},{authenticatedUserId:'fixture-owner'} as never)).toMatchObject({ok:true});
 const authorize=probe.authorize!,page='https://public-pages.fixture.invalid/search?q=fictional';
 expect(await authorize(page,'GET')).toBe(true);expect(await authorize(page,'HEAD')).toBe(true);
 for(const method of ['POST','PUT','PATCH','DELETE'])expect(await authorize(page,method),method).toBe(false);
 for(const url of ['https://elsewhere.fixture.invalid/a','http://127.0.0.1/a','https://169.254.169.254/latest'])expect(await authorize(url,'GET'),url).toBe(false);
 await host.cancel();
});
