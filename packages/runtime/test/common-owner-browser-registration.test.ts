import { beforeEach, expect, it, vi } from 'vitest';
import { ownerBrowserRuntime } from '../src/channels/owner-browser-runtime';
import { registerCommonBrowserSdk } from '../src/channels/common-staging-registration';
import { commonBrowserFixture, commonBrowserMeteredFixtureLoader } from './fixtures/common-browser-sdk';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { commonSpendReservation } from '../src/channels/common-spend-reservation';

const directory = vi.hoisted(() => ({ owner: '10000000-0000-0000-0000-000000000001', custody: 'a'.repeat(64), present: true }));
const provider = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: unknown) => { provider.calls.push(input); return { id: 'fake-response', output: [], output_text: 'Read complete.', usage: { input_tokens: 1, output_tokens: 1 } }; } }; } }));
vi.mock('../src/identity/common-owner-authority', () => ({ commonOwnerAuthority: () => ({ resolve: async (_provider: string, subject: string, doName: string) => directory.present ? { directoryOwnerId: directory.owner, custodyDigest: directory.custody, subject, doName } : null }) }));
registerCommonBrowserSdk(commonBrowserMeteredFixtureLoader);
beforeEach(() => { directory.owner = '10000000-0000-0000-0000-000000000001'; directory.custody = 'a'.repeat(64); directory.present = true; provider.calls = []; commonBrowserFixture.reset(); });
const setup = () => {
  const rows = new Map<string, any>([['do_name', 'automatic-owner'], ['telegram_subject', '81101']]);
  let alarm: number | null = null;
  const storage = { kv: { get: (key: string) => rows.get(key), put: (key: string, value: unknown) => rows.set(key, structuredClone(value)), list: ({ prefix }: { prefix: string }) => [...rows].filter(([key]) => key.startsWith(prefix)) }, transactionSync: <T>(work: () => T) => work(), getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; } } as unknown as DurableObjectStorage;
  const now = Date.now();
  const operator = { scope: 'verified_owners', policy: { ref: 'automatic-test', createdAt: now - 1000, expiresAt: now + 60000, allowedOrigins: ['*'], maxAllocations: 1, maxReservedBrowserMs: 120000, lifetimeMs: 60000, maxScreenshotBytes: 1024 }, billing: { cloudflareAccountId: 'a'.repeat(32), conservativeWorstCase: true }, spend: { limitMicrousd: 10000000, maxCalls: 100, validUntil: now + 60000 } };
  const binding = { fetch: vi.fn(async () => new Response('{}')) };
  const env = { WALDO_ENVIRONMENT: 'staging', COMMON_BROWSER_REGISTRATION: JSON.stringify(operator), OPENAI_API_KEY: 'synthetic-model-key', BROWSER: binding, TELEGRAM_OWNER_DO: { idFromName: (name: string) => ({ toString: () => name === 'automatic-owner' ? 'physical-owner' : 'foreign' }) } };
  const scope: RunEffectScope = { runId: crypto.randomUUID(), attempt: crypto.randomUUID(), deadline: now + 60000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() };
  const runtime = () => ownerBrowserRuntime({ env: env as never, storage, actualDoId: 'physical-owner', activeScope: () => scope });
  return { rows, storage, operator, binding, env, scope, runtime };
};

it('automatically derives the registered browser owner from current directory authority, without a selected subject in operator policy', async () => {
  commonBrowserFixture.reset();
  const fixture = setup(), runtime = fixture.runtime(), fallback = vi.fn();
  const result = await runtime.read({ name: 'browse_page', handle: fallback } as never).handle({ provider: 'cloudflare_playwright', url: 'https://example.com/a', instruction: 'Read' }, { authenticatedUserId: 'authenticated-owner', turnId: 'turn', toolCallId: 'read', runScope: fixture.scope, egressAllowlist: ['*'] } as never);
  expect(result).toMatchObject({ ok: true, data: { text: expect.stringContaining('Option A costs 10') } });
  expect(commonBrowserFixture.allocations).toBe(1);
  expect(fallback).not.toHaveBeenCalled();
  await runtime.finish(fixture.scope);
  expect(commonBrowserFixture.ends).toBe(1);
});

const request = (scope: RunEffectScope) => ({ runScope: scope, request: { model: WALDO_CHAT_MODEL, max_tokens: 16, system: 'Fixture', messages: [] }, route: { provider: 'openai', model: WALDO_CHAT_MODEL, cache: 'none', max_tokens: 16 }, step: { provider: 'openai', model: WALDO_CHAT_MODEL }, context: 'full_context', fallback_step: 'configured_model', headers: {} }) as unknown as LLMGatewayRequest;

it('removing automatic registration keeps the selected owner fail closed before any new model I/O', async () => {
  provider.calls = [];
  const fixture = setup(), gateway = fixture.runtime().gateway()!;
  expect(await gateway.complete(request(fixture.scope))).toMatchObject({ ok: true });
  expect(provider.calls).toHaveLength(1);
  const retained = structuredClone([...fixture.rows]);
  fixture.env.COMMON_BROWSER_REGISTRATION = '';
  const reconstructed = fixture.runtime().gateway();
  expect(reconstructed).toBeDefined();
  await expect(reconstructed!.complete(request(fixture.scope))).rejects.toThrow();
  expect(provider.calls).toHaveLength(1);
  expect([...fixture.rows]).toEqual(retained);
});

it('concurrent first model calls share physical ordinals and reconstruction cannot replay or refill an exhausted allowance', async () => {
  const fixture = setup(); fixture.operator.spend.maxCalls = 2;
  fixture.env.COMMON_BROWSER_REGISTRATION = JSON.stringify(fixture.operator);
  const gateway = fixture.runtime().gateway()!;
  expect(await Promise.all([gateway.complete(request(fixture.scope)), gateway.complete(request(fixture.scope))])).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
  expect(provider.calls).toHaveLength(2);
  await expect(gateway.complete(request(fixture.scope))).rejects.toThrow('call limit');
  const retained = structuredClone([...fixture.rows]);
  await expect(fixture.runtime().gateway()!.complete(request(fixture.scope))).rejects.toThrow();
  fixture.operator.spend.maxCalls = 100; fixture.operator.policy.ref = 'fresh-looking-policy';
  fixture.env.COMMON_BROWSER_REGISTRATION = JSON.stringify(fixture.operator);
  await expect(fixture.runtime().gateway()!.complete(request(fixture.scope))).rejects.toThrow('reconciliation');
  expect(provider.calls).toHaveLength(2); expect([...fixture.rows]).toEqual(retained);
});

it('unpriced models and missing, changed or unlinked directory authority cannot issue a model call', async () => {
  const fixture = setup(), gateway = fixture.runtime().gateway()!;
  const input = request(fixture.scope);
  await expect(gateway.complete({ ...input, request: { ...input.request, model: 'unpriced-model' as never } })).rejects.toThrow('price unavailable');
  expect(fixture.rows.has('common_owner_browser_registration_v1')).toBe(false);
  directory.present = false;
  await expect(gateway.complete(input)).rejects.toThrow('authority unavailable');
  expect(provider.calls).toHaveLength(0);
  directory.present = true;
  expect(await gateway.complete(input)).toMatchObject({ ok: true });
  const retained = structuredClone([...fixture.rows]);
  directory.custody = 'b'.repeat(64);
  await expect(gateway.complete(input)).rejects.toThrow('reconciliation');
  expect([...fixture.rows]).toEqual(retained);
  fixture.rows.set('telegram_unlinked', true);
  await expect(gateway.complete(input)).rejects.toThrow('owner unavailable');
  expect(provider.calls).toHaveLength(1);
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

it('manual registration spend cannot be bypassed by switching to an automatic policy ref', async () => {
  const fixture = setup();
  commonSpendReservation(fixture.storage, { ref: 'manual-owner-policy', ownerId: `prn_${directory.owner.replaceAll('-', '')}`, validUntil: fixture.operator.spend.validUntil, limitMicrousd: 10000000, maxCalls: 100 }, Date.now, () => {}).reserve('already-reserved', 10000000);
  const retained = structuredClone([...fixture.rows]);
  await expect(fixture.runtime().gateway()!.complete(request(fixture.scope))).rejects.toThrow('reconciliation');
  expect(provider.calls).toHaveLength(0); expect(commonBrowserFixture.allocations).toBe(0);
  expect([...fixture.rows]).toEqual(retained);
});

it('an expired operator window cannot poison owner admission or issue a model call', async () => {
  const fixture = setup();
  fixture.operator.policy.expiresAt = Date.now() - 1;
  fixture.operator.spend.validUntil = fixture.operator.policy.expiresAt;
  fixture.env.COMMON_BROWSER_REGISTRATION = JSON.stringify(fixture.operator);
  await expect(fixture.runtime().gateway()!.complete(request(fixture.scope))).rejects.toThrow();
  expect(provider.calls).toHaveLength(0);
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
