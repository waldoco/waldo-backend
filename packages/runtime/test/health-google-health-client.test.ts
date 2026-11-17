import { describe, expect, it } from 'vitest';
import {
  GOOGLE_HEALTH_SCOPES, GoogleHealthError, googleHealthAuthorizeUrl, googleHealthClient, googleHealthPins, googleHealthStartUrl, type GoogleHealthCall,
} from '../src/health/providers/google-health-client';
import { parseOAuthProxyRequest } from '../src/connectors/oauth-proxy-wire';

// Google Health API v4 as the owner object sees it, through the oauth-proxy edge. The edge is faked: it records each
// request and answers with synthetic bodies. No real account, no real readings, no token anywhere.
const config = { clientId: 'fictional-client.apps.googleusercontent.com', redirectUri: 'https://waldo.example/oauth/google-health/callback' };
const IST = '19800s';
const fitbit = { platform: 'FITBIT' };
type Sent = { method: string; path: string; query: Record<string, string> | undefined };
const edge = (answer: (sent: Sent) => { status: number; body: unknown; headers?: Record<string, string> }) => {
  const sent: Sent[] = [];
  const call: GoogleHealthCall = async (method, path, query) => {
    const request = { method, path, query: query ? { ...query } : undefined };
    // Every request must be one the edge's own wire parser admits, or it would be refused before reaching Google.
    if (!parseOAuthProxyRequest({ op: 'fetch', do_name: 'owner-a', connection: '00000000-0000-4000-8000-000000000001', method, path, ...(query ? { query } : {}) })) throw new Error(`edge refuses ${path}`);
    sent.push(request);
    const reply = answer(request);
    return { status: reply.status, body: reply.body, headers: reply.headers ?? {} };
  };
  return { sent, api: googleHealthClient(call) };
};

describe('Google Health sign-in', () => {
  it('asks for exactly the three read-only scopes, offline, with consent shown so a refresh token is issued', () => {
    expect(GOOGLE_HEALTH_SCOPES.split(' ')).toEqual([
      'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
      'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
      'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
    ]);
    const url = new URL(googleHealthAuthorizeUrl(config, 'StAtE123'));
    expect([url.origin + url.pathname, Object.fromEntries(url.searchParams)]).toEqual(['https://accounts.google.com/o/oauth2/v2/auth', {
      client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: GOOGLE_HEALTH_SCOPES, state: 'StAtE123', access_type: 'offline', prompt: 'consent',
    }]);
    expect(googleHealthStartUrl(config, 'StAtE123', 'h4ndoff')).toBe('https://waldo.example/oauth/google-health/start/StAtE123?handoff=h4ndoff');
  });

  it('pins Google\'s token, revocation and identity endpoints for the edge, with the case-sensitive health user id as the account', () => {
    expect(googleHealthPins(config)).toEqual({
      issuer: 'https://accounts.google.com', token_endpoint: 'https://oauth2.googleapis.com/token', revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
      client_id: config.clientId, client_auth: 'client_secret_post', redirect_uri: config.redirectUri,
      api_base: 'https://health.googleapis.com/v4/', account_url: 'https://health.googleapis.com/v4/users/me/identity', account_field: 'healthUserId',
    });
    expect(parseOAuthProxyRequest({ op: 'exchange', do_name: 'owner-a', provider: 'google_health', pins: googleHealthPins(config), code: 'fictional-code' })).not.toBeNull();
  });
});

describe('Google Health reads', () => {
  const window = { from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z', next: null };

  it('lists sleep by end time and parses each point through the mapper, dropping what it cannot place', async () => {
    const good = { dataSource: fitbit, sleep: { interval: { startTime: '2026-11-05T17:30:00Z', startUtcOffset: IST, endTime: '2026-11-06T01:00:00Z', endUtcOffset: IST },
      metadata: { mainSleep: true }, summary: { minutesAsleep: '405', minutesInSleepPeriod: '450' }, updateTime: '2026-11-06T01:20:00Z' } };
    const { sent, api } = edge(() => ({ status: 200, body: { dataPoints: [good, { dataSource: { platform: 'HEALTH_KIT' }, sleep: good.sleep }], nextPageToken: 'pg2' } }));
    const page = await api.sleeps(window);
    expect([page.records.length, page.dropped, page.next]).toEqual([1, 1, 'pg2']);
    expect(sent).toEqual([{ method: 'GET', path: 'users/me/dataTypes/sleep/dataPoints', query: {
      filter: 'sleep.interval.end_time >= "2026-11-01T00:00:00Z" AND sleep.interval.end_time < "2026-11-08T00:00:00Z"', pageSize: '25' } }]);
  });

  it('lists each daily vital by date, and passes the page token back', async () => {
    const { sent, api } = edge(() => ({ status: 200, body: { dataPoints: [{ dataSource: fitbit, dailyRestingHeartRate: { date: { year: 2026, month: 11, day: 6 }, beatsPerMinute: '57' } }] } }));
    const page = await api.daily('resting_heart_rate', { from: '2026-11-01', to: '2026-11-08', next: 'tok' });
    expect([page.records, page.next]).toEqual([[{ kind: 'resting_heart_rate', date: '2026-11-06', value: 57 }], null]);
    expect(sent[0]).toEqual({ method: 'GET', path: 'users/me/dataTypes/daily-resting-heart-rate/dataPoints', query: {
      filter: 'dailyRestingHeartRate.date >= "2026-11-01" AND dailyRestingHeartRate.date < "2026-11-08"', pageSize: '100', pageToken: 'tok' } });
  });

  it('drops a point of another type than the one asked for, and reads a page Google left empty as no records', async () => {
    const spo2 = { dataSource: fitbit, dailyOxygenSaturation: { date: { year: 2026, month: 11, day: 6 }, averagePercentage: 97 } };
    const fat = { dataSource: fitbit, bodyFat: { sampleTime: { physicalTime: '2026-11-06T02:00:00Z', utcOffset: IST }, percentage: 20 } };
    const wrong = edge(sent => ({ status: 200, body: { dataPoints: sent.path.startsWith('users/me/dataTypes/daily') ? [spo2] : [fat] } })).api;
    expect(await wrong.daily('resting_heart_rate', window)).toEqual({ records: [], next: null, dropped: 1 });
    expect(await wrong.body('body_mass', window)).toEqual({ records: [], next: null, dropped: 1 });
    expect(await edge(() => ({ status: 200, body: {} })).api.sleeps(window)).toEqual({ records: [], next: null, dropped: 0 });
  });

  it('reads steps and active energy reconciled across Google wearables only, so nothing imported from a phone is summed in', async () => {
    const { sent, api } = edge(() => ({ status: 200, body: { dataPoints: [{ steps: { interval: { startTime: '2026-11-06T03:30:00Z', startUtcOffset: IST, endTime: '2026-11-06T03:31:00Z', endUtcOffset: IST }, count: '50' } }] } }));
    const page = await api.intervals('steps', window);
    expect(page.records).toEqual([{ start: '2026-11-06T03:30:00Z', end: '2026-11-06T03:31:00Z', value: 50 }]);
    await api.intervals('active_energy', window);
    expect(sent.map(s => s.query?.pageSize)).toEqual(['1440', '1440']);
    expect(sent.map(s => [s.path, s.query?.dataSourceFamily, s.query?.filter])).toEqual([
      ['users/me/dataTypes/steps/dataPoints:reconcile', 'users/me/dataSourceFamilies/google-wearables', 'steps.interval.start_time >= "2026-11-01T00:00:00Z" AND steps.interval.start_time < "2026-11-08T00:00:00Z"'],
      ['users/me/dataTypes/active-energy-burned/dataPoints:reconcile', 'users/me/dataSourceFamilies/google-wearables', 'activeEnergyBurned.interval.start_time >= "2026-11-01T00:00:00Z" AND activeEnergyBurned.interval.start_time < "2026-11-08T00:00:00Z"'],
    ]);
  });

  it('lists workouts by civil start date and weight and body fat by sample time', async () => {
    const { sent, api } = edge(() => ({ status: 200, body: { dataPoints: [] } }));
    await api.workouts({ from: '2026-11-01', to: '2026-11-08', next: null });
    await api.body('body_mass', window);
    await api.body('body_fat_percentage', window);
    expect(sent.map(s => [s.path, s.query?.filter])).toEqual([
      ['users/me/dataTypes/exercise/dataPoints', 'exercise.interval.civil_start_time >= "2026-11-01" AND exercise.interval.civil_start_time < "2026-11-08"'],
      ['users/me/dataTypes/weight/dataPoints', 'weight.sample_time.physical_time >= "2026-11-01T00:00:00Z" AND weight.sample_time.physical_time < "2026-11-08T00:00:00Z"'],
      ['users/me/dataTypes/body-fat/dataPoints', 'bodyFat.sample_time.physical_time >= "2026-11-01T00:00:00Z" AND bodyFat.sample_time.physical_time < "2026-11-08T00:00:00Z"'],
    ]);
  });

  it('names a refusal, a rate limit with Google\'s retry delay, an outage and a malformed answer as distinct errors', async () => {
    const failing = (status: number, body: unknown, headers?: Record<string, string>) => edge(() => ({ status, body, ...(headers ? { headers } : {}) })).api.sleeps(window);
    await expect(failing(403, {})).rejects.toMatchObject({ kind: 'rejected', status: 403 });
    await expect(failing(429, {}, { 'retry-after': '120' })).rejects.toMatchObject({ kind: 'rate_limited', resetSeconds: 120 });
    await expect(failing(429, {})).rejects.toMatchObject({ kind: 'rate_limited', resetSeconds: 60 });
    await expect(failing(503, {})).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(failing(200, { dataPoints: 'nope' })).rejects.toMatchObject({ kind: 'malformed' });
    await expect(failing(200, [])).rejects.toBeInstanceOf(GoogleHealthError);
  });
});
