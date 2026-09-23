import { describe, expect, it, vi } from 'vitest';
import { renderAdmin } from '../src/channels/console-admin';
import { consoleAuth } from '../src/identity/console-auth';
import { routerSignature } from '../src/identity/owner-directory';

const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
const json = (value: unknown) => new Response(JSON.stringify(value));
const now = () => 1_790_000_000_000;

describe('console admin', () => {
  it('escapes owner and invite data and offers revoke only for open invites', () => {
    const html = renderAdmin({
      owners: [{ email: '<b>x</b>@test', state: 'active', created_at: '2026-09-24T01:00:00Z', presences: ['telegram'] }],
      invites: [
        { id: 'i-open', email: 'open@test', created_at: '2026-09-24T01:00:00Z', used_at: null, revoked_at: null },
        { id: 'i-used', email: 'used@test', created_at: '2026-09-24T01:00:00Z', used_at: '2026-09-24T02:00:00Z', revoked_at: null },
      ],
    }, 'csrf-1');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('value="i-open"');
    expect(html).not.toContain('value="i-used"');
    expect(html).toContain('value="csrf-1"');
  });

  it('signs admin calls for the calling owner and lowercases invited addresses', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(true)).mockResolvedValueOnce(json(null));
    const auth = consoleAuth(env, fetcher as unknown as typeof fetch, now)!;
    expect(await auth.invite('do-admin', ' New@Test.invalid ')).toBe(true);
    expect(JSON.parse(String((fetcher.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({ p_do_name: 'do-admin', p_email: 'new@test.invalid', p_sig: await routerSignature('router', 1_790_000_000, 'invite.do-admin.new@test.invalid') });
    expect(await auth.adminOverview('do-user')).toBeNull();
  });
});
