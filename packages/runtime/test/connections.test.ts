import { describe, expect, it, vi } from 'vitest';
import { googleProxy } from '../src/connectors/connections';
import { consentState, GoogleError, googleClient, googleHas, readConsentState, type GoogleClient } from '../src/connectors/google';
import { renderConsole } from '../src/channels/console';
import { SAMPLE_CONSOLE_VIEW } from './fixtures/console-sample';
import { googleHandlers } from '../src/tools/live/google';
import { hex, routerSignature } from '../src/identity/owner-directory';

const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
const at = 1_790_000_000;

describe('google proxy', () => {
  const proxyOf = (fetcher: ReturnType<typeof vi.fn>) => googleProxy(env, fetcher as unknown as typeof fetch, () => at * 1000)!;
  const sent = (fetcher: ReturnType<typeof vi.fn>, call = 0) => fetcher.mock.calls[call] as [string, RequestInit];

  it('is off without Supabase', () => {
    expect(googleProxy({})).toBeNull();
  });

  it('signs the whole body, so a call cannot be redirected to another owner or connection', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));
    await proxyOf(fetcher).client('do-a', 'c-1').events('a', 'b', 5, false);
    const [url, init] = sent(fetcher);
    expect(url).toBe('https://db.test/functions/v1/connector-proxy');
    const raw = String(init.body);
    expect(JSON.parse(raw)).toEqual({ do_name: 'do-a', op: 'call', connection: 'c-1', method: 'events', args: ['a', 'b', 5, false] });
    const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
    expect((init.headers as Record<string, string>)['x-waldo-sig']).toBe(await routerSignature('router', at, `proxy.${hash}`));
  });

  it('never sends or receives a token on a call; the runtime only holds the connection id', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { draft_id: 'd1' } })));
    expect(await proxyOf(fetcher).client('do-a', 'c-1').draft({ to: ['x@y.test'], subject: 's', body: 'b' })).toEqual({ draft_id: 'd1' });
    expect(String(sent(fetcher)[1].body)).not.toMatch(/refresh_token|access_token/);
  });

  it('maps a refresh failure to health and a scope gap to a 403 GoogleError', async () => {
    const health = vi.fn();
    const refused = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { status: 401, message: 'google token failed: invalid_grant' } })));
    await expect(proxyOf(refused).client('do-a', 'c-1', health).events('a', 'b', 1, false)).rejects.toThrow('invalid_grant');
    expect(health).toHaveBeenLastCalledWith('google token failed: invalid_grant');
    const scoped = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { status: 403, message: 'insufficient scopes' } })));
    await expect(proxyOf(scoped).client('do-a', 'c-1').newMail(0, 1)).rejects.toMatchObject({ status: 403 });
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
  it('a mail tool on a calendar-only grant sends the consent button for mail, not a retry and not a URL', async () => {
    const client = { draft: async () => { throw new GoogleError(403, 'google 403: insufficient scopes'); } } as unknown as GoogleClient;
    const asked: string[] = [];
    const google = { client: async () => client, connectUrl: async (feature: string) => (asked.push(feature), `https://accounts.google.com/x?f=${feature}&state=s`) };
    const draft = googleHandlers(google, { propose: async () => 'p', record: () => undefined }, { timezone: 'UTC', now: () => new Date() }, async () => true).find((tool) => tool.name === 'draft_email')!;
    const result = await draft.handle({ to: ['a@example.com'], subject: 'Hi', body: 'Body' } as never);
    expect(result).toMatchObject({ ok: false, code: 'auth_failed', error: expect.stringContaining('connect button was sent') });
    expect(JSON.stringify(result)).not.toMatch(/https?:|state=/);
    expect(asked).toEqual(['mail']);
  });
});

describe('several Google accounts', () => {
  it('a grant from before per-feature scopes keeps working for every feature', () => {
    expect(googleHas(null, 'mail')).toBe(true);
    expect(googleHas([], 'mail')).toBe(false);
  });

  it('the OAuth state carries a dotted owner name intact, and a tampered one fails', async () => {
    const state = await consentState('s', 'owner.with.dots', 'n1');
    expect(await readConsentState('s', state)).toEqual({ owner: 'owner.with.dots', nonce: 'n1' });
    expect(await readConsentState('s', state.replace('owner.with', 'owner.other'))).toBeNull();
  });

  it('shows one row per account, each with its own disconnect and health', () => {
    const html = renderConsole({ ...SAMPLE_CONSOLE_VIEW, google: { connectAvailable: true, accounts: [
      { id: 'c-1', email: 'me@work.test', error: null, mail: true },
      { id: 'c-2', email: 'me@home.test', error: 'invalid_grant', mail: false },
    ] } });
    expect(html).toContain('Google: me@work.test');
    expect(html).toContain('name="id" value="c-2"');
    expect(html).toContain('Needs reconnect');
    expect(html).toContain('Add account');
  });
});
