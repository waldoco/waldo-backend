import { expect, it, vi } from 'vitest';
import { browserProductionConfiguration } from '../src/channels/browser-production-factory';
import { browserOwnerAuthority, BROWSER_AUTHORIZATION_KEY, type BrowserOwnerAuthorization } from '../src/channels/browser-owner-authority';
import { fixtureDigest } from '../src/channels/public-fixture-browser';
import type { BrowserOwnerGrantRequest } from '../src/channels/browser-owner-host';

async function fixture() {
  let time = 1000;
  const binding = { owner_id: '10000000-0000-0000-0000-000000000001', presence_id: '20000000-0000-0000-0000-000000000001', do_name: 'owner-do', provider: 'telegram' as const, subject: '81101', admission_revision: '9007199254740993', state_version: 0 };
  const manifest = { origin: 'https://fixture.example', pagePath: '/trial-one/form', submitPath: '/trial-one/submit', receiptPrefix: '/trial-one/receipts/', runId: 'trial-one', fields: ['value'], formSelector: '#form', submitSelector: '#submit', resultSelector: '#result' };
  const authorization: BrowserOwnerAuthorization = { version: 1, ref: 'confirmed-trial-one', state: 'active', binding, manifest, manifestDigest: await fixtureDigest(manifest), createdAt: time, expiresAt: time + 60000, operations: ['navigate', 'extract', 'act'], budget: { maxAdmissions: 32, maxAllocations: 1, maxBrowserMs: 120000 } };
  const rows = new Map<string, unknown>([[BROWSER_AUTHORIZATION_KEY, authorization]]);
  const storage = { kv: { get: (key: string) => structuredClone(rows.get(key)), put: (key: string, value: unknown) => { rows.set(key, structuredClone(value)); } }, transactionSync: <T>(work: () => T) => work() } as unknown as DurableObjectStorage;
  const request: BrowserOwnerGrantRequest = { principal: 'prn_10000000000000000000000000000001', tenant: 'ten_10000000000000000000000000000001', doName: binding.do_name, presence: binding.presence_id, revision: binding.admission_revision, task: manifest.runId, manifest: authorization.manifestDigest, page: manifest.origin + manifest.pagePath, operation: 'extract', evidence: {} };
  return { binding, manifest, authorization, rows, storage, request, now: () => time, setTime: (value: number) => { time = value; } };
}

it('keeps the deployed default disabled without identity, storage or provider I/O', async () => {
  const fetcher = vi.fn(() => { throw Error('network must not run'); });
  const storage = new Proxy({}, { get: () => { throw Error('storage must not run'); } });
  expect(await browserProductionConfiguration({ env: {}, storage: storage as DurableObjectStorage, actualDoId: 'physical', fetcher })).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it('requires a matching recorded decision and consumes durable admission across reconstruction', async () => {
  const f = await fixture();
  const authority = browserOwnerAuthority(f.storage, f.now);
  expect(authority.grant({ ...f.request, task: 'foreign' }, f.binding)).toBeNull();
  for (let n = 0; n < 32; n++) expect(browserOwnerAuthority(f.storage, f.now).grant(f.request, f.binding)).toMatchObject({ ...f.request, expiresAt: 61000 });
  expect(browserOwnerAuthority(f.storage, f.now).grant(f.request, f.binding)).toBeNull();
});

it('reserves one allocation including failed-close time and does not replenish it after recreation', async () => {
  const f = await fixture(), authority = browserOwnerAuthority(f.storage, f.now);
  expect(authority.reserveAllocation(f.authorization, f.binding, 60000)).toBe(true);
  expect(browserOwnerAuthority(f.storage, f.now).reserveAllocation(f.authorization, f.binding, 60000)).toBe(false);
  f.rows.set(BROWSER_AUTHORIZATION_KEY, { ...f.authorization, ref: 'replacement' });
  expect(browserOwnerAuthority(f.storage, f.now).grant(f.request, f.binding)).toBeNull();
});

it('builds the concrete driver from a signed canonical binding and rejects the legacy route projection', async () => {
  const f = await fixture();
  f.rows.set('do_name', f.binding.do_name); f.rows.set('telegram_subject', f.binding.subject);
  const env = { WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE: 'namespace', SUPABASE_PROJECT_URL: 'https://database.example', SUPABASE_PUBLISHABLE_KEY: 'public-test-key', WALDO_ROUTER_HMAC_SECRET: 'test-secret', TELEGRAM_OWNER_DO: { idFromName: () => ({ toString: () => 'physical' }) } as unknown as DurableObjectNamespace, BROWSER: { fetch: vi.fn(() => { throw Error('provider must not allocate'); }) } as unknown as import('@cloudflare/playwright').BrowserWorker };
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let response: unknown = f.binding;
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json(response); };
  const options = { env, storage: f.storage, actualDoId: 'physical', now: f.now, fetcher, policy: { enabled: true, doName: f.binding.do_name, fixtureOrigin: f.manifest.origin } };
  const config = await browserProductionConfiguration(options);
  expect(config).toMatchObject({ enabled: true, binding: f.binding, manifestDigest: f.authorization.manifestDigest });
  expect(config!.driver).toMatchObject({ runId: f.manifest.runId, pageUrl: f.request.page, provider: 'cloudflare_playwright' });
  expect(await config!.grant(f.request)).toMatchObject({ ref: 'confirmed-trial-one:1' });
  expect(calls[0]!.url).toBe('https://database.example/rest/v1/rpc/browser_owner_binding');
  expect(calls[0]!.body).toMatchObject({ p_environment: 'staging', p_namespace: 'namespace', p_do_name: 'owner-do', p_do_id: 'physical', p_provider: 'telegram', p_subject: '81101', p_at: 1 });
  expect(calls[0]!.body.p_sig).toMatch(/^[0-9a-f]{64}$/);
  response = { do_name: f.binding.do_name, subject: f.binding.subject, timezone: null };
  expect(await config!.grant(f.request)).toBeNull();
  await expect(browserProductionConfiguration(options)).rejects.toThrow('browser configuration unavailable');
  expect(env.BROWSER.fetch).not.toHaveBeenCalled();
});
