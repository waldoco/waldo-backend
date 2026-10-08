import { it, expect } from 'vitest';
import type { Browser, BrowserContext, BrowserWorker, Page, HandoffCompleteResponse } from '@cloudflare/playwright';
import { cloudflarePrivateOwner } from '../src/channels/cloudflare-private-owner';
import { browserStateCustody } from '../src/channels/browser-state-custody';
const ownerId = '12345678-1234-1234-1234-123456789abc';
type SyntheticContext = BrowserContext & { syntheticLogin():void; syntheticRead():string; emit(event:HandoffCompleteResponse):void };
const fixture = async (owner=ownerId) => {
 const rows = new Map<string, unknown>();
 const kv = { get: (k:string) => rows.get(k), put: (k:string,v:unknown) => rows.set(k,v), delete: (k:string) => rows.delete(k), list: ({prefix}:{prefix:string}) => new Map([...rows].filter(([k])=>k.startsWith(prefix))) };
 const storage = { kv, transactionSync: <T>(f:()=>T)=>f() } as unknown as DurableObjectStorage;
 const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']) as CryptoKey;
 let callerOwner=owner;let approved=true;let cleanupFails=false;
 const sessions = new Set<string>(); const restored:unknown[]=[]; let loginCount=0;let lastContext:SyntheticContext|undefined;
 const launch = async () => {
  const id=crypto.randomUUID();sessions.add(id);
  return {sessionId:()=>id,newContext:async (input:{storageState?:unknown})=>{
   restored.push(input.storageState);let state=(input.storageState??{cookies:[],origins:[]}) as {cookies:unknown[];origins:unknown[]};
   let listener:((event:HandoffCompleteResponse)=>void)|undefined;
   let context!:SyntheticContext;
   const page={url:()=> 'https://synthetic.example/account',context:()=>context} as unknown as Page;
   const cdp={on:(_event:string,l:typeof listener)=>{listener=l;},off:()=>{listener=undefined;},detach:async()=>{},send:async(method:string)=>{
    if(method==='Cloudflare.getLiveView')return {id:'target',devtoolsFrontendUrl:'https://live.browser.run/?synthetic-bearer',webSocketDebuggerUrl:'wss://synthetic.invalid'};
    if(method==='Cloudflare.handoff')return {targetId:'target',handoffId:'handoff'};
    throw Error('unexpected CDP');
   }};
   context={newPage:async()=>page,newCDPSession:async()=>cdp,storageState:async()=>state,close:async()=>{},syntheticLogin:()=>{loginCount++;state={cookies:[{domain:'synthetic.example',name:'session',value:'SYNTHETIC_MFA_SESSION'}],origins:[]};listener?.({targetId:'target',handoffId:'handoff',success:true});},syntheticRead:()=>state.cookies.length?'Synthetic account page':'Sign in required',emit:(event:HandoffCompleteResponse)=>listener?.(event)} as unknown as SyntheticContext;
   lastContext=context;return context;
  },close:async()=>{sessions.delete(id);}} as unknown as Browser;
 };
 const options={storage,binding:{} as BrowserWorker,launch,terminate:async(id:string)=>{if(cleanupFails)throw Error('synthetic provider secret');sessions.delete(id);},key,
  bindingScope:{ownerId:owner,environment:'staging',siteOrigin:'https://synthetic.example',accountId:'synthetic-account',generation:1},
  expiresAt:1000000,now:()=>1000,assertOwnerCurrent:async(b:{ownerId:string})=>{if(b.ownerId!==callerOwner)throw Error('synthetic owner rejected');},assertPersistenceApproved:async()=>{if(!approved)throw Error('synthetic consent rejected');},keepAliveMs:60000,lifetimeMs:600000,deadline:()=>1000000,reserveAllocation:async()=>{},allowedDomains:['synthetic.example'],sitePolicy:{origins:['https://synthetic.example'],cookieDomains:['synthetic.example']}};
 return {rows,sessions,restored,options,get loginCount(){return loginCount;},get lastContext(){return lastContext;},set callerOwner(v:string){callerOwner=v;},set approved(v:boolean){approved=v;},set cleanupFails(v:boolean){cleanupFails=v;}};
};
it('synthetic owner completes MFA, saves encrypted state, reconstructs host and reads without another login',async()=>{
 const f=await fixture();let delivered=0;
 const first=await cloudflarePrivateOwner(f.options).run({
  verifyAccount:async context=>(context as SyntheticContext).syntheticRead()==='Synthetic account page',
  signIn:{prepare:async context=>context.newPage(),instructions:'Complete synthetic login and MFA',timeoutMs:60000,liveViewExpiresMs:60000,
   deliverToOwner:async(recipient,url)=>{expect(recipient).toBe(ownerId);expect(url).toContain('live.browser.run');delivered++;const context=f.lastContext!;context.syntheticLogin();}},
  work:async context=>(context as SyntheticContext).syntheticRead(),
 });
 expect(first).toEqual({status:'ok',value:'Synthetic account page',persistence:'saved'});
 expect(f.sessions.size).toBe(0);expect(delivered).toBe(1);expect(f.loginCount).toBe(1);
 expect(JSON.stringify([...f.rows.values()])).not.toContain('SYNTHETIC_MFA_SESSION');
 expect(JSON.stringify(first)).not.toContain('synthetic-bearer');
 expect(await cloudflarePrivateOwner(f.options).run({verifyAccount:async context=>(context as SyntheticContext).syntheticRead()==='Synthetic account page',work:async context=>(context as SyntheticContext).syntheticRead()})).toEqual({status:'ok',value:'Synthetic account page',persistence:'saved'});
 expect(f.restored[1]).toEqual({cookies:[{domain:'synthetic.example',name:'session',value:'SYNTHETIC_MFA_SESSION'}],origins:[]});
 expect(f.loginCount).toBe(1);expect(f.sessions.size).toBe(0);
});
it('trusted custody can encrypt behind the host boundary without returning a key to the runner', async () => {
 const f = await fixture();
 const { key, ...options } = f.options;
 let custodyCalls = 0;
 const host = cloudflarePrivateOwner({ ...options, custody: async (binding, blobs, admit) => {
  custodyCalls++; return browserStateCustody(binding, key, blobs, admit);
 }});
 expect(await host.run({ verifyAccount: async () => true, work: async () => 'Synthetic page' })).toEqual({ status: 'ok', value: 'Synthetic page', persistence: 'saved' });
 expect(custodyCalls).toBe(1);
});
it('a provider launch that never answers reaches its deadline and retains allocation uncertainty', async () => {
 const f = await fixture(); const at = Date.now();
 const host = cloudflarePrivateOwner({ ...f.options, now: Date.now, expiresAt: at + 100000, deadline: () => at + 20, launch: () => new Promise(() => {}) });
 let timer: ReturnType<typeof setTimeout>;
 const watchdog = new Promise(resolve => { timer = setTimeout(() => resolve('hung'), 100); });
 const result = await Promise.race([host.run({ verifyAccount: async () => true, work: async () => 'must not run' }), watchdog]); clearTimeout(timer!);
 expect(result).toEqual({ status: 'failed', phase: 'launch' });
 const record = [...f.rows.entries()].find(([path]) => path.startsWith('private-browser-owner/v1/') && !path.includes('/encrypted/'))?.[1];
 expect(record).toMatchObject({ allocation: 'prepared' });
});
it('sign-out fences a pending synthetic MFA and survives host recreation without a late state write',async()=>{
 const f=await fixture();let delivered!:()=>void;const sent=new Promise<void>(r=>{delivered=r;});
 const host=cloudflarePrivateOwner(f.options);
 const run=host.run({verifyAccount:async()=>false,signIn:{prepare:async context=>context.newPage(),instructions:'Synthetic MFA',timeoutMs:60000,liveViewExpiresMs:60000,deliverToOwner:async()=>{delivered();}},work:async()=> 'must not deliver'});
 await sent;
 expect(await cloudflarePrivateOwner(f.options).signOut()).toEqual({status:'signed_out',remoteLogout:'not_attempted'});
 expect((await run).status).toBe('failed');expect(f.sessions.size).toBe(0);
 expect([...f.rows.keys()].some(k=>k.includes('/encrypted/'))).toBe(false);
 expect((await cloudflarePrivateOwner(f.options).run({verifyAccount:async()=>true,work:async()=> 'must not run'})).status).toBe('failed');
});
it('restart recovery interrupts and fences an outstanding operation before exact-session cleanup',async()=>{
 const f=await fixture();let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});let finish!:()=>void;const waiting=new Promise<void>(r=>{finish=r;});
 const old=cloudflarePrivateOwner(f.options).run({verifyAccount:async()=>true,work:async()=>{entered();await waiting;return 'late page';}});
 await started;
 expect(await cloudflarePrivateOwner(f.options).recover()).toEqual({status:'interrupted'});
 finish();expect((await old).status).toBe('failed');
 expect([...f.rows.keys()].some(k=>k.includes('/encrypted/'))).toBe(false);
 expect(f.sessions.size).toBe(0);
});
it('another owner cannot read, hand off or sign out this owner state',async()=>{
 const f=await fixture();const host=cloudflarePrivateOwner(f.options);
 expect((await host.run({verifyAccount:async()=>true,work:async()=> 'owner page'})).status).toBe('ok');
 const before=[...f.rows];f.callerOwner='87654321-4321-4321-4321-cba987654321';
 expect((await cloudflarePrivateOwner(f.options).run({verifyAccount:async()=>true,work:async()=>{throw Error('must not run');}})).status).toBe('failed');
 expect(await cloudflarePrivateOwner(f.options).signOut()).toEqual({status:'failed',phase:'owner'});
 expect(await cloudflarePrivateOwner(f.options).recover()).toEqual({status:'failed',phase:'owner'});
 expect([...f.rows]).toEqual(before);expect(f.sessions.size).toBe(0);
});
it('encrypted state replay into a different owner is rejected before provider launch even with the same synthetic key',async()=>{
 const f=await fixture();await cloudflarePrivateOwner(f.options).run({verifyAccount:async()=>true,work:async context=>{(context as SyntheticContext).syntheticLogin();return 'page';}});
 const packet=[...f.rows].find(([k])=>k.includes('/encrypted/'))![1];
 const second=await fixture('87654321-4321-4321-4321-cba987654321');
 const get=second.options.storage.kv.get.bind(second.options.storage.kv);
 second.options.storage.kv.get=((k:string)=>k.includes('/encrypted/')?packet:get(k)) as typeof get;
 expect((await cloudflarePrivateOwner({...second.options,key:f.options.key}).run({verifyAccount:async()=>true,work:async()=> 'must not run'})).status).toBe('failed');
 expect(second.restored).toHaveLength(0);expect(second.sessions.size).toBe(0);
});
it('Done without verified account access saves nothing and is a typed failure',async()=>{
 const f=await fixture();
 const result=await cloudflarePrivateOwner(f.options).run({verifyAccount:async()=>false,
  signIn:{prepare:async context=>context.newPage(),instructions:'Synthetic MFA',timeoutMs:60000,liveViewExpiresMs:60000,
   deliverToOwner:async()=>{f.lastContext!.emit({targetId:'target',handoffId:'handoff',success:true});}},
  work:async()=> 'must not claim useful account read',
 });
 expect(result).toEqual({status:'failed',phase:'work'});expect(f.sessions.size).toBe(0);
 expect([...f.rows.keys()].some(k=>k.includes('/encrypted/'))).toBe(false);
});
it('expired task deadline admits no provider launch or allocation',async()=>{
 const f=await fixture();let allocations=0;
 expect((await cloudflarePrivateOwner({...f.options,deadline:()=>999,reserveAllocation:async()=>{allocations++;}}).run({verifyAccount:async()=>true,work:async()=> 'must not run'})).status).toBe('failed');
 expect(allocations).toBe(0);expect(f.restored).toHaveLength(0);
});
it('non-finite task deadline admits no provider launch or allocation',async()=>{
 const f=await fixture();let allocations=0;
 expect((await cloudflarePrivateOwner({...f.options,deadline:()=>NaN,reserveAllocation:async()=>{allocations++;}}).run({verifyAccount:async()=>true,work:async()=> 'must not run'})).status).toBe('failed');
 expect(allocations).toBe(0);expect(f.restored).toHaveLength(0);
});
it('restored state still requires current account proof before any private read',async()=>{
 const f=await fixture();await cloudflarePrivateOwner(f.options).run({verifyAccount:async()=>true,work:async context=>{(context as SyntheticContext).syntheticLogin();return 'synthetic page';}});
 let reads=0;const result=await cloudflarePrivateOwner(f.options).run({verifyAccount:async()=>false,work:async()=>{reads++;return 'must not read';}});
 expect(result).toEqual({status:'failed',phase:'work'});expect(reads).toBe(0);expect(f.sessions.size).toBe(0);
});
it('consent withdrawal denies restore but still permits authenticated local sign-out',async()=>{
 const f=await fixture();await cloudflarePrivateOwner(f.options).run({verifyAccount:async()=>true,work:async()=> 'synthetic page'});
 f.approved=false;expect((await cloudflarePrivateOwner(f.options).run({verifyAccount:async()=>true,work:async()=> 'must not run'})).status).toBe('failed');
 expect(await cloudflarePrivateOwner(f.options).signOut()).toEqual({status:'signed_out',remoteLogout:'not_attempted'});
 expect([...f.rows.keys()].some(k=>k.includes('/encrypted/'))).toBe(false);
});
it('handoff timeout closes the exact browser even while owner delivery is still pending',async()=>{
 const f=await fixture();let release!:()=>void;const delivery=new Promise<void>(r=>{release=r;});
 const run=cloudflarePrivateOwner(f.options).run({verifyAccount:async()=>false,
  signIn:{prepare:async context=>context.newPage(),instructions:'Synthetic MFA',timeoutMs:10,liveViewExpiresMs:60000,deliverToOwner:async()=>delivery},work:async()=> 'must not run'});
 try { const outcome=await Promise.race([run,new Promise<'still_pending'>(r=>setTimeout(()=>r('still_pending'),100))]);
  expect(outcome).toEqual({status:'failed',phase:'work'});expect(f.sessions.size).toBe(0);
 } finally {release();await run;}
});

it('failed physical cleanup remains typed and unresolved while local sign-out retires ciphertext',async()=>{
 const f=await fixture();f.cleanupFails=true;
 const outcome=await cloudflarePrivateOwner(f.options).run({verifyAccount:async()=>true,work:async()=> 'synthetic page'});
 expect(outcome).toEqual({status:'failed',phase:'cleanup'});
 expect(await cloudflarePrivateOwner(f.options).signOut()).toEqual({status:'failed',phase:'cleanup'});
 expect([...f.rows.keys()].some(k=>k.includes('/encrypted/'))).toBe(false);
 expect(JSON.stringify(outcome)).not.toContain('synthetic provider secret');
 f.cleanupFails=false;expect(await cloudflarePrivateOwner(f.options).recover()).toEqual({status:'interrupted'});
 expect((await cloudflarePrivateOwner(f.options).run({verifyAccount:async()=>true,work:async()=> 'must not run'})).status).toBe('failed');
});
it('task deadline interrupts a pending private read and fences its eventual completion',async()=>{
 const f=await fixture();let release!:()=>void;const pending=new Promise<void>(r=>{release=r;});const now=Date.now();
 const run=cloudflarePrivateOwner({...f.options,expiresAt:now+1000000,now:Date.now,deadline:()=>now+20}).run({verifyAccount:async()=>true,work:async()=>{await pending;return 'late synthetic page';}});
 try{const outcome=await Promise.race([run,new Promise<'still_pending'>(r=>setTimeout(()=>r('still_pending'),100))]);
  expect(outcome).toEqual({status:'failed',phase:'work'});expect(f.sessions.size).toBe(0);expect([...f.rows.keys()].some(k=>k.includes('/encrypted/'))).toBe(false);
 }finally{release();await run;}
});
