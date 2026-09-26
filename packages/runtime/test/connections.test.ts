import { describe, expect, it, vi } from 'vitest';
import { googleProxy } from '../src/connectors/connections';
import { consentState, GoogleError, googleClient, googleHas, readConsentState, type GoogleClient, b64url } from '../src/connectors/google';
import { renderConsole } from '../src/channels/console';
import { SAMPLE_CONSOLE_VIEW } from './fixtures/console-sample';
import { googleHandlers } from '../src/tools/live/google';
import { hex, routerSignature } from '../src/identity/owner-directory';

const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
const at = 1_790_000_000;

describe('google proxy', () => {
  const proxyOf = (fetcher: ReturnType<typeof vi.fn>) => googleProxy(env, fetcher as unknown as typeof fetch, () => at * 1000)!;

  it('routes profileEmail through the signed, mail-scoped proxy with no arguments', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(String(init.body));
      return Response.json({ data: 'owner@example.com' });
    });
    expect(await proxyOf(fetcher).client('do-a', 'c-1').profileEmail()).toBe('owner@example.com');
    expect(JSON.parse(calls[0]!)).toMatchObject({ op: 'call', method: 'profileEmail', connection: 'c-1', args: [] });
    expect(JSON.parse(calls[0]!)).not.toHaveProperty('intent');
  });
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

  it('carries a shape-valid turn correlation key in the signed body; invalid shapes are dropped before signing', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ data: [] }))));
    // success path: the opaque turn trace id rides the signed body for EF log correlation
    await proxyOf(fetcher).client('do-a', 'c-1', undefined, undefined, 'tg-904957567').events('a', 'b', 5, false);
    expect(JSON.parse(String(sent(fetcher, 0)[1].body)).trace).toBe('tg-904957567');
    // failure path: invalid shapes never leave the Worker (the EF also rejects them)
    await proxyOf(fetcher).client('do-a', 'c-1', undefined, undefined, 'not a trace!').events('a', 'b', 5, false);
    expect(JSON.parse(String(sent(fetcher, 1)[1].body))).not.toHaveProperty('trace');
    await proxyOf(fetcher).client('do-a', 'c-1', undefined, undefined, `tg-${'x'.repeat(100)}`).events('a', 'b', 5, false);
    expect(JSON.parse(String(sent(fetcher, 2)[1].body))).not.toHaveProperty('trace');
  });

  it('routes tasks, sendRaw and findSentByMessageId through the owner-bound signed call', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ data: null }))));
    const client = proxyOf(fetcher).client('do-a', 'c-1', undefined, 'email_send:prop-1');
    await client.tasks('todo', 20);
    await client.sendRaw('To: a@b.test\r\n\r\nhi', 'thread-1');
    await client.findSentByMessageId('<m@waldo-send>');
    const bodies = fetcher.mock.calls.map((call) => JSON.parse(String((call[1] as { body: string }).body)));
    const methods = bodies.map((body) => body.method);
    expect(methods).toEqual(['tasks', 'sendRaw', 'findSentByMessageId']);
    // the approval-intent id rides only on sendRaw; other methods carry no intent field
    expect(bodies[1].intent).toBe('email_send:prop-1');
    expect(bodies[0]).not.toHaveProperty('intent');
    expect(bodies[2]).not.toHaveProperty('intent');
    // every call is signed and carries the connection id, never a token
    for (const call of fetcher.mock.calls) {
      const init = call[1] as { headers: Record<string, string>; body: string };
      expect(init.headers['x-waldo-sig']).toBeTruthy();
      expect(String(init.body)).toContain('"connection":"c-1"');
      expect(String(init.body)).not.toMatch(/refresh_token|access_token/);
    }
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
  it('a mail tool on a calendar-only grant reports a scope_missing intent for mail, not a retry and not a URL', async () => {
    const client = { draft: async () => { throw new GoogleError(403, 'google 403: insufficient scopes'); } } as unknown as GoogleClient;
    const google = { client: async () => client, mailSender: async () => ({ ok: true as const, client, connection: 'conn-1', email: 'owner@example.com' }) };
    const draft = googleHandlers(google, { propose: async () => 'p', proposeSendEmail: async () => ({ ok: true as const, id: 'p', reused: null }), record: () => undefined }, { timezone: 'UTC', now: () => new Date() }).find((tool) => tool.name === 'draft_email')!;
    const result = await draft.handle({ to: ['a@example.com'], subject: 'Hi', body: 'Body' } as never);
    expect(result).toMatchObject({
      ok: false, code: 'auth_failed',
      connect: { status: 'auth_required', service: 'google', reason: 'scope_missing', feature: 'mail' },
    });
    expect(JSON.stringify(result)).not.toMatch(/https?:|state=/);
  });
});

describe('gmail send boundary', () => {
  const app = { clientId: 'c', clientSecret: 's', redirectUri: 'https://r.test' };
  const tokenOk = () => new Response(JSON.stringify({ access_token: 'at' }));

  it('b64url encodes near the 1MB proxy arg bound without a RangeError, byte-exact round trip', () => {
    // 200k bytes previously threw RangeError via String.fromCharCode(...bytes) spread; the
    // chunked helper must cover the full range the proxy accepts.
    const big = new Uint8Array(200 * 1024).map((_, i) => i % 256);
    const encoded = b64url(big);
    const decoded = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(big);
  });

  it('sendRaw posts base64url-encoded MIME as Message.raw - exactly once, never plain RFC2822', async () => {
    const bodies: string[] = [];
    const fetcher = vi.fn().mockImplementation((url: string, init?: { body?: string }) => {
      if (String(url).includes('oauth2') || String(url).includes('token')) return Promise.resolve(tokenOk());
      bodies.push(String(init?.body));
      return Promise.resolve(new Response(JSON.stringify({ id: 'g1', threadId: 't1' })));
    });
    const mime = 'To: a@x.test\r\nSubject: Hello+World/1?\r\n\r\nBody text';
    const out = await googleClient(app, { refresh_token: 'rt' }, fetcher as unknown as typeof fetch).sendRaw(mime, 't1');
    expect(out).toEqual({ message_id: 'g1', thread_id: 't1' });
    expect(bodies).toHaveLength(1);
    const sent = JSON.parse(bodies[0]!) as { raw: string; threadId: string };
    // base64url of the exact MIME bytes: no '+', '/', '=' and never the plain text
    expect(sent.raw).toBe(b64url(new TextEncoder().encode(mime)));
    expect(sent.raw).not.toContain('To: a@x.test');
    expect(sent.raw).not.toMatch(/[+/=]/);
    expect(sent.threadId).toBe('t1');
  });

  it('findSentByMessageId reconciles via the rfc822msgid Sent query, not a body guess', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('token')) return Promise.resolve(tokenOk());
      urls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ messages: [{ id: 'g9' }] })));
    });
    const found = await googleClient(app, { refresh_token: 'rt' }, fetcher as unknown as typeof fetch).findSentByMessageId('<abc@waldo-send>');
    expect(found).toBe(true);
    expect(urls[0]).toContain('in%3Asent');
    expect(urls[0]).toContain('rfc822msgid%3Aabc%40waldo-send');
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

  it('the OAuth state carries the initiating surface through the signature, and a tampered surface fails', async () => {
    for (const surface of ['telegram', 'whatsapp', 'dashboard', 'app'] as const) {
      const state = await consentState('s', 'owner.with.dots', 'n1', surface);
      expect(await readConsentState('s', state)).toEqual({ owner: 'owner.with.dots', nonce: 'n1', surface });
    }
    // editing the surface breaks the MAC
    const state = await consentState('s', 'o', 'n1', 'telegram');
    expect(await readConsentState('s', state.replace('telegram', 'dashboard'))).toBeNull();
    // an unknown surface shape fails verification outright
    const forged = await consentState('s', 'o', 'n1');
    expect(await readConsentState('s', forged.replace('.n1.', '.evil.'))).toBeNull();
    // pre-surface states still verify, surface undefined (console fallback on the page)
    expect(await readConsentState('s', forged)).toEqual({ owner: 'o', nonce: 'n1' });
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
