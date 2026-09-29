import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../src/index';
const ORIGIN = 'https://waldo.invalid';
describe('dashboard worker dispatch', () => {
  it('does not disclose the shell to unauthenticated callers', async () => {
    const res = await worker.fetch(new Request(ORIGIN + '/console/dashboard'), env);
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
  it('serves public versioned code but never maps unknown assets or the API to HTML', async () => {
    const code = await worker.fetch(new Request(ORIGIN + '/console/dashboard/assets/index-CRNlKF7e.js'), env);
    expect(code.status).toBe(200);
    expect(code.headers.get('content-type')).toContain('text/javascript');
    expect((await code.text()).length).toBeGreaterThan(100);
    const stale = await worker.fetch(new Request(ORIGIN + '/console/dashboard/assets/index-AAAAAAAA.js'), env);
    expect(stale.status).toBe(404);
    const api = await worker.fetch(new Request(ORIGIN + '/console/dashboard/api/v1/overview'), env);
    expect(api.status).not.toBe(200);
    expect(await api.text()).not.toContain('<html');
  });
});
