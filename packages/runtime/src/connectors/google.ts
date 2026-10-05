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
  // Read-only Workspace scopes for Google's MCP servers (draft: takes effect only when the owner deploys it
  // and reconnects). Write scopes stay out until a separate approval-gated slice.
  drive: [`${AUTH}drive.readonly`],
  docs: [`${AUTH}drive.readonly`, `${AUTH}documents.readonly`],
  sheets: [`${AUTH}drive.readonly`, `${AUTH}spreadsheets.readonly`],
  slides: [`${AUTH}drive.readonly`, `${AUTH}presentations.readonly`],
} as const;
export type GoogleFeature = keyof typeof GOOGLE_FEATURE_SCOPES;
// Never granted implicitly: legacy null-scope grants do not hold these.
const WORKSPACE_READ_FEATURES: readonly GoogleFeature[] = ['drive', 'docs', 'sheets', 'slides'];
// Features whose only scopes are read-only (GOOGLE_FEATURE_SCOPES lists no write scope for them).
export const isReadOnlyGoogleFeature = (feature: GoogleFeature): boolean => WORKSPACE_READ_FEATURES.includes(feature);
export const isGoogleFeature = (value: string): value is GoogleFeature => Object.hasOwn(GOOGLE_FEATURE_SCOPES, value);
// Legacy null grants retain old features, never a newly introduced availability scope.
export const googleHas = (scopes: readonly string[] | null | undefined, feature: GoogleFeature): boolean =>
  feature === 'availability'
    ? ['calendar.events.freebusy','calendar.freebusy','calendar.readonly','calendar'].some(scope => scopes?.includes(`${AUTH}${scope}`) ?? false)
    : WORKSPACE_READ_FEATURES.includes(feature)
      ? GOOGLE_FEATURE_SCOPES[feature].every((scope) => scopes?.includes(scope) ?? false)
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

export const GOOGLE_CONSENT_SCOPES: readonly string[] = ['openid', 'email', ...GOOGLE_FEATURE_SCOPES.calendar, ...GOOGLE_FEATURE_SCOPES.availability, ...GOOGLE_FEATURE_SCOPES.mail, ...GOOGLE_FEATURE_SCOPES.tasks, ...new Set([...GOOGLE_FEATURE_SCOPES.drive, ...GOOGLE_FEATURE_SCOPES.docs, ...GOOGLE_FEATURE_SCOPES.sheets, ...GOOGLE_FEATURE_SCOPES.slides])];

export function googleConsentUrl(app: GoogleApp, state: string, codeChallenge: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: app.clientId, redirect_uri: app.redirectUri, response_type: 'code', scope: GOOGLE_CONSENT_SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state,
    code_challenge: codeChallenge, code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

const tokenFailure = (status: number, code?: unknown): GoogleTokenError => {
  if (status === 429 || status >= 500 || code === 'temporarily_unavailable' || code === 'server_error') return new GoogleTokenError('transient', status);
  if (code === 'invalid_grant') return new GoogleTokenError('auth', status);
  if (code === 'invalid_client' || code === 'unauthorized_client') return new GoogleTokenError('configuration', status);
  return new GoogleTokenError('protocol', status);
};

async function token(app: GoogleApp, body: Record<string, string>, fetcher: Fetch): Promise<{ access_token: string; refresh_token?: string; id_token?: string; scope?: string }> {
  let response: Response;
  try {
    response = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...body }).toString(),
    });
  } catch {
    throw new GoogleTokenError('transient');
  }
  let json: { access_token?: string; refresh_token?: string; id_token?: string; scope?: string; error?: unknown } | null;
  try { json = await response.json() as typeof json; }
  catch (error) {
    if (error instanceof SyntaxError || !response.ok) throw tokenFailure(response.status);
    throw new GoogleTokenError('transient');
  }
  if (!response.ok || !json || typeof json.access_token !== 'string' || !json.access_token) throw tokenFailure(response.status, json?.error);
  return json as { access_token: string; refresh_token?: string; id_token?: string; scope?: string };
}

export async function exchangeGoogleCode(app: GoogleApp, code: string, fetcher: Fetch = fetch, codeVerifier?: string): Promise<GoogleTokens> {
  const result = await token(app, { code, grant_type: 'authorization_code', redirect_uri: app.redirectUri, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }, fetcher);
  if (!result.refresh_token) throw new Error('google returned no refresh token');
  const claims = result.id_token ? JSON.parse(atob(result.id_token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { email?: string } : {};
  return { refresh_token: result.refresh_token, scopes: (result.scope ?? '').split(' ').filter(Boolean), ...(claims.email ? { email: claims.email } : {}) };
}

export type CalendarItem = Readonly<{ id: string; title: string; start: string; end: string; all_day: boolean; location?: string; description?: string; attendees?: number; etag?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled'; updated?: string; recurring_event_id?: string; original_start?: string; source_url?: string; attendee_names?: readonly string[] }>;

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

// Structured provider evidence only (never message text): google.rpc.ErrorInfo.reason, or the legacy
// errors[].reason, exactly the pair drive-rest.ts already trusts. Anything else stays undefined.
export type GoogleErrorReason = 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' | 'SERVICE_DISABLED';
export class GoogleError extends Error {
  constructor(readonly status: number, message: string, readonly reason?: GoogleErrorReason) { super(message); }
}
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export type GoogleTokenFailure = 'auth' | 'transient' | 'configuration' | 'protocol';
export class GoogleTokenError extends GoogleError {
  constructor(readonly kind: GoogleTokenFailure, readonly providerStatus?: number) {
    super(kind === 'auth' ? 401 : kind === 'transient' && providerStatus && (providerStatus === 429 || providerStatus >= 500) ? providerStatus : 502, `google token ${kind} failure`);
    this.name = 'GoogleTokenError';
  }
}

export const googleErrorReason = (body: unknown): GoogleErrorReason | undefined => {
  const error = isObject(body) && isObject(body.error) ? body.error : undefined;
  const info = Array.isArray(error?.details) ? error.details.find((d) => isObject(d) && d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' && d.domain === 'googleapis.com') : undefined;
  const legacy = Array.isArray(error?.errors) ? error.errors.filter(isObject).map((item) => item.reason) : [];
  if ((isObject(info) && info.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') || legacy.includes('insufficientPermissions')) return 'ACCESS_TOKEN_SCOPE_INSUFFICIENT';
  if ((isObject(info) && info.reason === 'SERVICE_DISABLED') || legacy.includes('accessNotConfigured')) return 'SERVICE_DISABLED';
  return undefined;
};
export type CalendarChange = Omit<CalendarItem, 'status'> & Readonly<{ status: string; created: string }>;
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

export type CalendarPage = Readonly<{ events: readonly CalendarItem[]; next_page_token: string | null; fetched_count: number; account: Readonly<{connection_id: string | null; email: string | null}>; observed_at: string }>;

// Drive metadata only (REST, drive.readonly or narrower). Exactly these fields cross the boundary: no body, description,
// snippet, owner or permission data. The runtime re-projects any reply to this shape.
export type DriveFileMeta = Readonly<{ id: string; name: string; mimeType: string; modifiedTime: string | null; webViewLink: string | null; size: string | null }>;
export type DriveFilePage = Readonly<{ files: readonly DriveFileMeta[]; nextPageToken: string | null; incompleteSearch: boolean }>;

export type GoogleClient = Readonly<{
  account?: CalendarPage['account'];
  driveListFiles?(input: Readonly<{ pageSize?: number; pageToken?: string }>): Promise<DriveFilePage>;
  driveSearchFiles?(input: Readonly<{ nameContains: string; pageSize?: number; pageToken?: string }>): Promise<DriveFilePage>;
  driveGetFileMetadata?(input: Readonly<{ fileId: string }>): Promise<DriveFileMeta>;
  driveReadFileContent?(input: import('./drive-rest').DriveContentArgs): Promise<import('./drive-rest').DriveFileContent>;
  calendarPage?(calendarId: string, from: string, to: string, limit: number, includeDeclined: boolean, pageToken?: string): Promise<CalendarPage>;
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
export const GOOGLE_METHODS = ['calendarPage','mailPage','freeBusy', 'events', 'draft', 'sendRaw', 'findSentByMessageId', 'event', 'createEvent', 'moveEvent', 'cancelEvent', 'changedEvents', 'newMail', 'searchMail', 'readThread', 'tasks', 'driveListFiles', 'driveSearchFiles', 'driveGetFileMetadata','driveReadFileContent'] as const satisfies readonly (keyof GoogleClient)[];
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
    if (error instanceof GoogleTokenError && error.kind === 'auth') health?.(error.message);
    throw error;
  });
  health?.('');
  return result.access_token;
}

// Only an invalid grant marks connection health; provider outages and client configuration do not require owner reconnect.
export function googleClient(app: GoogleApp, tokens: GoogleTokens, fetcher: Fetch = fetch, health?: (error: string) => void, account: CalendarPage['account'] = {connection_id: null, email: tokens.email ?? null}): GoogleClient & Required<Pick<GoogleClient, 'calendarPage'>> {
  let access: { token: string; until: number } | null = null;
  const bearer = async () => {
    if (access && access.until > Date.now()) return access.token;
    const result = await token(app, { refresh_token: tokens.refresh_token, grant_type: 'refresh_token' }, fetcher).catch((error: unknown) => {
      if (error instanceof GoogleTokenError && error.kind === 'auth') health?.(error.message);
      throw error;
    });
    health?.('');
    access = { token: result.access_token, until: Date.now() + 50 * 60_000 };
    return access.token;
  };
  const call = async (url: string, init: RequestInit = {}) => {
    const response = await fetcher(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${await bearer()}` } });
    const json = response.status === 204 ? {} : await response.json() as Record<string, unknown>;
    if (!response.ok) throw new GoogleError(response.status, `google ${response.status}: ${(json.error as { message?: string } | undefined)?.message ?? 'request failed'}`, googleErrorReason(json));
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
    account,
    freeBusy:async(from,to,calendarIds,timezone)=>{
      if(![from,to].every(s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s)))||Date.parse(from)>=Date.parse(to)||!Array.isArray(calendarIds)||!calendarIds.length||calendarIds.length>50||calendarIds.some(id=>typeof id!=='string'||!id.trim()||id.length>256)||new Set(calendarIds).size!==calendarIds.length)throw new Error('invalid freebusy request');
      const data=await call('https://www.googleapis.com/calendar/v3/freeBusy',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({timeMin:from,timeMax:to,timeZone:timezone,calendarExpansionMax:50,items:calendarIds.map(id=>({id}))})});
      const result=data as {timeMin?:string;timeMax?:string;calendars?:FreeBusyResult['calendars']};
      if(!result||typeof result!=='object'||!result.calendars||typeof result.calendars!=='object'||Array.isArray(result.calendars)||!Object.values(result.calendars).every(validFreeBusyCalendar)||Date.parse(result.timeMin??'')!==Date.parse(from)||Date.parse(result.timeMax??'')!==Date.parse(to))throw new Error('freebusy coverage differs');
      return {from:result.timeMin!,to:result.timeMax!,calendars:result.calendars};
    },
    event: async (id) => {
      const value = await call(`${EVENTS}/${encodeURIComponent(id)}`);
      if (!validCalendarEvent(value) || value.id !== id) throw new Error('invalid Calendar event response');
      return toItem(value);
    },
    createEvent: ({ title, start, end }) => send(EVENTS, 'POST', { summary: title, start: { dateTime: start }, end: { dateTime: end } }),
    moveEvent: (id, start, end, etag) => send(`${EVENTS}/${encodeURIComponent(id)}`, 'PATCH', { start: { dateTime: start }, end: { dateTime: end } }, etag),
    async cancelEvent(id, etag) {
      await call(`${EVENTS}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: match(etag) });
    },
    async calendarPage(calendarId, from, to, limit, includeDeclined, pageToken) {
      if (typeof calendarId !== 'string' || !calendarId.trim() || calendarId.length > 254 || ![from,to].every(v => validCalendarInstant(v)) || Date.parse(from) >= Date.parse(to) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || typeof includeDeclined !== 'boolean' || (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken || pageToken.length > 4096))) throw new Error('invalid Calendar page request');
      const binding = JSON.stringify([account.connection_id, calendarId, from, to, limit, includeDeclined]);
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(tokens.refresh_token), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
      const signature = async (payload: string) => [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${binding}.${payload}`)))].map(b => b.toString(16).padStart(2,'0')).join('');
      let providerToken: string | undefined;
      if (pageToken !== undefined) {
        try {
          const parts = pageToken.split('.');
          if (parts.length !== 2) throw new Error();
          const expected = await signature(parts[0]!);
          let mismatch = expected.length ^ parts[1]!.length;
          for (let i=0;i<expected.length;i++) mismatch |= expected.charCodeAt(i) ^ (parts[1]!.charCodeAt(i)||0);
          if (mismatch) throw new Error();
          const cursor = JSON.parse(b64urlDecode(parts[0]!)) as {v?:unknown;token?:unknown};
          if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || Object.keys(cursor).length !== 2 || cursor.v !== 1 || typeof cursor.token !== 'string' || !cursor.token || cursor.token.length > 2048) throw new Error();
          providerToken = cursor.token;
        } catch { throw new Error('invalid Calendar cursor or query binding'); }
      }
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
      url.search = new URLSearchParams({timeMin:from,timeMax:to,singleEvents:'true',orderBy:'startTime',maxResults:String(limit),...(providerToken?{pageToken:providerToken}:{})}).toString();
      const data = await call(url.toString(), {signal:AbortSignal.timeout(30_000)});
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.kind !== 'calendar#events' || Object.hasOwn(data, 'error') || (data.items !== undefined && !Array.isArray(data.items)) || (data.nextPageToken !== undefined && (typeof data.nextPageToken !== 'string' || !data.nextPageToken || data.nextPageToken.length > 2048))) throw new Error('invalid Calendar page response');
      const items = (data.items ?? []) as GoogleEvent[];
      if (items.length > limit || !items.every(validCalendarEvent)) throw new Error('invalid Calendar page response');
      let continuation: string | null = null;
      if (data.nextPageToken) {
        const payload = b64url(new TextEncoder().encode(JSON.stringify({v:1,token:data.nextPageToken})));
        continuation = `${payload}.${await signature(payload)}`;
      }
      return {events: items.filter(e => e.status !== 'cancelled').filter(e => includeDeclined || e.attendees?.find(a => a.self)?.responseStatus !== 'declined').map(toItem).map(e=>({...e,title:e.title.slice(0,2000),...(e.location?{location:e.location.slice(0,2000)}:{})})), next_page_token: continuation, fetched_count: items.length, account, observed_at: new Date().toISOString()};
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
      if(!data||typeof data!=='object'||Array.isArray(data)||(data.messages!==undefined&&(!Array.isArray(data.messages)||data.messages.some(m=>!m||typeof m.id!=='string'||!m.id)))||(data.nextPageToken!==undefined&&(typeof data.nextPageToken!=='string'||!data.nextPageToken))||(data.resultSizeEstimate!==undefined&&(!Number.isSafeInteger(data.resultSizeEstimate)||data.resultSizeEstimate<0)))throw new Error('invalid Gmail page response');
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

// Kept self-contained: this connector also runs in the Deno edge function, without
// a workspace package import map. Calendar query bounds must be offset-bearing instants.
const validCalendarInstant = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const day = value.slice(0,10);
  return Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0,10) === day;
};

const validCalendarEvent = (value: unknown): value is GoogleEvent => {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!object(value) || typeof value.id !== 'string' || !value.id || value.id.length > 1024) return false;
  if (value.status === 'cancelled') return true;
  const endpoint = (v: unknown) => {
    if (!object(v) || (v.date !== undefined && v.dateTime !== undefined)) return null;
    if (typeof v.dateTime === 'string' && validCalendarInstant(v.dateTime)) return {allDay:false,at:Date.parse(v.dateTime)};
    if (typeof v.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(v.date) && Number.isFinite(Date.parse(v.date)) && new Date(v.date).toISOString().slice(0,10) === v.date) return {allDay:true,at:Date.parse(v.date)};
    return null;
  };
  const start=endpoint(value.start),end=endpoint(value.end);
  return !!start && !!end && start.allDay===end.allDay && start.at<end.at && ['summary','location','description','etag'].every(k => value[k] === undefined || typeof value[k] === 'string') && (value.attendees === undefined || (Array.isArray(value.attendees) && value.attendees.every(a => object(a) && (a.self === undefined || typeof a.self === 'boolean') && (a.responseStatus === undefined || typeof a.responseStatus === 'string'))));
};

const calendarSourceUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['calendar.google.com', 'www.google.com'].includes(url.hostname) && url.pathname.startsWith('/calendar/')
      && value.length <= 2048 && url.href.length <= 2048 ? url.href : undefined;
  } catch { return undefined; }
};
const toItem = (event: GoogleEvent): CalendarItem => ({
  id: event.id, title: event.summary ?? '(no title)',
  start: event.start?.dateTime ?? event.start?.date ?? '', end: event.end?.dateTime ?? event.end?.date ?? '',
  all_day: event.start?.dateTime === undefined,
  ...(event.location ? { location: event.location } : {}),
  ...(event.description?.trim() ? { description: event.description.trim().slice(0, 2000) } : {}),
  ...(event.attendees?.length ? { attendees: event.attendees.length } : {}),
  ...(event.etag ? { etag: event.etag } : {}),
  ...(['confirmed', 'tentative', 'cancelled'].includes(event.status ?? '') ? { status: event.status as CalendarItem['status'] } : {}),
  ...(typeof event.updated === 'string' && validCalendarInstant(event.updated) ? { updated: event.updated } : {}),
  ...(typeof event.recurringEventId === 'string' ? { recurring_event_id: event.recurringEventId.slice(0, 1024) } : {}),
  ...(typeof event.originalStartTime?.dateTime === 'string' && validCalendarInstant(event.originalStartTime.dateTime) ? { original_start: event.originalStartTime.dateTime } : {}),
  ...(calendarSourceUrl(event.htmlLink) ? { source_url: calendarSourceUrl(event.htmlLink) } : {}),
  ...(event.attendees?.some(a => typeof a.displayName === 'string' && a.displayName.trim() && a.responseStatus !== 'declined') ? { attendee_names: event.attendees.filter(a => a.responseStatus !== 'declined' && typeof a.displayName === 'string' && a.displayName.trim()).slice(0, 20).map(a => a.displayName!.trim().slice(0, 200)) } : {}),
});

type GoogleEvent = {
  id: string; etag?: string; status?: string; summary?: string; location?: string; description?: string; created?: string; updated?: string; recurringEventId?: string; originalStartTime?: { dateTime?: string; date?: string }; htmlLink?: string;
  start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string; displayName?: string }[];
};
