import {expect,it,vi} from 'vitest';
import {commonBrowserHost,type CommonBrowserGrant} from '../src/channels/common-browser-host';
import {BROWSER_ERRAND_GRANT_MS,browserErrandAdmits,grantBrowserErrand,revokeBrowserErrand,spendBrowserErrandSubmit} from '../src/channels/browser-errand-grant';
import {commonBrowserFixture,commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
const probe=vi.hoisted(()=>({authorize:undefined as undefined|((url:string,method:string,body?:Uint8Array)=>Promise<boolean>)}));
vi.mock('../src/channels/cloudflare-general-browser',async load=>{
 const actual=await load<typeof import('../src/channels/cloudflare-general-browser')>();
 return {...actual,cloudflareGeneralBrowser:(options:any)=>{probe.authorize=options.authorizeRequest;return actual.cloudflareGeneralBrowser(options);}};
});
const ORIGIN='https://public-pages.fixture.invalid',RUN='task:fixture-job';
const memory=()=>{const rows=new Map<string,unknown>();return {rows,storage:{kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>rows.set(key,structuredClone(value)),delete:(key:string)=>rows.delete(key),list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix))},transactionSync:<T>(work:()=>T)=>work()} as unknown as DurableObjectStorage};};
const granted=(storage:DurableObjectStorage,now:number,maxSubmits=2)=>grantBrowserErrand(storage,{approvalId:'approval-1',runId:RUN,origin:ORIGIN,expiresAt:now+BROWSER_ERRAND_GRANT_MS,maxSubmits},now);

it('a grant admits a write only to its exact origin, from its own run, while current, and at most its submit count',()=>{
 const {storage}=memory(),now=1_000_000;granted(storage,now);
 expect(browserErrandAdmits(storage,RUN,`${ORIGIN}/check-in`,now)).toBe(true);
 expect(browserErrandAdmits(storage,'task:other-job',`${ORIGIN}/check-in`,now)).toBe(false);
 for(const url of ['https://api.public-pages.fixture.invalid/x','https://elsewhere.fixture.invalid/x','http://public-pages.fixture.invalid/x','not a url'])expect(browserErrandAdmits(storage,RUN,url,now),url).toBe(false);
 expect(browserErrandAdmits(storage,RUN,`${ORIGIN}/check-in`,now+BROWSER_ERRAND_GRANT_MS)).toBe(false);
 expect(spendBrowserErrandSubmit(storage,RUN,`${ORIGIN}/a`,now)).toBe(true);expect(spendBrowserErrandSubmit(storage,RUN,`${ORIGIN}/b`,now+1)).toBe(true);
 expect(spendBrowserErrandSubmit(storage,RUN,`${ORIGIN}/c`,now+2)).toBe(false);expect(browserErrandAdmits(storage,RUN,`${ORIGIN}/c`,now+2)).toBe(false);
});
it('a revoked grant admits nothing, and a refused spend records no submit',()=>{
 const {storage,rows}=memory(),now=1_000_000;granted(storage,now);
 expect(spendBrowserErrandSubmit(storage,RUN,'https://elsewhere.fixture.invalid/x',now)).toBe(false);
 expect((rows.get(`browser-errand-grant:${RUN}`) as any).submits).toEqual([]);
 revokeBrowserErrand(storage,RUN);expect(spendBrowserErrandSubmit(storage,RUN,`${ORIGIN}/a`,now)).toBe(false);
});
it('a grant longer than fifteen minutes, without submits, or on a non-https origin is never written',()=>{
 const {storage}=memory(),now=1_000_000;
 for(const bad of [{expiresAt:now+BROWSER_ERRAND_GRANT_MS+1},{maxSubmits:0},{maxSubmits:1.5},{origin:'http://public-pages.fixture.invalid'},{origin:`${ORIGIN}/path`},{expiresAt:now}])
  expect(()=>grantBrowserErrand(storage,{approvalId:'approval-1',runId:RUN,origin:ORIGIN,expiresAt:now+60_000,maxSubmits:3,...bad},now),JSON.stringify(bad)).toThrow();
});

const hostFixture=()=>{
 commonBrowserFixture.reset();const {storage,rows}=memory();
 const grant:CommonBrowserGrant={ref:'fixture-grant',ownerId:'fixture-owner',taskId:'fixture-task',expiresAt:Date.now()+60000,allowedOrigins:['*'],maxScreenshotBytes:1024,lifetimeMs:60000};
 const host=commonBrowserHost({storage,config:{retainInteractions:true,binding:{} as never,loadSdk:commonBrowserFixtureLoader,grant:async()=>grant,reserveAllocation:async()=>{},assertGrantCurrent:async()=>{}},ownerId:'fixture-owner',source:()=>({taskId:'fixture-task',revision:1,sources:['browser'],ready:true,startRef:'fixture-owner'}),assertCurrent:async()=>{},deadline:()=>Date.now()+60000,now:Date.now});
 const ctx=(runId:string)=>({authenticatedUserId:'fixture-owner',assertTaskSourceCurrent:async()=>{},runScope:{runId}}) as never;
 return {host,storage,rows,ctx};
};
const submit=async(f:ReturnType<typeof hostFixture>,runId:string)=>{
 const first=await f.host.handler.handle({url:`${ORIGIN}/a`,instruction:'Read A.'},f.ctx(runId)) as any;
 return f.host.actionHandler.handle({url:first.data.url,task:'Check in',max_actions:1,command:{operation:'type',element_ref:first.data.elements[0].ref,key:'Enter',intent:'read'}},f.ctx(runId));
};
it('under a live errand grant the host submits a POST form to the approved origin and spends one submit per write request',async()=>{
 const f=hostFixture();commonBrowserFixture.form=true;commonBrowserFixture.formAction=`${ORIGIN}/check-in`;granted(f.storage,Date.now());
 const seen:boolean[]=[];commonBrowserFixture.onPress=async()=>{for(const url of [`${ORIGIN}/check-in`,'https://elsewhere.fixture.invalid/beacon',`${ORIGIN}/seat`,`${ORIGIN}/third`])seen.push(await probe.authorize!(url,'POST',new TextEncoder().encode('fictional=1')));};
 expect(await submit(f,RUN)).toMatchObject({ok:true});
 expect(seen).toEqual([true,false,true,false]);expect(commonBrowserFixture.effects).toBe(1);
 expect((f.rows.get(`browser-errand-grant:${RUN}`) as any).submits).toHaveLength(2);
 expect(await probe.authorize!(`${ORIGIN}/check-in`,'POST')).toBe(false);await f.host.cancel();
});
it('without a grant for this run, a POST form submit is still refused before dispatch',async()=>{
 const f=hostFixture();commonBrowserFixture.form=true;commonBrowserFixture.formAction=`${ORIGIN}/check-in`;granted(f.storage,Date.now());
 const refused=await submit(f,'task:other-job');
 expect(refused).toMatchObject({ok:false,code:'rejected'});expect(JSON.stringify(refused)).toContain('native_submit_requires_card');expect(commonBrowserFixture.effects).toBe(0);await f.host.cancel();
});
it('a grant does not admit a POST form whose action is another origin',async()=>{
 const f=hostFixture();commonBrowserFixture.form=true;commonBrowserFixture.formAction='https://elsewhere.fixture.invalid/check-in';granted(f.storage,Date.now());
 const refused=await submit(f,RUN);
 expect(refused).toMatchObject({ok:false,code:'rejected'});expect(JSON.stringify(refused)).toContain('native_submit_requires_card');expect(commonBrowserFixture.effects).toBe(0);await f.host.cancel();
});
it('under the run\'s live grant a step marked send may submit to the approved origin; any other run marked send is still refused before dispatch',async()=>{
 const f=hostFixture();commonBrowserFixture.form=true;commonBrowserFixture.formAction=`${ORIGIN}/check-in`;granted(f.storage,Date.now());
 const send=async(runId:string)=>{const first=await f.host.handler.handle({url:`${ORIGIN}/a`,instruction:'Read A.'},f.ctx(runId)) as any;
  return f.host.actionHandler.handle({url:first.data.url,task:'Check in',max_actions:1,command:{operation:'type',element_ref:first.data.elements[0].ref,key:'Enter',intent:'send'}},f.ctx(runId));};
 expect(await send('task:other-job')).toMatchObject({ok:false});expect(commonBrowserFixture.effects).toBe(0);
 expect(await send(RUN)).toMatchObject({ok:true});expect(commonBrowserFixture.effects).toBe(1);await f.host.cancel();
});
