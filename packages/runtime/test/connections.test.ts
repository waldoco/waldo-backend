import { describe, expect, it, vi } from 'vitest';
import { connectionVault } from '../src/connectors/connections';
import { GoogleError, googleClient, googleHas, type GoogleClient } from '../src/connectors/google';
import { googleHandlers } from '../src/tools/live/google';
import { hex, routerSignature } from '../src/identity/owner-directory';

const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
const at = 1_790_000_000;
const body = (fetcher: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(String((fetcher.mock.calls[call] as [string, RequestInit])[1].body)) as Record<string, string>;

describe('connection vault', () => {
  it('is off without Supabase, so the token stays in the Durable Object', () => {
    expect(connectionVault({})).toBeNull();
  });

  it('signs the token hash, so the signed call cannot carry a different token', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('"c-1"'));
    expect(await connectionVault(env, fetcher as unknown as typeof fetch, () => at * 1000)!.store('do-a', ' Me@Work.test ', ['openid', 'x'], 'rt-1')).toBe('c-1');
    const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rt-1')));
    expect(body(fetcher)).toEqual({ p_do_name: 'do-a', p_provider: 'google', p_account: 'me@work.test', p_scopes: 'openid x', p_secret: 'rt-1', p_at: at, p_sig: await routerSignature('router', at, `connstore.do-a.google.me@work.test.openid x.${hash}`) });
  });

  it('reads the token by connection id for this owner only', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('"rt-1"'));
    expect(await connectionVault(env, fetcher as unknown as typeof fetch, () => at * 1000)!.secret('do-a', 'c-1')).toBe('rt-1');
    expect(body(fetcher).p_sig).toBe(await routerSignature('router', at, 'connsecret.do-a.c-1'));
  });
});

describe('google health', () => {
  const app = { clientId: 'c', clientSecret: 's', redirectUri: 'https://r.test' };
  it('reports a failed refresh, then clears it after a good one', async () => {
    const health = vi.fn();
    const refused = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    await expect(googleClient(app, { refresh_token: 'rt' }, refused as unknown as typeof fetch, health).events('a', 'b', 1, false)).rejects.toThrow('invalid_grant');
    expect(health).toHaveBeenLastCalledWith('google token failed: invalid_grant');
    const ok = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })));
    await googleClient(app, { refresh_token: 'rt' }, ok as unknown as typeof fetch, health).events('a', 'b', 1, false);
    expect(health).toHaveBeenLastCalledWith('');
  });

  it('knows which features a grant covers', () => {
    expect(googleHas(['https://www.googleapis.com/auth/calendar.events'], 'calendar')).toBe(true);
    expect(googleHas(['https://www.googleapis.com/auth/gmail.readonly'], 'mail')).toBe(false);
    expect(googleHas(undefined, 'calendar')).toBe(false);
  });
});

describe('incremental Google access', () => {
  it('a mail tool on a calendar-only grant returns the Gmail consent link, not a retry', async () => {
    const client = { draft: async () => { throw new GoogleError(403, 'google 403: insufficient scopes'); } } as unknown as GoogleClient;
    const asked: string[] = [];
    const google = { client: async () => client, connectUrl: async (feature: string) => (asked.push(feature), `https://accounts.google.com/x?f=${feature}`) };
    const draft = googleHandlers(google, { propose: async () => 'p', record: () => undefined }, { timezone: 'UTC', now: () => new Date() }).find((tool) => tool.name === 'draft_email')!;
    expect(await draft.handle({ to: ['a@example.com'], subject: 'Hi', body: 'Body' } as never)).toMatchObject({ ok: false, code: 'auth_failed' });
    expect(asked).toEqual(['mail']);
  });
});
