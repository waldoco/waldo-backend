import { describe, expect, it } from 'vitest';
import { canonicalRedirect } from '../src/channels/canonical-host';
import { consoleCrossSiteRefusal } from '../src/channels/console-cross-site';

const env = { WALDO_PUBLIC_ORIGIN: 'https://staging.fixture.invalid' };
const get = (url: string, init: RequestInit = {}) => new Request(url, { redirect: 'manual', ...init });

describe('canonicalRedirect', () => {
  it('sends a browser opening a connect ticket or a console page on another host to the configured one, path and query kept', () => {
    for (const path of ['/c/AbCdEfGhIjKlMnOpQrStUv?handoff=AbCdEfGhIjKlMnOpQrStUv', '/console', '/console/signup', '/console/imessage', '/console/whatsapp/link?x=1']) {
      const response = canonicalRedirect(get(`https://old-host.fixture.invalid${path}`), env);
      expect(response?.status).toBe(307);
      expect(response?.headers.get('location')).toBe(`https://staging.fixture.invalid${path}`);
      expect(response?.headers.get('cache-control')).toBe('no-store');
    }
    expect(canonicalRedirect(get('https://old-host.fixture.invalid/console', { method: 'HEAD' }), env)?.status).toBe(307);
  });

  it('leaves the configured host, an unset environment and non-browser routes alone', () => {
    expect(canonicalRedirect(get('https://staging.fixture.invalid/console'), env)).toBeNull();
    expect(canonicalRedirect(get('https://old-host.fixture.invalid/console'), {})).toBeNull();
    for (const path of ['/healthz', '/app/v1/chat/main', '/telegram/webhook', '/events/gcal', '/oauth/google/callback', '/oauth/mcp/callback', '/imessage/photon/callback', '/consolex', '/cx'])
      expect(canonicalRedirect(get(`https://old-host.fixture.invalid${path}`), env)).toBeNull();
  });

  it('never moves a sign-in callback, a form post or a page script call: their binding or cookie lives on the host they started on', () => {
    expect(canonicalRedirect(get('https://old-host.fixture.invalid/console/signin/google/callback?code=x&state=y'), env)).toBeNull();
    expect(canonicalRedirect(get('https://old-host.fixture.invalid/console/action', { method: 'POST', body: 'a=1' }), env)).toBeNull();
    expect(canonicalRedirect(get('https://old-host.fixture.invalid/console/dashboard/api/v1/overview', { headers: { 'sec-fetch-mode': 'cors' } }), env)).toBeNull();
    expect(canonicalRedirect(get('https://old-host.fixture.invalid/console', { headers: { 'sec-fetch-mode': 'navigate' } }), env)?.status).toBe(307);
  });

  it('a redirected link is served on the configured host although the browser now calls it cross-site', () => {
    const redirected = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };
    for (const path of ['/console?t=c1.fixture', '/console/signup', '/console/whatsapp/link/AbCdEfGh', '/c/AbCdEfGhIjKlMnOpQrStUv']) {
      const request = get(`https://staging.fixture.invalid${path}`, { headers: redirected });
      expect(canonicalRedirect(request, env)).toBeNull();
      expect(consoleCrossSiteRefusal(request)).toBeNull();
    }
  });
});
