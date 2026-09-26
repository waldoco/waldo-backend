import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

describe('healthz', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('returns ok with the release, before any auth or flag gates', async () => {
    const res = await worker.fetch(new Request('https://waldo.invalid/healthz'), {
      WALDO_RELEASE: 'abc123',
    } as unknown as Cloudflare.Env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, release: 'abc123' });
  });

  it('unknown paths still 404 when the public api is disabled', async () => {
    const res = await worker.fetch(new Request('https://waldo.invalid/nope'), {} as unknown as Cloudflare.Env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');
  });

  it('routes a staging Telegram console link to the directory owner DO', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ do_name: 'owner-do-a', subject: '12345', timezone: null }])));
    const idFromName = vi.fn((name: string) => name);
    const doFetch = vi.fn(async (_request: Request) => new Response('owner console'));
    const res = await worker.fetch(new Request('https://waldo.invalid/console?t=forged', {
      headers: { 'x-waldo-do-name': 'attacker-chosen' },
    }), {
      WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_TELEGRAM_ID: '12345',
      SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'public', WALDO_ROUTER_HMAC_SECRET: 'test-secret',
      TELEGRAM_OWNER_DO: { idFromName, get: () => ({ fetch: doFetch }) },
    } as unknown as Cloudflare.Env);
    expect(res.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('owner-do-a');
    expect(doFetch).toHaveBeenCalledTimes(1);
    const forwarded = doFetch.mock.calls[0]?.[0];
    expect(forwarded?.headers.get('x-waldo-do-name')).toBe('owner-do-a');
  });
});
