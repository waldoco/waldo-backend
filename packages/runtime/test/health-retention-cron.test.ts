import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const env = (over: Record<string, string> = {}) => ({ SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret-00000000000000000', ...over }) as never;
afterEach(() => { vi.unstubAllGlobals(); });

describe('scheduled health retention', () => {
  it('runs one signed sweep off the request path when the cron fires', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { urls.push(`${url} ${String(init.body).includes('"p_sig"')}`); return Response.json({ owners: 0, more: false, raw_deleted: 0, requests_deleted: 0, context_deleted: 0 }); });
    const work: Promise<unknown>[] = [];
    await worker.scheduled!({} as never, env(), { waitUntil: (p: Promise<unknown>) => { work.push(p); } } as never);
    expect(work).toHaveLength(1);
    await Promise.all(work);
    expect(urls).toEqual(['https://directory.fixture.invalid/rest/v1/rpc/health_retention_sweep true']);
  });

  it('also keeps an idle Photon connection alive, without failing the cron, when Photon is configured', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ owners: 0, more: false, raw_deleted: 0, requests_deleted: 0, context_deleted: 0 }));
    const work: Promise<unknown>[] = [];
    await worker.scheduled!({} as never, env({ PHOTON_PROJECT_ID: 'proj-fixture', PHOTON_OAUTH_CLIENT_ID: 'client-fixture', PHOTON_OAUTH_CLIENT_SECRET: 'fictional-photon-client-secret' }),
      { waitUntil: (p: Promise<unknown>) => { work.push(p); } } as never);
    expect(work).toHaveLength(2);
    await expect(Promise.all(work)).resolves.toHaveLength(2);
  });

  it('does nothing, and does not fail the cron, when the database is not configured or is down', async () => {
    const work: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { work.push(p); } } as never;
    await worker.scheduled!({} as never, env({ WALDO_ROUTER_HMAC_SECRET: '' }), ctx);
    vi.stubGlobal('fetch', async () => { throw new Error('down'); });
    await worker.scheduled!({} as never, env(), ctx);
    await expect(Promise.all(work)).resolves.toHaveLength(2);
  });
});
