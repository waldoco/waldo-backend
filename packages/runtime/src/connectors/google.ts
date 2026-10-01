// Google connector for the owner's own accounts: OAuth offline grants, Calendar reads and Gmail.
// Consent asks once for the combined set (owner ruling 2026-09-24 13:31, reversing W3's per-feature asks):
// calendar + mail + tasks in a single dialog. Scope is not permission: each tool still gates its own effects.
// Unverified app, so only listed test users can connect (post-mvp-cleanup: Google verification).
// gmail.compose stays until Waldo keeps its own drafts (W6 follow-up loop); then it goes (post-mvp-cleanup).
const AUTH = 'https://www.googleapis.com/auth/';
export const GOOGLE_FEATURE_SCOPES = {
  calendar: [`${AUTH}calendar.events`],
  availability: [`${AUTH}calendar.events.freebusy`],
  mail: [`${AUTH}gmail.readonly`, `${AUTH}gmail.send`, `${AUTH}gmail.compose`],
  tasks: [`${AUTH}tasks`],
} as const;
export type GoogleFeature = keyof typeof GOOGLE_FEATURE_SCOPES;
export const isGoogleFeature = (value: string): value is GoogleFeature => Object.hasOwn(GOOGLE_FEATURE_SCOPES, value);
// Legacy null grants retain old features, never a newly introduced availability scope.
export const googleHas = (scopes: readonly string[] | null | undefined, feature: GoogleFeature): boolean =>
  feature === 'availability'
    ? ['calendar.events.freebusy','calendar.freebusy','calendar.readonly','calendar'].some(scope => scopes?.includes(`${AUTH}${scope}`) ?? false)
    : scopes === null || GOOGLE_FEATURE_SCOPES[feature].every((scope) => scopes?.includes(scope) ?? false);

export const GOOGLE_CALLBACK_PATH = '/oauth/google/callback';

export type GoogleApp = Readonly<{ clientId: string; clientSecret: string; redirectUri: string }>;
export type GoogleTokens = Readonly<{ refresh_token: string; email?: string; scopes?: readonly string[] | null }>;
type Fetch = typeof fetch;

export const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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

export const GOOGLE_CONSENT_SCOPES: readonly string[] = ['openid', 'email', ...GOOGLE_FEATURE_SCOPES.calendar, ...GOOGLE_FEATURE_SCOPES.availability, ...GOOGLE_FEATURE_SCOPES.mail, ...GOOGLE_FEATURE_SCOPES.tasks];

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

// Provider-internal etags are unnecessary in model-facing context. Keep them in the
// connector API for concurrency (moveEvent/cancelEvent), not in a card prompt.
export const calendarPromptProjection = (event: CalendarItem): Omit<CalendarItem, 'etag'> => {
  const { etag: _etag, ...projection } = event;
  return projection;
};

// Keep provider-internal IDs out of prompts, but preserve subject and snippet as user data.
// The scribe checks exact session canaries rather than rejecting any 16-hex value;
// a tracking string in mail text must not be silently replaced with [id].
export const mailPromptProjection = (item: MailItem): Omit<MailItem, 'id' | 'thread_id'> => {
  const { id: _id, thread_id: _threadId, ...projection } = item;
  return projection;
};

export class GoogleError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type CalendarChange = CalendarItem & Readonly<{ status: string; created: string }>;
export type MailItem = Readonly<{ id: string; thread_id: string; from: string; subject: string; snippet: string; at: string }>;
// A1: a thread-read message carries the decoded body; the list projection (MailItem) stays
// snippet-only so 'what is new' scans never pull bodies into a turn.
export type ThreadMessage = Readonly<{ id: string; from: string; subject: string; at: string; body: string }>;
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

// Provider calendars are untrusted even when transport returned HTTP 200.
export const validFreeBusyCalendar = (row: unknown): row is FreeBusyResult['calendars'][string] => {
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const instant = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
  if (!object(row) || !Array.isArray(row.busy)) return false;
  if (Object.hasOwn(row, 'errors') && (!Array.isArray(row.errors) || !row.errors.every(e => object(e) && typeof e.reason === 'string' && e.reason.length > 0 && (!Object.hasOwn(e,'domain') || typeof e.domain === 'string')))) return false;
  return row.busy.every(b => object(b) && instant(b.start) && instant(b.end) && Date.parse(b.start) < Date.parse(b.end));
};

export type FreeBusyResult=Readonly<{from:string;to:string;calendars:Readonly<Record<string,Readonly<{busy:readonly Readonly<{start:string;end:string}>[];errors?:readonly Readonly<{reason?:string}>[]}>>>}>;

export type GoogleClient = Readonly<{
  freeBusy(from:string,to:string,calendarIds:readonly string[],timezone:string):Promise<FreeBusyResult>;
  events(from: string, to: string, limit: number, includeDeclined: boolean): Promise<readonly CalendarItem[]>;
  draft(input: DraftInput): Promise<Readonly<{ draft_id: string; message_id?: string; thread_id?: string }>>;
  sendRaw(raw: string, threadId?: string): Promise<Readonly<{ message_id: string; thread_id?: string }>>;
  findSentByMessageId(messageId: string): Promise<boolean>;
  event(id: string): Promise<CalendarItem>;
  createEvent(input: Readonly<{ title: string; start: string; end: string }>): Promise<CalendarItem>;
  moveEvent(id: string, start: string, end: string, etag?: string): Promise<CalendarItem>;
  cancelEvent(id: string, etag?: string): Promise<void>;
  changedEvents(since: number, from: number, to: number): Promise<readonly CalendarChange[]>;
  mailPage(query:string,limit:number,pageToken?:string):Promise<Readonly<{messages:readonly MailItem[];next_page_token:string|null;result_size_estimate:number|null}>>;
  newMail(since: number, limit: number): Promise<readonly MailItem[]>;
  searchMail(query: string, limit: number): Promise<readonly MailItem[]>;
  readThread(threadId: string, limit: number): Promise<readonly ThreadMessage[]>;
  tasks(status: TaskStatusFilter, limit: number): Promise<readonly TaskItem[]>;
}>;

// Single source for the connector-proxy allowlist: the runtime's vault client and the Supabase
// connector-proxy Edge Function both build from this list, so a method added to GoogleClient but
// missed here fails `satisfies` / the parity test instead of breaking live calls on Vault installs.
export const GOOGLE_METHODS = ['mailPage','freeBusy', 'events', 'draft', 'sendRaw', 'findSentByMessageId', 'event', 'createEvent', 'moveEvent', 'cancelEvent', 'changedEvents', 'newMail', 'searchMail', 'readThread', 'tasks'] as const satisfies readonly (keyof GoogleClient)[];
export type GoogleMethod = (typeof GOOGLE_METHODS)[number];

const b64urlDecode = (data: string): string => {
  const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};

// Thread bodies enter model context only through the E1 verification-artifact quarantine
// (tools/live/google.ts); this cap is the second wall - a huge body never floods a turn.
const BODY_CAP = 4000;
type GmailPayload = Readonly<{ mimeType?: string; body?: { data?: string }; parts?: GmailPayload[]; headers?: { name: string; value: string }[] }>;
type GmailFullMessage = Readonly<{ id?: string; snippet?: string; internalDate?: string; payload?: GmailPayload }>;
const threadBody = (payload: GmailPayload | undefined): string => {
  const plain = (part: GmailPayload): string => {
    if (part.mimeType === 'text/plain' && part.body?.data) return b64urlDecode(part.body.data);
    for (const child of part.parts ?? []) { const text = plain(child); if (text) return text; }
    return '';
  };
  return (payload ? plain(payload) : '').trim().slice(0, BODY_CAP);
};

// Single-shot access-token mint for callers that need a raw bearer (Google-auth MCP servers on
// a locally held grant). Same refresh path and health reporting as googleClient, no cache: MCP
// calls are rare enough that one refresh per call beats a second cache to keep consistent.
export async function googleAccessToken(app: GoogleApp, tokens: GoogleTokens, fetcher: Fetch = fetch, health?: (error: string) => void): Promise<string> {
  const result = await token(app, { refresh_token: tokens.refresh_token, grant_type: 'refresh_token' }, fetcher).catch((error: unknown) => {
    health?.(error instanceof Error ? error.message : String(error));
    throw error;
  });
  health?.('');
  return result.access_token;
}

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
  const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
  const listIds = async (q: string, limit: number): Promise<readonly string[]> => {
    const list = new URL(GMAIL);
    list.search = new URLSearchParams({ q, maxResults: String(limit) }).toString();
    const { messages = [] } = await call(list.toString()) as { messages?: { id: string }[] };
    return messages.map((message) => message.id);
  };
  const mailItems = (ids: readonly string[]): Promise<readonly MailItem[]> => Promise.all(ids.map(async (id) => {
    const message = await call(`${GMAIL}/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`) as { threadId?: string; snippet?: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } };
    const header = (name: string) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
    return { id, thread_id: message.threadId ?? '', from: header('From'), subject: header('Subject'), snippet: message.snippet ?? '', at: new Date(Number(message.internalDate ?? 0)).toISOString() };
  }));
  return {
    freeBusy:async(from,to,calendarIds,timezone)=>{
      if(![from,to].every(s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s)))||Date.parse(from)>=Date.parse(to)||!Array.isArray(calendarIds)||!calendarIds.length||calendarIds.length>50||calendarIds.some(id=>typeof id!=='string'||!id.trim()||id.length>256)||new Set(calendarIds).size!==calendarIds.length)throw new Error('invalid freebusy request');
      const data=await call('https://www.googleapis.com/calendar/v3/freeBusy',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({timeMin:from,timeMax:to,timeZone:timezone,calendarExpansionMax:50,items:calendarIds.map(id=>({id}))})});
      const result=data as {timeMin?:string;timeMax?:string;calendars?:FreeBusyResult['calendars']};
      if(!result||typeof result!=='object'||!result.calendars||typeof result.calendars!=='object'||Array.isArray(result.calendars)||!Object.values(result.calendars).every(validFreeBusyCalendar)||Date.parse(result.timeMin??'')!==Date.parse(from)||Date.parse(result.timeMax??'')!==Date.parse(to))throw new Error('freebusy coverage differs');
      return {from:result.timeMin!,to:result.timeMax!,calendars:result.calendars};
    },
    event: async (id) => toItem(await call(`${EVENTS}/${encodeURIComponent(id)}`) as unknown as GoogleEvent),
    createEvent: ({ title, start, end }) => send(EVENTS, 'POST', { summary: title, start: { dateTime: start }, end: { dateTime: end } }),
    moveEvent: (id, start, end, etag) => send(`${EVENTS}/${encodeURIComponent(id)}`, 'PATCH', { start: { dateTime: start }, end: { dateTime: end } }, etag),
    async cancelEvent(id, etag) {
      await call(`${EVENTS}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: match(etag) });
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
    async mailPage(query,limit,pageToken) {
      if(typeof query!=='string'||!query.trim()||!Number.isSafeInteger(limit)||limit<1||limit>500||(pageToken!==undefined&&(typeof pageToken!=='string'||!pageToken)))throw new Error('invalid Gmail page request');
      const url=new URL(GMAIL);url.search=new URLSearchParams({q:query,maxResults:String(limit),...(pageToken?{pageToken}:{})}).toString();
      const data=await call(url.toString()) as {messages?:{id:string}[];nextPageToken?:string;resultSizeEstimate?:number};
      if(!data||typeof data!=='object'||(data.messages!==undefined&&(!Array.isArray(data.messages)||data.messages.some(m=>!m||typeof m.id!=='string'||!m.id)))||(data.nextPageToken!==undefined&&(typeof data.nextPageToken!=='string'||!data.nextPageToken))||(data.resultSizeEstimate!==undefined&&(!Number.isSafeInteger(data.resultSizeEstimate)||data.resultSizeEstimate<0)))throw new Error('invalid Gmail page response');
      return {messages:await mailItems((data.messages??[]).map(m=>m.id)),next_page_token:data.nextPageToken??null,result_size_estimate:data.resultSizeEstimate??null};
    },
    async newMail(since, limit) {
      return mailItems(await listIds(`in:inbox category:primary after:${Math.floor(since / 1000)}`, limit));
    },
    // A1: arbitrary Gmail search - the model builds q clauses (from:, subject:, words) and the
    // handler appends after:/before: from the date range. Same metadata projection as newMail.
    async searchMail(query, limit) {
      return mailItems(await listIds(query, limit));
    },
    // A1: one thread with bodies decoded. text/plain wins; an HTML-only or empty body falls
    // back to the snippet so the model still sees something.
    async readThread(threadId, limit) {
      const json = await call(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`) as { messages?: GmailFullMessage[] };
      return (json.messages ?? []).slice(0, limit).map((message) => {
        const header = (name: string) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
        return {
          id: message.id ?? '', from: header('From'), subject: header('Subject'),
          at: new Date(Number(message.internalDate ?? 0)).toISOString(),
          body: threadBody(message.payload) || (message.snippet ?? ''),
        };
      });
    },
    async tasks(status, limit) {
      const url = new URL('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks');
      // Google Tasks has no in-progress state: todo and in_progress both read the open list;
      // the handler says so on the result when the owner filtered for in_progress.
      const want = status === 'done' ? 'completed' : 'needsAction';
      url.search = new URLSearchParams({
        maxResults: String(limit), showHidden: 'false',
        showCompleted: status === 'done' || status === 'all' ? 'true' : 'false',
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
      const json = await call('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
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
