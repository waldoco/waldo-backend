import { expect, it, vi } from 'vitest';
import { browserTrialConsent, BROWSER_TRIAL_PATH } from '../src/channels/browser-trial-consent';
import { BROWSER_AUTHORIZATION_KEY, browserOwnerAuthority, type BrowserOwnerAuthorization } from '../src/channels/browser-owner-authority';

function fixture() {
  let time = 1000;
  const rows = new Map<string, unknown>();
  const storage = { kv: { get: (key: string) => structuredClone(rows.get(key)), put: (key: string, value: unknown) => rows.set(key, structuredClone(value)), delete: (key: string) => rows.delete(key) }, transactionSync: <T>(work: () => T) => work() } as unknown as DurableObjectStorage;
  let binding = { owner_id: '10000000-0000-0000-0000-000000000001', presence_id: '20000000-0000-0000-0000-000000000001', do_name: 'owner-do', provider: 'telegram' as const, subject: '81101', admission_revision: '1', state_version: 0 };
  const manifest = { origin: 'https://fixture.example', pagePath: '/form', submitPath: '/submit', receiptPrefix: '/receipts/', runId: 'trial-one', fields: ['value'], formSelector: '#form', submitSelector: '#submit', resultSelector: '#result' };
  const lookup = vi.fn(async () => ({ ...binding }));
  const limiter = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;
  const options = { storage, limiter, ownerScope: 'physical-owner-id', csrf: 'owner-session-csrf', trial: { policy: { enabled: false, doName: 'owner-do', fixtureOrigin: manifest.origin }, manifest }, lookup, doName: 'owner-do', subject: '81101', now: () => time, newId: () => 'fresh-owner-decision' };
  const get = () => browserTrialConsent(new Request(`https://local.invalid${BROWSER_TRIAL_PATH}`), options);
  const post = (changes: object = {}) => browserTrialConsent(new Request(`https://local.invalid${BROWSER_TRIAL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csrf: options.csrf, nonce: 'fresh-owner-decision', ...changes }) }), options);
  return { rows, storage, options, lookup, get, post, setTime: (value: number) => { time = value; }, changeOwner: () => { binding = { ...binding, owner_id: '10000000-0000-0000-0000-000000000002', admission_revision: '2' }; } };
}

it('default-off route performs no storage or directory work', async () => {
  const f = fixture();
  const response = await browserTrialConsent(new Request('https://local.invalid'), { ...f.options, trial: undefined, storage: new Proxy({}, { get: () => { throw Error('no storage'); } }) as DurableObjectStorage });
  expect(response.status).toBe(404); expect(f.lookup).not.toHaveBeenCalled();
});
it('displays exact bounded scope without writing authority until authenticated confirmation', async () => {
  const f = fixture(); const response = await f.get(); const view = await response.json() as { budget: object; fixture: object };
  expect(view.budget).toEqual({ maxAdmissions: 32, maxAllocations: 1, maxBrowserMs: 120000 });
  expect(view.fixture).toEqual(f.options.trial.manifest); expect(f.rows.has(BROWSER_AUTHORIZATION_KEY)).toBe(false);
  expect((await f.post()).status).toBe(200);
  expect(f.rows.get(BROWSER_AUTHORIZATION_KEY)).toMatchObject({ binding: { owner_id: '10000000-0000-0000-0000-000000000001' }, expiresAt: 61000, usage: { admissions: 0, allocations: 0, reservedBrowserMs: 0 } });
});
it.each([{ csrf: 'foreign' }, { nonce: 'foreign' }, { budget: { maxAllocations: 9 } }, { manifest: { origin: 'https://foreign.example' } }])('rejects foreign or widened confirmation %j', async change => {
  const f = fixture(); await f.get(); expect((await f.post(change)).ok).toBe(false); expect(f.rows.has(BROWSER_AUTHORIZATION_KEY)).toBe(false);
});
it('denies stale owner binding and expired nonce without installing authority', async () => {
  const f = fixture(); await f.get(); f.changeOwner(); expect((await f.post()).ok).toBe(false); expect(f.rows.has(BROWSER_AUTHORIZATION_KEY)).toBe(false);
  const expired = fixture(); await expired.get(); expired.setTime(61000); expect((await expired.post()).ok).toBe(false); expect(expired.rows.has(BROWSER_AUTHORIZATION_KEY)).toBe(false);
});
it('never resets counters or refreshes expiry after replay or a new proposal', async () => {
  const f = fixture(); await f.get(); await f.post();
  const row = f.rows.get(BROWSER_AUTHORIZATION_KEY) as BrowserOwnerAuthorization;
  const owner = row.binding.owner_id.replaceAll('-', '');
  expect(browserOwnerAuthority(f.storage, f.options.now).grant({ principal: `prn_${owner}`, tenant: `ten_${owner}`, doName: row.binding.do_name, presence: row.binding.presence_id, revision: row.binding.admission_revision, task: row.manifest.runId, manifest: row.manifestDigest, page: row.manifest.origin + row.manifest.pagePath, operation: 'extract', evidence: {} }, row.binding)).not.toBeNull();
  expect((await f.post()).status).toBe(409); expect((await f.get()).status).toBe(409);
  expect(f.rows.get(BROWSER_AUTHORIZATION_KEY)).toMatchObject({ expiresAt: 61000, usage: { admissions: 1 } });
});

it('fails closed before lookup and storage when owner-keyed rate admission is absent', async () => {
  const f = fixture();
  const response = await browserTrialConsent(new Request('https://local.invalid'), { ...f.options, limiter: undefined });
  expect(response.status).toBe(503); expect(f.lookup).not.toHaveBeenCalled(); expect(f.rows.size).toBe(0);
});

it.each(['denied', 'error'])('rejects %s rate admission before directory/storage work', async mode => {
  const f = fixture(); const limiter = { limit: async ({ key }: { key: string }) => { expect(key).toBe('browser-trial:physical-owner-id'); if (mode === 'error') throw Error('limiter unavailable'); return { success: false }; } } as RateLimit;
  const response = await browserTrialConsent(new Request('https://local.invalid'), { ...f.options, limiter });
  expect(response.status).toBe(mode === 'error' ? 503 : 429); expect(f.lookup).not.toHaveBeenCalled(); expect(f.rows.size).toBe(0);
});
it.each([true, false])('bounds declared and chunked POST bodies before lookup (declared=%s)', async declared => {
  const f = fixture(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(4097))); }, cancel() { cancelled = true; } });
  const request = new Request('https://local.invalid', { method: 'POST', headers: { 'content-type': 'application/json', ...(declared ? { 'content-length': '4097' } : {}) }, body, duplex: 'half' } as RequestInit);
  expect((await browserTrialConsent(request, f.options)).status).toBe(413); expect(f.lookup).not.toHaveBeenCalled(); expect(f.rows.size).toBe(0);
  if (!declared) expect(cancelled).toBe(true);
});
it('stop during final consent lookup invalidates pending confirmation and cannot create a new one', async () => {
  const { BROWSER_TRIAL_PENDING_KEY, BROWSER_TRIAL_REVOCATION_KEY } = await import('../src/channels/browser-trial-consent');
  for (const method of ['GET', 'POST']) {
    const f = fixture(); if (method === 'POST') await f.get();
    let calls = 0; f.lookup.mockImplementation(async () => { if (++calls === 2) { f.rows.delete(BROWSER_TRIAL_PENDING_KEY); f.rows.set(BROWSER_TRIAL_REVOCATION_KEY, 'owner-stop'); } return { ...(f.options.trial ? { owner_id: '10000000-0000-0000-0000-000000000001', presence_id: '20000000-0000-0000-0000-000000000001', do_name: 'owner-do', provider: 'telegram' as const, subject: '81101', admission_revision: '1', state_version: 0 } : {}) } as never; });
    expect((await (method === 'GET' ? f.get() : f.post())).status).toBe(409);
    expect(f.rows.has(BROWSER_AUTHORIZATION_KEY)).toBe(false); expect(f.rows.has(BROWSER_TRIAL_PENDING_KEY)).toBe(false);
  }
});
it('denies expiry or owner rebinding during final lookup', async () => {
  for (const change of ['expiry', 'owner']) {
    const f = fixture(); await f.get(); const previous = f.lookup.getMockImplementation()!; let calls = 0;
    f.lookup.mockImplementation(async () => { if (++calls === 2) { if (change === 'expiry') f.setTime(61000); else f.changeOwner(); } return previous(); });
    expect((await f.post()).status).toBe(409); expect(f.rows.has(BROWSER_AUTHORIZATION_KEY)).toBe(false);
  }
});

it('bounds a stalled chunked body for the entire read and cancels it at the deadline', async () => {
  const { browserBoundedJson } = await import('../src/channels/browser-bounded-body');
  vi.useFakeTimers(); let cancelled = false;
  try {
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const reading = expect(browserBoundedJson(response, 4096, 10)).rejects.toThrow('browser body timeout');
    await vi.advanceTimersByTimeAsync(11); await reading; expect(cancelled).toBe(true);
  } finally { vi.useRealTimers(); }
});
