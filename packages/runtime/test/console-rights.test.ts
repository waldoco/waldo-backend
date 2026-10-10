import { expect, it } from 'vitest';
import { consoleDeleteReview } from '../src/channels/console-rights';
import { rightsJobs, type RightsHost } from '../src/rights/jobs';
import { rightsInventory } from '../src/rights/custody';

it('requires reviewed exact scope, exposes honest limits and dispatches deletion only on the explicit final click', async () => {
  const data = new Map<string, unknown>(), inventory = await rightsInventory();
  const storage = { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, value); }, transaction: async (work: (store: unknown) => unknown) => work(storage) };
  const host = { storage, owner: 'owner', session: 'a'.repeat(64), secret: 'synthetic-console-rights-secret-000000000000', now: () => 1000, assertCurrent: async () => {}, inventory: async () => inventory } as unknown as RightsHost;
  const prepared = await rightsJobs(host).prepare('delete-operation-0001', inventory.revision);
  const response = consoleDeleteReview(prepared, inventory), html = await response.text();
  expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
  expect(html).toContain('Confirm deletion'); expect(html).toContain('No deletion has been submitted'); expect(html).toContain('backups'); expect(html).toContain('offline');
  expect(html).toContain("addEventListener('click'"); expect(html).toContain("credentials:'omit'"); expect(html).toContain("'/app/v1/rights/delete/submit'");
  expect(html).not.toMatch(/https?:\/\//); expect(html).not.toContain('session_hash');
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(script).toBeTruthy(); expect(() => new Function(script!)).not.toThrow();
  expect(() => consoleDeleteReview(prepared, { ...inventory, revision: 'b'.repeat(64) })).toThrow('rights_review_scope_changed');
  const attack = structuredClone(inventory); attack.stores[0]!.explanation = '</script><script>exfiltrate()</script>';
  expect(await consoleDeleteReview(prepared, attack).text()).not.toContain('<script>exfiltrate()');
});
