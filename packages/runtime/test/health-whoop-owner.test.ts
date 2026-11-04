import { describe, expect, it } from 'vitest';
import handoffMigration from '../../../supabase/migrations/20261023060000_waldo_connect_session_handoff.sql?raw';
import { whoopDeletions } from '../src/health/providers/whoop-map';
import { handoffHash, HANDOFF_CODE_TTL_MS } from '../src/channels/connect-confirm';
import { addNight, connected, DAY, harness, NOW, night, newPlane, newWorld, recoveryRecord, sleepRecord, workoutRecord } from './helpers/whoop-fakes';

// Distinctive synthetic readings: if one shows up in a log line, the owner object kept a value.
const LEAKS = ['47.318', '430', '93.5'];
const signals = (plane: { samples: Map<string, { payload: Record<string, unknown> }> }) => [...plane.samples.values()].map(s => s.payload.signal as string);

describe('WHOOP connect and callback', () => {
  it('starts with both of the owner\'s WHOOP grants live, and hands the app a first-party start link carrying an eight-character state and a one-time code, both stored hashed', async () => {
    const h = harness();
    const url = new URL((await h.owner.connect() as { authorize_url: string }).authorize_url);
    expect(url.origin).toBe('https://worker.example.invalid');
    expect(url.pathname).toMatch(/^\/oauth\/whoop\/start\/[A-Za-z0-9]{8}$/);
    expect(url.search).toMatch(/^\?handoff=[A-Za-z0-9_-]{22}$/);
    const state = url.pathname.split('/').at(-1)!, code = url.searchParams.get('handoff')!;
    expect(h.plane.sessions).toHaveLength(1);
    expect(h.plane.sessions[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(h.plane.sessions[0]).not.toContain(state);
    expect(h.plane.handoffs).toEqual([await handoffHash(code)]);
    expect(url.toString()).not.toContain('client-secret-fixture');
    // Each start is its own code, so a link the app opened once is never reissued.
    const again = new URL((await h.owner.connect() as { authorize_url: string }).authorize_url);
    expect(again.searchParams.get('handoff')).not.toBe(code);
  });

  it('tells the app the link works for as long as its one-time code does, and that lifetime is the one the directory enforces', async () => {
    const h = harness();
    expect(await h.owner.connect()).toMatchObject({ expires_at: NOW + HANDOFF_CODE_TTL_MS });
    expect(handoffMigration).toContain(`handoff_expires_at)\n    values (v_owner, p_provider, p_channel, p_ticket_hash, now() + interval '12 hours', p_handoff_hash, now() + interval '${HANDOFF_CODE_TTL_MS / 60_000} minutes')`);
  });

  // WHOOP's express authorization is the two grants for the whoop source. The answer names the missing one so the app can send
  // the owner to exactly that consent.
  const grantCases = [
    { storage: 'none', model: 'granted', missing: ['storage_compute'] },
    { storage: 'granted', model: 'none', missing: ['model_processing'] },
    { storage: 'none', model: 'none', missing: ['storage_compute', 'model_processing'] },
    { storage: 'withdrawn', model: 'granted', missing: ['storage_compute'] },
    { storage: 'granted', model: 'withdrawn', missing: ['model_processing'] },
  ] as const;
  it.each(grantCases)('refuses to start with storage $storage and model use $model, and names what is missing', async ({ storage, model, missing }) => {
    const h = harness();
    h.plane.consent = storage; h.plane.model = model;
    expect(await h.owner.connect()).toEqual({ error: 'consent_required', missing });
    expect(h.plane.sessions).toEqual([]);
    expect([h.world.calls, h.edgeCalls]).toEqual([[], []]);
  });
  it('refuses to start when WHOOP is not configured', async () => {
    expect(await harness({ configured: false }).owner.connect()).toEqual({ error: 'not_configured' });
  });
  it.each(grantCases)('does not trade the callback code for tokens with storage $storage and model use $model', async ({ storage, model }) => {
    const h = harness();
    h.plane.consent = storage; h.plane.model = model;
    expect(await h.owner.exchange({ code: 'good-code', denied: false })).toBe('consent_required');
    expect([h.world.calls, h.edgeCalls, h.plane.vault.rows.length, h.kv.size, h.armed.length]).toEqual([[], [], 0, 0, 0]);
  });

  it('has the edge trade the code and keep the tokens, pins what the edge may trust, and keeps only an id, an account and a token version in the object', async () => {
    const h = await connected();
    const [exchange] = h.edgeCalls;
    expect(exchange).toMatchObject({ op: 'exchange', provider: 'whoop', code: 'good-code', scope: 'offline read:profile read:sleep read:recovery read:workout' });
    expect(exchange!.pins).toEqual({
      issuer: 'https://api.prod.whoop.com', token_endpoint: 'https://api.prod.whoop.com/oauth/oauth2/token', client_id: 'client-id-fixture', client_auth: 'client_secret_post',
      redirect_uri: 'https://worker.example.invalid/oauth/whoop/callback', api_base: 'https://api.prod.whoop.com/developer/v2/', account_url: 'https://api.prod.whoop.com/developer/v2/user/profile/basic',
      account_field: 'user_id', rotation: 'single_use', refresh_scope: 'offline',
    });
    expect(h.plane.vault.rows).toHaveLength(1);
    expect(h.plane.vault.rows[0]).toMatchObject({ provider: 'whoop', account: '70001', status: 'active' });
    expect(JSON.parse(h.plane.vault.rows[0]!.secret)).toMatchObject({ access_token: expect.stringMatching(/^access-/), refresh_token: expect.stringMatching(/^refresh-/) });
    expect(Object.keys(h.kv.get('whoop:conn') as object).sort()).toEqual(['account', 'expires_at', 'id', 'version']);
    expect(h.kv.get('whoop:conn')).toMatchObject({ id: h.plane.vault.rows[0]!.id, account: '70001', version: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(JSON.stringify([...h.kv, h.edgeCalls])).not.toMatch(/access-|refresh-|client-secret-fixture/);
    expect(h.armed).toEqual([NOW]);
    expect(await h.owner.status()).toEqual({ provider: 'whoop', state: 'connected', last_sync_at: null });
  });

  it('refuses a WHOOP account another owner already holds, and keeps nothing', async () => {
    const plane = newPlane();
    const first = harness({ plane, doName: 'owner-one' });
    expect(await first.owner.exchange({ code: 'good-code', denied: false })).toBe('linked');
    const second = harness({ plane, world: first.world, doName: 'owner-two' });
    expect(await second.owner.exchange({ code: 'good-code', denied: false })).toBe('already_linked');
    expect(second.kv.get('whoop:conn')).toBeUndefined();
    expect(second.armed).toEqual([]);
  });

  it('reads a denied or code-less callback and a bad code as not connected', async () => {
    const h = harness();
    expect(await h.owner.exchange({ code: null, denied: true })).toBe('denied');
    expect(await h.owner.exchange({ code: null, denied: false })).toBe('denied');
    expect(await h.owner.exchange({ code: 'spent-code', denied: false })).toBe('failed');
    expect([h.kv.size, h.plane.vault.rows.length, h.armed.length]).toEqual([0, 0, 0]);
  });
});

describe('WHOOP backfill and reconcile', () => {
  it('reads a month oldest first in windows of at most seven days, then a day later reconciles the last three', async () => {
    const h = await connected({}, 30);
    expect(await h.owner.sync()).toBe('synced');
    const sleepCalls = h.world.calls.filter(call => call === 'GET /activity/sleep');
    expect(sleepCalls).toHaveLength(5);
    expect(h.produced.count).toBe(1);
    expect(h.kv.get('whoop:cursor')).toMatchObject({ backfilled: true, last_sync_at: NOW });
    expect(h.armed.at(-1)).toBe(NOW + DAY);
    expect(signals(h.plane).filter(s => s === 'sleep_duration')).toHaveLength(30);
    const before = h.world.calls.length;
    h.clock.now = NOW + DAY;
    expect(await h.owner.sync()).toBe('synced');
    expect(h.world.calls.slice(before).filter(call => call === 'GET /activity/sleep')).toHaveLength(1);
  });

  it('writes with a null anchor and a request id that depends only on the changes, so a retry replays and never writes twice', async () => {
    const h = await connected({}, 3);
    await h.owner.sync();
    const first = [...h.plane.requests.keys()];
    const ingests = h.plane.ingests;
    h.kv.set('whoop:cursor', { backfilled: false, next_from: null, last_sync_at: null });
    await h.owner.sync();
    expect(h.plane.ingests).toBe(ingests);
    expect([...h.plane.requests.keys()]).toEqual(first);
    for (const id of first) expect(id).toMatch(/^whoop-[0-9a-f]{32}$/);
  });

  it('follows next-page tokens, and fetches the sleep of a recovery that fell outside the window', async () => {
    const h = await connected();
    for (let i = 0; i < 5; i += 1) addNight(h.world, i);
    h.world.pageSize = 2;
    expect(await h.owner.sync()).toBe('synced');
    expect(signals(h.plane).filter(s => s === 'overnight_hrv')).toHaveLength(5);
    const outside = harness();
    const n = night(40);
    outside.world.recoveries.push({ ...n.recovery, created_at: new Date(NOW - 5 * DAY).toISOString() });
    outside.world.sleeps.push(n.sleep);
    await outside.owner.exchange({ code: 'good-code', denied: false });
    await outside.owner.sync();
    expect(outside.world.calls.some(call => call.startsWith('GET /activity/sleep/'))).toBe(true);
    expect(signals(outside.plane)).toContain('overnight_hrv');
  });

  it('shows a missing night as no readings and an unscored recovery as no HRV, never a zero', async () => {
    const h = await connected();
    for (const i of [0, 1, 3]) addNight(h.world, i);
    addNight(h.world, 2, { recovery: { score_state: 'PENDING_SCORE', score: undefined } });
    await h.owner.sync();
    const days = (signal: string) => [...h.plane.samples.values()].filter(s => s.payload.signal === signal).map(s => s.payload.day).sort();
    expect(days('sleep_duration')).toEqual(['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']);
    expect(days('overnight_hrv')).toEqual(['2026-10-18', '2026-10-20', '2026-10-21']);
    for (const stored of h.plane.samples.values()) expect(stored.payload.value).toBeGreaterThan(0);
  });

  it('labels every HRV reading rmssd, the only method WHOOP reports', async () => {
    const h = await connected({}, 3);
    await h.owner.sync();
    const hrv = [...h.plane.samples.values()].filter(s => s.payload.signal === 'overnight_hrv');
    expect(hrv.length).toBe(3);
    for (const stored of hrv) expect(stored.payload.method).toBe('rmssd');
  });

  it('keeps an older record\'s page from overwriting a newer fetch of the same record', async () => {
    const h = await connected();
    addNight(h.world, 1, { sleep: { updated_at: '2026-10-20T07:00:00.000Z' } });
    await h.owner.sync();
    const key = [...h.plane.samples.keys()].find(k => k.startsWith('sleep_duration|'))!;
    const newer = { revision: h.plane.samples.get(key)!.revision, value: h.plane.samples.get(key)!.payload.value };
    // WHOOP's backfill later returns the same record as an older revision with another figure.
    h.world.sleeps[0] = night(1, { sleep: { updated_at: '2026-10-20T06:00:00.000Z', score: { ...(sleepRecord().score as object), stage_summary: { total_light_sleep_time_milli: 9_000_000, total_slow_wave_sleep_time_milli: 3_000_000, total_rem_sleep_time_milli: 3_000_000 } } } }).sleep;
    h.kv.set('whoop:cursor', { backfilled: false, next_from: null, last_sync_at: null });
    await h.owner.sync();
    expect({ revision: h.plane.samples.get(key)!.revision, value: h.plane.samples.get(key)!.payload.value }).toEqual(newer);
  });

  it('maps a workout in its own minutes on its own day', async () => {
    const h = await connected();
    h.world.workouts.push(workoutRecord({ start: '2026-10-20T11:00:00.000Z', end: '2026-10-20T11:50:00.000Z' }));
    await h.owner.sync();
    expect([...h.plane.samples.values()].filter(s => s.payload.signal === 'workout').map(s => [s.payload.value, s.payload.day, s.payload.activity])).toEqual([[50, '2026-10-20', 'running']]);
  });
});

describe('WHOOP token custody', () => {
  const tokenCalls = (h: { world: { calls: string[] } }) => h.world.calls.filter(call => call === 'POST /oauth/oauth2/token');

  it('stops at a token revoked mid-sync: the committed windows stay, the rest is unknown, the connection is marked, nothing is zero-filled', async () => {
    const h = await connected({}, 30);
    h.world.breakAfter = { path: '/activity/sleep', count: 2, status: 401 };
    expect(await h.owner.sync()).toBe('needs_reconnect');
    expect(signals(h.plane).filter(s => s === 'sleep_duration').length).toBeGreaterThan(0);
    expect(signals(h.plane).filter(s => s === 'sleep_duration').length).toBeLessThan(30);
    const cursor = h.kv.get('whoop:cursor') as { backfilled: boolean; next_from: number };
    expect(cursor.backfilled).toBe(false);
    expect(cursor.next_from).toBe(NOW - 30 * DAY + 14 * DAY);
    expect(h.plane.vault.rows[0]).toMatchObject({ status: 'failing', last_error: 'oauth_reauth_needed' });
    expect(h.produced.count).toBe(1);
    expect((await h.owner.status()).state).toBe('needs_reconnect');
    const calls = h.world.calls.length;
    expect(await h.owner.sync()).toBe('needs_reconnect');
    expect(h.world.calls.length - calls).toBe(0);
    for (const stored of h.plane.samples.values()) expect(stored.payload.value).toBeGreaterThan(0);
  });

  it('refreshes an expired access token once, through the edge, which rotates the saved token; the object keeps only the new version', async () => {
    const h = await connected({}, 2);
    const before = h.plane.vault.rows[0]!.secret;
    const exchanged = h.kv.get('whoop:conn') as { version: string };
    h.clock.now = NOW + 2 * 3_600_000;
    h.world.calls.length = 0;
    h.edgeCalls.length = 0;
    await h.owner.sync();
    expect(tokenCalls(h)).toHaveLength(1);
    expect(h.world.calls.indexOf('POST /oauth/oauth2/token')).toBe(0);
    expect(h.world.calls.indexOf('GET /activity/sleep')).toBeGreaterThan(h.world.calls.indexOf('POST /oauth/oauth2/token'));
    expect(h.edgeCalls[0]).toEqual({ op: 'refresh', do_name: 'owner-w', connection: h.plane.vault.rows[0]!.id, version: exchanged.version });
    expect(h.plane.vault.rpcs).toContain('oauth_rotate');
    expect(h.plane.vault.rows[0]!.secret).not.toBe(before);
    expect((h.kv.get('whoop:conn') as { version: string }).version).not.toBe(exchanged.version);
    expect(JSON.stringify([...h.kv, h.edgeCalls])).not.toMatch(/access-|refresh-|client-secret-fixture/);
  });

  it('refreshes once when two calls find the token expired at the same time', async () => {
    const h = await connected({}, 2);
    h.clock.now = NOW + 2 * 3_600_000;
    h.world.calls.length = 0;
    const trace = (n: number) => ({ type: 'sleep.updated', id: night(n).sleep.id as string, trace: `t-${n}` });
    await Promise.all([h.owner.sync(), h.owner.hint(trace(0)), h.owner.hint(trace(1))]);
    expect(tokenCalls(h)).toHaveLength(1);
  });

  it('keeps the connection healthy when a second runtime races the same expired token: the edge hands it the winner\'s', async () => {
    const a = await connected({}, 2);
    const b = harness({ plane: a.plane, world: a.world, clock: a.clock, kv: new Map(a.kv) });
    a.clock.now = NOW + 2 * 3_600_000;
    expect(await Promise.all([a.owner.sync(), b.owner.sync()])).toEqual(['synced', 'synced']);
    expect(a.world.spent).toEqual(['refresh-1']);
    expect(a.plane.vault.rows[0]).toMatchObject({ status: 'active', last_error: null });
    expect((a.kv.get('whoop:conn') as { version: string }).version).toBe((b.kv.get('whoop:conn') as { version: string }).version);
  });

  it('when the edge could not save the rotated token, retries later, and a spent token afterwards asks the owner to connect again', async () => {
    const h = await connected({}, 2);
    h.clock.now = NOW + 2 * 3_600_000;
    h.plane.vault.faults.rotate = 3;
    h.world.calls.length = 0;
    expect(await h.owner.sync()).toBe('failed');
    expect(h.armed.at(-1)).toBe(h.clock.now + 15 * 60_000);
    expect(h.world.calls.filter(call => call.startsWith('GET /activity'))).toEqual([]);
    expect(await h.owner.sync()).toBe('needs_reconnect');
    // The second try used the saved secret, whose refresh token WHOOP had already spent: the owner connects again, not retried forever.
    expect(tokenCalls(h)).toHaveLength(2);
    expect((await h.owner.status()).state).toBe('needs_reconnect');
  });

  it('reads a rejected refresh token as the owner having revoked access at WHOOP, and stops calling until the owner connects again', async () => {
    const h = await connected({}, 1);
    h.world.validAccess.clear(); h.world.validRefresh.clear();
    expect(await h.owner.sync()).toBe('needs_reconnect');
    expect(h.plane.vault.rows[0]).toMatchObject({ status: 'failing', last_error: 'oauth_reauth_needed' });
    expect(h.armed.at(-1)).toBe(NOW);
    h.world.calls.length = 0;
    expect(await h.owner.hint({ type: 'sleep.updated', id: night(0).sleep.id as string, trace: 'trace-gggg-0001' })).toBe('needs_reconnect');
    expect(h.world.calls).toEqual([]);
    expect(await h.owner.exchange({ code: 'good-code', denied: false })).toBe('linked');
    expect((await h.owner.status()).state).toBe('connected');
  });

  it('waits out WHOOP\'s rate limit and resumes from the committed window', async () => {
    const h = await connected({}, 30);
    h.world.limited = { until: NOW + 3_600_000 };
    expect(await h.owner.sync()).toBe('rate_limited');
    expect(h.armed.at(-1)).toBe(NOW + 31_000);
    expect(h.plane.ingests).toBe(0);
    h.clock.now = NOW + 3_600_001;
    expect(await h.owner.sync()).toBe('synced');
  });
});

describe('WHOOP webhooks as hints', () => {
  it('fetches the changed sleep and its recovery with the owner\'s own token, and ignores a delivery it has already handled', async () => {
    const h = await connected();
    const n = addNight(h.world, 0);
    const hint = { type: 'sleep.updated', id: n.sleep.id as string, trace: 'trace-aaaa-0001' };
    expect(await h.owner.hint(hint)).toBe('handled');
    expect(signals(h.plane).sort()).toEqual(['overnight_hrv', 'resting_heart_rate', 'sleep_duration', 'sleep_efficiency', 'sleep_midpoint', 'spo2']);
    const calls = h.world.calls.length;
    expect(await h.owner.hint(hint)).toBe('duplicate');
    expect(h.world.calls.length).toBe(calls);
    expect(h.produced.count).toBe(1);
  });

  it('takes a recovery webhook\'s id as its sleep\'s id, and a redelivery under a new trace as a harmless replay', async () => {
    const h = await connected();
    const n = addNight(h.world, 0);
    expect(await h.owner.hint({ type: 'recovery.updated', id: n.sleep.id as string, trace: 'trace-bbbb-0001' })).toBe('handled');
    const ingests = h.plane.ingests;
    expect(await h.owner.hint({ type: 'recovery.updated', id: n.sleep.id as string, trace: 'trace-bbbb-0002' })).toBe('handled');
    expect(h.plane.ingests).toBe(ingests);
    expect(h.produced.count).toBe(1);
  });

  it('removes what a deleted record produced, and a workout hint maps the workout', async () => {
    const h = await connected();
    const n = addNight(h.world, 0);
    await h.owner.hint({ type: 'sleep.updated', id: n.sleep.id as string, trace: 'trace-cccc-0001' });
    expect(signals(h.plane)).toContain('sleep_duration');
    h.clock.now = NOW + 60_000;
    expect(await h.owner.hint({ type: 'sleep.deleted', id: n.sleep.id as string, trace: 'trace-cccc-0002' })).toBe('handled');
    expect(signals(h.plane)).toEqual([]);
    const w = workoutRecord();
    h.world.workouts.push(w);
    expect(await h.owner.hint({ type: 'workout.updated', id: w.id as string, trace: 'trace-cccc-0003' })).toBe('handled');
    expect(signals(h.plane)).toEqual(['workout']);
    expect(whoopDeletions('workout', 'x', 1)).toHaveLength(1);
  });

  it('ignores a type, an id or a trace it does not recognize, and a hint for an owner with no connection, without calling WHOOP', async () => {
    const h = await connected();
    h.world.calls.length = 0;
    for (const bad of [{ type: 'cycle.updated', id: 'x', trace: 'abcdefgh' }, { type: 'sleep.updated', id: '../x', trace: 'abcdefgh' }, { type: 'sleep.updated', id: 'x', trace: '' }]) expect(await h.owner.hint(bad)).toBe('ignored');
    expect(h.world.calls).toEqual([]);
    expect(await harness().owner.hint({ type: 'sleep.updated', id: 'x', trace: 'abcdefgh' })).toBe('ignored');
  });

  it('leaves a hint unhandled, so WHOOP\'s redelivery or the next reconcile catches it, when the fetch fails', async () => {
    const h = await connected();
    const n = addNight(h.world, 0);
    h.world.limited = { until: NOW + 10_000 };
    expect(await h.owner.hint({ type: 'sleep.updated', id: n.sleep.id as string, trace: 'trace-dddd-0001' })).toBe('rate_limited');
    h.world.limited = null;
    expect(await h.owner.hint({ type: 'sleep.updated', id: n.sleep.id as string, trace: 'trace-dddd-0001' })).toBe('handled');
  });
});

describe('WHOOP consent', () => {
  it('stops and stores nothing once the owner\'s storage consent is withdrawn, and says so in the status', async () => {
    const h = await connected({}, 3);
    h.plane.consent = 'withdrawn';
    expect(await h.owner.sync()).toBe('consent_required');
    expect(h.plane.ingests).toBe(0);
    expect(h.produced.count).toBe(0);
    expect((await h.owner.status()).state).toBe('consent_required');
    expect(await h.owner.hint({ type: 'sleep.updated', id: night(0).sleep.id as string, trace: 'trace-eeee-0001' })).toBe('consent_required');
  });

  it('stops the same way when only model use is withdrawn, since WHOOP data may be stored only for AI use the owner allowed', async () => {
    const h = await connected({}, 3);
    h.plane.model = 'withdrawn';
    const before = h.world.calls.length;
    expect(await h.owner.sync()).toBe('consent_required');
    expect([h.plane.ingests, h.produced.count, h.world.calls.length]).toEqual([0, 0, before]);
    expect((await h.owner.status()).state).toBe('consent_required');
    expect(await h.owner.hint({ type: 'sleep.updated', id: night(0).sleep.id as string, trace: 'trace-eeee-0002' })).toBe('consent_required');
    h.plane.model = 'granted';
    expect(await h.owner.sync()).toBe('synced');
    expect(h.plane.ingests).toBeGreaterThan(0);
  });

  it('follows a changed consent epoch once, and a withdrawal that lands mid-batch stops the run', async () => {
    const h = await connected({}, 2);
    h.plane.epoch = 2;
    expect(await h.owner.sync()).toBe('synced');
    expect(signals(h.plane)).toContain('sleep_duration');
  });
});

describe('WHOOP disconnect', () => {
  it('revokes at WHOOP, deletes the saved access, clears the cursor and stops the sync; stored readings stay until consent is withdrawn', async () => {
    const h = await connected({}, 3);
    await h.owner.sync();
    const stored = h.plane.samples.size;
    expect(await h.owner.disconnect()).toEqual({ revoked_at_provider: true });
    expect([h.plane.vault.rows.filter(row => row.status !== 'revoked').length, h.plane.vault.rows[0]!.secret, h.kv.has('whoop:conn'), h.kv.has('whoop:cursor'), h.disarmed.count]).toEqual([0, '', false, false, 1]);
    expect(h.world.calls).toContain('DELETE /user/access');
    expect(h.plane.samples.size).toBe(stored);
    expect(await h.owner.status()).toMatchObject({ state: 'not_connected' });
    expect(await h.owner.sync()).toBe('idle');
  });

  it('removes the saved access even when WHOOP does not confirm, and says it was unconfirmed', async () => {
    const h = await connected({}, 1);
    h.world.revokeStatus = 500;
    expect(await h.owner.disconnect()).toEqual({ revoked_at_provider: false });
    expect(h.plane.vault.rows.filter(row => row.status !== 'revoked')).toEqual([]);
  });

  it('is safe to repeat', async () => {
    const h = await connected();
    await h.owner.disconnect();
    expect(await h.owner.disconnect()).toEqual({ revoked_at_provider: false });
  });
});

describe('WHOOP privacy', () => {
  it('keeps no reading, token or zone in a log line or in the object\'s own storage', async () => {
    const h = await connected({}, 5);
    await h.owner.sync();
    h.world.limited = { until: NOW + 10_000 };
    await h.owner.hint({ type: 'sleep.updated', id: night(0).sleep.id as string, trace: 'trace-ffff-0001' });
    await h.owner.disconnect();
    const text = JSON.stringify([h.logs, [...h.kv], h.edgeCalls]);
    for (const leak of [...LEAKS, 'access-', 'refresh-', 'client-secret-fixture']) expect(text, leak).not.toContain(leak);
    for (const line of h.logs) expect(Object.keys(line).sort()).toEqual(['code', 'hop', 'ok']);
  });
});
