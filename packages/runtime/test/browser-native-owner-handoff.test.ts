import {expect,it} from 'vitest';
import {commonBrowserHost} from '../src/channels/common-browser-host';
import {commonBrowserFixture,commonBrowserFixtureLoader,nativeHandoffDouble} from './fixtures/common-browser-sdk';
function fixture(){
 commonBrowserFixture.reset();const rows=new Map<string,unknown>();let live=true;
 const storage={kv:{get:(k:string)=>{const value=rows.get(k);return value===undefined?undefined:structuredClone(value);},put:(k:string,v:unknown)=>rows.set(k,structuredClone(v)),list:({prefix}:{prefix:string})=>[...rows].filter(([k])=>k.startsWith(prefix))},transactionSync:<T>(f:()=>T)=>f()} as unknown as DurableObjectStorage;
 const task={taskId:'login-task',revision:1,sources:['browser'] as const,ready:true,startRef:'owner'};
 const grant={ref:'funded',taskId:task.taskId,ownerId:'owner',expiresAt:Date.now()+600000,lifetimeMs:600000,allowedOrigins:['https://public-pages.fixture.invalid'],maxScreenshotBytes:1024};
 const custody=async()=>{if(!live)throw Error('revoked');};
 const config={retainInteractions:true as const,binding:{} as never,loadSdk:commonBrowserFixtureLoader,grant:async()=>grant,reserveAllocation:async()=>{},assertGrantCurrent:custody,assertHandoffCurrent:custody};
 const host=commonBrowserHost({storage,config,ownerId:'owner',source:()=>task,assertCurrent:custody,deadline:()=>Date.now()+60000,now:Date.now});
 const ctx={turnId:'initial-owner-turn',authenticatedUserId:'owner',assertTaskSourceCurrent:custody} as never;
 return {host,rows,ctx,storage,config,revoke:()=>{live=false;}};
}
it('ordinary browser login pauses agent evidence and returns only a non-secret owner console path',async()=>{
 const f=fixture();const read=await f.host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Open my task'},f.ctx) as any;
 expect(read.ok).toBe(true);
 const result=await f.host.actionHandler.handle({url:read.data.url,task:'Read after owner login',session_handle:read.data.session_handle,max_actions:1,command:{operation:'owner_login',reason:'Sign in to the intended account and complete MFA.'}},f.ctx) as any;
 expect(result).toMatchObject({ok:true,data:{owner_login:'pending',console_path:'/console/browser-handoff'}});
 expect(f.host.attachments()).toEqual([]);
 expect(await f.host.handler.handle({url:read.data.url,instruction:'Read while owner signs in',session_handle:read.data.session_handle},f.ctx)).toMatchObject({ok:false});
 expect(await f.host.actionHandler.handle({url:read.data.url,task:'Screenshot',session_handle:read.data.session_handle,max_actions:1,command:{operation:'screenshot'}},f.ctx)).toMatchObject({ok:false});
 expect(commonBrowserFixture.allocations).toBe(1);
 expect(JSON.stringify([...f.rows.values()])+JSON.stringify(result)).not.toContain('live.browser.run');
});

it('maintenance does not terminate a starting native handoff while provider response is awaited',async()=>{
 const f=fixture(),read=await f.host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Open task'},f.ctx) as any;
 let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 nativeHandoffDouble.onSend=async method=>{if(method==='Cloudflare.handoff'){entered();await gate;}};
 const pending=f.host.actionHandler.handle({url:read.data.url,task:'Sign in',session_handle:read.data.session_handle,max_actions:1,command:{operation:'owner_login',reason:'Owner sign-in'}},f.ctx);
 await reached;await f.host.maintainHandoff();expect(commonBrowserFixture.ends).toBe(0);release();expect(await pending).toMatchObject({ok:true});
 await f.host.cancel();
});

it('matching provider completion cannot resume in the original model turn',async()=>{
 const f=fixture(),read=await f.host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Open task'},f.ctx) as any;
 expect(await f.host.actionHandler.handle({url:read.data.url,task:'Login',max_actions:1,command:{operation:'owner_login',reason:'Owner login'}},f.ctx)).toMatchObject({ok:true});
 nativeHandoffDouble.emit(true);
 expect(await f.host.actionHandler.handle({url:read.data.url,task:'Resume now',max_actions:1,command:{operation:'resume_owner_login'}},f.ctx)).toMatchObject({ok:false});
 await f.host.cancel();
});
it('later authenticated owner consumes matching completion once and receives fresh account verification evidence',async()=>{
 const f=fixture(),read=await f.host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Open task'},f.ctx) as any;
 expect(await f.host.actionHandler.handle({url:read.data.url,task:'Login',max_actions:1,command:{operation:'owner_login',reason:'Owner login'}},f.ctx)).toMatchObject({ok:true});
 nativeHandoffDouble.emit(true);commonBrowserFixture.text='Signed in as fictional intended owner';
 const next={...(f.ctx as any),turnId:'next-owner-turn'};
 const result=await f.host.actionHandler.handle({url:read.data.url,task:'Resume',max_actions:1,command:{operation:'resume_owner_login'}},next) as any;
 expect(result).toMatchObject({ok:true,data:{owner_login:'completed',intended_account_verification_required:true,text:'Signed in as fictional intended owner'}});
 expect(result.data.revision).not.toBe(read.data.revision);
 expect(await f.host.actionHandler.handle({url:read.data.url,task:'Duplicate',max_actions:1,command:{operation:'resume_owner_login'}},next)).toMatchObject({ok:false});
 expect(commonBrowserFixture.allocations).toBe(1);await f.host.cancel();expect(commonBrowserFixture.ends).toBe(1);
});
it('maintenance status awaited across successful resume does not close the resumed session',async()=>{
 const f=fixture(),read=await f.host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Open task'},f.ctx) as any;
 expect(await f.host.actionHandler.handle({url:read.data.url,task:'Login',max_actions:1,command:{operation:'owner_login',reason:'Owner login'}},f.ctx)).toMatchObject({ok:true});
 let entered!:()=>void,release!:()=>void,blocked=false;const reached=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 nativeHandoffDouble.onSend=async method=>{if(method==='Cloudflare.getHandoffState'&&!blocked){blocked=true;entered();await gate;}};
 const maintenance=f.host.maintainHandoff();await reached;nativeHandoffDouble.emit(true);
 expect(await f.host.actionHandler.handle({url:read.data.url,task:'Resume',max_actions:1,command:{operation:'resume_owner_login'}},{...(f.ctx as any),turnId:'later-turn'})).toMatchObject({ok:true});
 release();await maintenance;expect(commonBrowserFixture.ends).toBe(0);await f.host.cancel();
});
it('console opening rejects a changed session generation even with the same grant',async()=>{
 const f=fixture(),read=await f.host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Open task'},f.ctx) as any;
 expect(await f.host.actionHandler.handle({url:read.data.url,task:'Login',max_actions:1,command:{operation:'owner_login',reason:'Owner login'}},f.ctx)).toMatchObject({ok:true});
 const row=f.rows.get('common-browser:login-task') as any;row.session.generation++;f.rows.set('common-browser:login-task',row);
 await expect(f.host.openHandoff()).rejects.toThrow();expect(nativeHandoffDouble.commands).not.toContain('Cloudflare.getLiveView');await f.host.cancel();
});
it('revocation and funded expiry close the exact login session without allocation or snapshots',async()=>{
 for(const mode of ['revoked','expired']){
  const f=fixture(),read=await f.host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Open task'},f.ctx) as any;
  expect(await f.host.actionHandler.handle({url:read.data.url,task:'Login',max_actions:1,command:{operation:'owner_login',reason:'Owner login'}},f.ctx)).toMatchObject({ok:true});
  if(mode==='revoked')f.revoke();else{const row=f.rows.get('common-browser:login-task') as any;row.session.expiresAt=Date.now()-1;f.rows.set('common-browser:login-task',row);}
  await f.host.maintainHandoff();expect(commonBrowserFixture.ends).toBe(1);expect(commonBrowserFixture.allocations).toBe(1);expect(f.host.attachments()).toEqual([]);expect((f.rows.get('common-browser:login-task') as any).cleanup).toBe('closed');
 }
});
it('maintenance must close a generation change during awaited status even if transition becomes resuming',async()=>{
 const f=fixture(),read=await f.host.handler.handle({url:'https://public-pages.fixture.invalid/a',instruction:'Open task'},f.ctx) as any;
 expect(await f.host.actionHandler.handle({url:read.data.url,task:'Login',max_actions:1,command:{operation:'owner_login',reason:'Owner login'}},f.ctx)).toMatchObject({ok:true});
 let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 nativeHandoffDouble.onSend=async method=>{if(method==='Cloudflare.getHandoffState'){entered();await gate;}};
 const pending=f.host.maintainHandoff();await reached;const row=f.rows.get('common-browser:login-task') as any;row.session.generation++;row.handoff.state='resuming';f.rows.set('common-browser:login-task',row);release();await pending;expect(commonBrowserFixture.ends).toBe(1);
});
