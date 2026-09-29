import { describe, expect, it, vi } from 'vitest';
import { fetchOverview, readOverview } from './model';

const empty = { version: 1, as_of: '2026-09-29T07:40:00Z', timezone: 'Asia/Kolkata', brief: { status: 'not_sent', at: null }, waiting: { count: 0, first: null }, next_card: null, latest_activity: null, services: [] };
describe('owner-scoped overview contract', () => {
  it('accepts an honestly empty record and drops unsupported secret fields', () => {
    const parsed = readOverview({ ...empty, csrf: 'must-not-keep', waiting: { count: 1, first: { id: 'p1', summary: 'Review', secret: 'must-not-keep' } }, next_card: { id: 'c1', label: 'Brief', scheduled_at: '2026-09-30T04:00:00Z', secret: 'must-not-keep' }, services: [{ account_id: 'one', email: 'owner@example.test', grants: ['gmail'], health: 'access_granted', refresh_token: 'must-not-keep' }] });
    expect(JSON.stringify(parsed)).not.toContain('must-not-keep');
    expect(parsed.waiting.count).toBe(1);
  });
  it('rejects unknown versions and malformed or fabricated values', () => {
    expect(() => readOverview({ ...empty, version: 2 })).toThrow();
    expect(() => readOverview({ ...empty, brief: { status: 'delivered', at: null } })).toThrow();
    expect(() => readOverview({ ...empty, as_of: 'bad date' })).toThrow();
    expect(() => readOverview({ ...empty, waiting: { count: -1, first: null } })).toThrow();
  });
  it('uses only same-origin, no-store credentials and treats unsigned requests as blocked', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(empty), { status: 200 })).mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', mock);
    expect((await fetchOverview()).version).toBe(1);
    expect(mock.mock.calls[0]?.[0]).toBe('/console/dashboard/api/v1/overview');
    expect(mock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    await expect(fetchOverview()).rejects.toThrow('Sign in');
    vi.unstubAllGlobals();
  });
});
