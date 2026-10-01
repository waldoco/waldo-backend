import { describe, expect, it, vi } from 'vitest';
import { DASHBOARD_OVERVIEW_PATH } from '../src/channels/dashboard-overview';
import { serveDashboard } from '../src/channels/dashboard-static';
const root = 'https://waldo.test';
const url = (path: string, method = 'GET') => new Request(root + path, { method });
const assets = (status = 200) => ({ fetch: vi.fn(async (req: Request) => new Response(status === 200 ? 'built-file' : 'not found', { status, headers: { 'cache-control': 'public', 'content-type': 'text/plain' } })) }) as unknown as Fetcher;
const auth = (status = 200) => vi.fn(async () => new Response(status === 200 ? '{}' : 'unauthorized', { status }));
describe('dashboard static adapter', () => {
  it('gates the index through the exact same owner-scoped API session and never fetches assets for unsigned owners', async () => {
    const asset = assets(); const verify = auth(401);
    const response = await serveDashboard(url('/console/dashboard'), asset, verify);
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe('/console/signin');
    expect(response?.headers.get('cache-control')).toBe('private, no-store');
    expect(response?.headers.get('x-frame-options')).toBe('DENY');
    expect(response?.headers.get('referrer-policy')).toBe('no-referrer');
    expect((asset.fetch as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(new URL((verify.mock.calls[0] as unknown as [Request])[0].url).pathname).toBe(DASHBOARD_OVERVIEW_PATH);
    const unavailable = await serveDashboard(url('/console/dashboard/'), assets(), auth(503));
    expect(unavailable?.status).toBe(503);
  });
  it('serves the new root and authenticates HEAD via GET without stealing ticket, notice, JSON or POST routes', async () => {
    for (const method of ['GET', 'HEAD']) {
      const verify = auth();
      expect((await serveDashboard(url('/console', method), assets(), verify))?.status).toBe(200);
      expect((verify.mock.calls[0] as unknown as [Request])[0].method).toBe('GET');
    }
    for (const path of ['/console?t=one-use', '/console?m=invalid', '/console/legacy', '/console/waiting']) {
      expect(await serveDashboard(url(path), assets(), auth())).toBeNull();
    }
    expect(await serveDashboard(url('/console', 'POST'), assets(), auth())).toBeNull();
    expect(await serveDashboard(new Request(root + '/console', { headers: { accept: 'application/json' } }), assets(), auth())).toBeNull();
  });
  it('serves only the authenticated shell HTML, with no-store and anti-framing headers', async () => {
    const asset = assets(); const verify = auth();
    const response = await serveDashboard(url('/console/dashboard/'), asset, verify);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toContain('text/html');
    expect(response?.headers.get('cache-control')).toBe('private, no-store');
    expect(new URL(((asset.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request])[0].url).pathname).toBe('/console/dashboard/index.html');
    expect(verify).toHaveBeenCalledOnce();
  });
  it('serves public content-hashed JS/CSS only, not the API, stale or arbitrary assets, or post requests', async () => {
    const asset = assets(); const verify = auth();
    const js = await serveDashboard(url('/console/dashboard/assets/index-CRNlKF7e.js'), asset, verify);
    expect(js?.status).toBe(200);
    expect(js?.headers.get('content-type')).toContain('text/javascript');
    expect(js?.headers.get('cache-control')).toContain('immutable');
    expect(verify).not.toHaveBeenCalled();
    for (const path of ['/console/dashboard/assets/index.js', '/console/dashboard/assets/../../secrets', '/console/dashboard/assets/favicon.svg', '/console/dashboard/assets/index-12345678.js/extra']) {
      expect((await serveDashboard(url(path), asset, verify))?.status ?? 404).toBe(404);
    }
    expect((await serveDashboard(url('/console/dashboard/assets/index-CRNlKF7e.js', 'POST'), asset, verify))?.status).toBe(405);
    expect(await serveDashboard(url(DASHBOARD_OVERVIEW_PATH), asset, verify)).toBeNull();
  });
  it('does not fall back to the shell for missing assets or leak an asset binding failure', async () => {
    expect((await serveDashboard(url('/console/dashboard/assets/index-CRNlKF7e.js'), assets(404), auth()))?.status).toBe(404);
    expect((await serveDashboard(url('/console/dashboard'), undefined, auth()))?.status).toBe(503);
  });
});
