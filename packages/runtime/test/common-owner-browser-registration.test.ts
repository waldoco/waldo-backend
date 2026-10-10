import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ownerBrowserRuntime } from '../src/channels/owner-browser-runtime';
import { registerCommonBrowserSdk } from '../src/channels/common-staging-registration';
import { commonBrowserFixture, commonBrowserMeteredFixtureLoader } from './fixtures/common-browser-sdk';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { commonSpendReservation } from '../src/channels/common-spend-reservation';
import {canonicalOwnerBrowserIdentity} from '../src/channels/owner-browser-identity';
import type {OwnerBrowserIdentity} from '../src/channels/owner-browser-runtime';

const directory = vi.hoisted(() => ({ owner: '10000000-0000-0000-0000-000000000001', custody: 'a'.repeat(64), present: true, wait: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }));
const provider = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: unknown) => { provider.calls.push(input); return { id: 'fake-response', output: [], output_text: 'Read complete.', usage: { input_tokens: 1, output_tokens: 1 } }; } }; } }));
vi.mock('../src/identity/common-owner-authority', () => ({ commonOwnerAuthority: () => ({ resolve: async (_provider: string, subject: string, doName: string) => { const wait = directory.wait; directory.wait = undefined; if (wait) { directory.entered?.(); await wait; } return directory.present ? { directoryOwnerId: directory.owner, custodyDigest: directory.custody, subject, doName } : null; } }) }));
registerCommonBrowserSdk(commonBrowserMeteredFixtureLoader);
afterEach(() => vi.restoreAllMocks());
beforeEach(() => { directory.owner = '10000000-0000-0000-0000-000000000001'; directory.custody = 'a'.repeat(64); directory.present = true; directory.wait = undefined; directory.entered = undefined; provider.calls = []; commonBrowserFixture.reset(); });
const setup = () => {
  const rows = new Map<string, any>([['do_name', 'automatic-owner'], ['telegram_subject', '81101']]);
  let alarm: number | null = null;
  const storage = { kv: { get: (key: string) => rows.get(key), put: (key: string, value: unknown) => rows.set(key, structuredClone(value)), list: ({ prefix }: { prefix: string }) => [...rows].filter(([key]) => key.startsWith(prefix)) }, transactionSync: <T>(work: () => T) => work(), getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; } } as unknown as DurableObjectStorage;
  const now = Date.now();
  const operator = { scope: 'verified_owners', policy: { ref: 'automatic-test', createdAt: now - 1000, expiresAt: now + 60000, allowedOrigins: ['*'], maxAllocations: 1, maxReservedBrowserMs: 120000, lifetimeMs: 60000, maxScreenshotBytes: 1024 }, billing: { cloudflareAccountId: 'a'.repeat(32), conservativeWorstCase: true }, spend: { limitMicrousd: 10000000, maxCalls: 100, validUntil: now + 60000 } };
  const binding = { fetch: vi.fn(async () => new Response('{}')) };
  const env = { WALDO_ENVIRONMENT: 'staging', COMMON_BROWSER_REGISTRATION: JSON.stringify(operator), OPENAI_API_KEY: 'synthetic-model-key', BROWSER: binding, TELEGRAM_OWNER_DO: { idFromName: (name: string) => ({ toString: () => name === 'automatic-owner' ? 'physical-owner' : 'foreign' }) } };
  const scope: RunEffectScope = { runId: crypto.randomUUID(), attempt: crypto.randomUUID(), deadline: now + 60000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() };
  let activeScope=scope;
  const runtime = (identity?:OwnerBrowserIdentity) => ownerBrowserRuntime({ env: env as never, storage, actualDoId: 'physical-owner', activeScope: () => activeScope,identity });
  return { rows, storage, operator, binding, env, scope, runtime,activate:(next:RunEffectScope)=>{activeScope=next;} };
};

const appIdentity=()=>{
 let binding:string|null='app-owner-authority:1',present=true;
 const identity:OwnerBrowserIdentity={snapshot:()=>binding,assertCurrent:async(expected)=>{if(!present||expected!==binding)throw Error('app owner revoked');},resolve:async()=>({directoryOwnerId:directory.owner,custodyDigest:directory.custody})};
 return {identity,revoke:()=>{present=false;},changeBinding:()=>{binding='app-owner-authority:2';}};
};

it('the actual app owner can use the same funded browser path without any Telegram link',async()=>{
 const f=setup(),owner=appIdentity();f.rows.delete('telegram_subject');f.rows.set('telegram_unlinked',true);directory.present=false;
 const runtime=f.runtime(owner.identity),ctx={authenticatedUserId:'server-app-owner',runScope:f.scope,turnId:'app-turn',toolCallId:'app-read',egressAllowlist:['*']} as never;
 const result=await runtime.read({name:'browse_page'} as never).handle({provider:'cloudflare_playwright',retain_session:true,url:'https://example.com/a',instruction:'Read for my app'},ctx) as any;
 expect(result).toMatchObject({ok:true,data:{session_handle:expect.any(String)}});
 expect(f.rows.get('common_owner_browser_registration_v1').registration.policy).toMatchObject({authority:'verified_owner',directoryOwnerId:directory.owner});
 expect(f.rows.get('common_owner_browser_registration_v1').registration.policy.subject).toBeUndefined();
 const handle=result.data.session_handle;await runtime.finish(f.scope);
 const next={...f.scope,runId:crypto.randomUUID(),attempt:crypto.randomUUID()};f.activate(next);
 expect(await runtime.act({name:'browse_act'} as never).handle({provider:'cloudflare_playwright',url:'https://example.com/a',task:'Inspect exact retained app session',session_handle:handle,max_actions:1,command:{operation:'inspect'}},{...ctx as object,runScope:next,turnId:'app-next',toolCallId:'inspect'} as never)).toMatchObject({ok:true});
 expect(commonBrowserFixture.allocations).toBe(1);owner.revoke();
 expect(await runtime.act({name:'browse_act'} as never).handle({provider:'cloudflare_playwright',url:'https://example.com/a',task:'Read after revoke',session_handle:handle,max_actions:1,command:{operation:'read'}},{...ctx as object,runScope:next} as never)).toMatchObject({ok:false});
 runtime.stop();await f.runtime(owner.identity).maintain();expect(commonBrowserFixture.ends).toBe(1);expect(commonBrowserFixture.allocations).toBe(1);
});

it('authenticated surface changes cannot manufacture a new allowance or replace the retained owner',async()=>{
 const f=setup(),runtime=f.runtime();await allocate(f,runtime);await runtime.finish(f.scope);
 const pinned=structuredClone(f.rows.get('common_owner_browser_registration_v1')),owner=appIdentity();f.rows.delete('telegram_subject');f.rows.set('telegram_unlinked',true);directory.present=false;
 const pointer=f.rows.get('common-browser-current:v1'),next={...f.scope,runId:crypto.randomUUID(),attempt:crypto.randomUUID()};f.activate(next);
 const app=f.runtime(owner.identity),args={provider:'cloudflare_playwright' as const,url:'https://example.com/a',instruction:'Read same retained session',session_handle:pointer.sessionHandle};
 const ctx={authenticatedUserId:'app-owner',runScope:next,turnId:'app-turn',toolCallId:'read',egressAllowlist:['*']} as never;
 expect(await app.read({name:'browse_page'} as never).handle(args,ctx)).toMatchObject({ok:true});
 expect(f.rows.get('common_owner_browser_registration_v1')).toEqual(pinned);expect(commonBrowserFixture.allocations).toBe(1);
 directory.owner='20000000-0000-0000-0000-000000000001';
 expect(await app.read({name:'browse_page'} as never).handle(args,ctx)).toMatchObject({ok:false});expect(commonBrowserFixture.allocations).toBe(1);
 app.stop();await app.maintain();expect(commonBrowserFixture.ends).toBe(1);
});

it('an app binding change while directory resolution waits prevents allocation',async()=>{
 const f=setup(),owner=appIdentity();f.rows.delete('telegram_subject');let entered!:()=>void,release!:()=>void;
 const reached=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const original=owner.identity.resolve;const identity={...owner.identity,resolve:async(binding:string)=>{entered();await gate;return original(binding);}};
 const pending=f.runtime(identity).read({name:'browse_page'} as never).handle({provider:'cloudflare_playwright',retain_session:true,url:'https://example.com/a',instruction:'Read'}, {authenticatedUserId:'owner',runScope:f.scope,turnId:'turn',toolCallId:'read',egressAllowlist:['*']} as never);
 await reached;owner.changeBinding();release();expect(await pending).toMatchObject({ok:false});expect(commonBrowserFixture.allocations).toBe(0);
});

it('automatically derives the registered browser owner from current directory authority, without a selected subject in operator policy', async () => {
  commonBrowserFixture.reset();
  const fixture = setup(), runtime = fixture.runtime(), fallback = vi.fn();
  const result = await runtime.read({ name: 'browse_page', handle: fallback } as never).handle({ provider: 'cloudflare_playwright', url: 'https://example.com/a', instruction: 'Read' }, { authenticatedUserId: 'authenticated-owner', turnId: 'turn', toolCallId: 'read', runScope: fixture.scope, egressAllowlist: ['*'] } as never);
  expect(result).toMatchObject({ ok: true, data: { text: expect.stringContaining('Option A costs 10') } });
  expect(commonBrowserFixture.allocations).toBe(1);
  expect(fallback).not.toHaveBeenCalled();
  await runtime.finish(fixture.scope);
  expect(commonBrowserFixture.ends).toBe(0);expect(commonBrowserFixture.pages).toHaveLength(1);
  expect(runtime.attachments(fixture.scope)).toHaveLength(0);
  expect(await runtime.read({name:'browse_page'} as never).handle({provider:'cloudflare_playwright',url:'https://example.com/a',instruction:'No renewed scope'}, {authenticatedUserId:'owner',runScope:fixture.scope,turnId:'idle',toolCallId:'idle'} as never)).toMatchObject({ok:false});
  expect(commonBrowserFixture.allocations).toBe(1);
  runtime.stop();await runtime.maintain();expect(commonBrowserFixture.ends).toBe(1);expect(commonBrowserFixture.pages).toHaveLength(0);
});

const request = (scope: RunEffectScope) => ({ runScope: scope, request: { model: WALDO_CHAT_MODEL, max_tokens: 16, system: 'Fixture', messages: [] }, route: { provider: 'openai', model: WALDO_CHAT_MODEL, cache: 'none', max_tokens: 16 }, step: { provider: 'openai', model: WALDO_CHAT_MODEL }, context: 'full_context', fallback_step: 'configured_model', headers: {} }) as unknown as LLMGatewayRequest;

const allocate = async (fixture: ReturnType<typeof setup>, runtime: ReturnType<ReturnType<typeof setup>['runtime']>) => {
  expect(await runtime.read({ name: 'browse_page' } as never).handle({ provider: 'cloudflare_playwright', url: 'https://example.com/a', instruction: 'Read' },
    { authenticatedUserId: 'owner', runScope: fixture.scope, turnId: 'funded-turn', toolCallId: 'funded-call', egressAllowlist: ['*'] } as never)).toMatchObject({ ok: true });
};
it('removing trial registration preserves ordinary model admission without resetting retained browser spend', async () => {
  const fixture = setup(), runtime = fixture.runtime(); await allocate(fixture, runtime);
  expect(await runtime.gateway()!.complete(request(fixture.scope))).toMatchObject({ ok: true });
  expect(provider.calls).toHaveLength(1); const retained = structuredClone([...fixture.rows]);
  fixture.env.COMMON_BROWSER_REGISTRATION = '';
  expect(await fixture.runtime().gateway()!.complete(request(fixture.scope))).toMatchObject({ok:true});
  expect(provider.calls).toHaveLength(2); expect([...fixture.rows]).toEqual(retained);
});
it('concurrent funded model calls share ordinals and reconstruction cannot refill exhausted allowance', async () => {
  const fixture = setup(); fixture.operator.spend.maxCalls = 20;
  fixture.env.COMMON_BROWSER_REGISTRATION = JSON.stringify(fixture.operator);
  const runtime = fixture.runtime(); await allocate(fixture, runtime);
  const ledger = [...fixture.rows].find(([key]) => key.startsWith('common-spend:'))![1];
  const callSlots = ledger.policy.maxCalls - ledger.calls.length - ledger.cleanup.reduce((sum: number, item: any) => sum + item.maxCalls, 0);
  expect(callSlots).toBeGreaterThanOrEqual(2); const gateway = runtime.gateway()!;
  expect(await Promise.all([gateway.complete(request(fixture.scope)), gateway.complete(request(fixture.scope))])).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
  const charged = [...fixture.rows].find(([key]) => key.startsWith('common-spend:'))![1].calls.filter((call: any) => call.id.startsWith('model:'));
  expect(charged).toHaveLength(2); expect(new Set(charged.map((call: any) => call.id)).size).toBe(2);
  expect(charged[0].upperBoundMicrousd).toBe(charged[1].upperBoundMicrousd);
  const slots = Math.min(callSlots, Math.floor((ledger.policy.limitMicrousd - ledger.reservedMicrousd) / charged[0].upperBoundMicrousd));
  expect(slots).toBeGreaterThanOrEqual(2);
  for (let issued = 2; issued < slots; issued++) expect(await gateway.complete(request(fixture.scope))).toMatchObject({ ok: true });
  await expect(gateway.complete(request(fixture.scope))).rejects.toThrow('limit');
  const retained = structuredClone([...fixture.rows]);
  await expect(fixture.runtime().gateway()!.complete(request(fixture.scope))).rejects.toThrow();
  fixture.operator.spend.maxCalls = 100; fixture.operator.policy.ref = 'fresh-looking-policy';
  fixture.env.COMMON_BROWSER_REGISTRATION = JSON.stringify(fixture.operator);
  await expect(fixture.runtime().gateway()!.complete(request(fixture.scope))).rejects.toThrow('reconciliation');
  expect(provider.calls).toHaveLength(slots); expect([...fixture.rows]).toEqual(retained);
});
it('unpriced models and missing, changed or unlinked authority cannot issue funded model calls', async () => {
  const fixture = setup(), runtime = fixture.runtime(); await allocate(fixture, runtime);
  const gateway = runtime.gateway()!, input = request(fixture.scope), original = structuredClone([...fixture.rows]);
  await expect(gateway.complete({ ...input, request: { ...input.request, model: 'unpriced-model' as never } })).rejects.toThrow('price unavailable');
  expect([...fixture.rows]).toEqual(original); directory.present = false;
  await expect(gateway.complete(input)).rejects.toThrow('authority unavailable'); expect(provider.calls).toHaveLength(0);
  directory.present = true; expect(await gateway.complete(input)).toMatchObject({ ok: true });
  const retained = structuredClone([...fixture.rows]); directory.custody = 'b'.repeat(64);
  await expect(gateway.complete(input)).rejects.toThrow('reconciliation'); expect([...fixture.rows]).toEqual(retained);
  fixture.rows.set('telegram_unlinked', true);
  await expect(gateway.complete(input)).rejects.toThrow('owner unavailable'); expect(provider.calls).toHaveLength(1);
});

it('cleanup survives registration removal and unlink without funding another session', async () => {
  const fixture = setup(), runtime = fixture.runtime();
  const args = { provider: 'cloudflare_playwright' as const, url: 'https://example.com/a', instruction: 'Read' };
  const ctx = { authenticatedUserId: 'owner', runScope: fixture.scope, turnId: 'turn', toolCallId: 'call', egressAllowlist: ['*'] } as never;
  expect(await runtime.read({ name: 'browse_page' } as never).handle(args, ctx)).toMatchObject({ ok: true });
  const ledger = structuredClone([...fixture.rows].find(([key]) => key.startsWith('common-spend:'))![1]);
  fixture.env.COMMON_BROWSER_REGISTRATION = ''; fixture.rows.set('telegram_unlinked', true);
  runtime.stop(); await fixture.runtime().maintain();
  expect(commonBrowserFixture.allocations).toBe(1); expect(commonBrowserFixture.ends).toBe(1);
  expect([...fixture.rows].find(([key]) => key.startsWith('common-spend:'))![1].reservedMicrousd).toBe(ledger.reservedMicrousd);
  expect(await fixture.runtime().read({ name: 'browse_page' } as never).handle(args, ctx)).toMatchObject({ ok: false });
});
it.each(['expired','unavailable'])('a changed retained ref cannot hide behind %s configuration',async kind=>{
 const fixture=setup(),runtime=fixture.runtime();await allocate(fixture,runtime);
 fixture.operator.policy.ref='changed-ref';
 if(kind==='expired'){fixture.operator.policy.expiresAt=Date.now()-1;fixture.operator.spend.validUntil=fixture.operator.policy.expiresAt;}else{delete (fixture.env as any).BROWSER;}
 fixture.env.COMMON_BROWSER_REGISTRATION=JSON.stringify(fixture.operator);const retained=structuredClone([...fixture.rows]);
 await expect(fixture.runtime().gateway()!.complete(request(fixture.scope))).rejects.toThrow('reconciliation');
 expect(await fixture.runtime().read({name:'browse_page'} as never).handle({provider:'cloudflare_playwright',url:'https://example.com/a',instruction:'Read'},{authenticatedUserId:'owner',runScope:fixture.scope,turnId:'new',toolCallId:'new',egressAllowlist:['*']} as never)).toMatchObject({ok:false});
 expect(provider.calls).toHaveLength(0);expect(commonBrowserFixture.allocations).toBe(1);expect([...fixture.rows]).toEqual(retained);
});

it('manual registration spend cannot be bypassed by switching to an automatic policy ref', async () => {
  const fixture = setup();
  commonSpendReservation(fixture.storage, { ref: 'manual-owner-policy', ownerId: `prn_${directory.owner.replaceAll('-', '')}`, validUntil: fixture.operator.spend.validUntil, limitMicrousd: 10000000, maxCalls: 100 }, Date.now, () => {}).reserve('already-reserved', 10000000);
  const retained = structuredClone([...fixture.rows]);
  expect(await fixture.runtime().read({ name: 'browse_page' } as never).handle({ provider: 'cloudflare_playwright', url: 'https://example.com/a', instruction: 'Read' }, { authenticatedUserId: 'owner', runScope: fixture.scope, turnId: 'turn', toolCallId: 'call', egressAllowlist: ['*'] } as never)).toMatchObject({ ok: false });
  expect(provider.calls).toHaveLength(0); expect(commonBrowserFixture.allocations).toBe(0);
  expect([...fixture.rows]).toEqual(retained);
});

it('an expired trial permits a normal accounted public read and ordinary model work without renewing registration', async () => {
  const fixture = setup();
  fixture.operator.policy.expiresAt = Date.now() - 1;
  fixture.operator.spend.validUntil = fixture.operator.policy.expiresAt;
  fixture.env.COMMON_BROWSER_REGISTRATION = JSON.stringify(fixture.operator);
  const runtime = fixture.runtime();
  expect(await runtime.gateway()!.complete(request(fixture.scope))).toMatchObject({ ok: true });
  expect(await runtime.read({ name: 'browse_page' } as never).handle({ provider: 'cloudflare_playwright', url: 'https://example.com/a', instruction: 'Read' }, { authenticatedUserId: 'owner', runScope: fixture.scope, turnId: 'turn', toolCallId: 'call', egressAllowlist: ['*'] } as never)).toMatchObject({ ok: true });
  expect(provider.calls).toHaveLength(1); expect(commonBrowserFixture.allocations).toBe(1);expect(commonBrowserFixture.ends).toBe(1);
  expect(fixture.rows.get('owner-public-browser-spend:v2').reservedMicrousd).toBeLessThanOrEqual(1250);
  expect(fixture.rows.get('owner-public-browser-spend:v2').reservations[0].settled).toBe(true);
  expect(fixture.rows.has('common_owner_browser_registration_v1')).toBe(false);
});

it('a malformed operator update denies new work but cannot strand retained funded cleanup', async () => {
  const fixture = setup(), runtime = fixture.runtime();
  expect(await runtime.read({ name: 'browse_page' } as never).handle({ provider: 'cloudflare_playwright', url: 'https://example.com/a', instruction: 'Read' }, { authenticatedUserId: 'owner', runScope: fixture.scope, turnId: 'turn', toolCallId: 'call', egressAllowlist: ['*'] } as never)).toMatchObject({ ok: true });
  fixture.env.COMMON_BROWSER_REGISTRATION = '{invalid';
  expect(() => fixture.runtime()).not.toThrow();
  await expect(fixture.runtime().gateway()!.complete(request(fixture.scope))).rejects.toThrow();
  runtime.stop(); await fixture.runtime().maintain();
  expect(commonBrowserFixture.allocations).toBe(1); expect(commonBrowserFixture.ends).toBe(1);
  expect(provider.calls).toHaveLength(0);
});

it('meters a browser allocation created while ordinary model authority is pending', async () => {
  const fixture = setup(), runtime = fixture.runtime();
  let release!: () => void;
  const entered = new Promise<void>(resolve => { directory.entered = resolve; });
  directory.wait = new Promise<void>(resolve => { release = resolve; });
  const model = runtime.gateway()!.complete(request(fixture.scope));
  await entered;
  await allocate(fixture, runtime);
  release();
  expect(await model).toMatchObject({ ok: true });
  const ledger = [...fixture.rows].find(([key]) => key.startsWith('common-spend:'))![1];
  expect(ledger.calls.filter((call: any) => call.id.startsWith('model:'))).toHaveLength(1);
  expect(provider.calls).toHaveLength(1);
});

it('a retained browser does not meter an unrelated run without explicit browser admission',async()=>{
 const f=setup(),runtime=f.runtime();await allocate(f,runtime);await runtime.finish(f.scope);
 const before=structuredClone([...f.rows].find(([key])=>key.startsWith('common-spend:'))![1]);
 const unrelated={...f.scope,runId:crypto.randomUUID(),attempt:crypto.randomUUID()};f.activate(unrelated);
 expect(await runtime.gateway()!.complete(request(unrelated))).toMatchObject({ok:true});
 expect([...f.rows].find(([key])=>key.startsWith('common-spend:'))![1]).toEqual(before);
 expect(f.rows.get(`common-browser-run:${unrelated.runId}`)).toBeUndefined();
 runtime.stop();await runtime.maintain();expect(commonBrowserFixture.ends).toBe(1);
});


it.each(['automatic','manual'])('historical %s registration cleanup survives the lower admission cap without new funding',async kind=>{
 const f=setup();
 if(kind==='manual')f.env.COMMON_BROWSER_REGISTRATION=JSON.stringify({policy:{...f.operator.policy,doName:'automatic-owner',subject:'81101',directoryOwnerId:directory.owner},spend:f.operator.spend,billing:f.operator.billing});
 const runtime=f.runtime();await allocate(f,runtime);
 // Model a retained registration written when the parser accepted $20.
 const descriptor=JSON.parse(f.env.COMMON_BROWSER_REGISTRATION);descriptor.spend.limitMicrousd=20_000_000;
 f.env.COMMON_BROWSER_REGISTRATION=JSON.stringify(descriptor);
 const pinned=f.rows.get('common_owner_browser_registration_v1');
 if(pinned){pinned.operator=f.env.COMMON_BROWSER_REGISTRATION;pinned.registration.spend.limitMicrousd=20_000_000;}
 const ledger=[...f.rows].find(([key])=>key.startsWith('common-spend:'))![1];ledger.policy.limitMicrousd=20_000_000;
 const before=structuredClone([...f.rows]),reserved=ledger.reservedMicrousd;
 expect(await f.runtime().read({name:'browse_page'} as never).handle({provider:'cloudflare_playwright',url:'https://example.com/a',instruction:'Read'},{authenticatedUserId:'owner',runScope:f.scope,turnId:'new',toolCallId:'new',egressAllowlist:['*']} as never)).toMatchObject({ok:false});
 expect([...f.rows]).toEqual(before);expect(commonBrowserFixture.allocations).toBe(1);
 runtime.stop();await f.runtime().maintain();
 expect(commonBrowserFixture.ends).toBe(1);expect(commonBrowserFixture.allocations).toBe(1);expect(provider.calls).toHaveLength(0);
 expect([...f.rows].find(([key])=>key.startsWith('common-spend:'))![1].reservedMicrousd).toBe(reserved);
});


async function expiredHistoricalRegistration(kind:string,limitMicrousd=17_910_000){
 const f=setup();
 if(kind==='manual')f.env.COMMON_BROWSER_REGISTRATION=JSON.stringify({policy:{...f.operator.policy,doName:'automatic-owner',subject:'81101',directoryOwnerId:directory.owner},spend:f.operator.spend,billing:f.operator.billing});
 const runtime=f.runtime();await allocate(f,runtime);
 const descriptor=JSON.parse(f.env.COMMON_BROWSER_REGISTRATION);descriptor.spend.limitMicrousd=limitMicrousd;
 f.env.COMMON_BROWSER_REGISTRATION=JSON.stringify(descriptor);
 const pinned=f.rows.get('common_owner_browser_registration_v1');
 if(pinned){pinned.operator=f.env.COMMON_BROWSER_REGISTRATION;pinned.registration.spend.limitMicrousd=limitMicrousd;}
 const ledger=[...f.rows].find(([key])=>key.startsWith('common-spend:'))![1];ledger.policy.limitMicrousd=limitMicrousd;
 const retainedCharge=ledger.reservedMicrousd;runtime.stop();await f.runtime().maintain();
 expect(commonBrowserFixture.allocations).toBe(1);expect(commonBrowserFixture.ends).toBe(1);expect([...f.rows].find(([key])=>key.startsWith('common-spend:'))![1].reservedMicrousd).toBe(retainedCharge);
 let clock=f.operator.policy.expiresAt+1;vi.spyOn(Date,'now').mockImplementation(()=>clock);
 const scope={...f.scope,runId:crypto.randomUUID(),attempt:crypto.randomUUID(),deadline:clock+60000};f.activate(scope);
 const read=(id='normal')=>f.runtime().read({name:'browse_page'} as never).handle({provider:'cloudflare_playwright',url:'https://example.com/a',instruction:'Read'},{authenticatedUserId:'owner',runScope:scope,turnId:'normal',toolCallId:id,egressAllowlist:['*']} as never);
 return {f,read,advance:(ms:number)=>{clock+=ms;}};
}
it.each([['automatic',17_910_000],['manual',17_910_000],['automatic',8_000_000],['manual',8_000_000]] as const)('expired %s %i declaration admits a normal read at the effective cap without changing history',async(kind,limit)=>{
 const {f,read,advance}=await expiredHistoricalRegistration(kind,limit),before=structuredClone([...f.rows]),descriptor=f.env.COMMON_BROWSER_REGISTRATION;
 const month=`common-public-browser-month:${new Date().toISOString().slice(0,7)}`,priorMonth=f.rows.get(month),effective=Math.min(limit,10_000_000);
 commonBrowserFixture.onAcquire=()=>{expect(f.rows.get('owner-public-browser-spend:v2')).toMatchObject({limitMicrousd:effective,reservedMicrousd:1250});expect(f.rows.get(month)).toBe(priorMonth+1250);advance(4000);};
 expect(await read()).toMatchObject({ok:true,data:{provider:'cloudflare_playwright',data:{text:expect.stringContaining('Option A costs 10')}}});
 expect(commonBrowserFixture.allocations).toBe(2);expect(commonBrowserFixture.ends).toBe(2);expect(provider.calls).toHaveLength(0);
 expect(f.rows.get('owner-public-browser-spend:v2')).toMatchObject({limitMicrousd:effective,reservedMicrousd:100});
 for(const [key,value] of before)if(key!==month)expect(f.rows.get(key)).toEqual(value);
 expect(f.rows.get(month)).toBe(priorMonth+100);expect(f.env.COMMON_BROWSER_REGISTRATION).toBe(descriptor);
});
it.each(['automatic','manual'])('expired %s historical spend cannot exceed ten dollars after descriptor removal',async kind=>{
 const {f,read}=await expiredHistoricalRegistration(kind);
 expect(await read()).toMatchObject({ok:true});f.env.COMMON_BROWSER_REGISTRATION='';
 const ledger=[...f.rows].find(([key])=>key.startsWith('common-spend:'))![1],extra=9_998_751-ledger.reservedMicrousd;
 ledger.calls.push({id:'older-model',upperBoundMicrousd:extra});ledger.reservedMicrousd+=extra;
 const before=structuredClone([...f.rows]);expect(await read('later')).toMatchObject({ok:false});
 expect([...f.rows]).toEqual(before);expect(commonBrowserFixture.allocations).toBe(2);
});
it.each([['automatic','live'],['manual','live'],['automatic','future'],['manual','future']])('new %s %s declaration above ten dollars remains rejected',async(kind,state)=>{
 const f=setup();f.operator.spend.limitMicrousd=17_910_000;
 if(state==='future'){f.operator.policy.createdAt+=120000;f.operator.policy.expiresAt+=180000;f.operator.spend.validUntil=f.operator.policy.expiresAt;}
 f.env.COMMON_BROWSER_REGISTRATION=JSON.stringify(kind==='automatic'?f.operator:{policy:{...f.operator.policy,doName:'automatic-owner',subject:'81101',directoryOwnerId:directory.owner},spend:f.operator.spend,billing:f.operator.billing});
 const before=structuredClone([...f.rows]);
 expect(await f.runtime().read({name:'browse_page'} as never).handle({provider:'cloudflare_playwright',url:'https://example.com/a',instruction:'Read'},{authenticatedUserId:'owner',runScope:f.scope,turnId:'new',toolCallId:'new',egressAllowlist:['*']} as never)).toMatchObject({ok:false});
 expect([...f.rows]).toEqual(before);expect(commonBrowserFixture.allocations).toBe(0);expect(provider.calls).toHaveLength(0);
});
it.each([['automatic','pin'],['automatic','owner'],['automatic','custody'],['manual','owner'],['manual','custody']])('expired historical %s declaration cannot hide changed %s',async(mode,kind)=>{
 const {f,read}=await expiredHistoricalRegistration(mode);
 if(kind==='pin'){const descriptor=JSON.parse(f.env.COMMON_BROWSER_REGISTRATION);descriptor.spend.limitMicrousd=10_000_000;f.env.COMMON_BROWSER_REGISTRATION=JSON.stringify(descriptor);}
 if(kind==='owner')directory.owner='10000000-0000-0000-0000-000000000002';
 if(kind==='custody')directory.custody='b'.repeat(64);
 const before=structuredClone([...f.rows]);expect(await read()).toMatchObject({ok:false});expect([...f.rows]).toEqual(before);expect(commonBrowserFixture.allocations).toBe(1);
});


it('the canonical physical factory preserves one app-originated paid session across linking and unlinking surfaces',async()=>{
 const f=setup();f.rows.delete('telegram_subject');directory.present=false;
 let admittedOwner=directory.owner,live=true;
 const identity=canonicalOwnerBrowserIdentity({env:f.env as never,storage:f.storage,actualDoId:'physical-owner',snapshot:()=>({directoryOwnerId:admittedOwner,doName:'automatic-owner'}),assertCurrent:async(expected)=>{if(!live||expected.directoryOwnerId!==admittedOwner)throw Error('canonical owner revoked');}});
 const runtime=f.runtime(identity),ctx={authenticatedUserId:'server-owner',runScope:f.scope,turnId:'app-first',toolCallId:'read',egressAllowlist:['*']} as never;
 const first=await runtime.read({name:'browse_page'} as never).handle({provider:'cloudflare_playwright',retain_session:true,url:'https://example.com/a',instruction:'Use my app browser'},ctx) as any;
 expect(first).toMatchObject({ok:true,data:{session_handle:expect.any(String)}});
 const handle=first.data.session_handle,pinned=structuredClone(f.rows.get('common_owner_browser_registration_v1'));
 await runtime.finish(f.scope);f.rows.set('telegram_subject','81101');f.rows.set('whatsapp_subject','919000000001');
 const second={...f.scope,runId:crypto.randomUUID(),attempt:crypto.randomUUID()};f.activate(second);
 expect(await runtime.read({name:'browse_page'} as never).handle({provider:'cloudflare_playwright',session_handle:handle,url:'https://example.com/a',instruction:'Continue from my linked surface'},{...ctx as object,runScope:second,turnId:'linked-second',toolCallId:'read'} as never)).toMatchObject({ok:true,data:{session_handle:handle}});
 await runtime.finish(second);f.rows.delete('telegram_subject');f.rows.set('telegram_unlinked',true);f.rows.delete('whatsapp_subject');
 const third={...f.scope,runId:crypto.randomUUID(),attempt:crypto.randomUUID()};f.activate(third);
 expect(await runtime.act({name:'browse_act'} as never).handle({provider:'cloudflare_playwright',session_handle:handle,url:'https://example.com/a',task:'Inspect after unlink',max_actions:1,command:{operation:'inspect'}},{...ctx as object,runScope:third,turnId:'app-third',toolCallId:'inspect'} as never)).toMatchObject({ok:true});
 expect(f.rows.get('common_owner_browser_registration_v1')).toEqual(pinned);expect(commonBrowserFixture.allocations).toBe(1);
 admittedOwner='20000000-0000-0000-0000-000000000001';
 expect(await runtime.read({name:'browse_page'} as never).handle({provider:'cloudflare_playwright',session_handle:handle,url:'https://example.com/a',instruction:'Foreign owner access'},{...ctx as object,runScope:third} as never)).toMatchObject({ok:false});
 expect(commonBrowserFixture.allocations).toBe(1);live=false;runtime.stop();await runtime.maintain();expect(commonBrowserFixture.ends).toBe(1);
});
