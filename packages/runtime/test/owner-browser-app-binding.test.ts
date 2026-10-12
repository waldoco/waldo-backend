import { afterEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { ownerBrowserRuntime } from '../src/channels/owner-browser-runtime';
import type { RunEffectScope } from '../src/channels/run-effect-scope';

// Browsing serves the owner bound to this physical object through the app as it does through Telegram.
const OWNER = '1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic', WALDO_ROUTER_HMAC_SECRET: 'synthetic' };
const asked: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); asked.length = 0; });
const scope: RunEffectScope = { runId: 'app-run', attempt: 'app-attempt', deadline: Date.now() + 60_000, signal: new AbortController().signal, admit: () => undefined, commit: work => work() };
const runtimeFor = (rows: Map<string, unknown>, actualDoId: string, env: Record<string, unknown> = {}) => ownerBrowserRuntime({
  env: { ...directory, WALDO_ENVIRONMENT: 'production', BROWSERBASE_API_KEY: 'synthetic', BROWSERBASE_PROJECT_ID: 'synthetic', TELEGRAM_OWNER_DO: { idFromName: (name: string) => ({ toString: () => `id-of-${name}` }) }, ...env } as never,
  storage: { kv: { get: (key: string) => rows.get(key), put: (key: string, value: unknown) => rows.set(key, value), list: () => [] }, transactionSync: <T>(work: () => T) => work(), getAlarm: async () => null, setAlarm: async () => undefined } as unknown as DurableObjectStorage,
  actualDoId, activeScope: () => scope,
});
const appOwner = () => new Map<string, unknown>([['do_name', 'app-owner'], ['app_subject', String(appSubjectFor('app-owner'))]]);
const ctx = { authenticatedUserId: `prn_${OWNER.replaceAll('-', '')}`, runScope: scope, turnId: 'app-turn', toolCallId: 'read' } as never;
const args = { url: 'https://example.com/menu', instruction: 'Read the menu' };

it('an app-only owner\'s browse_page reaches the browser with the run\'s currentness check', async () => {
  const handle = vi.fn(async (_args: unknown, context: { assertTaskSourceCurrent?: () => Promise<void> }) => { await context.assertTaskSourceCurrent?.(); return { ok: true as const, data: { read: true }, source_taint: 'external' as const }; });
  const read = runtimeFor(appOwner(), 'id-of-app-owner').read({ name: 'browse_page', handle } as never);
  expect(await read.eligible!()).toEqual({ ok: true });
  expect(await read.handle(args, ctx)).toMatchObject({ ok: true, data: { read: true } });
  expect(handle).toHaveBeenCalledTimes(1);
});

it('the same app owner on a foreign physical object is refused before any browser work', async () => {
  const handle = vi.fn();
  expect(await runtimeFor(appOwner(), 'id-of-another-owner').read({ name: 'browse_page', handle } as never).handle(args, ctx)).toMatchObject({ ok: false, code: 'rejected' });
  expect(handle).not.toHaveBeenCalled();
});

it('an app binding minted for another owner, or unlinked, holds no browser', async () => {
  const handle = vi.fn();
  const foreignSubject = new Map<string, unknown>([['do_name', 'app-owner'], ['app_subject', String(appSubjectFor('someone-else'))]]);
  const unlinked = new Map<string, unknown>([...appOwner(), ['app_unlinked', true]]);
  for (const rows of [foreignSubject, unlinked]) expect(await runtimeFor(rows, 'id-of-app-owner').read({ name: 'browse_page', handle } as never).handle(args, ctx)).toMatchObject({ ok: false });
  expect(handle).not.toHaveBeenCalled();
});

it('an app binding that changes mid-read stops the read at its next currentness check', async () => {
  const rows = appOwner();
  const handle = vi.fn(async (_args: unknown, context: { assertTaskSourceCurrent?: () => Promise<void> }) => { rows.set('app_unlinked', true); await context.assertTaskSourceCurrent?.(); return { ok: true as const, data: {}, source_taint: 'external' as const }; });
  await expect(runtimeFor(rows, 'id-of-app-owner').read({ name: 'browse_page', handle } as never).handle(args, ctx)).rejects.toThrow('run is closed');
});

it('the Cloudflare public read for an app owner is confirmed by the account directory', async () => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = String(input).split('/rpc/')[1] ?? ''; asked.push(fn);
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    return Response.json(fn === 'owner_runtime_authority' ? { owner_id: OWNER, auth_user_id: OWNER, do_name: body.p_do_name, state_version: 1, admission_revision: '2' } : null);
  });
  // Staging without Browserbase keys or a browser binding: the read reaches the Cloudflare host and stops there for want of
  // the binding, after admission, never through a Telegram presence.
  const result = await runtimeFor(appOwner(), 'id-of-app-owner', { WALDO_ENVIRONMENT: 'staging', BROWSERBASE_API_KEY: undefined, BROWSERBASE_PROJECT_ID: undefined })
    .read({ name: 'browse_page', handle: vi.fn() } as never).handle(args, ctx);
  expect(result).toMatchObject({ ok: false, code: 'auth_failed' });
  expect(asked).not.toContain('common_owner_authority');
});
