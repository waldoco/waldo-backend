// Google Calendar push channels. A push only says "look now": it carries no event data, and the
// owner object answers it by running its existing update check sooner. Shared with the
// connector-proxy edge, which starts and stops channels for Vault-backed grants.

export const CALENDAR_PUSH_PATH = '/events/gcal';
export const CALENDAR_WATCH_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events/watch';
export const CHANNEL_STOP_URL = 'https://www.googleapis.com/calendar/v3/channels/stop';
const WATCH_TTL_S = 7 * 24 * 3600;
const RENEW_BEFORE_MS = 24 * 3_600_000;
const RETRY_AFTER_FAILURE_MS = 6 * 3_600_000;

export type CalendarWatch = Readonly<{ channelId: string; resourceId: string; expiration: number }>;
export type CalendarWatchState = CalendarWatch | Readonly<{ failedAt: number }>;
export type CalendarPush = Readonly<{ channelId: string; token: string; state: 'sync' | 'exists' | 'not_exists'; messageNumber: number }>;

export class GooglePushError extends Error {
  constructor(readonly status: number, readonly code: 'invalid_request' | 'auth' | 'refused' | 'transient' | 'malformed') { super(`google_push_${code}`); this.name = 'GooglePushError'; }
}

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const b64url = (text: string) => btoa(String.fromCharCode(...encoder.encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (text: string): string | null => {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(text)) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))); } catch { return null; }
};
const mac = async (secret: string, doName: string, channelId: string) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`gcal-channel.v1.${doName}.${channelId}`)));
};
const same = (a: string, b: string) => {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
};

// Google echoes the token on every push. It names the owner object to wake, bound to one channel.
export const calendarChannelToken = async (secret: string, doName: string, channelId: string): Promise<string> =>
  `v1.${b64url(doName)}.${await mac(secret, doName, channelId)}`;

export const verifyCalendarChannel = async (secret: string, token: string, channelId: string): Promise<string | null> => {
  const [version, name, given, ...rest] = token.split('.');
  if (version !== 'v1' || rest.length || !name || !given || !/^[0-9a-f]{64}$/.test(given)) return null;
  const doName = fromB64url(name);
  if (!doName) return null;
  return same(given, await mac(secret, doName, channelId)) ? doName : null;
};

export const parseCalendarPush = (headers: Headers): CalendarPush | null => {
  const channelId = headers.get('x-goog-channel-id') ?? '';
  const token = headers.get('x-goog-channel-token') ?? '';
  const state = headers.get('x-goog-resource-state');
  const number = headers.get('x-goog-message-number') ?? '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(channelId) || !token || token.length > 256 || !/^\d{1,15}$/.test(number)) return null;
  if (state !== 'sync' && state !== 'exists' && state !== 'not_exists') return null;
  return { channelId, token, state, messageNumber: Number(number) };
};

const failure = (status: number): GooglePushError =>
  new GooglePushError(status, status === 401 ? 'auth' : status === 429 || status >= 500 ? 'transient' : 'refused');

const post = async (fetcher: typeof fetch, bearer: string, url: string, body: unknown): Promise<Response> => {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new GooglePushError(502, 'transient');
  }
  if (!response.ok) { void response.body?.cancel(); throw failure(response.status); }
  return response;
};

export const startCalendarWatch = async (fetcher: typeof fetch, bearer: string, input: Readonly<{ channelId: string; token: string; address: string }>): Promise<CalendarWatch> => {
  let address: URL;
  try { address = new URL(input.address); } catch { throw new GooglePushError(400, 'invalid_request'); }
  if (address.protocol !== 'https:' || address.pathname !== CALENDAR_PUSH_PATH || !/^[A-Za-z0-9_-]{1,64}$/.test(input.channelId) || !input.token || input.token.length > 256) throw new GooglePushError(400, 'invalid_request');
  const response = await post(fetcher, bearer, CALENDAR_WATCH_URL, { id: input.channelId, type: 'web_hook', address: address.toString(), token: input.token, params: { ttl: String(WATCH_TTL_S) } });
  const text = await response.text();
  let data: { id?: unknown; resourceId?: unknown; expiration?: unknown };
  try { data = JSON.parse(text.length <= 4096 ? text : '') as typeof data; } catch { throw new GooglePushError(502, 'malformed'); }
  if (data.id !== input.channelId || typeof data.resourceId !== 'string' || !data.resourceId || data.resourceId.length > 256 || typeof data.expiration !== 'string' || !/^\d{1,15}$/.test(data.expiration)) throw new GooglePushError(502, 'malformed');
  return { channelId: input.channelId, resourceId: data.resourceId, expiration: Number(data.expiration) };
};

export const stopChannel = async (fetcher: typeof fetch, bearer: string, channel: Readonly<{ channelId: string; resourceId: string }>): Promise<void> => {
  const response = await post(fetcher, bearer, CHANNEL_STOP_URL, { id: channel.channelId, resourceId: channel.resourceId });
  void response.body?.cancel();
};

// Renew a day before expiry; after a failed attempt, the 10-minute poll carries on and the next try waits.
export const watchDue = (state: CalendarWatchState | null, now: number): boolean =>
  state === null ? true : 'failedAt' in state ? now - state.failedAt >= RETRY_AFTER_FAILURE_MS : state.expiration - now < RENEW_BEFORE_MS;
