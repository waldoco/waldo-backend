import { describe, expect, it, vi } from 'vitest';
import { b64url, readConsentState } from '../src/connectors/google';
import { CONSENT_TTL_MS, finishConsent, sessionGatedExchange, startConsent, type ConsentFlow, type ConsentGrant } from '../src/connectors/google-consent';
import { consentPage, handleGoogleCallback, GOOGLE_FINISH_PATH } from '../src/channels/google-oauth';
import { googleProxy } from '../src/connectors/connections';

const app = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://w.example/oauth/google/callback' };
const SECRET = 'state-secret';

const memoryStore = () => {
  let flows: Record<string, ConsentFlow> = {};
  return { store: { read: async () => flows, write: async (next: Record<string, ConsentFlow>) => { flows = next; } }, flows: () => flows };
};

const setup = (start = 1_000_000) => {
  let now = start;
  const memory = memoryStore();
  const deps = { store: memory.store, now: () => now };
  return { deps, memory, advance: (ms: number) => { now += ms; } };
};

// The default test flow mints from telegram, matching how the chat connect affordance mints.
const begin = async (deps: Parameters<typeof startConsent>[0], owner = '5458446350', surface?: 'telegram' | 'whatsapp' | 'dashboard' | 'app') => {
  const { url, nonce } = await startConsent(deps, app, SECRET, owner, { surface });
  return { url: new URL(url), nonce };
};

describe('session-gated exchange (revoked/expired connect ticket)', () => {
  const grant: ConsentGrant = { email: 'owner@example.com', scopes: ['scope.calendar'] };

  it('claims the session BEFORE the exchange runs, and never exchanges when the ticket is revoked', async () => {
    const order: string[] = [];
    const exchange = sessionGatedExchange(async () => { order.push('exchange'); return grant; }, async () => { order.push('claim'); return false; });
    await expect(exchange('code', 'verifier', app.redirectUri)).rejects.toThrow('connect session revoked or expired');
    expect(order).toEqual(['claim']); // claim first; the revoked ticket stopped the vault write
  });

  it('an active ticket claims first, then exchanges and returns the grant', async () => {
    const order: string[] = [];
    const exchange = sessionGatedExchange(async () => { order.push('exchange'); return grant; }, async () => { order.push('claim'); return true; });
    await expect(exchange('code', 'verifier', app.redirectUri)).resolves.toEqual(grant);
    expect(order).toEqual(['claim', 'exchange']);
  });

  it('attempts without a connect session exchange directly (no claim)', async () => {
    const order: string[] = [];
    const exchange = sessionGatedExchange(async () => { order.push('exchange'); return grant; }, null);
    await expect(exchange('code', 'verifier', app.redirectUri)).resolves.toEqual(grant);
    expect(order).toEqual(['exchange']);
  });

  it('revoked ticket through the full callback: settles failed, exchange never runs, nothing stored', async () => {
    const { deps, memory } = setup();
    const { nonce } = await startConsent(deps, app, SECRET, '5458446350', { session: 'revokedhash' });
    let exchanged = 0;
    const { outcome, fresh } = await finishConsent(deps, { nonce, code: 'authcode' },
      sessionGatedExchange(async () => { exchanged += 1; return grant; }, async () => false));
    expect(fresh).toBe(true);
    expect(outcome).toEqual({ kind: 'failed', reason: 'connect session revoked or expired' });
    expect(exchanged).toBe(0);
    expect(memory.flows()[nonce]!.settled).toEqual({ kind: 'failed', reason: 'connect session revoked or expired' });
    // A replayed callback (browser reload) replays the failed outcome and still never exchanges.
    const replay = await finishConsent(deps, { nonce, code: 'authcode' },
      sessionGatedExchange(async () => { exchanged += 1; return grant; }, async () => true));
    expect(replay.fresh).toBe(false);
    expect(exchanged).toBe(0);
  });

  it('reissue race: a reissued (superseded) ticket claims false, so the stale callback cannot store', async () => {
    const { deps } = setup();
    const { nonce } = await startConsent(deps, app, SECRET, '5458446350', { session: 'oldticket' });
    // Control plane answers like a reissued flow: the old ticket is no longer active.
    let exchanged = 0;
    const { outcome } = await finishConsent(deps, { nonce, code: 'authcode' },
      sessionGatedExchange(async () => { exchanged += 1; return grant; }, async () => false));
    expect(outcome.kind).toBe('failed');
    expect(exchanged).toBe(0);
  });

  it('exchange failure after a successful claim settles a truthful failed state', async () => {
    const { deps, memory } = setup();
    const { nonce } = await startConsent(deps, app, SECRET, '5458446350', { session: 'goodticket' });
    const { outcome } = await finishConsent(deps, { nonce, code: 'authcode' },
      sessionGatedExchange(async () => { throw new Error('google 500'); }, async () => true));
    expect(outcome).toEqual({ kind: 'failed', reason: 'google 500' });
    expect(memory.flows()[nonce]!.settled?.kind).toBe('failed');
  });
});

describe('google consent attempt', () => {
  it('records the connect-session ticket hash on the attempt when started from a /c/ link (S3)', async () => {
    const { deps, memory } = setup();
    const { nonce } = await startConsent(deps, app, SECRET, '5458446350', { session: 'hashabc' });
    expect(memory.flows()[nonce]!.session).toBe('hashabc');
    const { nonce: plain } = await startConsent(deps, app, SECRET, '5458446350');
    expect(memory.flows()[plain]!.session).toBeUndefined();
  });

  it('starts with a signed one-time state and an S256 challenge whose verifier stays server-side', async () => {
    const { deps, memory } = setup();
    const { url, nonce } = await begin(deps);
    expect(await readConsentState(SECRET, url.searchParams.get('state')!)).toEqual({ owner: '5458446350', nonce });
    const flow = memory.flows()[nonce]!;
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(flow.verifier))));
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.toString()).not.toContain(flow.verifier);
    expect(flow.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.redirect_uri).toBe(app.redirectUri);
  });

  it('links once: a reloaded callback replays success and never exchanges the single-use code twice', async () => {
    const { deps } = setup();
    const { nonce } = await begin(deps);
    const exchange = vi.fn(async (): Promise<ConsentGrant> => ({ email: 'me@example.com', scopes: ['openid', 'email'] }));
    const first = await finishConsent(deps, { nonce, code: 'c1' }, exchange);
    const again = await finishConsent(deps, { nonce, code: 'c1' }, exchange);
    expect(first).toEqual({ outcome: { kind: 'linked', email: 'me@example.com', scopes: ['openid', 'email'] }, fresh: true });
    expect(again).toEqual({ outcome: first.outcome, fresh: false });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('passes the stored verifier and redirect URI to the exchange', async () => {
    const { deps, memory } = setup();
    const { nonce } = await begin(deps);
    const exchange = vi.fn(async () => ({ email: 'me@example.com', scopes: [] }));
    await finishConsent(deps, { nonce, code: 'c1' }, exchange);
    expect(exchange).toHaveBeenCalledWith('c1', memory.flows()[nonce]!.verifier, app.redirectUri);
  });

  it('a failing exchange settles as failed with the reason instead of throwing, and is not retried on reload', async () => {
    const { deps } = setup();
    const { nonce } = await begin(deps);
    const exchange = vi.fn(async (): Promise<ConsentGrant> => { throw new Error('google token failed: invalid_grant'); });
    expect(await finishConsent(deps, { nonce, code: 'c1' }, exchange)).toEqual({ outcome: { kind: 'failed', reason: 'google token failed: invalid_grant' }, fresh: true });
    expect((await finishConsent(deps, { nonce, code: 'c1' }, exchange)).outcome.kind).toBe('failed');
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('distinguishes denied, expired, unknown and code-less callbacks, exchanging nothing', async () => {
    const exchange = vi.fn(async () => ({ email: 'x', scopes: [] }));
    const denied = setup();
    const a = await begin(denied.deps);
    expect((await finishConsent(denied.deps, { nonce: a.nonce, error: 'access_denied' }, exchange)).outcome).toEqual({ kind: 'denied' });

    const late = setup();
    const b = await begin(late.deps);
    late.advance(CONSENT_TTL_MS);
    expect((await finishConsent(late.deps, { nonce: b.nonce, code: 'c1' }, exchange)).outcome).toEqual({ kind: 'expired' });

    const fresh = setup();
    expect((await finishConsent(fresh.deps, { nonce: 'never-issued', code: 'c1' }, exchange)).outcome).toEqual({ kind: 'invalid' });
    const c = await begin(fresh.deps);
    expect((await finishConsent(fresh.deps, { nonce: c.nonce }, exchange)).outcome).toEqual({ kind: 'invalid' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('a nonce from one owner attempt cannot settle another attempt', async () => {
    const { deps } = setup();
    const first = await begin(deps);
    const second = await begin(deps);
    const exchange = vi.fn(async () => ({ email: 'me@example.com', scopes: [] }));
    await finishConsent(deps, { nonce: first.nonce, code: 'c1' }, exchange);
    expect((await finishConsent(deps, { nonce: second.nonce, code: 'c2' }, exchange)).fresh).toBe(true);
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it('keeps an attempt started while another exchange was in flight', async () => {
    const { deps, memory } = setup();
    const { nonce } = await begin(deps);
    let started = '';
    await finishConsent(deps, { nonce, code: 'c1' }, async () => {
      started = (await begin(deps)).nonce;
      return { email: 'me@example.com', scopes: [] };
    });
    expect(memory.flows()[started]).toBeDefined();
    expect(memory.flows()[nonce]!.settled?.kind).toBe('linked');
  });

  it('prunes expired attempts when a new one starts', async () => {
    const { deps, memory, advance } = setup();
    const old = await begin(deps);
    advance(CONSENT_TTL_MS + 1);
    await begin(deps);
    expect(memory.flows()[old.nonce]).toBeUndefined();
  });
});

describe('consent result page', () => {
  it('shows success with the account and a Back to Telegram button for a telegram-origin flow', async () => {
    const response = consentPage({ kind: 'linked', email: 'me@example.com', scopes: [] }, 'waldo_bot', 'telegram');
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('Google is connected');
    expect(html).toContain('me@example.com');
    expect(html).toContain('href="https://t.me/waldo_bot"');
    expect(html).toContain('Back to Telegram');
  });

  it('gives every failure its own status and message', async () => {
    const pages = await Promise.all((['denied', 'expired', 'invalid'] as const).map(async (kind) => {
      const response = consentPage({ kind }, null);
      return [response.status, await response.text()] as const;
    }));
    const failed = consentPage({ kind: 'failed', reason: 'db proxy_store 500' }, null);
    expect(pages.map(([status]) => status)).toEqual([400, 410, 400]);
    expect(pages[0]![1]).toContain('was not connected');
    expect(pages[1]![1]).toContain('expired');
    expect(pages[2]![1]).toContain('not valid');
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('proxy_store');
  });

  it('escapes the account email and locks down caching, framing and the referrer carrying the code', async () => {
    const response = consentPage({ kind: 'linked', email: '<script>x</script>@e.com', scopes: [] }, null);
    expect(await response.text()).not.toContain('<script>x');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('routes each initiating surface back to where it started, with the console as the safe fallback', async () => {
    const linked = { kind: 'linked', email: null, scopes: [] } as const;
    const telegram = await consentPage(linked, 'waldo_bot', 'telegram').text();
    expect(telegram).toContain('href="https://t.me/waldo_bot"');
    const whatsapp = await consentPage(linked, null, 'whatsapp').text();
    expect(whatsapp).toContain('back to WhatsApp');
    expect(whatsapp).not.toContain('class="button"');
    const dashboard = await consentPage(linked, null, 'dashboard').text();
    expect(dashboard).toContain('href="/console"');
    expect(dashboard).toContain('Back to your console');
    const app = await consentPage(linked, null, 'app').text();
    expect(app).toContain('href="waldo://oauth/complete"');
    // no surface in the state: console fallback, never a telegram guess
    const fallback = await consentPage(linked, 'waldo_bot').text();
    expect(fallback).toContain('href="/console"');
    expect(fallback).not.toContain('t.me');
  });

  it('never renders an arbitrary return URL: every href is from the fixed allowlist', async () => {
    const linked = { kind: 'linked', email: null, scopes: [] } as const;
    for (const surface of ['telegram', 'whatsapp', 'dashboard', 'app', undefined] as const) {
      const html = await consentPage(linked, 'waldo_bot', surface).text();
      for (const href of html.match(/href="([^"]*)"/g) ?? []) {
        const target = href.slice(6, -1);
        expect(target === '/console' || target === 'waldo://oauth/complete' || target.startsWith('https://t.me/')).toBe(true);
      }
    }
  });
});

describe('google callback in the Worker', () => {
  const ownerNamespace = (reply: (body: unknown) => Promise<Response>) => {
    const calls: { name: string; url: string; body: unknown }[] = [];
    return {
      calls,
      ns: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          fetch: async (url: string, init: RequestInit) => {
            const body = JSON.parse(String(init.body));
            calls.push({ name, url, body });
            return reply(body);
          },
        }),
      },
    };
  };
  const env = (ns: unknown) => ({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_OWNER_DO: ns }) as never;
  const callback = (query: string) => new Request(`https://w.example/oauth/google/callback?${query}`);

  it('forwards a verified attempt to the owner Durable Object and renders its outcome', async () => {
    const { deps } = setup();
    const { url, nonce } = await begin(deps, 'owner.with.dots', 'telegram');
    const owner = ownerNamespace(async () => Response.json({ outcome: { kind: 'linked', email: 'me@example.com', scopes: [] }, bot: 'waldo_bot' }));
    const state = encodeURIComponent(url.searchParams.get('state')!);
    const response = await handleGoogleCallback(callback(`state=${state}&code=c1&scope=openid`), env(owner.ns));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('https://t.me/waldo_bot');
    expect(owner.calls).toEqual([{ name: 'owner.with.dots', url: `https://telegram-owner${GOOGLE_FINISH_PATH}`, body: { nonce, code: 'c1', error: null } }]);
  });

  it('drops a tampered or missing state without waking any Durable Object', async () => {
    const owner = ownerNamespace(async () => Response.json({}));
    const forged = await handleGoogleCallback(callback('state=5458446350.nonce.forgedmac&code=c1'), env(owner.ns));
    const missing = await handleGoogleCallback(callback('code=c1'), env(owner.ns));
    const deniedForged = await handleGoogleCallback(callback('state=x.y.z&error=access_denied'), env(owner.ns));
    expect([forged.status, missing.status, deniedForged.status]).toEqual([400, 400, 400]);
    expect(await forged.text()).toContain('not valid');
    expect(await deniedForged.text()).toContain('was not connected');
    expect(owner.calls).toEqual([]);
  });

  it('shows the failure page, never a blank error, when the owner Durable Object fails', async () => {
    const { deps } = setup();
    const { url } = await begin(deps);
    const owner = ownerNamespace(async () => { throw new Error('do reset'); });
    const response = await handleGoogleCallback(callback(`state=${encodeURIComponent(url.searchParams.get('state')!)}&code=c1`), env(owner.ns));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('could not be connected');
  });

  it('keeps the signed surface on the failure page: a telegram-origin failure routes back to Telegram, a dashboard-origin failure to the console', async () => {
    const { deps } = setup();
    const owner = ownerNamespace(async () => { throw new Error('do reset'); });
    // telegram origin: failure must NOT strand the owner on /console
    const tg = await begin(deps, '5458446350', 'telegram');
    const tgResponse = await handleGoogleCallback(callback(`state=${encodeURIComponent(tg.url.searchParams.get('state')!)}&code=c1`), env(owner.ns));
    expect(tgResponse.status).toBe(502);
    const tgHtml = await tgResponse.text();
    expect(tgHtml).toContain('go back to Telegram');
    expect(tgHtml).not.toContain('Back to your console');
    // dashboard origin: failure keeps the console back-link
    const dash = await begin(deps, '5458446350', 'dashboard');
    const dashResponse = await handleGoogleCallback(callback(`state=${encodeURIComponent(dash.url.searchParams.get('state')!)}&code=c1`), env(owner.ns));
    expect(dashResponse.status).toBe(502);
    expect(await dashResponse.text()).toContain('Back to your console');
  });
});

describe('connector proxy exchange', () => {
  it('sends the PKCE verifier inside the signed body', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'conn1', email: 'me@example.com', scopes: ['openid'] }));
    const proxy = googleProxy({ SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' }, fetcher as unknown as typeof fetch, () => 1_790_000_000_000)!;
    expect(await proxy.exchange('owner', 'c1', app.redirectUri, 'verifier1')).toEqual({ id: 'conn1', email: 'me@example.com', scopes: ['openid'] });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ do_name: 'owner', op: 'exchange', code: 'c1', redirect_uri: app.redirectUri, code_verifier: 'verifier1' });
  });
});
