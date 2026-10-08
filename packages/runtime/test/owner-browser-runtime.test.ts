import { expect, it, vi } from 'vitest';
import { browserTaskHandler } from '../src/tools/live/browser-task';
import { ownerBrowserRuntime } from '../src/channels/owner-browser-runtime';
import { configureCommonPublicBrowser } from '../src/channels/common-public-browser-configuration';
import { commonBrowserFixture, commonBrowserMeteredFixtureLoader } from './fixtures/common-browser-sdk';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
vi.mock('../src/identity/common-owner-authority', () => ({ commonOwnerAuthority: () => ({ resolve: async () => ({ directoryOwnerId: '10000000-0000-0000-0000-000000000002', custodyDigest: 'b'.repeat(64) }) }) }));
it('late old-run cleanup preserves the newer session; unlink reconstruction cleans only its retained identity', async () => {
 commonBrowserFixture.reset();
 const rows = new Map<string, any>([['do_name', 'runtime-owner'], ['telegram_subject', '81102']]);
 let alarm: number | null = null;
 const storage = { kv: { get: (key: string) => rows.get(key), put: (key: string, value: unknown) => rows.set(key, structuredClone(value)), list: ({prefix}: {prefix: string}) => [...rows].filter(([key]) => key.startsWith(prefix)) }, transactionSync: <T>(work: () => T) => work(), getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; } } as unknown as DurableObjectStorage;
 const now = Date.now(), ownerId = 'prn_10000000000000000000000000000002';
 configureCommonPublicBrowser({ ref: 'runtime-policy', doName: 'runtime-owner', subject: '81102', directoryOwnerId: '10000000-0000-0000-0000-000000000002', createdAt: now - 1, expiresAt: now + 60000, allowedOrigins: ['*'], maxAllocations: 1, maxReservedBrowserMs: 120000, lifetimeMs: 60000, maxScreenshotBytes: 1024 }, commonBrowserMeteredFixtureLoader,
 { policy: { ref: 'runtime-policy', ownerId, validUntil: now + 60000, limitMicrousd: 10000, maxCalls: 100 }, quote: kind => kind === 'browser' ? 0 : 1, allocationMicrousd: 100 });
 const binding = { fetch: vi.fn(async () => new Response('{}')) };
 const env = { WALDO_ENVIRONMENT: 'staging', BROWSER: binding, TELEGRAM_OWNER_DO: { idFromName: (name: string) => ({ toString: () => name === 'runtime-owner' ? 'physical-owner' : 'foreign' }) } } as never;
 const makeScope = (runId: string): RunEffectScope => ({ runId, attempt: runId, deadline: now + 60000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() });
 const old = makeScope('old'), newer = makeScope('new'); let active: RunEffectScope | undefined = newer;
 const options = { env, storage, actualDoId: 'physical-owner', activeScope: () => active };
 const runtime = ownerBrowserRuntime(options);
 const fallbackHandle = vi.fn(); const fallback = { name: 'browse_page', handle: fallbackHandle } as never;
 const ctx = { authenticatedUserId: ownerId, turnId: 'new-turn', toolCallId: 'new-call', runScope: { ...newer }, egressAllowlist: ['*', '-blocked.example.com'] } as never;
 const args = { provider: 'cloudflare_playwright' as const, url: 'https://example.com/a', instruction: 'Read page' };
 expect(await runtime.read(fallback).handle(args, ctx)).toMatchObject({ ok: true });
 expect(runtime.attachments(newer)).toHaveLength(1);
 await runtime.finish(old);
 expect(commonBrowserFixture.ends).toBe(0);
 expect(runtime.attachments(newer)).toHaveLength(1);
 expect(await runtime.read(fallback).handle({ ...args, url: 'https://blocked.example.com' }, ctx)).toMatchObject({ ok: false });
 expect(await runtime.read(fallback).handle(args, { ...ctx as object, runScope: { ...newer, admit() {} } } as never)).toMatchObject({ ok: false });
 expect(commonBrowserFixture.allocations).toBe(1);
 // A cancel from an older turn cannot fence the public session after its lookup resumes.
 let reached!: () => void, release!: () => void;
 const entered = new Promise<void>(resolve => reached = resolve), gate = new Promise<void>(resolve => release = resolve);
 const cancel = vi.fn();
 const cancelHandler = runtime.guard(browserTaskHandler({ legacy: { name: 'browse_act' } as never,
 host: async () => { reached(); await gate; return { pageUrl: args.url, cancel } as never; }, propose: async () => 'unused',
 stopAdmission: async context => { await runtime.current(context)(); runtime.stop(); } }));
 active = old;
 const pendingCancel = cancelHandler.handle({ url: args.url, task: 'Cancel', max_actions: 1, command: { operation: 'cancel' } }, { ...ctx as object, runScope: old } as never);
 await entered; active = newer; release();
 expect(await pendingCancel).toMatchObject({ ok: false }); expect(cancel).not.toHaveBeenCalled();
 expect(rows.get('common-browser:new').cleanup).toBeUndefined();
 rows.set('telegram_unlinked', true); active = undefined;
 const reconstructed = ownerBrowserRuntime(options);
 runtime.stop(); await reconstructed.maintain();
 expect(commonBrowserFixture.ends).toBe(1);
 expect(rows.get('common-browser:new')).toMatchObject({ allocation: 'observed', cleanup: 'closed', session: { state: 'ended' } });
 expect(await (await commonBrowserMeteredFixtureLoader()).sessions(binding as never)).toEqual([]);
 await runtime.finish(old);
 expect(commonBrowserFixture.ends).toBe(1);
 expect(fallbackHandle).not.toHaveBeenCalled();
});

 it('preserves an unselected typed fixture host but never falls back for explicit Cloudflare or free-text staging calls',async()=>{
 const rows=new Map<string,unknown>([['do_name','fixture-only'],['telegram_subject','81102']]);
 const scope:RunEffectScope={runId:'fixture-run',attempt:'fixture-attempt',deadline:Date.now()+60000,signal:new AbortController().signal,admit(){},commit:work=>work()};
 const storage={kv:{get:(key:string)=>rows.get(key),put:(key:string,value:unknown)=>rows.set(key,value)},getAlarm:async()=>null,setAlarm:async()=>{}} as unknown as DurableObjectStorage;
 const env={WALDO_ENVIRONMENT:'staging',TELEGRAM_OWNER_DO:{idFromName:()=>({toString:()=> 'fixture-physical'})}} as never;
 const runtime=ownerBrowserRuntime({env,storage,actualDoId:'fixture-physical',activeScope:()=>scope});
 const called=vi.fn(async()=>({ok:true as const,data:{fixture:true},source_taint:'external' as const}));
 const fallback={name:'browse_act',handle:called} as never;
 const handler=runtime.act(fallback),ctx={authenticatedUserId:'fixture-owner',runScope:scope} as never;
 const args={url:'https://fixture.example/form',task:'Inspect',max_actions:1,command:{operation:'inspect' as const}};
 expect(await handler.handle(args,ctx)).toMatchObject({ok:true,data:{fixture:true}});expect(called).toHaveBeenCalledTimes(1);
 expect(await handler.handle({...args,provider:'cloudflare_playwright'},ctx)).toMatchObject({ok:false});
 expect(await handler.handle({...args,session_handle:'retained-common-session'},ctx)).toMatchObject({ok:false});
 expect(await runtime.read(fallback).handle({url:args.url,instruction:'Read',session_handle:'retained-common-session',provider:'browserbase_stagehand_http_v3'},ctx)).toMatchObject({ok:false});
 expect(await handler.handle({...args,command:undefined},ctx)).toMatchObject({ok:false});expect(called).toHaveBeenCalledTimes(1);
 expect(await handler.handle({...args,provider:'browserbase_stagehand_http_v3'},ctx)).toMatchObject({ok:false});
 expect(await handler.handle({...args,command:undefined,provider:'browserbase_stagehand_http_v3',session_handle:'retained-common-session'},ctx)).toMatchObject({ok:false});expect(called).toHaveBeenCalledTimes(1);
 expect(await handler.handle({...args,command:undefined,provider:'browserbase_stagehand_http_v3'},ctx)).toMatchObject({ok:true});expect(called).toHaveBeenCalledTimes(2);
 });
