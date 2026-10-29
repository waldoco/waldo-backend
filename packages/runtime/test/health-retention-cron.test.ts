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

describe('scheduled Langfuse retention', () => {
  const LANGFUSE = { LANGFUSE_PUBLIC_KEY: 'pk-lf-synthetic', LANGFUSE_SECRET_KEY: 'sk-lf-synthetic', LANGFUSE_BASE_URL: 'https://langfuse.test' };

  it('adds nothing to the cron while switched off, even with Langfuse configured', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ owners: 0, more: false, raw_deleted: 0, requests_deleted: 0, context_deleted: 0 }));
    for (const flag of [{}, { LANGFUSE_RETENTION_SWEEP: '0' }] as Record<string, string>[]) {
      const work: Promise<unknown>[] = [];
      await worker.scheduled!({} as never, env({ ...LANGFUSE, ...flag }), { waitUntil: (p: Promise<unknown>) => { work.push(p); } } as never);
      expect(work).toHaveLength(1);
    }
  });

  it('logs the sweep as an error when traces are already past the thirty days promised', async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (!url.startsWith('https://langfuse.test')) return Response.json({ owners: 0, more: false, raw_deleted: 0, requests_deleted: 0, context_deleted: 0 });
      if (url.includes('/projects')) return Response.json({ data: [{ id: 'proj' }] });
      return url.includes('/v2/metrics') ? Response.json({ data: [{ count_count: '3' }] }) : new Response('no', { status: 401 });
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const work: Promise<unknown>[] = [];
    await worker.scheduled!({} as never, env({ ...LANGFUSE, LANGFUSE_RETENTION_SWEEP: 'dry' }), { waitUntil: (p: Promise<unknown>) => { work.push(p); } } as never);
    await Promise.all(work);
    expect(errors.mock.calls.map(args => String(args[0])).find(line => line.startsWith('langfuse retention sweep'))).toContain('overdue=3');
    errors.mockRestore();
  }, 30_000);

  it('in dry-run reads Langfuse and sends no delete', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
      if (!String(input).startsWith('https://langfuse.test')) return Response.json({ owners: 0, more: false, raw_deleted: 0, requests_deleted: 0, context_deleted: 0 });
      methods.push(init.method ?? 'GET');
      return String(input).includes('/projects') ? Response.json({ data: [{ id: 'proj' }] }) : Response.json({ data: [], meta: {} });
    });
    const work: Promise<unknown>[] = [];
    await worker.scheduled!({} as never, env({ ...LANGFUSE, LANGFUSE_RETENTION_SWEEP: 'dry' }), { waitUntil: (p: Promise<unknown>) => { work.push(p); } } as never);
    expect(work).toHaveLength(2);
    await Promise.all(work);
    expect(methods.length).toBeGreaterThan(1);
    expect(methods.every(method => method === 'GET')).toBe(true);
  }, 30_000);

  it('runs the sweep beside the health sweep when switched on, without failing the cron when Langfuse refuses', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      urls.push(String(input).split('?')[0]!);
      return String(input).startsWith('https://langfuse.test') ? new Response('unauthorized', { status: 401 }) : Response.json({ owners: 0, more: false, raw_deleted: 0, requests_deleted: 0, context_deleted: 0 });
    });
    const work: Promise<unknown>[] = [];
    await worker.scheduled!({} as never, env({ ...LANGFUSE, LANGFUSE_RETENTION_SWEEP: '1' }), { waitUntil: (p: Promise<unknown>) => { work.push(p); } } as never);
    expect(work).toHaveLength(2);
    await expect(Promise.all(work)).resolves.toHaveLength(2);
    expect(urls).toContain('https://langfuse.test/api/public/projects');
  });
});
