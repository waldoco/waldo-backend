import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { ownerBrowserRuntime } from '../src/channels/owner-browser-runtime';
import { registerCommonBrowserSdk } from '../src/channels/common-staging-registration';
import type { RunEffectScope } from '../src/channels/run-effect-scope';

// Browsing serves the owner bound to this physical object through the app as it does through Telegram, on the owner's
// Cloudflare host; Browserbase keys in the environment change nothing.
const OWNER = '1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic', WALDO_ROUTER_HMAC_SECRET: 'synthetic' };
const asked: string[] = [], provider: string[] = [];
let duringAcquire: (() => void) | undefined;
registerCommonBrowserSdk(async () => ({
  acquire: async () => { provider.push('acquire'); duringAcquire?.(); return { sessionId: 'app-owner-session' }; },
  connect: async () => ({ newContext: async () => ({ route: async () => {}, newPage: async () => ({ mainFrame: () => null, setDefaultTimeout() {}, goto: async () => ({ status: () => 200 }), url: () => 'https://example.com/menu', title: async () => 'Menu', locator: () => ({ innerText: async () => 'Vegetarian pasta' }) }), close: async () => {} }),
    newBrowserCDPSession: async () => ({ send: async () => { provider.push('close'); } }), close: async () => {} }),
  sessions: async () => [], endpointURLString: () => '',
}) as never);
beforeEach(() => vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const fn = String(input).split('/rpc/')[1] ?? ''; asked.push(fn);
  const body = JSON.parse(String(init?.body)) as Record<string, string>;
  return Response.json(fn === 'owner_runtime_authority' ? { owner_id: OWNER, auth_user_id: OWNER, do_name: body.p_do_name, state_version: 1, admission_revision: '2' } : null);
}));
afterEach(() => { vi.unstubAllGlobals(); asked.length = 0; provider.length = 0; duringAcquire = undefined; });
const scope: RunEffectScope = { runId: 'app-run', attempt: 'app-attempt', deadline: Date.now() + 60_000, signal: new AbortController().signal, admit: () => undefined, commit: work => work() };
const runtimeFor = (rows: Map<string, unknown>, actualDoId: string, env: Record<string, unknown> = {}) => ownerBrowserRuntime({
  env: { ...directory, WALDO_ENVIRONMENT: 'staging', BROWSER: {}, BROWSERBASE_API_KEY: 'synthetic', BROWSERBASE_PROJECT_ID: 'synthetic', TELEGRAM_OWNER_DO: { idFromName: (name: string) => ({ toString: () => `id-of-${name}` }) }, ...env } as never,
  storage: { kv: { get: (key: string) => rows.get(key), put: (key: string, value: unknown) => rows.set(key, value), list: () => [] }, transactionSync: <T>(work: () => T) => work(), getAlarm: async () => null, setAlarm: async () => undefined } as unknown as DurableObjectStorage,
  actualDoId, activeScope: () => scope,
});
const appOwner = () => new Map<string, unknown>([['do_name', 'app-owner'], ['app_subject', String(appSubjectFor('app-owner'))]]);
const ctx = { authenticatedUserId: `prn_${OWNER.replaceAll('-', '')}`, runScope: scope, turnId: 'app-turn', toolCallId: 'read', egressAllowlist: ['*'] } as never;
const args = { url: 'https://example.com/menu', instruction: 'Read the menu' };

it('an app-only owner\'s browse_page is confirmed by the account directory and served by the Cloudflare host, never Browserbase', async () => {
  const handle = vi.fn();
  const read = runtimeFor(appOwner(), 'id-of-app-owner').read({ name: 'browse_page', handle } as never);
  expect(await read.eligible!()).toEqual({ ok: true });
  expect(await read.handle(args, ctx)).toMatchObject({ ok: true, data: { provider: 'cloudflare_playwright', data: { text: 'Vegetarian pasta' } } });
  expect(handle).not.toHaveBeenCalled();
  expect(asked).toContain('owner_runtime_authority'); expect(asked).not.toContain('common_owner_authority');
  expect(provider).toEqual(['acquire', 'close']);
});

it('the same app owner on a foreign physical object is refused before any browser work', async () => {
  const handle = vi.fn();
  expect(await runtimeFor(appOwner(), 'id-of-another-owner').read({ name: 'browse_page', handle } as never).handle(args, ctx)).toMatchObject({ ok: false, code: 'rejected' });
  expect(handle).not.toHaveBeenCalled(); expect(asked).toEqual([]); expect(provider).toEqual([]);
});

it('an app binding minted for another owner, or unlinked, holds no browser', async () => {
  const handle = vi.fn();
  const foreignSubject = new Map<string, unknown>([['do_name', 'app-owner'], ['app_subject', String(appSubjectFor('someone-else'))]]);
  const unlinked = new Map<string, unknown>([...appOwner(), ['app_unlinked', true]]);
  for (const rows of [foreignSubject, unlinked]) expect(await runtimeFor(rows, 'id-of-app-owner').read({ name: 'browse_page', handle } as never).handle(args, ctx)).toMatchObject({ ok: false });
  expect(handle).not.toHaveBeenCalled(); expect(provider).toEqual([]);
});

it('an app binding that changes mid-read stops the read at its next currentness check and ends the session', async () => {
  const rows = appOwner();
  duringAcquire = () => { rows.set('app_unlinked', true); };
  expect(await runtimeFor(rows, 'id-of-app-owner').read({ name: 'browse_page', handle: vi.fn() } as never).handle(args, ctx)).toMatchObject({ ok: false });
  expect(provider).toEqual(['acquire', 'close']);
});

it('without a browser binding the app owner\'s read is refused before any directory or provider I/O', async () => {
  const read = runtimeFor(appOwner(), 'id-of-app-owner', { BROWSER: undefined }).read({ name: 'browse_page', handle: vi.fn() } as never);
  expect(await read.eligible!()).toEqual({ ok: false, reason: 'not_configured' });
  expect(await read.handle(args, ctx)).toMatchObject({ ok: false, code: 'auth_failed' });
  expect(asked).toEqual([]); expect(provider).toEqual([]);
});
