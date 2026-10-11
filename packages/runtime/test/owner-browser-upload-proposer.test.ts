import { expect, it, vi } from 'vitest';
import { ownerBrowserRuntime } from '../src/channels/owner-browser-runtime';
import { configureCommonPublicBrowser } from '../src/channels/common-public-browser-configuration';
import { commonBrowserMeteredFixtureLoader } from './fixtures/common-browser-sdk';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
vi.mock('../src/identity/common-owner-authority', () => ({ commonOwnerAuthority: () => ({ resolve: async () => ({ directoryOwnerId: '10000000-0000-0000-0000-000000000002', custodyDigest: 'b'.repeat(64) }) }) }));
// The host stands in for the retained browser: an upload command asks its
// configured proposer for the approval card, the way the real host does.
vi.mock('../src/channels/common-browser-host', async load => ({
  ...await load<typeof import('../src/channels/common-browser-host')>(),
  commonBrowserHost: (options: { proposeUpload?: (proposal: unknown, ctx: unknown) => Promise<string> }) => ({
    handler: { handle: async () => ({ ok: true, data: {}, source_taint: 'external' }) },
    actionHandler: { handle: async (_args: unknown, ctx: unknown) => {
      if (!options.proposeUpload) throw Error('upload unavailable');
      return { ok: true, data: { proposal_id: await options.proposeUpload({ url: 'https://example.com/form' }, ctx) }, source_taint: 'external' };
    } },
    sessionHandle: () => undefined, attachments: () => [], resetAttachments: () => {},
    cancel: async () => {}, maintainHandoff: async () => {},
  }),
}));

it('an upload card goes to the surface whose turn asked for it, whichever surface set up last', async () => {
  const rows = new Map<string, unknown>([['do_name', 'runtime-owner'], ['telegram_subject', '81102']]);
  let alarm: number | null = null;
  const storage = { kv: { get: (key: string) => rows.get(key), put: (key: string, value: unknown) => rows.set(key, structuredClone(value)), list: ({ prefix }: { prefix: string }) => [...rows].filter(([key]) => key.startsWith(prefix)) }, transactionSync: <T>(work: () => T) => work(), getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; } } as unknown as DurableObjectStorage;
  const now = Date.now(), ownerId = 'prn_10000000000000000000000000000002';
  configureCommonPublicBrowser({ ref: 'proposer-policy', doName: 'runtime-owner', subject: '81102', directoryOwnerId: '10000000-0000-0000-0000-000000000002', createdAt: now - 1, expiresAt: now + 60000, allowedOrigins: ['*'], maxAllocations: 1, maxReservedBrowserMs: 120000, lifetimeMs: 60000, maxScreenshotBytes: 1024 }, commonBrowserMeteredFixtureLoader,
    { policy: { ref: 'proposer-policy', ownerId, validUntil: now + 60000, limitMicrousd: 10000, maxCalls: 100 }, quote: kind => kind === 'browser' ? 0 : 1, allocationMicrousd: 100 });
  const env = { WALDO_ENVIRONMENT: 'staging', BROWSER: { fetch: vi.fn(async () => new Response('{}')) }, TELEGRAM_OWNER_DO: { idFromName: (name: string) => ({ toString: () => name === 'runtime-owner' ? 'physical-owner' : 'foreign' }) } } as never;
  const scope: RunEffectScope = { runId: 'run', attempt: 'run', deadline: now + 60000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() };
  const runtime = ownerBrowserRuntime({ env, storage, actualDoId: 'physical-owner', activeScope: () => scope });
  const fallback = { name: 'browse_act', handle: vi.fn() } as never;
  // One runtime per surface, each with its own approval desk, as the owner DO builds them.
  const telegram = runtime.act(fallback, async () => 'telegram-card');
  const app = runtime.act(fallback, async () => 'app-card');
  const unwired = runtime.act(fallback);
  const ctx = { authenticatedUserId: ownerId, turnId: 'turn', toolCallId: 'call', runScope: { ...scope }, egressAllowlist: ['*'] } as never;
  const upload = { provider: 'cloudflare_playwright' as const, url: 'https://example.com/form', task: 'Upload', max_actions: 1, command: { operation: 'upload', element_ref: 'e1', file_id: 'f1', revision: 1 } } as never;
  expect(await telegram.handle(upload, ctx)).toMatchObject({ ok: true, data: { proposal_id: 'telegram-card' } });
  expect(await app.handle(upload, ctx)).toMatchObject({ ok: true, data: { proposal_id: 'app-card' } });
  expect(await unwired.handle(upload, ctx)).toMatchObject({ ok: false });
});
