import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignInRequired } from './model';
import { allowedControlNavigation, fetchControls, readActionResult, readControls, submitControl } from './controls-model';

const day = { version: 1, view: 'day', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), data: { date: '2026-10-02', timezone: 'Asia/Kolkata', cards: [{ id: 'card:brief', name: 'The Brief', defaultTime: '08:00', time: null, sent: false, pin: '08:30', reason: 'Pinned by you' }], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' } } };
const connections = { ...day, view: 'connections', data: { google: { connectAvailable: true, accounts: [{ id: 'g1', email: 'owner@test.invalid', calendar: true, mail: false, tasks: true, health: 'access_granted' }] }, telegram: { linked: true, unlinkAvailable: true }, sessions: { count: 1, until: '2026-10-02 07:30' } } };
afterEach(() => vi.unstubAllGlobals());

describe('modern owner controls read', () => {
  it('validates the exact view and revision while dropping nested secrets and unrelated data', () => {
    expect(readControls({ ...day, session_token: 'never-retain', data: { ...day.data, cards: [{ ...day.data.cards[0], secret: 'never-retain' }], other_memory: 'never-retain' } }, 'day')).toEqual(day);
    expect(readControls({ ...connections, data: { ...connections.data, google: { ...connections.data.google, accounts: [{ ...connections.data.google.accounts[0], refresh_token: 'never-retain' }] } } }, 'connections')).toEqual(connections);
    for (const value of [{ ...day, view: 'connections' }, { ...day, revision: 'unknown' }, { ...day, state: 'unavailable' }, { ...day, csrf: '' }, { ...day, data: { ...day.data, cards: [{ ...day.data.cards[0], sent: 'true' }] } }, { ...day, data: { ...day.data, proactivity: { ...day.data.proactivity, volume: 'very-high' } } }]) expect(() => readControls(value, 'day')).toThrow('unsupported');
    expect(() => readControls({ ...connections, data: { ...connections.data, sessions: { count: 0, until: 'today' } } }, 'connections')).toThrow();
  });

  it('uses the fixed same-origin read and keeps signed-out, failed and malformed distinct', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(day)).mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response('{', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchControls('day')).toEqual(day);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/console/dashboard/api/v1/controls?view=day');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    await expect(fetchControls('day')).rejects.toBeInstanceOf(SignInRequired);
    await expect(fetchControls('day')).rejects.toThrow('no empty state');
    await expect(fetchControls('day')).rejects.toThrow('unsupported');
  });

  it('whitelists each additional view and rejects unsupported data instead of an empty fallback', () => {
    const envelope = (view: string, data: unknown) => ({ ...day, view, data, secret: 'never-retain' });
    const profile = readControls(envelope('profile', { sections: [{ title: 'About', lines: ['Owner context'], source_ref: 'never-retain' }], barriers: 1, removal: { state: 'none_recorded', pending_count: 0 }, holds: [{ id: 'never-retain', kind: 'shared', reason: 'untrusted', created_at: '2026-10-01', text: 'never-retain' }] }), 'profile');
    expect(JSON.stringify(profile)).not.toContain('never-retain');
    expect(profile.data.sections[0]?.lines).toEqual(['Owner context']);
    expect(() => readControls(envelope('profile', { ...profile.data, removal: { state: 'incomplete', pending_count: 1 } }), 'profile')).toThrow();
    expect(readControls(envelope('setup', { telegram_linked: false, google_access_granted: true, quiet_hours_set: false }), 'setup').data.google_access_granted).toBe(true);
    expect(() => readControls(envelope('setup', { telegram_linked: 'false', google_access_granted: true, quiet_hours_set: false }), 'setup')).toThrow();
    const usage = readControls(envelope('usage', { rows: [{ model: 'model', calls: 1, input: 10, cached: 5, output: 2, usd: .01, private_payload: 'never-retain' }] }), 'usage');
    expect(JSON.stringify(usage)).not.toContain('never-retain');
    expect(() => readControls(envelope('usage', { rows: [{ ...usage.data.rows[0], usd: Infinity }] }), 'usage')).toThrow();
    const files = readControls(envelope('files', { storage: 'telegram_reference', items: [{ id: 1, kind: 'document', name: 'file.pdf', mime: null, size: null, caption: '', at: 1790000000000, file_id: 'never-retain' }] }), 'files');
    expect(JSON.stringify(files)).not.toContain('never-retain'); expect(files.data.items[0]?.size).toBeNull();
    expect(() => readControls(envelope('files', { ...files.data, storage: 'private_workspace' }), 'files')).toThrow();
    expect(() => readControls(envelope('files', { ...files.data, items: [{ ...files.data.items[0], id: '../other-owner' }] }), 'files')).toThrow();
  });

  it('validates exact reviews and never admits email approval or unsupported calendar undo', () => {
    const proposal = { id: 'email', kind: 'email_send', state: 'open', summary: 'Send proposal', actions: ['approval.skip'], review: { kind: 'email_send', to: ['to@test.invalid'], cc: [], bcc: [], subject: 'Exact subject', body: 'Exact words', raw: 'never-retain' } };
    const value = { ...day, view: 'waiting', data: { proposals: [proposal] } };
    const parsed = readControls(value, 'waiting');
    expect(parsed.data.proposals[0]?.review).toMatchObject({ body: 'Exact words' }); expect(JSON.stringify(parsed)).not.toContain('never-retain');
    expect(() => readControls({ ...value, data: { proposals: [{ ...proposal, actions: ['approval.approve'] }] } }, 'waiting')).toThrow();
    expect(() => readControls({ ...value, data: { proposals: [{ ...proposal, state: 'done', actions: ['approval.undo'] }] } }, 'waiting')).toThrow();
    expect(() => readControls({ ...value, data: { proposals: [{ ...proposal, review: { kind: 'message_send', channel: 'telegram', content: 'Other review' } }] } }, 'waiting')).toThrow();
    expect(() => readControls({ ...value, data: { proposals: [{ ...proposal, review: { ...proposal.review, to: 'to@test.invalid' } }] } }, 'waiting')).toThrow();
  });

  it('keeps activity summaries narrow and passes independently selected cursors', async () => {
    const activity = { ...day, view: 'activity', data: { steps: [], runs: [], ledger: 'Recorded reminders', page: { trace_before: 10, runs_before: null, trace_applied: 20, runs_applied: 30 }, trace: [{ time: '10:00', hop: 'skip', ok: true, ms: 0, summary: 'Recorded quiet-hour suppression', detail: 'never-retain', error: 'never-retain' }] } };
    const parsed = readControls(activity, 'activity');
    expect(JSON.stringify(parsed)).not.toContain('never-retain'); expect(parsed.data.trace[0]?.summary).toContain('suppression');
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(activity)); vi.stubGlobal('fetch', fetcher);
    await fetchControls('activity', undefined, { trace_before: 10, runs_before: 30 });
    expect(fetcher.mock.calls[0]?.[0]).toBe('/console/dashboard/api/v1/controls?view=activity&trace_before=10&runs_before=30');
    await expect(fetchControls('day', undefined, { trace_before: 10 })).rejects.toThrow();
    await expect(fetchControls('activity', undefined, { runs_before: -1 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => readControls({ ...activity, data: { ...activity.data, page: { ...activity.data.page, trace_before: 'owner-id' } } }, 'activity')).toThrow();
  });
});

describe('revision-bound owner control actions', () => {
  it('sends CSRF, revision and stable request id in FormData without an owner selector', async () => {
    const fetcher = vi.fn(async () => Response.json({ receipt: { state: 'recorded', message: 'Time saved.' }, duplicate: false }));
    vi.stubGlobal('fetch', fetcher);
    const record = readControls(day, 'day');
    const result = await submitControl(record, 'proactivity.set', { quiet_start: '', quiet_end: '', volume: 'normal' }, 'fixed-request-1');
    expect(result.receipt.state).toBe('recorded');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/console/dashboard/api/v1/actions');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(Object.fromEntries((init.body as FormData).entries())).toEqual({ csrf: day.csrf, revision: day.revision, view: 'day', request_id: 'fixed-request-1', action: 'proactivity.set', quiet_start: '', quiet_end: '', volume: 'normal' });
    await submitControl(record, 'proactivity.set', { quiet_start: '', quiet_end: '', volume: 'normal' }, 'fixed-request-1');
    const second = (fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as FormData;
    expect(second.get('request_id')).toBe('fixed-request-1');
  });

  it('preserves incomplete and duplicate receipts without treating unconfirmed as success', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ receipt: { state: 'incomplete', message: 'Removal incomplete.' }, duplicate: false })).mockResolvedValueOnce(Response.json({ receipt: { state: 'unconfirmed', message: 'Outcome not confirmed.' }, duplicate: true }, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const record = readControls(day, 'day');
    expect((await submitControl(record, 'timezone.set', { value: 'UTC' }, 'request-1')).receipt.state).toBe('incomplete');
    expect(await submitControl(record, 'timezone.set', { value: 'UTC' }, 'request-1')).toEqual({ receipt: { state: 'unconfirmed', message: 'Outcome not confirmed.' }, duplicate: true });
  });

  it('requires fresh review on stale reads and keeps lost responses unknown', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: 'stale_read' }, { status: 409 })).mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    const record = readControls(day, 'day');
    await expect(submitControl(record, 'timezone.set', { value: 'UTC' }, 'request-1')).rejects.toMatchObject({ code: 'stale_read', uncertain: false });
    await expect(submitControl(record, 'timezone.set', { value: 'UTC' }, 'request-1')).rejects.toMatchObject({ code: 'outcome_unavailable', uncertain: true });
    await expect(submitControl(record, 'timezone.set', { value: 'UTC' }, 'request-1')).rejects.toMatchObject({ uncertain: true });
    await expect(submitControl(record, 'timezone.set', { value: 'UTC' }, 'request-1')).rejects.toBeInstanceOf(SignInRequired);
  });

  it('rejects a success-looking receipt on an unavailable response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ receipt: { state: 'recorded', message: 'Saved' }, duplicate: false }, { status: 503 })));
    await expect(submitControl(readControls(day, 'day'), 'timezone.set', { value: 'UTC' }, 'request-1')).rejects.toMatchObject({ code: 'receipt_unavailable', uncertain: true });
  });

  it('does not copy raw error fields from rejected responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'secret-provider-stack', message: 'secret-private-message' }, { status: 409 })));
    await expect(submitControl(readControls(day, 'day'), 'timezone.set', { value: 'UTC' }, 'request-1')).rejects.toMatchObject({ code: 'not_completed', message: 'These records or action eligibility changed. Refresh and review the controls before deciding again.' });
  });

  it('allows only the existing HTTPS ticket or exact Google authorization destination', () => {
    const ticket = 'https://w.test/c/ABCDEFGHIJKLMNOPQRSTUV';
    expect(allowedControlNavigation(ticket, 'https://w.test')).toBe(ticket);
    expect(allowedControlNavigation('https://accounts.google.com/o/oauth2/v2/auth?state=server-state', 'https://w.test')).toContain('accounts.google.com');
    for (const target of ['javascript:alert(1)', 'https://foreign.test/c/ABCDEFGHIJKLMNOPQRSTUV', 'http://w.test/c/ABCDEFGHIJKLMNOPQRSTUV', 'https://w.test/c/short', `${ticket}?next=https://evil.test`, 'https://accounts.google.com.evil.test/o/oauth2/v2/auth', 'https://accounts.google.com:444/o/oauth2/v2/auth', 'https://user:password@accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com/other']) expect(() => allowedControlNavigation(target, 'https://w.test')).toThrow();
    expect(() => readActionResult({ receipt: { state: 'recorded', message: 'Saved', navigation: ticket }, duplicate: false }, 'timezone.set', 'https://w.test')).toThrow('navigation receipt');
    expect(() => readActionResult({ receipt: { state: 'unconfirmed', message: 'Unknown', navigation: ticket }, duplicate: false }, 'google.connect', 'https://w.test')).toThrow();
  });
});
