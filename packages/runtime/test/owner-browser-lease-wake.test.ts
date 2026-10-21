import { expect, it, vi } from 'vitest';
import { COMMON_BROWSER_LEASE_DUE, ownerBrowserRuntime } from '../src/channels/owner-browser-runtime';
import { commonPublicBrowserConfigured, configureCommonPublicBrowser } from '../src/channels/common-public-browser-configuration';
import { commonBrowserFixture, commonBrowserMeteredFixtureLoader } from './fixtures/common-browser-sdk';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
vi.mock('../src/identity/common-owner-authority', () => ({ commonOwnerAuthority: () => ({ resolve: async () => ({ directoryOwnerId: '10000000-0000-0000-0000-000000000002', custodyDigest: 'b'.repeat(64) }) }) }));

// A public read under a run admits a browser lease.
const admitLease = async () => {
 commonBrowserFixture.reset();
 const rows = new Map<string, any>([['do_name', 'runtime-owner'], ['telegram_subject', '81102']]);
 let alarm: number | null = null;
 const storage = { kv: { get: (key: string) => rows.get(key), put: (key: string, value: unknown) => rows.set(key, structuredClone(value)), list: ({prefix}: {prefix: string}) => [...rows].filter(([key]) => key.startsWith(prefix)) }, transactionSync: <T>(work: () => T) => work(), getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; } } as unknown as DurableObjectStorage;
 const now = Date.now(), ownerId = 'prn_10000000000000000000000000000002';
 if (!commonPublicBrowserConfigured()) configureCommonPublicBrowser({ ref: 'runtime-policy', doName: 'runtime-owner', subject: '81102', directoryOwnerId: '10000000-0000-0000-0000-000000000002', createdAt: now - 1, expiresAt: now + 60000, allowedOrigins: ['*'], maxAllocations: 1, maxReservedBrowserMs: 120000, lifetimeMs: 60000, maxScreenshotBytes: 1024 }, commonBrowserMeteredFixtureLoader,
  { policy: { ref: 'runtime-policy', ownerId, validUntil: now + 60000, limitMicrousd: 10000, maxCalls: 100 }, quote: kind => kind === 'browser' ? 0 : 1, allocationMicrousd: 100 });
 const env = { WALDO_ENVIRONMENT: 'staging', BROWSER: { fetch: vi.fn(async () => new Response('{}')) }, OWNER_DO: { idFromName: (name: string) => ({ toString: () => name === 'runtime-owner' ? 'physical-owner' : 'foreign' }) } } as never;
 const scope: RunEffectScope = { runId: 'lease-run', attempt: 'lease-run', deadline: now + 30000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() };
 const runtime = ownerBrowserRuntime({ env, storage, actualDoId: 'physical-owner', activeScope: () => scope });
 const ctx = { authenticatedUserId: ownerId, turnId: 'lease-turn', toolCallId: 'lease-call', runScope: { ...scope }, egressAllowlist: ['*'] } as never;
 expect(await runtime.read({ name: 'browse_page', handle: vi.fn() } as never).handle({ url: 'https://example.com/a', instruction: 'Read page' }, ctx)).toMatchObject({ ok: true });
 return { rows, runtime, scope, armed: () => alarm };
};

// A run's browser lease wake is a listed due key, so an arbiter re-arm keeps it and its end clears it.
it('a run lease writes its wake as a listed due key, the one it arms, and its end clears it', async () => {
 const { rows, runtime, scope, armed } = await admitLease();
 expect(rows.get(COMMON_BROWSER_LEASE_DUE)).toBe(scope.deadline);
 expect(armed()).toBe(scope.deadline);
 await runtime.finish(scope);
 expect(rows.get(COMMON_BROWSER_LEASE_DUE)).toBeNull();
});

// The lease wake comes before the run's deadline when the browser configuration or the session lifetime ends first.
it('maintenance moves a passed lease wake to a live lease\'s deadline, and clears it once that deadline has passed', async () => {
 const { rows, runtime, scope } = await admitLease();
 rows.set(COMMON_BROWSER_LEASE_DUE, Date.now() - 1);
 await runtime.maintain();
 expect(rows.get(COMMON_BROWSER_LEASE_DUE)).toBe(scope.deadline);
 const clock = vi.spyOn(Date, 'now').mockReturnValue(scope.deadline + 1);
 try { await runtime.maintain(); } finally { clock.mockRestore(); }
 expect(rows.get(COMMON_BROWSER_LEASE_DUE)).toBeNull();
});
