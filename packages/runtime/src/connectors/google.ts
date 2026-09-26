// Google connector for the owner's own accounts: OAuth offline grants, Calendar reads and Gmail.
// Consent asks once for the combined set (owner ruling 2026-09-24 13:31, reversing W3's per-feature asks):
// calendar + mail + tasks in a single dialog. Scope is not permission: each tool still gates its own effects.
// Unverified app, so only listed test users can connect (post-mvp-cleanup: Google verification).
// gmail.compose stays until Waldo keeps its own drafts (W6 follow-up loop); then it goes (post-mvp-cleanup).
const AUTH = 'https://www.googleapis.com/auth/';
export const GOOGLE_FEATURE_SCOPES = {
  calendar: [`${AUTH}calendar.events`],
  mail: [`${AUTH}gmail.readonly`, `${AUTH}gmail.send`, `${AUTH}gmail.compose`],
  tasks: [`${AUTH}tasks`],
} as const;
export type GoogleFeature = keyof typeof GOOGLE_FEATURE_SCOPES;
export const isGoogleFeature = (value: string): value is GoogleFeature => Object.hasOwn(GOOGLE_FEATURE_SCOPES, value);
// null is a grant from before per-feature scopes, made under the broad consent, so it covers every feature.
export const googleHas = (scopes: readonly string[] | null | undefined, feature: GoogleFeature): boolean =>
  scopes === null || GOOGLE_FEATURE_SCOPES[feature].every((scope) => scopes?.includes(scope) ?? false);

export const GOOGLE_CALLBACK_PATH = '/oauth/google/callback';

export type GoogleApp = Readonly<{ clientId: string; clientSecret: string; redirectUri: string }>;
export type GoogleTokens = Readonly<{ refresh_token: string; email?: string; scopes?: readonly string[] | null }>;
type Fetch = typeof fetch;

// Chunked: String.fromCharCode(...bytes) on a whole MIME throws RangeError well under the 1MB
// proxy arg bound, so the spread never spans more than 32KB of the input.
export const b64url = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`google-oauth-state:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
}

// The state names the owner's Durable Object (to route the callback) and a one-time nonce whose
// record, expiry and PKCE verifier live in that Durable Object. The MAC lets the Worker drop forged
// callbacks before waking anything.
// The surface that started the flow (telegram, whatsapp, dashboard, app) rides in the signed
// state so the completion page can route the owner back where they came from. Unknown or
// tampered surfaces fail verification; the page falls back to the console.
export const CONSENT_SURFACES = ['telegram', 'whatsapp', 'dashboard', 'app'] as const;
export type ConsentSurface = (typeof CONSENT_SURFACES)[number];

export async function consentState(secret: string, owner: string, nonce: string, surface?: ConsentSurface): Promise<string> {
  const body = surface ? `${owner}.${nonce}.${surface}` : `${owner}.${nonce}`;
  return `${body}.${await sign(secret, body)}`;
}

// The owner is the Durable Object name, which may hold dots, so split from the right.
export async function readConsentState(secret: string, state: string): Promise<Readonly<{ owner: string; nonce: string; surface?: ConsentSurface }> | null> {
  const parts = state.split('.');
  const mac = parts[parts.length - 1];
  if (!mac || parts.length < 3) return null;
  // Surface-aware shape first: owner.nonce.surface.mac, owner itself dotted. The MAC binds the
  // exact layout, so a surface moved or edited by hand fails both shapes.
  if (parts.length >= 4) {
    const surface = parts[parts.length - 2] ?? '';
    const nonce = parts[parts.length - 3] ?? '';
    const owner = parts.slice(0, -3).join('.');
    if (owner && nonce && (CONSENT_SURFACES as readonly string[]).includes(surface)) {
      const body = `${owner}.${nonce}.${surface}`;
      if ((await sign(secret, body)) === mac) return { owner, nonce, surface: surface as ConsentSurface };
    }
  }
  const nonce = parts[parts.length - 2] ?? '';
  const owner = parts.slice(0, -2).join('.');
  if (!owner || !nonce) return null;
  return (await sign(secret, `${owner}.${nonce}`)) === mac ? { owner, nonce } : null;
}

export const GOOGLE_CONSENT_SCOPES: readonly string[] = ['openid', 'email', ...GOOGLE_FEATURE_SCOPES.calendar, ...GOOGLE_FEATURE_SCOPES.mail, ...GOOGLE_FEATURE_SCOPES.tasks];

export function googleConsentUrl(app: GoogleApp, state: string, codeChallenge: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: app.clientId, redirect_uri: app.redirectUri, response_type: 'code', scope: GOOGLE_CONSENT_SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state,
    code_challenge: codeChallenge, code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

async function token(app: GoogleApp, body: Record<string, string>, fetcher: Fetch): Promise<{ access_token: string; refresh_token?: string; id_token?: string; scope?: string }> {
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...body }).toString(),
  });
  const json = await response.json() as { access_token?: string; refresh_token?: string; id_token?: string; error?: string };
  if (!response.ok || !json.access_token) throw new Error(`google token failed: ${json.error ?? response.status}`);
  return json as { access_token: string; refresh_token?: string; id_token?: string; scope?: string };
}

export async function exchangeGoogleCode(app: GoogleApp, code: string, fetcher: Fetch = fetch, codeVerifier?: string): Promise<GoogleTokens> {
  const result = await token(app, { code, grant_type: 'authorization_code', redirect_uri: app.redirectUri, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }, fetcher);
  if (!result.refresh_token) throw new Error('google returned no refresh token');
  const claims = result.id_token ? JSON.parse(atob(result.id_token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { email?: string } : {};
  return { refresh_token: result.refresh_token, scopes: (result.scope ?? '').split(' ').filter(Boolean), ...(claims.email ? { email: claims.email } : {}) };
}

export type CalendarItem = Readonly<{ id: string; title: string; start: string; end: string; all_day: boolean; location?: string; description?: string; attendees?: number; etag?: string }>;

export class GoogleError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type CalendarChange = CalendarItem & Readonly<{ status: string; created: string }>;
export type MailItem = Readonly<{ id: string; from: string; subject: string; snippet: string; at: string }>;
export type DraftInput = Readonly<{ to: readonly string[]; cc?: readonly string[]; bcc?: readonly string[]; subject: string; body: string; threadId?: string }>;

// Canonical MIME for the send rail: fixed header order, CRLF, no display names. The digest the
// owner approves binds these exact bytes; Message-ID (set by us) is the reconciliation handle
// when the send result is ambiguous (timeout after Gmail accepted).
export const buildMime = (input: DraftInput & { messageId?: string }): string => {
  const clean = (value: string) => value.replace(/[\r\n]+/g, ' ');
  const headers = [
    `To: ${clean(input.to.join(', '))}`,
    ...(input.cc?.length ? [`Cc: ${clean(input.cc.join(', '))}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${clean(input.bcc.join(', '))}`] : []),
    `Subject: ${clean(input.subject)}`,
    ...(input.messageId ? [`Message-ID: ${input.messageId}`, 'MIME-Version: 1.0'] : []),
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${input.body}`;
};

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export type TaskStatusFilter = 'todo' | 'in_progress' | 'done' | 'all';
export type TaskItem = Readonly<{ id: string; title: string; status: 'todo' | 'done'; due?: string; updated?: string }>;
type GoogleTask = Readonly<{ id: string; title?: string; status: string; due?: string; updated?: string }>;

export type GoogleClient = Readonly<{
  events(from: string, to: string, limit: number, includeDeclined: boolean): Promise<readonly CalendarItem[]>;
  draft(input: DraftInput): Promise<Readonly<{ draft_id: string; message_id?: string; thread_id?: string }>>;
  sendRaw(raw: string, threadId?: string): Promise<Readonly<{ message_id: string; thread_id?: string }>>;
  findSentByMessageId(messageId: string): Promise<boolean>;
  event(id: string): Promise<CalendarItem>;
  createEvent(input: Readonly<{ title: string; start: string; end: string }>): Promise<CalendarItem>;
  moveEvent(id: string, start: string, end: string, etag?: string): Promise<CalendarItem>;
  cancelEvent(id: string, etag?: string): Promise<void>;
  changedEvents(since: number, from: number, to: number): Promise<readonly CalendarChange[]>;
  newMail(since: number, limit: number): Promise<readonly MailItem[]>;
  tasks(status: TaskStatusFilter, limit: number): Promise<readonly TaskItem[]>;
}>;

// health hears '' after a good refresh and the error after a failed one, so the console can offer a reconnect.
export function googleClient(app: GoogleApp, tokens: GoogleTokens, fetcher: Fetch = fetch, health?: (error: string) => void): GoogleClient {
  let access: { token: string; until: number } | null = null;
  const bearer = async () => {
    if (access && access.until > Date.now()) return access.token;
    const result = await token(app, { refresh_token: tokens.refresh_token, grant_type: 'refresh_token' }, fetcher).catch((error: unknown) => {
      health?.(error instanceof Error ? error.message : String(error));
      throw error;
    });
    health?.('');
    access = { token: result.access_token, until: Date.now() + 50 * 60_000 };
    return access.token;
  };
  const call = async (url: string, init: RequestInit = {}) => {
    const response = await fetcher(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${await bearer()}` } });
    const json = response.status === 204 ? {} : await response.json() as Record<string, unknown>;
    if (!response.ok) throw new GoogleError(response.status, `google ${response.status}: ${(json.error as { message?: string } | undefined)?.message ?? 'request failed'}`);
    return json;
  };
  const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const match = (etag?: string): Record<string, string> => (etag ? { 'if-match': etag } : {});
  const send = async (url: string, method: string, body: unknown, etag?: string) =>
    toItem(await call(url, { method, headers: { 'content-type': 'application/json', ...match(etag) }, body: JSON.stringify(body) }) as unknown as GoogleEvent);
  return {
    event: async (id) => toItem(await call(`${EVENTS}/${encodeURIComponent(id)}`) as unknown as GoogleEvent),
    createEvent: ({ title, start, end }) => send(EVENTS, 'POST', { summary: title, start: { dateTime: start }, end: { dateTime: end } }),
    moveEvent: (id, start, end, etag) => send(`${EVENTS}/${encodeURIComponent(id)}`, 'PATCH', { start: { dateTime: start }, end: { dateTime: end } }, etag),
    async cancelEvent(id, etag) {
      await call(`${EVENTS}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: match(etag) });
    },
    async events(from, to, limit, includeDeclined) {
      // Google may return a SHORT page (fewer than maxResults) with a nextPageToken; a single
      // fetch silently under-reports the range. Follow pages until the requested limit is
      // covered or the range is exhausted (bounded at 5 pages).
      const collected: GoogleEvent[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 5 && collected.length < limit; page += 1) {
        const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
        url.search = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: 'true', orderBy: 'startTime', maxResults: String(limit), ...(pageToken ? { pageToken } : {}) }).toString();
        const json = await call(url.toString()) as { items?: GoogleEvent[]; nextPageToken?: string };
        collected.push(...(json.items ?? []));
        pageToken = json.nextPageToken;
        if (!pageToken) break;
      }
      return collected.slice(0, limit)
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
    async tasks(status, limit) {
      const url = new URL('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks');
      // Google Tasks has no in-progress state: todo and in_progress both read the open list;
      // the handler says so on the result when the owner filtered for in_progress.
      const want = status === 'done' ? 'completed' : 'needsAction';
      // First-party completed tasks only appear when BOTH showCompleted and showHidden are
      // true (Google tasks.list hides completed-and-hidden items otherwise); open-only reads
      // keep both false so deleted/hidden noise stays out.
      const includeCompleted = status === 'done' || status === 'all';
      url.search = new URLSearchParams({
        maxResults: String(limit),
        showHidden: includeCompleted ? 'true' : 'false',
        showCompleted: includeCompleted ? 'true' : 'false',
      }).toString();
      const json = await call(url.toString()) as { items?: GoogleTask[] };
      return (json.items ?? [])
        .filter((task) => status === 'all' || task.status === want)
        .map((task) => ({
          id: task.id, title: task.title ?? '(no title)', status: task.status === 'completed' ? 'done' as const : 'todo' as const,
          ...(task.due ? { due: task.due } : {}), ...(task.updated ? { updated: task.updated } : {}),
        }));
    },
    async draft(input) {
      const raw = b64url(new TextEncoder().encode(buildMime(input)));
      const json = await call('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: { raw, ...(input.threadId ? { threadId: input.threadId } : {}) } }),
      }) as { id: string; message?: { id?: string; threadId?: string } };
      return { draft_id: json.id, ...(json.message?.id ? { message_id: json.message.id } : {}), ...(json.message?.threadId ? { thread_id: json.message.threadId } : {}) };
    },
    async sendRaw(raw, threadId) {
      // Gmail messages.send takes base64url MIME in Message.raw (same as drafts.create above).
      // Callers pass the plain RFC2822 bytes; the encoding happens exactly once, here at the
      // client boundary, so the approval rail never double-encodes or sends plain text.
      const json = await call('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw: b64url(new TextEncoder().encode(raw)), ...(threadId ? { threadId } : {}) }),
      }) as { id: string; threadId?: string };
      return { message_id: json.id, ...(json.threadId ? { thread_id: json.threadId } : {}) };
    },
    async findSentByMessageId(messageId) {
      const list = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      const bare = messageId.replace(/^<|>$/g, '');
      list.search = new URLSearchParams({ q: `in:sent rfc822msgid:${bare}`, maxResults: '1' }).toString();
      const { messages = [] } = await call(list.toString()) as { messages?: { id: string }[] };
      return messages.length > 0;
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
  ...(event.etag ? { etag: event.etag } : {}),
});

type GoogleEvent = {
  id: string; etag?: string; status?: string; summary?: string; location?: string; description?: string; created?: string;
  start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
};
