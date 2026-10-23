import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardNavigation, isSettingsRoute, resolveRoute } from './App';
import { SettingsNavigation } from './Settings';
import { AdminHealthView, HealthView } from './Health';
import { fetchAdminHealth, fetchHealth, readAdminHealth, readHealth, type AdminHealthRecord } from './health-model';
import { SignInRequired } from './model';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const pillar = (score: number, zone: string | null) => ({ state: 'available', score, zone, algorithm_version: 'recovery.v1', activation: 'candidate_unaccepted', confidence: 0.8, hrv_method: null });
const freshness = {
  sources: [{ source: 'apple', newest_upload_at: '2026-10-23T11:00:00.000Z', uploads_7d: 12, rejected_readings_7d: [{ reason: 'invalid_sample', count: 2 }] }],
  refusals_7d: [{ code: 'invalid_request', status: 400, count: 3, newest_at: '2026-10-23T10:00:00.000Z' }],
  newest_derived: { day: '2026-10-23', compiled_at: '2026-10-23T11:30:00.000Z' },
};
const consent = (purpose: string, status: string) => ({ consent_class: 'health_processing', source: 'apple', purpose, version: 2, status, epoch: 1,
  granted_at: '2026-10-20T08:00:00.000Z', withdrawn_at: status === 'withdrawn' ? '2026-10-21T08:00:00.000Z' : null, deletion_state: 'not_required' });
const scores = (over: Record<string, unknown> = {}) => ({ day: '2026-10-23', timezone: 'Europe/London', compiled_at: '2026-10-23T11:00:00.000Z', freshness: 'fresh',
  recovery: pillar(87.5, 'excellent'), form: pillar(61.25, 'steady'), weight: { state: 'unavailable', reason: 'calendar_demand_unavailable' }, ...over });
const raw = (over: Record<string, unknown> = {}) => ({ version: 1, as_of: NOW.toISOString(), scores: scores(), consents: [consent('model_processing', 'withdrawn'), consent('storage_compute', 'granted')], freshness, ...over });
const view = (over: Record<string, unknown> = {}) => renderToStaticMarkup(<HealthView state={{ kind: 'ready', data: readHealth(raw(over)) }} now={NOW}/>);

describe('health pages in the console', () => {
  it('has a Health page in Settings for every owner and a tester page only for the admin, and keeps the five destinations', () => {
    expect(resolveRoute('health')).toBe('health');
    expect(isSettingsRoute('health')).toBe(true);
    expect(renderToStaticMarkup(<SettingsNavigation selected="health"/>)).toMatch(/aria-current="page" href="#\/health">Health/);
    expect(renderToStaticMarkup(<DashboardNavigation route="health"/>)).not.toContain('#/health');
    expect(resolveRoute('admin/health')).toBe('admin/health');
    expect(isSettingsRoute('admin/health')).toBe(true);
    expect(renderToStaticMarkup(<SettingsNavigation selected="day"/>)).not.toContain('#/admin/health');
    expect(renderToStaticMarkup(<SettingsNavigation selected="admin-health" isAdmin/>)).toMatch(/aria-current="page" href="#\/admin\/health">Tester health/);
  });
});

describe('owner health view', () => {
  it('shows today\'s scores with their zone words, freshness and when they were derived', () => {
    const html = view();
    expect(html).toContain('Recovery');
    expect(html).toContain('88');
    expect(html).toContain('excellent');
    expect(html).toContain('steady');
    expect(html).toContain('Weight');
    expect(html).toContain('Waldo can’t read your calendar');
    expect(html).toContain('Fresh');
    expect(html).toContain('Derived 1 hour ago');
  });
  it('labels stale and expired scores for what they are', () => {
    expect(view({ scores: scores({ freshness: 'stale' }) })).toContain('Stale');
    const expired = view({ scores: scores({ freshness: 'expired' }) });
    expect(expired).toContain('Expired');
    expect(expired).toContain('more than three days ago');
  });
  it('shows sleep debt only when the row carries it', () => {
    expect(view()).not.toContain('Sleep debt');
    expect(view({ scores: scores({ sleep_debt: { state: 'available', debt_minutes: 95, need_basis: 'own_average', algorithm_version: 'sleep-debt.v1', activation: 'candidate_unaccepted' } }) })).toContain('Sleep debt: 1 h 35 min');
    expect(view({ scores: scores({ sleep_debt: { state: 'partial', confidence: 0.4, algorithm_version: 'sleep-debt.v1', activation: 'candidate_unaccepted' } }) })).toContain('Sleep debt: not enough nights yet');
  });
  it('shows each source\'s last upload and what was refused', () => {
    const html = view();
    expect(html).toContain('Apple Health');
    expect(html).toContain('Last upload 1 hour ago');
    expect(html).toContain('12 uploads in the last 7 days');
    expect(html).toContain('2 readings rejected');
    expect(html).toContain('3 uploads refused');
    expect(html).toContain('Only uploads refused after sign-in are counted.');
  });
  it('shows both consents, each in its own state', () => {
    const html = view();
    expect(html).toMatch(/Storage and computing[^]*Shared/);
    expect(html).toMatch(/Model processing[^]*Withdrawn/);
  });
  it('says not shared when there is no consent, and why there are no scores', () => {
    const html = view({ consents: [], scores: { state: 'unavailable', day: null, reason: 'consent_required' }, freshness: { sources: [], refusals_7d: [], newest_derived: null } });
    expect(html.match(/Not shared/g)).toHaveLength(2);
    expect(html).toContain('You haven’t shared health data with Waldo');
    expect(html).toContain('No uploads yet');
  });
  it('says which part could not be read instead of showing nothing', () => {
    const html = view({ freshness: null, consents: null });
    expect(html).toContain('Couldn’t read your uploads');
    expect(html).toContain('Couldn’t read your consent');
    expect(html).toContain('88');
  });
  it('reads only the fields it shows, and refuses an unknown shape', () => {
    const read = readHealth(raw({ csrf: 'x', freshness: { ...freshness, payload: { value: 4321 } } }));
    expect(JSON.stringify(read)).not.toContain('4321');
    expect(JSON.stringify(read)).not.toContain('csrf');
    expect(() => readHealth(raw({ scores: scores({ freshness: 'fine' }) }))).toThrow();
    expect(() => readHealth(raw({ version: 2 }))).toThrow();
  });
});

describe('health fetches', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('asks for sign-in on 401 and reads the admin page as absent on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(fetchHealth()).rejects.toBeInstanceOf(SignInRequired);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'not_found' }, { status: 404 })));
    expect(await fetchAdminHealth()).toBeNull();
  });
  it('says when it is being asked too often', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'rate_limited' }, { status: 429 })));
    await expect(fetchHealth()).rejects.toThrow(/too often/);
  });
  it('reads the same-origin JSON routes without following a redirect', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json(raw()));
    vi.stubGlobal('fetch', fetcher);
    await fetchHealth();
    expect(fetcher.mock.calls[0]![0]).toBe('/console/dashboard/api/v1/health');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  });
});

describe('admin tester freshness view', () => {
  const owner = (email: string, over: Record<string, unknown> = {}) => ({ id: '00000000-0000-0000-0000-000000000001', email, state: 'active', created_at: '2026-10-01T00:00:00.000Z',
    consents: [{ source: 'apple', purpose: 'storage_compute', status: 'granted', granted_at: '2026-10-20T08:00:00.000Z', withdrawn_at: null }], freshness, ...over });
  const record = (owners: unknown[]): AdminHealthRecord => readAdminHealth({ version: 1, as_of: NOW.toISOString(), owners });
  it('lists each tester\'s uploads, refusals by code, newest derived day and consent, with no values', () => {
    const html = renderToStaticMarkup(<AdminHealthView state={{ kind: 'ready', data: record([
      owner('<script>@example.invalid', { score: 87.5, freshness: { ...freshness, sources: [{ ...freshness.sources[0], value: 4321 }] } }),
      owner('quiet@example.invalid', { id: '00000000-0000-0000-0000-000000000002', consents: [], freshness: { sources: [], refusals_7d: [], newest_derived: null } }),
    ]) }} now={NOW}/>);
    expect(html).toContain('&lt;script&gt;@example.invalid');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Apple Health: 1 hour ago');
    expect(html).toContain('12');
    expect(html).toContain('invalid_request ×3');
    expect(html).toContain('invalid_sample ×2');
    expect(html).toContain('2026-10-23');
    expect(html).toMatch(/quiet@example\.invalid[^]*Not shared[^]*No uploads/);
    expect(html).not.toContain('4321');
    expect(html).not.toContain('87.5');
  });
  it('drops anything the admin projection does not name', () => {
    const read = record([owner('a@example.invalid', { score: 87.5, payload: { value: 4321 }, consents: [{ source: 'apple', purpose: 'storage_compute', status: 'granted', granted_at: null, withdrawn_at: null, epoch: 9 }] })]);
    expect(JSON.stringify(read)).not.toMatch(/4321|87\.5|"epoch"|"payload"|"score"/);
    expect(() => readAdminHealth({ version: 1, as_of: NOW.toISOString(), owners: [owner('a@example.invalid', { state: 7 })] })).toThrow();
  });
  it('shows page not found to anyone the read refuses', () => {
    expect(renderToStaticMarkup(<AdminHealthView state={{ kind: 'absent' }} now={NOW}/>)).toContain('Page not found');
  });
});

