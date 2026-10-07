import {it,expect} from 'vitest';
import {commonBrowserHost,maintainCommonBrowsers,revokeCommonBrowsers,type CommonBrowserGrant} from '../src/channels/common-browser-host';
import {commonBrowserFixture,commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
const fixture=()=>{
 commonBrowserFixture.reset();let live=true;const rows=new Map<string,unknown>();
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>rows.set(key,structuredClone(value)),list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix))},transactionSync:<T>(work:()=>T)=>work()} as unknown as DurableObjectStorage;
 const task={taskId:'fixture-task',revision:1,sources:['browser'] as const,ready:true,startRef:'fixture-owner'};
 const grant:CommonBrowserGrant={ref:'fixture-grant',ownerId:'fixture-owner',taskId:task.taskId,expiresAt:Date.now()+60000,allowedOrigins:['https://public-pages.fixture.invalid'],maxScreenshotBytes:1024,lifetimeMs:60000};
 const config={binding:{} as never,loadSdk:commonBrowserFixtureLoader,grant:async()=>grant,reserveAllocation:async()=>{},assertGrantCurrent:async()=>{if(!live)throw Error('withdrawn');}};
 const host=()=>commonBrowserHost({storage,config,ownerId:'fixture-owner',source:()=>task,assertCurrent:async()=>{if(!live)throw Error('withdrawn');},deadline:()=>Date.now()+60000,now:Date.now});
 const ctx={authenticatedUserId:'fixture-owner',assertTaskSourceCurrent:async()=>{if(!live)throw Error('withdrawn');}} as never;
 return {host,storage,grant,config,ctx,rows,revoke:()=>{live=false;}};
};
it('retains exact grant/session and two tabs after host reconstruction with native image bytes only',async()=>{
 const f=fixture();const one=f.host();expect(await one.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read A.'},f.ctx)).toMatchObject({ok:true,source_taint:'external'});
 expect(one.attachments()[0]?.data_base64).toMatch(/^iVBOR/);
 const two=f.host();expect(await two.handler.handle({url:'https://public-pages.fixture.invalid/b',instruction:'Read B.'},f.ctx)).toMatchObject({ok:true,data:{tabs:expect.any(Array)}});
 expect(commonBrowserFixture.allocations).toBe(1);expect(commonBrowserFixture.pages).toHaveLength(2);
});
it('changed grant and pending allocation refuse replacement allocation',async()=>{
 const f=fixture();await f.host().handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx);
 (f.grant as {expiresAt:number}).expiresAt++;
 expect(await f.host().handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx)).toMatchObject({ok:false});
 expect(commonBrowserFixture.allocations).toBe(1);
 const row=f.rows.get('common-browser:fixture-task') as any;row.allocation='prepared';f.rows.set('common-browser:fixture-task',row);
 expect(await f.host().handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx)).toMatchObject({ok:false});expect(commonBrowserFixture.allocations).toBe(1);
});
it('withdrawn authority denies reads but does not block physical cleanup',async()=>{
 const f=fixture();const host=f.host();await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx);f.revoke();
 expect(await host.handler.handle({url:'https://public-pages.fixture.invalid/b',instruction:'Read.'},f.ctx)).toMatchObject({ok:false});
 await host.cancel();expect(commonBrowserFixture.ends).toBe(1);expect(host.attachments()).toHaveLength(0);
});
it('expiry cleanup terminates retained session and records unknown allocation without reallocation',async()=>{
 const f=fixture();await f.host().handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx);f.revoke();
 await maintainCommonBrowsers(f.storage,f.config,f.grant.expiresAt+1);expect(commonBrowserFixture.ends).toBe(1);
 const row=f.rows.get('common-browser:fixture-task') as any;expect(row.cleanup).toBe('closed');
 f.rows.set('common-browser:fixture-uncertain',{...row,cleanup:undefined,session:{...row.session,providerSessionId:'pending'}});
 await maintainCommonBrowsers(f.storage,f.config,f.grant.expiresAt+1);
 expect((f.rows.get('common-browser:fixture-uncertain') as any).cleanupFailed).toBe(true);expect(commonBrowserFixture.allocations).toBe(1);
});

it('records exact allocation when authority expires in flight and denies image/replacement after cleanup',async()=>{
 const f=fixture();commonBrowserFixture.onAcquire=f.revoke;const host=f.host();
 expect(await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx)).toMatchObject({ok:false});
 const row=f.rows.get('common-browser:fixture-task') as any;
 expect(row).toMatchObject({allocation:'observed',session:{providerSessionId:'fixture-retained-provider'}});
 expect(commonBrowserFixture.ends).toBe(1);expect(host.attachments()).toHaveLength(0);
 expect(await f.host().handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx)).toMatchObject({ok:false});expect(commonBrowserFixture.allocations).toBe(1);
});
it('wrong owner/provider/origin are rejected before allocation',async()=>{
 const f=fixture();const host=f.host();
 for(const args of [{url:'https://public-pages.fixture.invalid/a',provider:'browserbase'},{url:'https://outside.fixture.invalid/a'}])expect(await host.handler.handle({...args,instruction:'Read.'} as never,f.ctx)).toMatchObject({ok:false});
 expect(await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},{authenticatedUserId:'another-owner'} as never)).toMatchObject({ok:false});
 expect(commonBrowserFixture.allocations).toBe(0);
});

it('stop during provider acquire preserves cleanup fence when exact provider ID arrives',async()=>{
 const f=fixture();commonBrowserFixture.onAcquire=()=>revokeCommonBrowsers(f.storage,Date.now());
 const host=f.host();expect(await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx)).toMatchObject({ok:false});
 const row=f.rows.get('common-browser:fixture-task') as any;
 expect(row).toMatchObject({cleanup:'pending',allocation:'observed',session:{providerSessionId:'fixture-retained-provider'}});
 expect(commonBrowserFixture.ends).toBe(1);expect(host.attachments()).toHaveLength(0);expect(commonBrowserFixture.allocations).toBe(1);
});

for(const mode of ['cancel','maintain'] as const)it(`delayed ${mode} cleanup cannot overwrite a changed session generation`,async()=>{
 const f=fixture();const host=f.host();await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx);
 let reached!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>reached=r),gate=new Promise<void>(r=>release=r);
 commonBrowserFixture.onTerminate=async()=>{reached();await gate;};
 const cleanup=mode==='cancel'?host.cancel():maintainCommonBrowsers(f.storage,f.config,f.grant.expiresAt+1);await entered;
 const key='common-browser:fixture-task',prior=f.rows.get(key) as any;
 const successor={...prior,cleanup:undefined,session:{...prior.session,generation:prior.session.generation+1,providerSessionId:'different-exact-id'}};f.rows.set(key,successor);
 release();await cleanup;expect(f.rows.get(key)).toEqual(successor);expect(commonBrowserFixture.ends).toBe(1);
});
