import { expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { workspaceStore, type WorkspaceState } from '@waldo/workspace';
import { ownerPrivateBrowserHost } from '../src/channels/owner-private-browser-host';
import { ownerBrowserVaultRegistration, revokeOwnerBrowserVault } from '../src/channels/owner-browser-vault-registration';
import type { CommonBrowserConfiguration } from '../src/channels/common-browser-host';

it('confirmed owner signs in, reads through the browser handler after recreation, then retires state without refreshing spend', async () => {
 const rows = new Map<string, any>();
 const storage = { kv: { get: (k: string) => rows.get(k), put: (k: string, v: unknown) => rows.set(k, v), delete: (k: string) => rows.delete(k), list: ({ prefix }: { prefix: string }) => new Map([...rows].filter(([k]) => k.startsWith(prefix))) }, transactionSync: <T>(f: () => T) => f() } as unknown as DurableObjectStorage;
 const directoryOwnerId = '12345678-1234-1234-1234-123456789abc', ownerId = `prn_${directoryOwnerId.replaceAll('-', '')}`;
 let downloadRead=false, downloadDeleted=false;
 const fileState:WorkspaceState={binding:null,files:[],bodies:[],operations:[]}, fileObjects=new Map<string,Uint8Array>();
 const workspace=await workspaceStore({binding:{ownerId:directoryOwnerId,environment:'staging',namespace:'fixture',doName:'owner',doId:'physical',stateVersion:1,mappingVersion:1},admit:async()=>({status:'ok'}),metadata:{transaction:f=>f(fileState)},bodies:{put:async(b,v)=>{fileObjects.set(b.blob_id,v.slice());},get:async b=>fileObjects.get(b.blob_id)??null,remove:async b=>{fileObjects.delete(b.blob_id);}},now:Date.now,newId:()=>crypto.randomUUID()});
 let allocations = 0, deliveries = 0, caller = directoryOwnerId, restored = 0, socketDenials = 0, duplicateCleanup=0;
 const cleanupGrants=new Set<string>(); let holdRead=false, entered!:()=>void, release!:()=>void; const reading=new Promise<void>(yes=>{entered=yes;}); const held=new Promise<void>(yes=>{release=yes;});
 const native = new Set<string>();
 const configuration = { ownerId, lifetimeMs: 120000, expiresAt: Date.now() + 600000, binding: {},
  grant: async (task: any) => ({ ownerId, taskId: task.taskId, ref: 'unchanged-budget', expiresAt: Date.now() + 600000, lifetimeMs: 120000, maxScreenshotBytes: 1000, allowedOrigins: ['https://synthetic.example'] }),
  assertGrantCurrent: async () => {}, reserveAllocation: async () => { allocations++; }, bindingForOperation: () => ({}),
  cleanupBinding: (grant:any) => { const record=[...rows.entries()].find(([path])=>path.startsWith('private-browser-owner/v1/')&&!path.includes('/encrypted/'))?.[1]; expect(grant.taskId).toBe(record.allocationRef); if(cleanupGrants.has(grant.taskId)){duplicateCleanup++;throw Error('cleanup allowance exhausted');} cleanupGrants.add(grant.taskId);return {}; }, loadSdk: async () => ({ sessions: async () => [...native].map(sessionId => ({ sessionId })), connect:async (_:any,args:any)=>({close:async()=>{},newBrowserCDPSession:async()=>({send:async()=>{native.delete(args.sessionId);}})}) })
 } as unknown as CommonBrowserConfiguration & { ownerId: string; lifetimeMs: number; expiresAt: number };
 const fixtureRegistration = { siteOrigin: 'https://synthetic.example', accountId: 'synthetic-account', expiresAt: configuration.expiresAt, allowedDomains: ['synthetic.example'], sitePolicy: { origins: ['https://synthetic.example'], cookieDomains: ['synthetic.example'] },
  verifyAccount: async (context: any) => { if(context.restored) expect(context.readPolicy).toBe(true); return context.signedIn(); },
  signIn: { instructions: 'Complete synthetic MFA', prepare: async (context: any) => context.newPage() },
  deliverToOwner: async (recipient: string, url: string) => { expect(recipient).toBe(directoryOwnerId); expect(url).toContain('live.browser.run'); deliveries++; complete!(); },
  launch: async () => {
   const id = crypto.randomUUID(); native.add(id);
   return { sessionId: () => id, close: async () => { native.delete(id); }, newContext: async (args: any) => {
    let state = args.storageState ?? { cookies: [], origins: [] }; if (args.storageState) restored++;
    let listener: any;
    const context: any = { restored: !!args.storageState, readPolicy:false, signedIn: () => state.cookies.length > 0, route: async () => { context.readPolicy=true; }, routeWebSocket: async (_:string, deny:any) => { await deny({close:()=>{socketDenials++;}}); }, storageState: async () => state, close: async () => {},
     newPage: async () => { let url = 'https://synthetic.example/account', listener:any; const page:any={ on:(_:string,fn:any)=>{listener=fn;},off:()=>{listener=undefined;}, context: () => context, url: () => url, goto: async (next: string) => { url = next; if(downloadRead){listener?.({page:()=>page,suggestedFilename:()=> 'report.txt',failure:async()=>null,createReadStream:async()=>Readable.from([new TextEncoder().encode('Owner report bytes')]),delete:async()=>{downloadDeleted=true;},cancel:async()=>{}});throw Error('Download navigation');} return { status: () => 200 }; }, title: async () => 'Synthetic account', evaluate: async () => { if(holdRead){entered();await held;} return 'Useful synthetic private account page'; }, close: async () => {if(downloadRead)expect(downloadDeleted).toBe(true);} };return page; },
     newCDPSession: async () => ({ on: (_: string, fn: any) => { listener = fn; }, off: () => {}, detach: async () => {}, send: async (method: string) => method === 'Cloudflare.getLiveView' ? { id: 'target', devtoolsFrontendUrl: 'https://live.browser.run/?synthetic-bearer' } : { targetId: 'target', handoffId: 'handoff' } }) };
    complete = () => { state = { cookies: [{ domain: 'synthetic.example', name: 'session', value: 'SYNTHETIC_SESSION' }], origins: [] }; listener({ targetId: 'target', handoffId: 'handoff', success: true }); };
    return context;
   } };
  } };
 let revokeOutage=false, revokeCalls=0;
 const vault=new Map<string,{state:string|null;revision:number;revoked:boolean}>();
 rows.set('do_name','owner');rows.set('telegram_subject','81101');
 const vaultEnv={WALDO_ENVIRONMENT:'staging',WALDO_OWNER_DO_NAMESPACE:'fixture',SUPABASE_PROJECT_URL:'https://vault.invalid',SUPABASE_PUBLISHABLE_KEY:'synthetic',WALDO_ROUTER_HMAC_SECRET:'synthetic',TELEGRAM_OWNER_DO:{idFromName:()=>({toString:()=> 'physical'})}} as any;
 const vaultNetwork=async(input:RequestInfo|URL,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));if(String(input).endsWith('/workspace_owner_binding'))return Response.json({owner_id:directoryOwnerId,environment:'staging',namespace:'fixture',do_name:'owner',do_id:'physical',state_version:1,mapping_version:1});expect(String(input)).toBe('https://vault.invalid/functions/v1/connector-proxy');const id=JSON.stringify(body.scope.binding),prior=vault.get(id)??{state:null,revision:0,revoked:false};if(body.action==='revoke'){revokeCalls++;if(revokeOutage)throw Error('synthetic Vault outage');vault.set(id,{...prior,state:null,revoked:true});return Response.json({data:{revoked:true,revision:prior.revision}});}if(prior.revoked)return Response.json({error:{message:'revoked'}});if(body.action==='save'){expect(body.expected_revision).toBe(prior.revision);vault.set(id,{state:body.state,revision:prior.revision+1,revoked:false});return Response.json({data:{saved:true,revision:prior.revision+1}});}return Response.json({data:{state:prior.state,revision:prior.revision}});};
 const vaultOptions={env:vaultEnv,storage,actualDoId:'physical',fetcher:vaultNetwork,assertOwner:async()=>{if(caller!==directoryOwnerId)throw Error('owner denied');return {directoryOwnerId,custodyDigest:'a'.repeat(64)};}};
 const registration=ownerBrowserVaultRegistration({...vaultOptions,registration:fixtureRegistration as any});
 let complete: (() => void) | undefined;
 const make = (selected:typeof registration|undefined=registration) => ownerPrivateBrowserHost({ storage, environment: 'staging', registration: selected as never, configuration: async () => configuration,
  assertOwner: async () => { if (caller !== directoryOwnerId) throw Error('owner denied'); return { directoryOwnerId, custodyDigest: 'a'.repeat(64) }; }, now: Date.now, retireState: (approval:any)=>revokeOwnerBrowserVault(vaultOptions,approval), files: async (assertCurrent:any)=>{await assertCurrent();return {workspace,origin:'https://owner.invalid'};} } as any);
 const request = (host: ReturnType<typeof make>, body?: object) => host.control(new Request('https://local.invalid/console/browser/saved', body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, csrf: 'owner-csrf' }) } : {}), 'owner-csrf');
 let host = make();
 const proposed = await (await request(host)).json() as any;
 expect((await request(host, { action: 'confirm', nonce: proposed.nonce })).status).toBe(200);
 const signed = await request(host, { action: 'sign_in' }); expect(await signed.json()).toEqual({signed_in:true}); expect(signed.status).toBe(200);
 expect(allocations).toBe(1); expect(deliveries).toBe(1); expect(native.size).toBe(0);
 expect((await request(make({...registration,accountId:'changed-account'}),{action:'sign_in'})).status).toBe(409); expect(allocations).toBe(1);
 host = make();
 const result = await host.read({ provider: 'cloudflare_playwright', url: 'https://synthetic.example/account', instruction: 'Read account' }, { turnId: 'fresh-turn', toolCallId: 'call', runScope: { runId: 'task', attempt: 1, deadline: Date.now() + 60000 }, assertTaskSourceCurrent: async () => {} } as any);
 expect(result).toMatchObject({ ok: true, data: { text: 'Useful synthetic private account page' }, source_taint: 'external' });
 expect(restored).toBe(1); expect(socketDenials).toBe(1); expect(deliveries).toBe(1); expect(allocations).toBe(2);
 expect(JSON.stringify([...rows.values()])).not.toContain('SYNTHETIC_SESSION'); expect(JSON.stringify(result)).not.toContain('synthetic-bearer');
 downloadRead=true;
 const downloaded=await host.read({provider:'cloudflare_playwright',url:'https://synthetic.example/report',instruction:'Get report'}, {turnId:'download-turn',toolCallId:'download-call',runScope:{runId:'download-task',attempt:1,deadline:Date.now()+60000},assertTaskSourceCurrent:async()=>{}} as any);
 expect(downloaded).toMatchObject({ok:true,data:{file:{audience:'owner_authenticated',retrieval:'verified',byte_size:18}}});
 const receipt=(downloaded as any).data.file;expect(new TextDecoder().decode((await workspace.export(receipt.file_id,receipt.revision)).bytes)).toBe('Owner report bytes');
 expect(downloadDeleted).toBe(true);downloadRead=false;
 const renewal=await (await request(host)).json() as any; expect(renewal.generation).toBe(2);
 expect((await request(host,{action:'confirm',nonce:renewal.nonce})).status).toBe(200); expect(allocations).toBe(3);
 expect([...rows.keys()].some(k=>k.includes('/encrypted/'))).toBe(false);expect([...vault.values()].every(v=>v.state===null&&v.revoked)).toBe(true);
 expect((await request(host,{action:'sign_in'})).status).toBe(200); expect(deliveries).toBe(2);
 holdRead=true;
 const activeRead=host.read({provider:'cloudflare_playwright',url:'https://synthetic.example/account',instruction:'Read'}, {turnId:'active-turn',toolCallId:'active-call',runScope:{runId:'active-task',attempt:1,deadline:Date.now()+60000},assertTaskSourceCurrent:async()=>{}} as any);
 await reading;
 caller = 'other-owner'; expect((await request(host, { action: 'revoke' })).status).toBe(409);
 caller = directoryOwnerId; const revokedRegistrationHost=make({...registration,accountId:'changed-account'});
 revokeOutage=true;expect((await request(revokedRegistrationHost,{action:'revoke'})).status).toBe(409);
 expect(native.size).toBe(0);expect(rows.get('private_browser_due_v1')).toBe(null);
 const attempted=revokeCalls;await make().maintain();expect(revokeCalls).toBe(attempted);
 const recovery=await revokedRegistrationHost.control(new Request('https://local.invalid/console/browser/saved',{headers:{accept:'text/html'}}),'owner-csrf');expect(recovery.status).toBe(200);expect(await recovery.text()).toContain('Removal remains unconfirmed');
 revokeOutage=false;expect((await request(revokedRegistrationHost, { action: 'revoke' })).status).toBe(200);
 release(); expect(await activeRead).toMatchObject({ok:false});
 expect([...vault.values()].every(v=>v.state===null&&v.revoked)).toBe(true);
 expect(allocations).toBe(5); expect(native.size).toBe(0);
 expect(cleanupGrants.size).toBe(5); expect(duplicateCleanup).toBe(0);
 expect([...rows.keys()].some(k => k.includes('/encrypted/'))).toBe(false);
 expect(await host.read({ provider: 'cloudflare_playwright', url: 'https://synthetic.example/account', instruction: 'Read' }, {} as any)).toMatchObject({ ok: false });
});
