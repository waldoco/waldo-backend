import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignInRequired } from './model';
import { allowedControlNavigation, fetchControls, readActionResult, readControls, submitControl } from './controls-model';

const day = { version: 1, view: 'day', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), data: { date: '2026-10-02', timezone: 'Asia/Kolkata', cards: [{ id: 'card:brief', name: 'The Brief', defaultTime: '08:00', time: null, sent: false, pin: '08:30', reason: 'Pinned by you' }], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' } } };
const connections = { ...day, view: 'connections', data: { google: { connectAvailable: true, accounts: [{ id: 'g1', email: 'owner@test.invalid', calendar: true, mail: false, tasks: true, health: 'access_granted' }] }, telegram: { linked: true, unlinkAvailable: true }, sessions: { count: 1, until: '2026-10-02 07:30', items: [{ signed_in: '2026-10-01 19:30', until: '2026-10-02 07:30', current: true }] } } };
afterEach(() => vi.unstubAllGlobals());

describe('modern owner controls read', () => {
  it('validates the exact view and revision while dropping nested secrets and unrelated data', () => {
    expect(readControls({ ...day, session_token: 'never-retain', data: { ...day.data, cards: [{ ...day.data.cards[0], secret: 'never-retain' }], other_memory: 'never-retain' } }, 'day')).toEqual(day);
    expect(readControls({ ...connections, data: { ...connections.data, google: { ...connections.data.google, accounts: [{ ...connections.data.google.accounts[0], refresh_token: 'never-retain' }] } } }, 'connections')).toEqual(connections);
    for (const value of [{ ...day, view: 'connections' }, { ...day, revision: 'unknown' }, { ...day, state: 'unavailable' }, { ...day, csrf: '' }, { ...day, data: { ...day.data, cards: [{ ...day.data.cards[0], sent: 'true' }] } }, { ...day, data: { ...day.data, proactivity: { ...day.data.proactivity, volume: 'very-high' } } }]) expect(() => readControls(value, 'day')).toThrow('unsupported');
    expect(() => readControls({ ...connections, data: { ...connections.data, sessions: { count: 0, until: 'today', items: [] } } }, 'connections')).toThrow();
    expect(() => readControls({ ...connections, data: { ...connections.data, sessions: { count: 1, until: 'today' } } }, 'connections')).toThrow();
    expect(readControls(connections, 'connections').data.sessions.items).toEqual([{ signed_in: '2026-10-01 19:30', until: '2026-10-02 07:30', current: true }]);
    expect(JSON.stringify(readControls({ ...connections, data: { ...connections.data, sessions: { ...connections.data.sessions, items: [{ ...connections.data.sessions.items[0], token: 'never-retain' }] } } }, 'connections'))).not.toContain('never-retain');
  });

  it('keeps each MCP tool\'s shown digest, which a grant sends back, and refuses a server record without one', () => {
    const server = { id: 'c1', name: 'notion', host: 'mcp.notion.com', server_url: 'https://mcp.notion.com/mcp', auth: 'oauth', status: 'active', scopes: [], wants_scopes: [], tools: 1, hidden_tools: 0, runs_without_asking: 0, marked_read_only: 1, tools_changed: false, tools_capped: false, read_only_digest: 'b'.repeat(64), tool_list: [{ tool: 'search', runs: 'asks_first', read_only_hint: true, digest: 'a'.repeat(64) }] };
    const withServer = (record: unknown) => ({ ...connections, data: { ...connections.data, mcp: [record] } });
    expect(readControls(withServer(server), 'connections').data.mcp).toEqual([server]);
    expect(readControls(withServer({ ...server, tools_capped: true }), 'connections').data.mcp?.[0]?.tools_capped).toBe(true);
    const onConnect = { ...server, tool_list: [{ ...server.tool_list[0], runs: 'without_asking', allowed_on_connect: true }] };
    expect(readControls(withServer(onConnect), 'connections').data.mcp?.[0]?.tool_list[0]?.allowed_on_connect).toBe(true);
    for (const broken of [{ ...server, read_only_digest: undefined }, { ...server, tool_list: [{ ...server.tool_list[0], digest: 'short' }] }, { ...server, tools_capped: 'no' }, { ...server, tool_list: [{ ...server.tool_list[0], allowed_on_connect: false }] }, { ...server, tool_list: [{ ...server.tool_list[0], allowed_on_connect: 'yes' }] }]) {
      expect(() => readControls(withServer(broken), 'connections')).toThrow();
    }
  });

  it('keeps the official MCP catalogue tiles and refuses a malformed tile', () => {
    const tile = { id: 'notion', label: 'Notion', about: 'Search and read your pages.', url: 'https://mcp.notion.com/mcp', connected: false };
    const withTile = (value: unknown) => ({ ...connections, data: { ...connections.data, mcp_catalogue: [value] } });
    expect(readControls(withTile(tile), 'connections').data.mcp_catalogue).toEqual([tile]);
    expect(readControls(withTile({ ...tile, extra: 'dropped' }), 'connections').data.mcp_catalogue).toEqual([tile]);
    expect(readControls(connections, 'connections').data.mcp_catalogue).toBeUndefined();
    for (const broken of [{ ...tile, url: 'http://mcp.notion.com/mcp' }, { ...tile, url: 'javascript:alert(1)' }, { ...tile, connected: 'no' }, { ...tile, label: undefined }]) {
      expect(() => readControls(withTile(broken), 'connections')).toThrow();
    }
    expect(() => readControls({ ...connections, data: { ...connections.data, mcp_catalogue: tile } }, 'connections')).toThrow();
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

  it('validates exact reviews, admits Send and Change it only on an open draft, and no unsupported calendar undo', () => {
    const proposal = { id: 'email', kind: 'email_send', state: 'open', summary: 'Send proposal', actions: ['approval.send', 'approval.edit', 'approval.skip'], review: { kind: 'email_send', account: 'me@test.invalid', to: ['to@test.invalid'], cc: [], bcc: [], subject: 'Exact subject', body: 'Exact words', raw: 'never-retain' } };
    const message = { id: 'message', kind: 'message_send', state: 'open', summary: 'Send message', actions: ['approval.send', 'approval.edit', 'approval.skip'], review: { kind: 'message_send', channel: 'telegram', content: 'Exact message' } };
    const value = { ...day, view: 'waiting', data: { proposals: [proposal, message] } };
    const parsed = readControls(value, 'waiting');
    expect(parsed.data.proposals[0]?.review).toEqual({ kind: 'email_send', account: 'me@test.invalid', to: ['to@test.invalid'], cc: [], bcc: [], subject: 'Exact subject', body: 'Exact words' });
    expect(parsed.data.proposals.map(item => item.actions)).toEqual([proposal.actions, message.actions]);
    expect(JSON.stringify(parsed)).not.toContain('never-retain');
    expect(parsed.data.timezone).toBeNull();
    expect(readControls({ ...value, data: { timezone: 'Asia/Kolkata', proposals: [proposal] } }, 'waiting').data.timezone).toBe('Asia/Kolkata');
    expect(readControls({ ...value, data: { timezone: 'Not/AZone', proposals: [proposal] } }, 'waiting').data.timezone).toBeNull();
    const { account: _account, ...withoutAccount } = proposal.review;
    expect(readControls({ ...value, data: { proposals: [{ ...proposal, review: withoutAccount }] } }, 'waiting').data.proposals[0]?.review).not.toHaveProperty('account');
    const earlier = (at: unknown) => readControls({ ...value, data: { proposals: [{ ...proposal, review: { ...proposal.review, earlier_unknown_at: at } }] } }, 'waiting').data.proposals[0]?.review;
    expect(earlier('Fri 23 Oct, 14:05')).toMatchObject({ earlier_unknown_at: 'Fri 23 Oct, 14:05' });
    expect(readControls(value, 'waiting').data.proposals[0]?.review).not.toHaveProperty('earlier_unknown_at');
    expect(() => earlier(42)).toThrow();
    const calendar = { id: 'walk', kind: 'calendar_change', state: 'open', summary: 'Walk', actions: ['approval.approve', 'approval.skip'], review: { kind: 'calendar_change', action: 'create', title: 'Walk', event_id: null, start: null, end: null, reason: 'asked' } };
    expect(readControls({ ...value, data: { proposals: [calendar] } }, 'waiting').data.proposals[0]?.actions).toEqual(calendar.actions);
    for (const wrong of [
      { ...proposal, state: 'review_only' }, { ...proposal, state: 'review_only', actions: ['approval.edit'] }, { ...proposal, review: null }, { ...proposal, actions: ['approval.edit'], review: null },
      { ...calendar, actions: ['approval.edit'] }, { ...calendar, actions: ['approval.send'] }, { ...proposal, actions: ['approval.approve'] }, { ...proposal, state: 'done', actions: ['approval.undo'] }, { ...proposal, actions: ['approval.later'] },
      { ...proposal, review: { kind: 'message_send', channel: 'telegram', content: 'Other review' } }, { ...proposal, review: { ...proposal.review, to: 'to@test.invalid' } }, { ...proposal, review: { ...proposal.review, account: 7 } },
    ]) expect(() => readControls({ ...value, data: { proposals: [wrong] } }, 'waiting')).toThrow();
  });

  it('keeps activity summaries narrow and passes independently selected cursors', async () => {
    const activity = { ...day, view: 'activity', data: { steps: [], last_request: { at: '2026-10-02 10:00', ok: true, partial: false, recorded_steps: 1, hops: [{ hop: 'llm_reply', ok: true, ms: 5, note: '', raw: 'never-retain' }] }, runs: [], ledger: 'Recorded reminders', page: { trace_before: 10, runs_before: null, trace_applied: 20, runs_applied: 30 }, trace: [{ time: '10:00', hop: 'skip', ok: true, ms: 0, summary: 'Recorded quiet-hour suppression', detail: 'never-retain', error: 'never-retain' }] } };
    const parsed = readControls(activity, 'activity');
    expect(parsed.data.last_request).toEqual({ at: '2026-10-02 10:00', ok: true, partial: false, recorded_steps: 1, hops: [{ hop: 'llm_reply', ok: true, ms: 5, note: '' }] });
    expect(() => readControls({ ...activity, data: { ...activity.data, last_request: undefined } }, 'activity')).toThrow();
    expect(readControls({ ...activity, data: { ...activity.data, last_request: null } }, 'activity').data.last_request).toBeNull();
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

  it('allows an MCP connect to continue only on this console\'s own start link', () => {
    const start = `/console/mcp/start/${'A'.repeat(43)}`;
    expect(readActionResult({ receipt: { state: 'recorded', message: 'Sign in', navigation: start }, duplicate: false }, 'mcp.connect', 'https://w.test').receipt.navigation).toBe(`https://w.test${start}`);
    for (const target of [`https://foreign.test${start}`, '/console/mcp/start/short', `${start}?next=https://evil.test`, 'https://auth.provider.test/authorize']) expect(() => allowedControlNavigation(target, 'https://w.test')).toThrow();
    expect(() => readActionResult({ receipt: { state: 'recorded', message: 'Saved', navigation: start }, duplicate: false }, 'mcp.runs', 'https://w.test')).toThrow('navigation receipt');
  });
});

describe('iMessage and device setup reads', () => {
  const bridge = { id: 'imb_' + '0'.repeat(32), kind: 'owner', state: 'pending', subject: 'owner@test.invalid', chat: 'iMessage;-;owner@test.invalid', observed: true, host_version: 'host-1', actions: ['imessage.verify', 'imessage.activate', 'imessage.revoke'] };
  const imessage = { ...day, view: 'imessage', data: { enabled: true, address: 'waldo@test.invalid', linked_hint: '1234', admin: false, phone: null, photon: null, phone_on_file: null, actions: ['imessage.link', 'imessage.unlink', 'imessage.pair'], bridges: [bridge] }, status: { bridges: [{ id: bridge.id, online: true, text_ready: false, sending_paused: false }] } };
  const device = { id: 'dev_fixture', label: '<b>Mac</b>', capabilities: ['machine_state_query'], created_at: '2026-10-16', actions: ['device.revoke', 'device.query'] };
  const devices = { ...day, view: 'devices', data: { actions: ['device.pair'], devices: [device], query_kinds: ['session_status'], notification_bodies: ['Your Mac is connected.'] }, status: { devices: [{ id: device.id, online: false, last_seen_at: null, commands: [{ class: 'machine_state_query', state: 'queued', result_state: null }] }] } };
  it('reads the number on file and whether it is verified; an older server reads as not known', () => {
    const { phone_on_file: _absent, ...older } = imessage.data;
    expect(readControls({ ...imessage, data: older }, 'imessage').data.phone_on_file).toBeNull();
    const onFile = { phone: '+15550000001', verified: false };
    expect(readControls({ ...imessage, data: { ...imessage.data, phone_on_file: { ...onFile, raw: 'never-retain' } } }, 'imessage').data.phone_on_file).toEqual(onFile);
    for (const phone_on_file of ['+15550000001', { phone: 5, verified: false }, { phone: '+15550000001', verified: 'no' }, { verified: true }])
      expect(() => readControls({ ...imessage, data: { ...imessage.data, phone_on_file } }, 'imessage')).toThrow('unsupported');
  });
  it('keeps only the listed fields and actions, and liveness beside the data', () => {
    const parsed = readControls({ ...imessage, data: { ...imessage.data, bridges: [{ ...bridge, wrapped_credential: 'never-retain' }] }, status: { bridges: [{ ...imessage.status.bridges[0], quarantine: 'never-retain' }] } }, 'imessage');
    expect(parsed).toEqual(imessage); expect(JSON.stringify(parsed)).not.toContain('never-retain');
    expect(readControls({ ...devices, data: { ...devices.data, devices: [{ ...device, pubkey: 'never-retain' }] } }, 'devices')).toEqual(devices);
    for (const value of [
      { ...imessage, status: undefined }, { ...imessage, data: { ...imessage.data, actions: ['imessage.link', 'invite.create'] } }, { ...imessage, data: { ...imessage.data, actions: ['imessage.link', 'imessage.link'] } },
      { ...imessage, data: { ...imessage.data, bridges: [{ ...bridge, id: '../other' }] } }, { ...imessage, data: { ...imessage.data, bridges: [{ ...bridge, actions: ['imessage.link'] }] } }, { ...imessage, data: { ...imessage.data, enabled: 'true' } }, { ...imessage, data: { ...imessage.data, photon: 'maybe' } }, { ...imessage, data: { ...imessage.data, phone: 5 } },
    ]) expect(() => readControls(value, 'imessage')).toThrow('unsupported');
    for (const value of [{ ...devices, data: { ...devices.data, actions: ['device.revoke'] } }, { ...devices, data: { ...devices.data, devices: [{ ...device, actions: ['device.pair'] }] } }, { ...devices, status: { devices: [{ ...devices.status.devices[0], online: 'yes' }] } }])
      expect(() => readControls(value, 'devices')).toThrow('unsupported');
  });
  it('reads each view from the fixed controls route', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(imessage)).mockResolvedValueOnce(Response.json(devices)); vi.stubGlobal('fetch', fetcher);
    expect((await fetchControls('imessage')).data.linked_hint).toBe('1234');
    expect((await fetchControls('devices')).data.devices[0]?.label).toBe('<b>Mac</b>');
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/console/dashboard/api/v1/controls?view=imessage', '/console/dashboard/api/v1/controls?view=devices']);
  });
  it('sends a view’s own fields with the action', async () => {
    const fetcher = vi.fn(async () => Response.json({ receipt: { state: 'recorded', message: 'Send this exact text.' }, duplicate: false, reveal: { kind: 'challenge', value: 'wic_' + '1'.repeat(48) } })); vi.stubGlobal('fetch', fetcher);
    const result = await submitControl(readControls(imessage, 'imessage'), 'imessage.verify', { id: bridge.id, subject: 'owner@test.invalid', chat: 'iMessage;-;owner@test.invalid' }, 'verify-request-1');
    expect(result.reveal).toEqual({ kind: 'challenge', value: 'wic_' + '1'.repeat(48) });
    expect(Object.fromEntries(((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData).entries())).toEqual({ csrf: day.csrf, revision: day.revision, view: 'imessage', request_id: 'verify-request-1', action: 'imessage.verify', id: bridge.id, subject: 'owner@test.invalid', chat: 'iMessage;-;owner@test.invalid' });
  });
});

describe('one-time values in receipts', () => {
  const recorded = { state: 'recorded', message: 'Shown once.' };
  const host = 'wim_' + 'ab'.repeat(24), pairing = 'wp1.e2e00000-0000-4000-8000-0000000000aa.' + 'A'.repeat(43);
  it('accepts each value only from its own action and in its exact shape', () => {
    expect(readActionResult({ receipt: recorded, duplicate: false, reveal: { kind: 'host_code', value: host } }, 'imessage.pair', 'https://x.test').reveal).toEqual({ kind: 'host_code', value: host });
    expect(readActionResult({ receipt: recorded, duplicate: false, reveal: { kind: 'pairing_code', value: pairing, extra: 'never-retain' } }, 'device.pair', 'https://x.test').reveal).toEqual({ kind: 'pairing_code', value: pairing });
    expect(readActionResult({ receipt: recorded, duplicate: false, reveal: { kind: 'link_code', value: 'waldo ABCDEFGHJK', send_url: 'sms:waldo@test.invalid&body=waldo%20ABCDEFGHJK' } }, 'imessage.link', 'https://x.test').reveal).toEqual({ kind: 'link_code', value: 'waldo ABCDEFGHJK' });
    for (const [value, action] of [
      [{ receipt: recorded, duplicate: false, reveal: { kind: 'host_code', value: host } }, 'device.pair'],
      [{ receipt: recorded, duplicate: false, reveal: { kind: 'challenge', value: host } }, 'imessage.pair'],
      [{ receipt: recorded, duplicate: false, reveal: { kind: 'host_code', value: host + '<script>' } }, 'imessage.pair'],
      [{ receipt: recorded, duplicate: true, reveal: { kind: 'host_code', value: host } }, 'imessage.pair'],
      [{ receipt: { state: 'rejected', message: 'No.' }, duplicate: false, reveal: { kind: 'host_code', value: host } }, 'imessage.pair'],
      [{ receipt: recorded, duplicate: false, reveal: { kind: 'host_code', value: host } }, 'timezone.set'],
      [{ receipt: recorded, duplicate: false, reveal: { kind: 'link_code', value: 'waldo ABCDEFGHJ1' } }, 'imessage.link'],
    ] as const) expect(() => readActionResult(value, action, 'https://x.test')).toThrow('unsupported');
  });
});

describe('the phone read', () => {
  const phone = { version: 1, view: 'phone', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), status: {},
    data: { phone: '+919800000001', verified: false, sms: true, challenge: { state: 'pending', expires_at: 1_800_000_600, retry_at: null, checks_left: 5 }, actions: ['phone.sms_send', 'phone.sms_check'] } };
  it('reads the number on file, its proof and the code in flight, dropping anything else', () => {
    const { status: _status, ...expected } = phone;
    expect(readControls({ ...phone, data: { ...phone.data, code: '424242' } }, 'phone')).toEqual(expected);
    expect(readControls({ ...phone, data: { ...phone.data, phone: null, challenge: null, actions: [] } }, 'phone').data).toMatchObject({ phone: null, challenge: null });
  });
  it('refuses a malformed read instead of showing it', () => {
    for (const data of [{ ...phone.data, phone: '98000 00001' }, { ...phone.data, verified: 'no' }, { ...phone.data, actions: ['phone.sms_resend'] },
      { ...phone.data, challenge: { ...phone.data.challenge, state: 'sent' } }, { ...phone.data, challenge: { ...phone.data.challenge, checks_left: 6 } },
      { ...phone.data, challenge: { ...phone.data.challenge, retry_at: '1' } }, { ...phone.data, sms: undefined }])
      expect(() => readControls({ ...phone, data }, 'phone'), JSON.stringify(data)).toThrow('unsupported');
  });
  it('sends the code as its own field and nothing else', async () => {
    let sent: FormData | undefined;
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => { sent = init?.body as FormData; return Response.json({ receipt: { state: 'recorded', message: 'Your number is verified.' }, duplicate: false }); });
    await submitControl({ csrf: phone.csrf, revision: phone.revision, view: 'phone' }, 'phone.sms_check', { code: '424242' }, 'phone-request-1');
    expect(Object.fromEntries(sent!.entries())).toEqual({ csrf: phone.csrf, view: 'phone', revision: phone.revision, request_id: 'phone-request-1', action: 'phone.sms_check', code: '424242' });
  });
});
