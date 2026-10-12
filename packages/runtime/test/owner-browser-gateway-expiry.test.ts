import { expect, it, vi } from 'vitest';
import { ownerBrowserRuntime } from '../src/channels/owner-browser-runtime';
import { configureCommonPublicBrowser } from '../src/channels/common-public-browser-configuration';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
const complete = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('../src/llm/openai', () => ({ OpenAIResponsesAdapter: class { complete = complete; } }));
vi.mock('../src/identity/common-owner-authority', () => ({ commonOwnerAuthority: () => ({ resolve: async () => ({ directoryOwnerId: '10000000-0000-0000-0000-000000000002', custodyDigest: 'b'.repeat(64) }) }) }));
it('an expired browser registration does not block an ordinary model call', async () => {
  const rows = new Map<string, any>([['do_name', 'expiry-owner'], ['telegram_subject', '81103']]);
  const storage = { kv: { get: (key: string) => rows.get(key), put: (key: string, value: unknown) => rows.set(key, structuredClone(value)), list: ({ prefix }: { prefix: string }) => [...rows].filter(([key]) => key.startsWith(prefix)) }, transactionSync: <T>(work: () => T) => work(), getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} } as never;
  const now = Date.now(), ownerId = 'prn_10000000000000000000000000000002';
  configureCommonPublicBrowser({ ref: 'expiry-policy', doName: 'expiry-owner', subject: '81103', directoryOwnerId: '10000000-0000-0000-0000-000000000002', createdAt: now - 120000, expiresAt: now - 60000, allowedOrigins: ['*'], maxAllocations: 1, maxReservedBrowserMs: 120000, lifetimeMs: 60000, maxScreenshotBytes: 1000 } as never, (() => undefined) as never,
    { policy: { ref: 'expiry-policy', ownerId, validUntil: now - 60000, limitMicrousd: 10000, maxCalls: 100 }, quote: (kind: string) => kind === 'browser' ? 0 : 1, allocationMicrousd: 100 });
  const env = { WALDO_ENVIRONMENT: 'staging', OPENAI_API_KEY: 'k', BROWSER: { fetch: async () => new Response('{}') }, TELEGRAM_OWNER_DO: { idFromName: () => ({ toString: () => 'physical-owner' }) } } as never;
  const scope: RunEffectScope = { runId: 'r1', attempt: 'a1', deadline: now + 60000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() };
  const runtime = ownerBrowserRuntime({ env, storage, actualDoId: 'physical-owner', activeScope: () => scope });
  const gateway = runtime.gateway();
  expect(gateway).toBeDefined(); const reply = gateway ? await gateway.complete({ runScope: scope } as never) : { ok: true };
  expect(reply).toEqual({ ok: true });
  expect(complete).toHaveBeenCalledTimes(1);
});
