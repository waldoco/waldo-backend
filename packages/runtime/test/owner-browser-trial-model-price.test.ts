import { expect, it, vi } from 'vitest';
import { OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_LUNA_MODEL } from '@waldo/contracts';
import { ownerBrowserRuntime } from '../src/channels/owner-browser-runtime';
import { configureCommonPublicBrowser } from '../src/channels/common-public-browser-configuration';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
const complete = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('../src/llm/openai', () => ({ OpenAIResponsesAdapter: class { complete = complete; } }));
vi.mock('../src/identity/common-owner-authority', () => ({ commonOwnerAuthority: () => ({ resolve: async () => ({ directoryOwnerId: '10000000-0000-0000-0000-000000000004', custodyDigest: 'c'.repeat(64) }) }) }));

// The manual trial meters a funded run's model calls with a Luna price envelope, so it refuses any other model before
// the meter takes an ordinal or a reservation.
it('a funded run under a live manual trial meters Luna and refuses Sol before the meter', async () => {
  const rows = new Map<string, any>([['do_name', 'trial-owner'], ['telegram_subject', '81104'], ['common-browser:funded-run', { allocation: 'observed' }]]);
  const storage = { kv: { get: (key: string) => rows.get(key), put: (key: string, value: unknown) => rows.set(key, structuredClone(value)), list: ({ prefix }: { prefix: string }) => [...rows].filter(([key]) => key.startsWith(prefix)) }, transactionSync: <T>(work: () => T) => work(), getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} } as never;
  const now = Date.now(), ownerId = 'prn_10000000000000000000000000000004';
  configureCommonPublicBrowser({ ref: 'trial-policy', doName: 'trial-owner', subject: '81104', directoryOwnerId: '10000000-0000-0000-0000-000000000004', createdAt: now - 1000, expiresAt: now + 60000, allowedOrigins: ['*'], maxAllocations: 1, maxReservedBrowserMs: 120000, lifetimeMs: 60000, maxScreenshotBytes: 1000 } as never, (() => undefined) as never,
    { policy: { ref: 'trial-policy', ownerId, validUntil: now + 60000, limitMicrousd: 10000, maxCalls: 100 }, quote: (kind: string) => kind === 'browser' ? 0 : 1, allocationMicrousd: 100 });
  const env = { WALDO_ENVIRONMENT: 'staging', OPENAI_API_KEY: 'k', BROWSER: { fetch: async () => new Response('{}') }, OWNER_DO: { idFromName: () => ({ toString: () => 'physical-owner' }) } } as never;
  const scope: RunEffectScope = { runId: 'funded-run', attempt: 'a1', deadline: now + 60000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() };
  const gateway = ownerBrowserRuntime({ env, storage, actualDoId: 'physical-owner', activeScope: () => scope }).gateway()!;
  const before = structuredClone([...rows]);
  await expect(gateway.complete({ runScope: scope, request: { model: OPENAI_GPT_6_1_SOL_MODEL, max_tokens: 16 } } as never)).rejects.toThrow('browser trial model price unavailable');
  expect(complete).not.toHaveBeenCalled();
  expect([...rows]).toEqual(before);
  await expect(gateway.complete({ runScope: scope, request: { model: OPENAI_GPT_6_LUNA_MODEL, max_tokens: 16 } } as never)).resolves.toEqual({ ok: true });
  expect(complete).toHaveBeenCalledTimes(1);
  expect([...rows].some(([key]) => key.startsWith('common-spend:'))).toBe(true);
});
