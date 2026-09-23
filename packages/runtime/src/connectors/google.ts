// Google connector for the owner's own account: OAuth (offline, one refresh token held in the
// owner's Durable Object, never in the repo or prompt), Calendar reads and Gmail drafts.
// Owner decision 2026-09-23: consent once to the workspace set Waldo will grow into, so new
// tools don't force re-consent. Scope is not permission: each tool still gates its own effects.
// Unverified app, so only listed test users can connect (post-mvp-cleanup: Google verification).
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/contacts',
] as const;

export const GOOGLE_CALLBACK_PATH = '/oauth/google/callback';
const STATE_TTL_MS = 15 * 60_000;

export type GoogleApp = Readonly<{ clientId: string; clientSecret: string; redirectUri: string }>;
export type GoogleTokens = Readonly<{ refresh_token: string; email?: string }>;
type Fetch = typeof fetch;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`google-oauth-state:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
}

export async function oauthState(secret: string, owner: string, now: number): Promise<string> {
  const payload = `${owner}.${now + STATE_TTL_MS}`;
  return `${payload}.${await sign(secret, payload)}`;
}

export async function verifyOauthState(secret: string, state: string, now: number): Promise<string | null> {
  const [owner, expires, mac] = state.split('.');
  if (!owner || !expires || !mac || Number(expires) < now) return null;
  return (await sign(secret, `${owner}.${expires}`)) === mac ? owner : null;
}

export function googleConsentUrl(app: GoogleApp, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: app.clientId, redirect_uri: app.redirectUri, response_type: 'code', scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  }).toString();
  return url.toString();
}

async function token(app: GoogleApp, body: Record<string, string>, fetcher: Fetch): Promise<{ access_token: string; refresh_token?: string; id_token?: string }> {
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...body }).toString(),
  });
  const json = await response.json() as { access_token?: string; refresh_token?: string; id_token?: string; error?: string };
  if (!response.ok || !json.access_token) throw new Error(`google token failed: ${json.error ?? response.status}`);
  return json as { access_token: string; refresh_token?: string; id_token?: string };
}

export async function exchangeGoogleCode(app: GoogleApp, code: string, fetcher: Fetch = fetch): Promise<GoogleTokens> {
  const result = await token(app, { code, grant_type: 'authorization_code', redirect_uri: app.redirectUri }, fetcher);
  if (!result.refresh_token) throw new Error('google returned no refresh token');
  const claims = result.id_token ? JSON.parse(atob(result.id_token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { email?: string } : {};
  return { refresh_token: result.refresh_token, ...(claims.email ? { email: claims.email } : {}) };
}

export type CalendarItem = Readonly<{ id: string; title: string; start: string; end: string; all_day: boolean; location?: string; description?: string; attendees?: number }>;
export type CalendarChange = CalendarItem & Readonly<{ status: string; created: string }>;
export type MailItem = Readonly<{ id: string; from: string; subject: string; snippet: string; at: string }>;
export type DraftInput = Readonly<{ to: readonly string[]; cc?: readonly string[]; bcc?: readonly string[]; subject: string; body: string; threadId?: string }>;

export type GoogleClient = Readonly<{
  events(from: string, to: string, limit: number, includeDeclined: boolean): Promise<readonly CalendarItem[]>;
  draft(input: DraftInput): Promise<Readonly<{ draft_id: string; message_id?: string; thread_id?: string }>>;
  event(id: string): Promise<CalendarItem>;
  createEvent(input: Readonly<{ title: string; start: string; end: string }>): Promise<CalendarItem>;
  moveEvent(id: string, start: string, end: string): Promise<CalendarItem>;
  cancelEvent(id: string): Promise<void>;
  changedEvents(since: number, from: number, to: number): Promise<readonly CalendarChange[]>;
  newMail(since: number, limit: number): Promise<readonly MailItem[]>;
}>;

export function googleClient(app: GoogleApp, tokens: GoogleTokens, fetcher: Fetch = fetch): GoogleClient {
  let access: { token: string; until: number } | null = null;
  const bearer = async () => {
    if (access && access.until > Date.now()) return access.token;
    const result = await token(app, { refresh_token: tokens.refresh_token, grant_type: 'refresh_token' }, fetcher);
    access = { token: result.access_token, until: Date.now() + 50 * 60_000 };
    return access.token;
  };
  const call = async (url: string, init: RequestInit = {}) => {
    const response = await fetcher(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${await bearer()}` } });
    const json = response.status === 204 ? {} : await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`google ${response.status}: ${(json.error as { message?: string } | undefined)?.message ?? 'request failed'}`);
    return json;
  };
  const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const send = async (url: string, method: string, body: unknown) =>
    toItem(await call(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) as unknown as GoogleEvent);
  return {
    event: async (id) => toItem(await call(`${EVENTS}/${encodeURIComponent(id)}`) as unknown as GoogleEvent),
    createEvent: ({ title, start, end }) => send(EVENTS, 'POST', { summary: title, start: { dateTime: start }, end: { dateTime: end } }),
    moveEvent: (id, start, end) => send(`${EVENTS}/${encodeURIComponent(id)}`, 'PATCH', { start: { dateTime: start }, end: { dateTime: end } }),
    async cancelEvent(id) {
      await call(`${EVENTS}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async events(from, to, limit, includeDeclined) {
      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
      url.search = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: 'true', orderBy: 'startTime', maxResults: String(limit) }).toString();
      const json = await call(url.toString()) as { items?: GoogleEvent[] };
      return (json.items ?? [])
        .filter((event) => event.status !== 'cancelled')
        .filter((event) => includeDeclined || event.attendees?.find((a) => a.self)?.responseStatus !== 'declined')
        .map(toItem);
    },
    async changedEvents(since, from, to) {
      const url = new URL(EVENTS);
      url.search = new URLSearchParams({ updatedMin: new Date(since).toISOString(), timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: 'true', showDeleted: 'true', maxResults: '50' }).toString();
      const json = await call(url.toString()) as { items?: GoogleEvent[] };
      return (json.items ?? [])
        .filter((event) => event.attendees?.find((a) => a.self)?.responseStatus !== 'declined')
        .map((event) => ({ ...toItem({ ...event, start: event.start ?? {}, end: event.end ?? {} }), status: event.status ?? 'confirmed', created: event.created ?? '' }));
    },
    async newMail(since, limit) {
      const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
      const list = new URL(GMAIL);
      list.search = new URLSearchParams({ q: `in:inbox category:primary after:${Math.floor(since / 1000)}`, maxResults: String(limit) }).toString();
      const { messages = [] } = await call(list.toString()) as { messages?: { id: string }[] };
      return Promise.all(messages.map(async ({ id }) => {
        const message = await call(`${GMAIL}/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`) as { snippet?: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } };
        const header = (name: string) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
        return { id, from: header('From'), subject: header('Subject'), snippet: message.snippet ?? '', at: new Date(Number(message.internalDate ?? 0)).toISOString() };
      }));
    },
    async draft(input) {
      const clean = (value: string) => value.replace(/[\r\n]+/g, ' ');
      const headers = [
        `To: ${clean(input.to.join(', '))}`,
        ...(input.cc?.length ? [`Cc: ${clean(input.cc.join(', '))}`] : []),
        ...(input.bcc?.length ? [`Bcc: ${clean(input.bcc.join(', '))}`] : []),
        `Subject: ${clean(input.subject)}`,
        'Content-Type: text/plain; charset="UTF-8"',
      ];
      const raw = b64url(new TextEncoder().encode(`${headers.join('\r\n')}\r\n\r\n${input.body}`));
      const json = await call('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: { raw, ...(input.threadId ? { threadId: input.threadId } : {}) } }),
      }) as { id: string; message?: { id?: string; threadId?: string } };
      return { draft_id: json.id, ...(json.message?.id ? { message_id: json.message.id } : {}), ...(json.message?.threadId ? { thread_id: json.message.threadId } : {}) };
    },
  };
}

const toItem = (event: GoogleEvent): CalendarItem => ({
  id: event.id, title: event.summary ?? '(no title)',
  start: event.start.dateTime ?? event.start.date ?? '', end: event.end.dateTime ?? event.end.date ?? '',
  all_day: event.start.dateTime === undefined,
  ...(event.location ? { location: event.location } : {}),
  ...(event.description?.trim() ? { description: event.description.trim().slice(0, 2000) } : {}),
  ...(event.attendees?.length ? { attendees: event.attendees.length } : {}),
});

type GoogleEvent = {
  id: string; status?: string; summary?: string; location?: string; description?: string; created?: string;
  start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
};
