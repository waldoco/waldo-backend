import { beforeEach, expect, it, vi } from 'vitest';
import { ownerBrowserRuntime } from '../src/channels/owner-browser-runtime';
import { registerCommonBrowserSdk } from '../src/channels/common-staging-registration';
import { commonBrowserFixture, commonBrowserMeteredFixtureLoader } from './fixtures/common-browser-sdk';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { commonSpendReservation } from '../src/channels/common-spend-reservation';

const directory = vi.hoisted(() => ({ owner: '10000000-0000-0000-0000-000000000001', custody: 'a'.repeat(64), present: true, wait: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }));
const provider = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: unknown) => { provider.calls.push(input); return { id: 'fake-response', output: [], output_text: 'Read complete.', usage: { input_tokens: 1, output_tokens: 1 } }; } }; } }));
vi.mock('../src/identity/common-owner-authority', () => ({ commonOwnerAuthority: () => ({ resolve: async (_provider: string, subject: string, doName: string) => { const wait = directory.wait; directory.wait = undefined; if (wait) { directory.entered?.(); await wait; } return directory.present ? { directoryOwnerId: directory.owner, custodyDigest: directory.custody, subject, doName } : null; } }) }));
registerCommonBrowserSdk(commonBrowserMeteredFixtureLoader);
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
  const runtime = () => ownerBrowserRuntime({ env: env as never, storage, actualDoId: 'physical-owner', activeScope: () => activeScope });
  return { rows, storage, operator, binding, env, scope, runtime,activate:(next:RunEffectScope)=>{activeScope=next;} };
};

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
