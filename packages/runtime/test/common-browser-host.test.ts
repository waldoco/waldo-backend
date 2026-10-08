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
it('retains exact grant/session and guarded documents after host reconstruction with native image bytes only',async()=>{
 const f=fixture();const one=f.host();expect(await one.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read A.'},f.ctx)).toMatchObject({ok:true,source_taint:'external'});
 expect(one.attachments()[0]?.data_base64).toMatch(/^iVBOR/);
 const two=f.host();expect(await two.handler.handle({url:'https://public-pages.fixture.invalid/b',instruction:'Read B.'},f.ctx)).toMatchObject({ok:true,data:{tabs:expect.any(Array)}});
 expect(commonBrowserFixture.allocations).toBe(1);expect(commonBrowserFixture.pages).toHaveLength(1);
 await two.cancel();expect(commonBrowserFixture.pages).toHaveLength(0);expect(commonBrowserFixture.ends).toBe(1);
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
 expect(row).toMatchObject({cleanup:'closed',allocation:'observed',session:{providerSessionId:'fixture-retained-provider'}});
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

it('preserves bounded provider failure diagnostic through common caller without provider text',async()=>{
 const f=fixture();const {GeneralBrowserError}=await import('../src/channels/cloudflare-general-browser');
 commonBrowserFixture.onAcquire=()=>{throw new GeneralBrowserError('provider_unavailable',{status:402,code:'usage_limit',request_id:'request-123'});};
 const result=await f.host().handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx);expect(result).toMatchObject({ok:false,code:'rejected',source_taint:'external'});expect(JSON.stringify(result)).toContain('402');expect(JSON.stringify(result)).toContain('usage_limit');expect(JSON.stringify(result)).toContain('request-123');
});

it('registered dispatcher and post hooks preserve provider402 to model-bound result',async()=>{
 const f=fixture();const {GeneralBrowserError}=await import('../src/channels/cloudflare-general-browser');const {dispatchTool}=await import('../src/tools/dispatcher');const {buildSessionState}=await import('@waldo/contracts');
 commonBrowserFixture.onAcquire=()=>{throw new GeneralBrowserError('provider_unavailable',{status:402,code:'usage_limit',request_id:'request-123'});};
 const ctx={authenticatedUserId:'fixture-owner',assertTaskSourceCurrent:async()=>{},trigger:'user_message',egressAllowlist:['public-pages.fixture.invalid'],session:buildSessionState({trigger:'user_message',canary_tokens:['1111111111111111','2222222222222222','3333333333333333'],started_at:Date.now()}),hasApproval:()=>true,sourceTaint:null,toolArgSourceTaint:null,sanitise:(await import('../src/scribe/sanitiser')).sanitise} as never;
 const result=await dispatchTool({id:'fixture402',name:'browse_page',args:{url:'https://public-pages.fixture.invalid/a',instruction:'Read.'}},ctx,{handlers:[f.host().handler]});
 expect(result).toMatchObject({ok:false,reason:'tool_result_error',source_taint:'external'});expect(JSON.stringify(result)).toContain('402');expect(JSON.stringify(result)).toContain('usage_limit');expect(JSON.stringify(result)).toContain('request-123');
});

it('finite grants cannot bypass the established private-network boundary',async()=>{
 const f=fixture();(f.grant as {allowedOrigins:readonly string[]}).allowedOrigins=['https://127.0.0.1'];
 expect(await f.host().handler.handle({url:'https://127.0.0.1/private',instruction:'Read.',provider:'cloudflare_playwright'},f.ctx)).toMatchObject({ok:false});
 expect(commonBrowserFixture.allocations).toBe(0);
});

it('read result exposes the real retained session handle across fresh host reads',async()=>{
 const f=fixture(),first=await f.host().handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx) as any;
 const retained=f.rows.get('common-browser:fixture-task') as any;
 expect(first.data.session_handle).toBe(retained.session.id);
 const second=await f.host().handler.handle({url:'https://public-pages.fixture.invalid/b',instruction:'Read.'},f.ctx) as any;
 expect(second.data.session_handle).toBe(first.data.session_handle);expect(commonBrowserFixture.allocations).toBe(1);
});
it('normal browser host reads, types into an observed public input, reobserves and terminates one allocation',async()=>{
 const f=fixture(),host=f.host();
 const first=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read A.',provider:'cloudflare_playwright'},f.ctx) as any;
 const filled=await host.actionHandler.handle({url:first.data.url,task:'Set the note',max_actions:1,command:{operation:'type',element_ref:first.data.elements[0].ref,value:'Owner note',intent:'read'}},f.ctx);
 expect(filled).toMatchObject({ok:true,data:{field_values:[{name:'Note',value:'Owner note'}],session_handle:first.data.session_handle}});
 const read=await host.actionHandler.handle({url:first.data.url,task:'Check the note',max_actions:1,command:{operation:'read',intent:'read'}},f.ctx);
 expect(read).toMatchObject({ok:true,data:{field_values:[{name:'Note',value:'Owner note'}]}});
 expect(commonBrowserFixture.allocations).toBe(1);expect(commonBrowserFixture.attachments).toBe(1);
 await host.cancel();expect(commonBrowserFixture.pages).toHaveLength(0);expect(commonBrowserFixture.ends).toBe(1);
});
it('uncertain native effects survive reobservation and cannot dispatch again',async()=>{
 const f=fixture(),host=f.host();const first=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read A.'},f.ctx) as any;
 commonBrowserFixture.onFill=()=>{throw Error('lost native acknowledgement');};
 const command={url:first.data.url,task:'Set note',max_actions:1,command:{operation:'type',element_ref:first.data.elements[0].ref,value:'Owner note',intent:'read'}} as const;
 expect(await host.actionHandler.handle(command,f.ctx)).toMatchObject({ok:false});expect(commonBrowserFixture.effects).toBe(1);
 const observed=await host.handler.handle({url:first.data.url,instruction:'Inspect current state.'},f.ctx) as any;
 expect(observed).toMatchObject({ok:true,data:{action_outcome:'uncertain'}});
 expect(await host.actionHandler.handle({...command,command:{...command.command,element_ref:observed.data.elements[0].ref}},f.ctx)).toMatchObject({ok:false});
 expect(commonBrowserFixture.effects).toBe(1);expect(commonBrowserFixture.allocations).toBe(1);await host.cancel();
});
it('native form Enter and declared sends wait for owner approval without native dispatch',async()=>{
 const f=fixture(),host=f.host();commonBrowserFixture.form=true;
 const first=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read A.'},f.ctx) as any;
 for(const command of [{operation:'type',element_ref:first.data.elements[0].ref,key:'Enter',intent:'read'},{operation:'type',element_ref:first.data.elements[0].ref,value:'Owner note',intent:'send'}] as const)
  expect(await host.actionHandler.handle({url:first.data.url,task:'Update form',max_actions:1,command},f.ctx)).toMatchObject({ok:false});
 expect(commonBrowserFixture.effects).toBe(0);await host.cancel();
});
it('registered dispatcher uses the existing host for native field observation and interaction',async()=>{
 const f=fixture(),host=f.host();const {dispatchTool}=await import('../src/tools/dispatcher');const {buildSessionState}=await import('@waldo/contracts');
 const ctx={...f.ctx as any,trigger:'user_message',egressAllowlist:['public-pages.fixture.invalid'],session:buildSessionState({trigger:'user_message',canary_tokens:['1111111111111111','2222222222222222','3333333333333333'],started_at:Date.now()}),hasApproval:()=>true,sourceTaint:null,toolArgSourceTaint:null,sanitise:(await import('../src/scribe/sanitiser')).sanitise} as never;
 const handlers=[host.handler,host.actionHandler];
 const first=await dispatchTool({id:'native-read',name:'browse_page',args:{url:'https://public-pages.fixture.invalid/a',instruction:'Read the note input.',provider:'cloudflare_playwright'}},ctx,{handlers}) as any;
 expect(first).toMatchObject({ok:true});
 const acted=await dispatchTool({id:'native-type',name:'browse_act',args:{url:first.data.url,task:'Set the note',max_actions:1,command:{operation:'type',element_ref:first.data.elements[0].ref,value:'Exact owner note',intent:'read'}}},ctx,{handlers});
 expect(acted).toMatchObject({ok:true,data:{field_values:[{value:'Exact owner note'}]},source_taint:'external'});
 expect(commonBrowserFixture.allocations).toBe(1);expect(commonBrowserFixture.effects).toBe(1);await host.cancel();
});
