import { describe, expect, it } from 'vitest';
import { bindBrowser, checkBrowser, releaseBrowser } from '../src/connectors/oauth-browser-binding';
import { constantTimeEqual } from '../src/connectors/constant-time';

const NONCE = 'N'.repeat(43);
const NOW = 1_790_000_000_000;
const TTL = 15 * 60_000;
const PATH = '/oauth/mcp/callback';

// The browser as the binding sees it: the name=value pair a Set-Cookie leaves in the jar.
const jarEntry = (setCookie: string) => setCookie.split(';')[0]!;
const callback = (...cookies: string[]) => new Request(`https://waldo.example${PATH}?state=x`, cookies.length ? { headers: { cookie: cookies.join('; ') } } : {});

describe('the browser binding every OAuth callback shares', () => {
  // __Host- makes the browser refuse any version of this cookie set by a sibling subdomain or with a Domain or a narrower
  // path, so another host under the same site cannot plant or overwrite the binding.
  it('sets a __Host- cookie, HttpOnly, Secure, SameSite=Lax, that lasts no longer than the attempt', async () => {
    const set = await bindBrowser('mcp', NONCE, TTL, NOW);
    const attributes = set.split('; ').slice(1);
    expect(attributes).toEqual(['Path=/', 'Max-Age=900', 'HttpOnly', 'Secure', 'SameSite=Lax']);
    expect(set).toMatch(/^__Host-waldo-oauth-[A-Za-z0-9_-]{16}=/);
    expect(set).not.toContain('Domain=');
    expect(set).not.toContain(NONCE);
  });

  it('admits the browser that started the attempt', async () => {
    const set = await bindBrowser('mcp', NONCE, TTL, NOW);
    expect(await checkBrowser(callback('other=1', jarEntry(set)), 'mcp', NONCE, NOW + 1_000)).toBe('bound');
  });

  it('refuses a browser with no cookie, another attempt\'s cookie, or another provider\'s cookie', async () => {
    const other = await bindBrowser('mcp', 'O'.repeat(43), TTL, NOW);
    const google = await bindBrowser('google', NONCE, TTL, NOW);
    expect(await checkBrowser(callback(), 'mcp', NONCE, NOW)).toBe('missing');
    expect(await checkBrowser(callback(jarEntry(other)), 'mcp', NONCE, NOW)).toBe('missing');
    expect(await checkBrowser(callback(jarEntry(google)), 'mcp', NONCE, NOW)).toBe('missing');
  });

  it('refuses a cookie whose value was altered, including a pushed-out expiry', async () => {
    const [name, value] = jarEntry(await bindBrowser('mcp', NONCE, TTL, NOW)).split('=') as [string, string];
    const [expires, digest] = value.split('.') as [string, string];
    expect(await checkBrowser(callback(`${name}=${expires}.${digest.slice(1)}A`), 'mcp', NONCE, NOW)).toBe('mismatch');
    expect(await checkBrowser(callback(`${name}=${Number(expires) + 3_600_000}.${digest}`), 'mcp', NONCE, NOW)).toBe('mismatch');
    expect(await checkBrowser(callback(`${name}=garbage`), 'mcp', NONCE, NOW)).toBe('mismatch');
  });

  it('refuses a cookie past the attempt lifetime even when the browser still sends it', async () => {
    const set = await bindBrowser('mcp', NONCE, TTL, NOW);
    expect(await checkBrowser(callback(jarEntry(set)), 'mcp', NONCE, NOW + TTL - 1)).toBe('bound');
    expect(await checkBrowser(callback(jarEntry(set)), 'mcp', NONCE, NOW + TTL)).toBe('expired');
  });

  it('clears exactly the attempt\'s cookie once the callback has used it', async () => {
    const set = await bindBrowser('mcp', NONCE, TTL, NOW);
    const cleared = await releaseBrowser('mcp', NONCE);
    expect(cleared.split('=')[0]).toBe(set.split('=')[0]);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/;');
  });
});

describe('the constant-time compare', () => {
  it('is true only for identical text, whatever the lengths', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
    expect(constantTimeEqual('ab', 'abc')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('é', 'é')).toBe(false);
  });
});
