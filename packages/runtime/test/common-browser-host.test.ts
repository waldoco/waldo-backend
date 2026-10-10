import {it,expect} from 'vitest';
import {commonBrowserHost,maintainCommonBrowsers,revokeCommonBrowsers,type CommonBrowserGrant} from '../src/channels/common-browser-host';
import {commonBrowserFixture,commonBrowserFixtureLoader} from './fixtures/common-browser-sdk';
const fixture=()=>{
 commonBrowserFixture.reset();let live=true;const rows=new Map<string,unknown>();
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>rows.set(key,structuredClone(value)),list:({prefix}:{prefix:string})=>[...rows].filter(([key])=>key.startsWith(prefix))},transactionSync:<T>(work:()=>T)=>work()} as unknown as DurableObjectStorage;
 const task={taskId:'fixture-task',revision:1,sources:['browser'] as const,ready:true,startRef:'fixture-owner'};
 const grant:CommonBrowserGrant={ref:'fixture-grant',ownerId:'fixture-owner',taskId:task.taskId,expiresAt:Date.now()+60000,allowedOrigins:['https://public-pages.fixture.invalid'],maxScreenshotBytes:1024,lifetimeMs:60000};
 const config={retainInteractions:true as true,binding:{} as never,loadSdk:commonBrowserFixtureLoader,grant:async()=>grant,reserveAllocation:async()=>{},assertGrantCurrent:async()=>{if(!live)throw Error('withdrawn');}};
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

it('an initial empty observation keeps model-visible exact-session custody for inspect, recovery and cancel',async()=>{
 const f=fixture(),host=f.host();commonBrowserFixture.text='';
 const failed=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read A.'},f.ctx) as any;
 expect(failed).toMatchObject({ok:false,browser:{code:'empty_content',stage:'observation',diagnostic:{status:200},retained:{state:'unobserved',observation_revision:null},recovery:{can_cancel:true,can_inspect:true,can_navigate:true,requires_same_session:true}}});
 const handle=failed.browser.retained.session_handle;
 expect(handle).toBe((f.rows.get('common-browser:fixture-task') as any).session.id);expect(host.attachments()).toEqual([]);
 const command={url:'https://public-pages.fixture.invalid/a',task:'Inspect current retained custody',session_handle:handle,max_actions:1,command:{operation:'inspect' as const}};
 expect(await host.actionHandler.handle(command,f.ctx)).toMatchObject({ok:true,data:{kind:'retained_session_status',page_observed:false,retained:{session_handle:handle}}});
 expect(commonBrowserFixture.navigations).toBe(1);commonBrowserFixture.text='Actually rendered option B.';
 expect(await host.actionHandler.handle({...command,command:{operation:'goto',url:'https://public-pages.fixture.invalid/b'}},f.ctx)).toMatchObject({ok:true,data:{text:'Actually rendered option B.',session_handle:handle,document_state:'recreated'}});
 expect(commonBrowserFixture.allocations).toBe(1);
 expect(await host.actionHandler.handle({...command,command:{operation:'cancel'}},f.ctx)).toMatchObject({ok:true,data:{ended:true}});
 expect((f.rows.get('common-browser:fixture-task') as any).cleanup).toBe('closed');expect(commonBrowserFixture.ends).toBe(1);
});

it('initial failed observation can close before inspect and rejects owner/handle/provider substitution',async()=>{
 const f=fixture(),host=f.host();commonBrowserFixture.text='';const failed=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read A.'},f.ctx) as any;
 const args={url:'https://public-pages.fixture.invalid/a',task:'Cancel exact failed session',session_handle:failed.browser.retained.session_handle,max_actions:1,command:{operation:'cancel' as const}};
 expect(await host.actionHandler.handle(args,{...f.ctx as object,authenticatedUserId:'other-owner'} as never)).toMatchObject({ok:false});
 expect(await host.actionHandler.handle({...args,session_handle:crypto.randomUUID()},f.ctx)).toMatchObject({ok:false});
 expect(await host.actionHandler.handle({...args,provider:'browserbase_stagehand_http_v3'},f.ctx)).toMatchObject({ok:false});expect(commonBrowserFixture.ends).toBe(0);
 expect(await host.actionHandler.handle(args,f.ctx)).toMatchObject({ok:true,data:{ended:true}});expect(commonBrowserFixture.allocations).toBe(1);expect(commonBrowserFixture.ends).toBe(1);
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
it('public-only browsing refuses native form Enter, sends, submit preparation and uploads without dispatch',async()=>{
 const f=fixture(),host=f.host();commonBrowserFixture.form=true;
 const first=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read A.'},f.ctx) as any;
 expect(first).toMatchObject({ok:true});
 for(const command of [{operation:'type',element_ref:first.data.elements[0].ref,key:'Enter',intent:'read'},{operation:'type',element_ref:first.data.elements[0].ref,value:'Owner note',intent:'send'},{operation:'prepare_submit'},{operation:'upload',element_ref:first.data.elements[0].ref,file_id:'00000000-0000-4000-8000-000000000001',revision:1}] as const)
  expect(await host.actionHandler.handle({url:first.data.url,task:'Update form',max_actions:1,command} as never,f.ctx)).toMatchObject({ok:false});
 expect(commonBrowserFixture.effects).toBe(0);expect((f.rows.get('common-browser:fixture-task') as any).pending).toBeUndefined();await host.cancel();
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

it('rejects an oversized encoded observation and clears earlier action eligibility before persistence',async()=>{
 const f=fixture(),host=f.host();
 const first=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read A.'},f.ctx) as any;
 commonBrowserFixture.text='é'.repeat(140000);
 const oversized=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read again.'},f.ctx);
 expect(oversized).toMatchObject({ok:false});expect(JSON.stringify(oversized)).toContain('observation_oversize');
 const row=f.rows.get('common-browser:fixture-task') as any;
 expect(row.observation).toBeUndefined();expect(new TextEncoder().encode(JSON.stringify(row)).byteLength).toBeLessThan(131072);
 expect(await host.actionHandler.handle({url:first.data.url,task:'Set note',max_actions:1,command:{operation:'type',element_ref:first.data.elements[0].ref,value:'Must not dispatch',intent:'read'}},f.ctx)).toMatchObject({ok:false});
 expect(commonBrowserFixture.effects).toBe(0);expect(host.attachments()).toHaveLength(1);await host.cancel();
});

it('default serving reads close documents and reject retained interactions without the trusted capability',async()=>{
 const f=fixture();delete (f.config as {retainInteractions?:true}).retainInteractions;
 const host=f.host(),first=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read A.'},f.ctx) as any;
 expect(first.ok).toBe(true);expect(commonBrowserFixture.pages).toHaveLength(0);
 expect(await host.actionHandler.handle({url:first.data.url,task:'Set note',max_actions:1,command:{operation:'type',element_ref:first.data.elements[0].ref,value:'Unavailable',intent:'read'}},f.ctx)).toMatchObject({ok:false});
 expect(commonBrowserFixture.effects).toBe(0);await host.cancel();
});

it('near-full public observation evidence cannot prevent exact cancellation cleanup',async()=>{
 const f=fixture(),host=f.host();await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read'},f.ctx);
 const key='common-browser:fixture-task',row=f.rows.get(key) as any;
 row.observation.state.text='';
 row.observation.state.text='x'.repeat(131070-new TextEncoder().encode(JSON.stringify(row)).byteLength);
 f.rows.set(key,row);expect(new TextEncoder().encode(JSON.stringify(row)).byteLength).toBe(131070);
 await host.cancel();expect(commonBrowserFixture.ends).toBe(1);expect(commonBrowserFixture.pages).toHaveLength(0);
 expect(f.rows.get(key)).toMatchObject({cleanup:'closed',observation:undefined,tabs:[]});
});

 it.each(['goto','open_tab','close_tab'] as const)('durably fences failed %s readback before any replay',async operation=>{
 const f=fixture(),host=f.host();let first=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read'},f.ctx) as any;
 if(operation==='close_tab')first=await host.actionHandler.handle({url:first.data.url,task:'Open B',max_actions:1,command:{operation:'open_tab',url:'https://public-pages.fixture.invalid/b'}},f.ctx) as any;
 const command=operation==='close_tab'?{operation,tab_ref:first.data.tabs[0].ref}:{operation,url:'https://public-pages.fixture.invalid/b'};
 const args={url:first.data.url,task:'Native change',command} as any;
 if(operation==='close_tab')commonBrowserFixture.onClose=()=>{commonBrowserFixture.onClose=undefined;throw Error('lost close acknowledgement');};else commonBrowserFixture.onGoto=()=>{throw Error('lost navigation acknowledgement');};
 expect(await host.actionHandler.handle(args,f.ctx)).toMatchObject({ok:false});
 expect(f.rows.get('common-browser:fixture-task')).toMatchObject({action:{state:'uncertain'}});
 const count=operation==='close_tab'?commonBrowserFixture.tabCloses:commonBrowserFixture.navigations;
 commonBrowserFixture.onGoto=undefined;commonBrowserFixture.onClose=undefined;
 const observed=await host.handler.handle({url:first.data.url,instruction:'Observe changed state'},f.ctx) as any;
 expect(observed).toMatchObject({ok:true,data:{action_outcome:'uncertain'}});
 const afterRead=operation==='close_tab'?commonBrowserFixture.tabCloses:commonBrowserFixture.navigations;
 expect(afterRead).toBeGreaterThanOrEqual(count);
 expect(await host.actionHandler.handle({...args,url:observed.data.url},f.ctx)).toMatchObject({ok:false});
 expect(operation==='close_tab'?commonBrowserFixture.tabCloses:commonBrowserFixture.navigations).toBe(afterRead);await host.cancel();
 });


it('selects an observed enabled public filter and publishes semantic selected state',async()=>{
 const f=fixture();commonBrowserFixture.filters=true;const host=f.host();
 const first=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read filters.'},f.ctx) as any;
 const select=first.data.elements.find((row:any)=>row.name==='Region');
 const result=await host.actionHandler.handle({url:first.data.url,task:'Choose the North filter',session_handle:first.data.session_handle,command:{operation:'select',element_ref:select.ref,value:'north'}} as never,f.ctx) as any;
 expect(result).toMatchObject({ok:true,data:{elements:expect.arrayContaining([{ref:expect.any(String),role:'combobox',name:'Region',tag:'select',disabled:false,options:expect.arrayContaining([{value:'north',label:'North',disabled:false,selected:true}])}])}});
 expect(commonBrowserFixture.allocations).toBe(1);
 await host.cancel();
});

it('returns native accessibility context and verified desired checkbox state on the exact retained session',async()=>{
 const f=fixture();commonBrowserFixture.filters=true;const host=f.host();
 const first=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read available filters.'},f.ctx) as any;
 expect(first.data.accessibility_snapshot).toContain('"name":"Available only"');
 const checkbox=first.data.elements.find((row:any)=>row.name==='Available only');
 expect(checkbox.checked).toBe(false);
 const result=await host.actionHandler.handle({url:first.data.url,task:'Show available only',session_handle:first.data.session_handle,command:{operation:'set_checked',element_ref:checkbox.ref,checked:true}} as never,f.ctx) as any;
 expect(result).toMatchObject({ok:true,data:{session_handle:first.data.session_handle}});
 expect(result.data.elements.find((row:any)=>row.name==='Available only').checked).toBe(true);
 expect(result.data.accessibility_snapshot).toContain('"checked":true');
 expect(commonBrowserFixture.allocations).toBe(1);await host.cancel();
});

it('a disabled public option is refused without dispatching a selection or granting another session',async()=>{
 const f=fixture();commonBrowserFixture.filters=true;const host=f.host();
 const first=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read filters.'},f.ctx) as any;
 const select=first.data.elements.find((row:any)=>row.name==='Region');
 expect(await host.actionHandler.handle({url:first.data.url,task:'Choose unavailable',session_handle:first.data.session_handle,command:{operation:'select',element_ref:select.ref,value:'closed'}} as never,f.ctx)).toMatchObject({ok:false});
 expect(commonBrowserFixture.effects).toBe(0);expect(commonBrowserFixture.allocations).toBe(1);await host.cancel();
});

it('continues beyond four observations while retaining only bounded recent model images',async()=>{
 const f=fixture(),host=f.host(),url='https://public-pages.fixture.invalid/a';
 const first=await host.handler.handle({url,instruction:'Read.'},f.ctx);expect(first.ok).toBe(true);
 for(let step=0;step<8;step++){
  const result=await host.actionHandler.handle({url,task:'Observe the current page.',max_actions:1,command:{operation:'read'}},f.ctx);
  expect(result).toMatchObject({ok:true,data:{session_handle:host.sessionHandle()}});
  expect(host.attachments().length).toBeLessThanOrEqual(4);
 }
 expect(commonBrowserFixture.allocations).toBe(1);await host.cancel();expect(commonBrowserFixture.ends).toBe(1);
});
it('separates an admitted long task from the provider inactivity timeout',async()=>{
 const f=fixture();(f.grant as any).lifetimeMs=3_600_000;(f.grant as any).keepAliveMs=600_000;(f.grant as any).expiresAt=Date.now()+3_600_000;
 let idle:number|undefined;const load=f.config.loadSdk;f.config.loadSdk=async()=>{const sdk=await load();return {...sdk,acquire:async(binding:any,options:any)=>{idle=options.keep_alive;return sdk.acquire(binding,options);}} as never;};
 const host=f.host();expect(await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx)).toMatchObject({ok:true});expect(idle).toBe(600_000);
 expect((f.rows.get('common-browser:fixture-task') as any).session.expiresAt).toBeGreaterThan(Date.now()+3_500_000);await host.cancel();
});


it('confirmed emergency provider termination closes exact host custody and settles one allocation',async()=>{
 const f=fixture(),host=f.host();let settlements=0;
 (f.config as any).allocationClosed=async()=>{settlements++;};
 commonBrowserFixture.text='';
 commonBrowserFixture.onGoto=()=>{const page=commonBrowserFixture.pages[0];page.close=async()=>{throw Error('page shutdown failed');};};
 const failed=await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read page.'},f.ctx) as any;
 expect(failed).toMatchObject({ok:false,browser:{retained:{state:'closed'},recovery:{can_navigate:false,can_cancel:false}}});
 expect(f.rows.get('common-browser:fixture-task')).toMatchObject({cleanup:'closed',session:{state:'ended'}});
 expect(settlements).toBe(1);expect(commonBrowserFixture.ends).toBe(1);
 expect(await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read again.'},f.ctx)).toMatchObject({ok:false});
 expect(commonBrowserFixture.allocations).toBe(1);expect(settlements).toBe(1);
});


it('confirmed absence survives settlement failure with frozen duration and bounded bookkeeping retry',async()=>{
 const f=fixture(),host=f.host(),times:number[]=[];
 (f.config as any).allocationClosed=async(_grant:unknown,_session:unknown,terminatedAt:number)=>{times.push(terminatedAt);if(times.length===1)throw Error('spend ledger temporarily unavailable');};
 commonBrowserFixture.text='';commonBrowserFixture.onGoto=()=>{commonBrowserFixture.pages[0].close=async()=>{throw Error('page shutdown failed');};};
 expect(await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx)).toMatchObject({ok:false,browser:{code:'cleanup_unconfirmed',retained:{state:'closed'},recovery:{can_navigate:false}}});
 const closed=f.rows.get('common-browser:fixture-task') as any;
 expect(closed).toMatchObject({cleanup:'closed',session:{state:'ended'},settlement:{state:'pending',attempts:1,failed:true}});
 expect(commonBrowserFixture.ends).toBe(1);
 await maintainCommonBrowsers(f.storage,f.config,closed.settlement.retryAt);
 expect(f.rows.get('common-browser:fixture-task')).toMatchObject({cleanup:'closed',settlement:{state:'settled',attempts:2}});
 expect(times).toEqual([closed.settlement.terminatedAt,closed.settlement.terminatedAt]);
 expect(commonBrowserFixture.ends).toBe(1);expect(commonBrowserFixture.allocations).toBe(1);
});

it('failed settlement retries stop after three attempts while physical custody stays closed',async()=>{
 const f=fixture(),host=f.host();let attempts=0;
 (f.config as any).allocationClosed=async()=>{attempts++;throw Error('spend repair required');};
 await host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Read.'},f.ctx);
 await expect(host.cancel()).rejects.toThrow('spend repair required');
 for(let i=0;i<4;i++){const row=f.rows.get('common-browser:fixture-task') as any;await maintainCommonBrowsers(f.storage,f.config,row.settlement.retryAt);}
 expect(attempts).toBe(3);expect(commonBrowserFixture.ends).toBe(1);
 expect(f.rows.get('common-browser:fixture-task')).toMatchObject({cleanup:'closed',settlement:{state:'pending',attempts:3,failed:true}});
 expect(f.rows.get('common_browser_due_v1')).toBeNull();
});
