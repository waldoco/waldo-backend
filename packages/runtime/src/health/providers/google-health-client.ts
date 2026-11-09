import { HANDOFF_PARAM } from '../../channels/connect-confirm';
import type { ClientPins } from '../../connectors/mcp-oauth';
import type { EdgeReply } from './whoop-client';
import {
  googleHealthBody, googleHealthDaily, googleHealthExercise, googleHealthInterval, googleHealthSleep,
  type GoogleHealthBody, type GoogleHealthDaily, type GoogleHealthDailyKind, type GoogleHealthExercise, type GoogleHealthInterval, type GoogleHealthSleep,
} from './google-health-map';

// Google Health API v4 as the owner object sees it: the oauth-proxy Edge Function holds every token and the client secret,
// makes each GET under the pinned API base, and hands back only a status, the parsed body and the headers. This module
// builds the pins the edge is told to trust, names each request as a path and filter under that base, and parses each
// answer through google-health-map. It never sees a token.
export type GoogleHealthConfig = Readonly<{ clientId: string; redirectUri: string }>;
// Read-only, and only the three groups Waldo maps: sleep, vitals and body measurements, activity and exercise.
export const GOOGLE_HEALTH_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
].join(' ');
export const GOOGLE_HEALTH_CALLBACK_PATH = '/oauth/google-health/callback';
export const GOOGLE_HEALTH_START_PATH = '/oauth/google-health/start/';
const ISSUER = 'https://accounts.google.com';
const API_BASE = 'https://health.googleapis.com/v4/';
// Google caps sleep and exercise pages at 25. 1440 is one day of minute-long step intervals, Google's own default, and keeps
// a page well inside what the edge will carry.
const SESSION_PAGE = '25';
const SAMPLE_PAGE = '100';
const INTERVAL_PAGE = '1440';
// Reconciled steps and energy merged across Google's own wearables only, so an Apple Health or Health Connect import is
// never summed in. Reconciled points carry no data source, so the family is the only place that exclusion can happen.
const WEARABLES = 'users/me/dataSourceFamilies/google-wearables';

// Google's behaviour, pinned for the edge: a confidential web client, refresh tokens that do not rotate, and the
// case-sensitive health user id from the identity resource as the account.
export const googleHealthPins = (config: GoogleHealthConfig): ClientPins => ({
  issuer: ISSUER, token_endpoint: 'https://oauth2.googleapis.com/token', revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
  client_id: config.clientId, client_auth: 'client_secret_post', redirect_uri: config.redirectUri,
  api_base: API_BASE, account_url: `${API_BASE}users/me/identity`, account_field: 'healthUserId',
});
// The app opens Waldo's own start link, never Google's page directly, so the browser that receives the callback is the one
// that took the hop and holds the attempt's binding.
export const googleHealthStartUrl = (config: GoogleHealthConfig, state: string, handoff: string): string => {
  const url = new URL(`${GOOGLE_HEALTH_START_PATH}${state}`, config.redirectUri);
  url.searchParams.set(HANDOFF_PARAM, handoff);
  return url.toString();
};
// offline makes Google issue a refresh token; consent makes it issue one again when the owner reconnects.
export const googleHealthAuthorizeUrl = (config: GoogleHealthConfig, state: string): string =>
  `${ISSUER}/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: GOOGLE_HEALTH_SCOPES, state, access_type: 'offline', prompt: 'consent',
  })}`;

// rejected: Google refused the request itself (a missing scope, a bad filter). rate_limited carries the seconds Google asks
// to wait. unavailable: Google failed, so trying again later is safe. malformed: an answer of the wrong shape.
export class GoogleHealthError extends Error {
  constructor(readonly kind: 'rejected' | 'rate_limited' | 'unavailable' | 'malformed', readonly status: number, readonly resetSeconds = 0) { super(`google_health ${kind}`); }
}
export type GoogleHealthCall = (method: 'GET', path: string, query?: Readonly<Record<string, string>>) => Promise<EdgeReply>;
export type GoogleHealthPage<T> = Readonly<{ records: readonly T[]; next: string | null; dropped: number }>;
// Instants for timed records; dates (YYYY-MM-DD) for daily summaries and exercise, which Google filters by local date.
export type GoogleHealthWindow = Readonly<{ from: string; to: string; next: string | null }>;

const DAILY: Readonly<Record<GoogleHealthDailyKind, readonly [path: string, field: string]>> = {
  overnight_hrv: ['daily-heart-rate-variability', 'dailyHeartRateVariability'],
  resting_heart_rate: ['daily-resting-heart-rate', 'dailyRestingHeartRate'],
  spo2: ['daily-oxygen-saturation', 'dailyOxygenSaturation'],
  respiratory_rate: ['daily-respiratory-rate', 'dailyRespiratoryRate'],
  wrist_temperature: ['daily-sleep-temperature-derivations', 'dailySleepTemperatureDerivations'],
};
const BODY: Readonly<Record<GoogleHealthBody['kind'], readonly [path: string, field: string]>> = {
  body_mass: ['weight', 'weight'],
  body_fat_percentage: ['body-fat', 'bodyFat'],
};
const INTERVAL: Readonly<Record<'steps' | 'active_energy', readonly [path: string, field: string]>> = {
  steps: ['steps', 'steps'],
  active_energy: ['active-energy-burned', 'activeEnergyBurned'],
};

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const range = (field: string, window: GoogleHealthWindow) => `${field} >= "${window.from}" AND ${field} < "${window.to}"`;

export const googleHealthClient = (call: GoogleHealthCall) => {
  const answer = (reply: EdgeReply): Record<string, unknown> => {
    if (reply.status === 429) throw new GoogleHealthError('rate_limited', 429, Math.max(1, Math.min(3_600, Number(reply.headers['retry-after']) || 60)));
    if (reply.status < 200 || reply.status >= 300) throw new GoogleHealthError(reply.status >= 500 ? 'unavailable' : 'rejected', reply.status);
    const body = record(reply.body);
    if (!body) throw new GoogleHealthError('malformed', reply.status);
    return body;
  };
  const page = async <T>(path: string, query: Record<string, string>, next: string | null, parse: (raw: unknown) => T | null): Promise<GoogleHealthPage<T>> => {
    const body = answer(await call('GET', `users/me/dataTypes/${path}`, { ...query, ...(next ? { pageToken: next } : {}) }));
    // Google leaves dataPoints out of an empty page.
    const raw = body.dataPoints === undefined ? [] : Array.isArray(body.dataPoints) ? body.dataPoints : null;
    if (!raw) throw new GoogleHealthError('malformed', 200);
    const records = raw.flatMap(item => { const parsed = parse(item); return parsed ? [parsed] : []; });
    return { records, next: typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null, dropped: raw.length - records.length };
  };

  return {
    // Sleep is listed by when it ended, so a night belongs to the window holding its waking.
    sleeps: (window: GoogleHealthWindow) =>
      page<GoogleHealthSleep>('sleep/dataPoints', { filter: range('sleep.interval.end_time', window), pageSize: SESSION_PAGE }, window.next, googleHealthSleep),
    daily: (kind: GoogleHealthDailyKind, window: GoogleHealthWindow) => {
      const [path, field] = DAILY[kind];
      return page<GoogleHealthDaily>(`${path}/dataPoints`, { filter: range(`${field}.date`, window), pageSize: SAMPLE_PAGE }, window.next,
        raw => { const daily = googleHealthDaily(raw); return daily?.kind === kind ? daily : null; });
    },
    // Google filters exercise only by local start date, so the caller names dates and leaves a day's margin either side.
    workouts: (window: GoogleHealthWindow) =>
      page<GoogleHealthExercise>('exercise/dataPoints', { filter: range('exercise.interval.civil_start_time', window), pageSize: SESSION_PAGE }, window.next, googleHealthExercise),
    body: (kind: GoogleHealthBody['kind'], window: GoogleHealthWindow) => {
      const [path, field] = BODY[kind];
      return page<GoogleHealthBody>(`${path}/dataPoints`, { filter: range(`${field}.sample_time.physical_time`, window), pageSize: SAMPLE_PAGE }, window.next,
        raw => { const body = googleHealthBody(raw); return body?.kind === kind ? body : null; });
    },
    intervals: (kind: 'steps' | 'active_energy', window: GoogleHealthWindow) => {
      const [path, field] = INTERVAL[kind];
      return page<GoogleHealthInterval>(`${path}/dataPoints:reconcile`, { filter: range(`${field}.interval.start_time`, window), pageSize: INTERVAL_PAGE, dataSourceFamily: WEARABLES },
        window.next, raw => googleHealthInterval(kind, raw));
    },
  };
};
export type GoogleHealthClient = ReturnType<typeof googleHealthClient>;
