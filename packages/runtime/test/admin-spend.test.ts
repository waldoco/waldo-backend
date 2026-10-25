import { describe, expect, it, vi } from 'vitest';
import { ADMIN_COST_ROW_CAP, adminCostSummarySchema, adminSpend } from '../src/channels/admin-spend';
import { renderAdmin } from '../src/channels/console-admin';
import { adminRead } from '../src/channels/dashboard-admin';
import { consoleAuth, type AdminOverview } from '../src/identity/console-auth';
import { routerSignature } from '../src/identity/owner-directory';

const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
const json = (value: unknown) => new Response(JSON.stringify(value));
const now = () => 1_790_000_000_000;
const A = '0b6f2c1e-4a5d-4e3f-9a8b-1c2d3e4f5a6b', B = '1c7a3d2f-5b6e-4f4a-8b9c-2d3e4f5a6b7c', GONE = '2d8b4e3a-6c7f-4a5b-9c0d-3e4f5a6b7c8d';
const row = (owner_id: string, day: string, usd: number, calls = 1, input_tokens = 100, cached_tokens = 10) => ({ owner_id, day, usd, calls, input_tokens, cached_tokens });
const summary = { rows: [row(A, '2026-10-24', 0.25, 3, 1000, 400), row(A, '2026-10-23', 0.05), row(B, '2026-10-20', 1.5, 2, 5000, 0), row(GONE, '2026-10-01', 0.01)], truncated: false };
const overview: AdminOverview = {
  owners: [{ id: A, email: 'a@test.invalid', state: 'active', created_at: '2026-09-01T00:00:00Z', presences: [] },
    { id: B, email: '<b>b</b>@test.invalid', state: 'active', created_at: '2026-09-02T00:00:00Z', presences: [] },
    { id: '3e9c5f4b-7d8a-4b6c-8d1e-4f5a6b7c8d9e', email: 'idle@test.invalid', state: 'active', created_at: '2026-09-03T00:00:00Z', presences: [] }],
  invites: [],
};

describe('the admin cost summary schema', () => {
  it('accepts the rows the database returns', () => {
    expect(adminCostSummarySchema.safeParse(summary).success).toBe(true);
    expect(adminCostSummarySchema.safeParse({ rows: [], truncated: true }).success).toBe(true);
  });
  it.each([
    ['a column beyond the six', { rows: [{ ...row(A, '2026-10-24', 1), model: 'model-a' }], truncated: false }],
    ['text on a row', { rows: [{ ...row(A, '2026-10-24', 1), note: 'hello' }], truncated: false }],
    ['a negative cost', { rows: [row(A, '2026-10-24', -1)], truncated: false }],
    ['a fractional call count', { rows: [row(A, '2026-10-24', 1, 1.5)], truncated: false }],
    ['an owner that is not a uuid', { rows: [row('owner-a', '2026-10-24', 1)], truncated: false }],
    ['a day that is not a date', { rows: [row(A, 'yesterday', 1)], truncated: false }],
    ['no truncated flag', { rows: [] }],
    ['more rows than the cap', { rows: Array.from({ length: ADMIN_COST_ROW_CAP + 1 }, () => row(A, '2026-10-24', 0)), truncated: true }],
    ['a bare array', []],
  ])('refuses %s', (_label, value) => {
    expect(adminCostSummarySchema.safeParse(value).success).toBe(false);
  });
});

describe('the admin cost summary call', () => {
  it('signs a call of its own for the calling owner and parses the answer', async () => {
    const fetcher = vi.fn(async () => json(summary));
    expect(await consoleAuth(env, fetcher as unknown as typeof fetch, now)!.adminCostSummary('do-admin')).toEqual(summary);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/rpc/admin_cost_summary');
    const args = JSON.parse(String(init.body));
    expect(args).toMatchObject({ p_do_name: 'do-admin' });
    expect(args.p_sig).toBe(await routerSignature('router', 1_790_000_000, 'admincost.do-admin'));
  });
  it('answers null for an owner the database does not admit and throws on an answer of the wrong shape', async () => {
    expect(await consoleAuth(env, vi.fn(async () => json(null)) as unknown as typeof fetch, now)!.adminCostSummary('do-user')).toBeNull();
    await expect(consoleAuth(env, vi.fn(async () => json({ rows: [{ owner_id: A }], truncated: false })) as unknown as typeof fetch, now)!.adminCostSummary('do-admin')).rejects.toThrow();
  });
});

describe('the spend section', () => {
  it('totals each owner over the window with their email, keeps owners with no spend at zero, and sums a deployment total', () => {
    const spend = adminSpend(overview, summary);
    expect(spend.owners.map(({ owner_id, email, usd, calls }) => [owner_id, email, usd, calls])).toEqual([
      [B, '<b>b</b>@test.invalid', 1.5, 2], [A, 'a@test.invalid', 0.3, 4], [GONE, null, 0.01, 1], ['3e9c5f4b-7d8a-4b6c-8d1e-4f5a6b7c8d9e', 'idle@test.invalid', 0, 0],
    ]);
    expect(spend.owners[1]).toMatchObject({ input_tokens: 1100, cached_tokens: 410 });
    expect(spend.total).toEqual({ usd: 1.81, calls: 7, input_tokens: 6200, cached_tokens: 420 });
    expect(spend).toMatchObject({ days: 30, truncated: false });
  });

  it('adds the section to the admin read, and asks nothing about spend for an owner who is not an admin', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => json(String(input).includes('admin_overview') ? overview : summary));
    const read = await adminRead(consoleAuth(env, fetcher as unknown as typeof fetch, now)!, 'do-admin', 'csrf');
    expect(read.status).toBe(200);
    const body = await read.json() as { spend: ReturnType<typeof adminSpend> };
    expect(body.spend.total.usd).toBe(1.81);
    expect(JSON.stringify(body.spend)).not.toMatch(/model|text|note/);

    const refused = vi.fn(async () => json(null));
    expect((await adminRead(consoleAuth(env, refused as unknown as typeof fetch, now)!, 'do-user', 'csrf')).status).toBe(404);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('keeps the admin read when spend cannot be read, and says only that it is unavailable', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('admin_overview')) return json(overview);
      throw new Error('relation waldo.cost_ledger_daily: connection refused at 10.0.0.5');
    });
    const read = await adminRead(consoleAuth(env, fetcher as unknown as typeof fetch, now)!, 'do-admin', 'csrf');
    expect(read.status).toBe(200);
    const body = await read.json() as { owners: unknown[]; spend: unknown };
    expect(body.owners).toHaveLength(3);
    expect(body.spend).toEqual({ error: 'unavailable' });
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });

  it('renders a spend table with one escaped row per owner and a total, or says it is unavailable or empty', () => {
    const html = renderAdmin(overview, 'csrf', adminSpend(overview, summary));
    expect(html).toContain('Spend (last 30 days)');
    expect(html).not.toContain('<b>b</b>');
    expect(html).toContain('&#60;b&#62;b&#60;/b&#62;@test.invalid');
    expect(html).toContain('All owners');
    expect(html).toContain('$1.81');
    expect(renderAdmin(overview, 'csrf', { error: 'unavailable' })).toContain('Spend is unavailable right now.');
    expect(renderAdmin(overview, 'csrf', adminSpend(overview, { rows: [], truncated: false }))).toContain('No spend recorded in the last 30 days');
  });
});
