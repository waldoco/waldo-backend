import { expect, it } from 'vitest';
import { ownerPrivateBrowserHost } from '../src/channels/owner-private-browser-host';
import { browserStateCustody } from '../src/channels/browser-state-custody';
import type { CommonBrowserConfiguration } from '../src/channels/common-browser-host';

it('confirmed owner signs in, reads through the browser handler after recreation, then retires state without refreshing spend', async () => {
 const rows = new Map<string, any>();
 const storage = { kv: { get: (k: string) => rows.get(k), put: (k: string, v: unknown) => rows.set(k, v), delete: (k: string) => rows.delete(k), list: ({ prefix }: { prefix: string }) => new Map([...rows].filter(([k]) => k.startsWith(prefix))) }, transactionSync: <T>(f: () => T) => f() } as unknown as DurableObjectStorage;
 const directoryOwnerId = '12345678-1234-1234-1234-123456789abc', ownerId = `prn_${directoryOwnerId.replaceAll('-', '')}`;
 const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
 let allocations = 0, deliveries = 0, caller = directoryOwnerId, restored = 0, socketDenials = 0, duplicateCleanup=0;
 const cleanupGrants=new Set<string>(); let holdRead=false, entered!:()=>void, release!:()=>void; const reading=new Promise<void>(yes=>{entered=yes;}); const held=new Promise<void>(yes=>{release=yes;});
 const native = new Set<string>();
 const configuration = { ownerId, lifetimeMs: 120000, expiresAt: Date.now() + 600000, binding: {},
  grant: async (task: any) => ({ ownerId, taskId: task.taskId, ref: 'unchanged-budget', expiresAt: Date.now() + 600000, lifetimeMs: 120000, maxScreenshotBytes: 1000, allowedOrigins: ['https://synthetic.example'] }),
  assertGrantCurrent: async () => {}, reserveAllocation: async () => { allocations++; }, bindingForOperation: () => ({}),
  cleanupBinding: (grant:any) => { const record=[...rows.entries()].find(([path])=>path.startsWith('private-browser-owner/v1/')&&!path.includes('/encrypted/'))?.[1]; expect(grant.taskId).toBe(record.allocationRef); if(cleanupGrants.has(grant.taskId)){duplicateCleanup++;throw Error('cleanup allowance exhausted');} cleanupGrants.add(grant.taskId);return {}; }, loadSdk: async () => ({ sessions: async () => [...native].map(sessionId => ({ sessionId })), connect:async (_:any,args:any)=>({close:async()=>{},newBrowserCDPSession:async()=>({send:async()=>{native.delete(args.sessionId);}})}) })
 } as unknown as CommonBrowserConfiguration & { ownerId: string; lifetimeMs: number; expiresAt: number };
 const registration = { siteOrigin: 'https://synthetic.example', accountId: 'synthetic-account', expiresAt: configuration.expiresAt, allowedDomains: ['synthetic.example'], sitePolicy: { origins: ['https://synthetic.example'], cookieDomains: ['synthetic.example'] },
  custody: async (binding: any, blobs: any, admit: any) => browserStateCustody(binding, key, blobs, admit),
  verifyAccount: async (context: any) => { if(context.restored) expect(context.readPolicy).toBe(true); return context.signedIn(); },
  signIn: { instructions: 'Complete synthetic MFA', prepare: async (context: any) => context.newPage() },
  deliverToOwner: async (recipient: string, url: string) => { expect(recipient).toBe(directoryOwnerId); expect(url).toContain('live.browser.run'); deliveries++; complete!(); },
  launch: async () => {
   const id = crypto.randomUUID(); native.add(id);
   return { sessionId: () => id, close: async () => { native.delete(id); }, newContext: async (args: any) => {
    let state = args.storageState ?? { cookies: [], origins: [] }; if (args.storageState) restored++;
    let listener: any;
    const context: any = { restored: !!args.storageState, readPolicy:false, signedIn: () => state.cookies.length > 0, route: async () => { context.readPolicy=true; }, routeWebSocket: async (_:string, deny:any) => { await deny({close:()=>{socketDenials++;}}); }, storageState: async () => state, close: async () => {},
     newPage: async () => { let url = 'https://synthetic.example/account'; return { context: () => context, url: () => url, goto: async (next: string) => { url = next; return { status: () => 200 }; }, title: async () => 'Synthetic account', evaluate: async () => { if(holdRead){entered();await held;} return 'Useful synthetic private account page'; }, close: async () => {} }; },
     newCDPSession: async () => ({ on: (_: string, fn: any) => { listener = fn; }, off: () => {}, detach: async () => {}, send: async (method: string) => method === 'Cloudflare.getLiveView' ? { id: 'target', devtoolsFrontendUrl: 'https://live.browser.run/?synthetic-bearer' } : { targetId: 'target', handoffId: 'handoff' } }) };
    complete = () => { state = { cookies: [{ domain: 'synthetic.example', name: 'session', value: 'SYNTHETIC_SESSION' }], origins: [] }; listener({ targetId: 'target', handoffId: 'handoff', success: true }); };
    return context;
   } };
  } };
 let complete: (() => void) | undefined;
 const make = (selected:typeof registration|undefined=registration) => ownerPrivateBrowserHost({ storage, environment: 'staging', registration: selected as never, configuration: async () => configuration,
  assertOwner: async () => { if (caller !== directoryOwnerId) throw Error('owner denied'); return { directoryOwnerId, custodyDigest: 'signed-custody' }; }, now: Date.now });
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
 const renewal=await (await request(host)).json() as any; expect(renewal.generation).toBe(2);
 expect((await request(host,{action:'confirm',nonce:renewal.nonce})).status).toBe(200); expect(allocations).toBe(2);
 expect([...rows.keys()].some(k=>k.includes('/encrypted/'))).toBe(false);
 expect((await request(host,{action:'sign_in'})).status).toBe(200); expect(deliveries).toBe(2);
 holdRead=true;
 const activeRead=host.read({provider:'cloudflare_playwright',url:'https://synthetic.example/account',instruction:'Read'}, {turnId:'active-turn',toolCallId:'active-call',runScope:{runId:'active-task',attempt:1,deadline:Date.now()+60000},assertTaskSourceCurrent:async()=>{}} as any);
 await reading;
 caller = 'other-owner'; expect((await request(host, { action: 'revoke' })).status).toBe(409);
 caller = directoryOwnerId; const revokedRegistrationHost=make({...registration,accountId:'changed-account'}); expect((await request(revokedRegistrationHost, { action: 'revoke' })).status).toBe(200);
 release(); expect(await activeRead).toMatchObject({ok:false});
 expect(allocations).toBe(4); expect(native.size).toBe(0);
 expect(cleanupGrants.size).toBe(4); expect(duplicateCleanup).toBe(0);
 expect([...rows.keys()].some(k => k.includes('/encrypted/'))).toBe(false);
 expect(await host.read({ provider: 'cloudflare_playwright', url: 'https://synthetic.example/account', instruction: 'Read' }, {} as any)).toMatchObject({ ok: false });
});
