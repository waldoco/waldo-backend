import { describe, expect, it, vi } from 'vitest';
import { egressTarget, EgressError, guardedFetch } from '../src/connectors/egress';

const refused = (fn: () => unknown, code: string) => {
  try { fn(); } catch (error) { expect(error).toBeInstanceOf(EgressError); expect((error as EgressError).code).toBe(code); return; }
  throw new Error('expected a refusal');
};

describe('egressTarget', () => {
  it('accepts a public https URL and drops the fragment', () => {
    expect(egressTarget('https://mcp.example.com/mcp#x').toString()).toBe('https://mcp.example.com/mcp');
    expect(egressTarget('https://mcp.example.com:443/mcp').toString()).toBe('https://mcp.example.com/mcp');
  });
  it.each([
    ['http://mcp.example.com/mcp', 'egress_scheme'],
    ['ftp://mcp.example.com/', 'egress_scheme'],
    ['https://user:pass@mcp.example.com/', 'egress_credentials'],
    ['https://mcp.example.com:8443/', 'egress_port'],
    ['https://localhost/mcp', 'egress_host'],
    ['https://api.localhost/', 'egress_host'],
    ['https://169.254.169.254/latest/meta-data', 'egress_host'],
    ['https://metadata.google.internal/', 'egress_host'],
    ['https://10.0.0.7/', 'egress_host'],
    ['https://192.168.1.1/', 'egress_host'],
    ['https://[::1]/', 'egress_host'],
    ['https://[fd00::1]/', 'egress_host'],
    ['https://intranet/', 'egress_host'],
    ['https://db.svc/', 'egress_host'],
    ['not a url', 'egress_malformed'],
  ])('refuses %s', (url, code) => refused(() => egressTarget(url), code));
});

const respond = (status: number, body = '', headers: Record<string, string> = {}) => new Response(status >= 300 && status < 400 ? null : body, { status, headers });

describe('guardedFetch', () => {
  it('follows a GET redirect only to another public host, re-checking each hop', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes('first') ? respond(302, '', { location: 'https://second.example.com/doc' }) : respond(200, '{"ok":true}'));
    const out = await guardedFetch(fetcher as typeof fetch, 'https://first.example.com/doc', {}, { redirects: 2, maxBytes: 1000, timeoutMs: 1000 });
    expect(out).toMatchObject({ status: 200, text: '{"ok":true}', url: 'https://second.example.com/doc' });
    expect(fetcher.mock.calls.map(([, init]) => (init as RequestInit).redirect)).toEqual(['manual', 'manual']);
  });
  it('refuses a redirect into the metadata address (SSRF by redirect)', async () => {
    const fetcher = vi.fn(async () => respond(307, '', { location: 'https://169.254.169.254/latest/meta-data/iam' }));
    await expect(guardedFetch(fetcher as typeof fetch, 'https://evil.example.com/.well-known/oauth-protected-resource', {}, { redirects: 3, maxBytes: 1000, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'egress_host' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('never follows a redirect on a POST, so a token request cannot be bounced elsewhere', async () => {
    const fetcher = vi.fn(async () => respond(307, '', { location: 'https://collector.example.net/token' }));
    await expect(guardedFetch(fetcher as typeof fetch, 'https://auth.example.com/token', { method: 'POST', body: 'x' }, { redirects: 3, maxBytes: 1000, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'egress_redirect' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses an origin the connection did not pin', async () => {
    const fetcher = vi.fn(async () => respond(200, 'x'));
    await expect(guardedFetch(fetcher as typeof fetch, 'https://other.example.com/mcp', { method: 'POST' }, { pinned: ['https://mcp.example.com'], maxBytes: 10, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'egress_unpinned' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses a body past the cap, by declared length or while streaming', async () => {
    await expect(guardedFetch((async () => respond(200, 'x'.repeat(11), { 'content-length': '11' })) as typeof fetch, 'https://mcp.example.com/', {}, { maxBytes: 10, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'egress_oversize' });
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 5; i += 1) c.enqueue(new TextEncoder().encode('abcd')); c.close(); } });
    await expect(guardedFetch((async () => new Response(stream)) as typeof fetch, 'https://mcp.example.com/', {}, { maxBytes: 10, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'egress_oversize' });
    await expect(guardedFetch((async () => respond(200, 'abcdefghij')) as typeof fetch, 'https://mcp.example.com/', {}, { maxBytes: 10, timeoutMs: 1000 })).resolves.toMatchObject({ text: 'abcdefghij' });
  });
  it('maps a network failure and a timeout to typed codes', async () => {
    await expect(guardedFetch((async () => { throw new TypeError('fetch failed'); }) as typeof fetch, 'https://gone.example.com/', {}, { maxBytes: 10, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'egress_network' });
    await expect(guardedFetch((async () => { throw new DOMException('timed out', 'TimeoutError'); }) as typeof fetch, 'https://slow.example.com/', {}, { maxBytes: 10, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'egress_timeout' });
  });
});
