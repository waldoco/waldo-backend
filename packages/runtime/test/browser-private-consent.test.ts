import { expect, it } from 'vitest';
import { privateBrowserConsent } from '../src/channels/browser-private-consent';

it('owner confirms and renews exact saved-sign-in scope only after retiring the previous generation', async () => {
  const rows = new Map<string, unknown>();
  const storage = { kv: { get: (k: string) => rows.get(k), put: (k: string, v: unknown) => rows.set(k, v), delete: (k: string) => rows.delete(k) }, transactionSync: <T>(f: () => T) => f() } as unknown as DurableObjectStorage;
  let now = 1000, retired = 0;
  const options = { storage, csrf: 'owner-csrf', now: () => now, newId: () => crypto.randomUUID(), assertOwner: async () => 'custody-v1',
    binding: { ownerId: '12345678-1234-1234-1234-123456789abc', environment: 'staging', siteOrigin: 'https://synthetic.example', accountId: 'synthetic-account' },
    expiresAt: 100000, retire: async () => { retired++; } };
  const get = () => privateBrowserConsent(new Request('https://local.invalid/console/browser/saved'), options);
  const confirm = (nonce: string, csrf = options.csrf) => privateBrowserConsent(new Request('https://local.invalid/console/browser/saved', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'confirm', nonce, csrf }) }), options);
  const proposal = await (await get()).json() as any;
  expect(proposal).toMatchObject({ site: options.binding.siteOrigin, account: options.binding.accountId, generation: 1 });
  expect((await confirm(proposal.nonce, 'other-owner')).status).toBe(403);
  expect((await confirm(proposal.nonce)).status).toBe(200);
  expect((await confirm(proposal.nonce)).status).toBe(409);
  const renewal = await (await get()).json() as any;
  expect(renewal.generation).toBe(2);
  expect((await confirm(renewal.nonce)).status).toBe(200);
  expect(retired).toBe(1);
  now = 100001;
  expect((await get()).status).toBe(409);
});

it('a failed retirement stays fenced and an explicit revoke can retry cleanup after custody renewal', async () => {
  const rows = new Map<string, unknown>();
  const storage = { kv: { get: (k: string) => rows.get(k), put: (k: string, v: unknown) => rows.set(k, v), delete: (k: string) => rows.delete(k) }, transactionSync: <T>(f: () => T) => f() } as unknown as DurableObjectStorage;
  let fail = false, custody = 'custody-v1';
  const options = { storage, csrf: 'owner-csrf', now: () => 1000, newId: () => crypto.randomUUID(), assertOwner: async () => custody,
    binding: { ownerId: '12345678-1234-1234-1234-123456789abc', environment: 'staging', siteOrigin: 'https://synthetic.example', accountId: 'synthetic-account' },
    expiresAt: 100000, retire: async () => { if (fail) throw Error('uncertain cleanup'); } };
  const call = (body?: object) => privateBrowserConsent(new Request('https://local.invalid/console/browser/saved', body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, csrf: options.csrf }) } : {}), options);
  const first = await (await call()).json() as any;
  expect((await call({ action: 'confirm', nonce: first.nonce })).status).toBe(200);
  fail = true;
  expect((await call({ action: 'revoke' })).status).toBe(409);
  expect((await call()).status).toBe(409);
  custody = 'custody-v2'; fail = false;
  expect((await call({ action: 'revoke' })).status).toBe(200);
});
