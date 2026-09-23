import { describe, expect, it, vi } from 'vitest';
import { linkCodeHash, ownerDirectory, routerSignature } from '../src/identity/owner-directory';

const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const now = () => 1_790_000_000_000;
const sent = (fetcher: ReturnType<typeof vi.fn>, index = 0) => {
  const [url, init] = fetcher.mock.calls[index] as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> };
};

describe('ownerDirectory', () => {
  it('falls back to the one deploy-configured owner when Supabase is not configured', async () => {
    const directory = ownerDirectory({ WALDO_OWNER_TELEGRAM_ID: '42', WALDO_OWNER_TIMEZONE: 'Asia/Kolkata' });
    expect(await directory.byPresence('telegram', '42')).toEqual({ doName: '42', subject: '42', timezone: 'Asia/Kolkata' });
    expect(await directory.byPresence('telegram', '43')).toBeNull();
    expect(await directory.redeem('telegram', '43', 'ANY')).toBeNull();
  });

  it('resolves a presence through the signed route function with only the publishable key', async () => {
    const fetcher = vi.fn(async () => json([{ do_name: 'do-a', subject: '42', timezone: 'Europe/Paris' }]));
    const route = await ownerDirectory(env, fetcher as unknown as typeof fetch, now).byPresence('telegram', '42');
    expect(route).toEqual({ doName: 'do-a', subject: '42', timezone: 'Europe/Paris' });
    const call = sent(fetcher);
    expect(call.url).toBe('https://db.test/rest/v1/rpc/route_presence');
    expect(call.headers).toEqual({ apikey: 'pub', 'content-profile': 'waldo', 'content-type': 'application/json' });
    expect(call.body).toEqual({ p_provider: 'telegram', p_subject: '42', p_at: 1_790_000_000, p_sig: await routerSignature('router', 1_790_000_000, 'route.telegram.42') });
  });

  it('signs the exact subject, so a signature cannot be reused for another sender', async () => {
    expect(await routerSignature('router', 1, 'route.telegram.42')).not.toBe(await routerSignature('router', 1, 'route.telegram.43'));
    expect(await routerSignature('router', 1, 'route.telegram.42')).not.toBe(await routerSignature('router', 2, 'route.telegram.42'));
  });

  it('an unknown sender resolves to nobody', async () => {
    const fetcher = vi.fn(async () => json([]));
    expect(await ownerDirectory(env, fetcher as unknown as typeof fetch, now).byPresence('telegram', '99')).toBeNull();
  });

  it('redeems only the hash of a code, never the code itself, then resolves the new presence', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json('10000000-0000-0000-0000-00000000000a'))
      .mockResolvedValueOnce(json([{ do_name: 'do-a', subject: '42', timezone: null }]));
    const route = await ownerDirectory(env, fetcher as unknown as typeof fetch, now).redeem('telegram', '42', ' ab12cd ');
    expect(route).toEqual({ doName: 'do-a', subject: '42', timezone: null });
    const hash = await linkCodeHash('AB12CD');
    expect(sent(fetcher).body).toMatchObject({ p_code_hash: hash, p_provider: 'telegram', p_subject: '42', p_sig: await routerSignature('router', 1_790_000_000, `redeem.${hash}.telegram.42`) });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('AB12CD');
  });

  it('a spent or expired code links nothing', async () => {
    const fetcher = vi.fn(async () => json(null));
    expect(await ownerDirectory(env, fetcher as unknown as typeof fetch, now).redeem('telegram', '42', 'OLD')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('surfaces a database failure instead of treating it as an unknown sender', async () => {
    const fetcher = vi.fn(async () => json({ message: 'unsigned router call' }, 403));
    await expect(ownerDirectory(env, fetcher as unknown as typeof fetch, now).byPresence('telegram', '42')).rejects.toThrow('owner directory 403');
  });
});
