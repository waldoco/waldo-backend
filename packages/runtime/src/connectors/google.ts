import { Parser } from 'htmlparser2';
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

export type CalendarItem = Readonly<{ id: string; title: string; start: string; end: string; all_day: boolean; location?: string; description?: string; attendees?: number; etag?: string; operation_marker?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled'; updated?: string; recurring_event_id?: string; original_start?: string; source_url?: string; attendee_names?: readonly string[] }>;

// Provider-internal etags are unnecessary in model-facing context. Keep them in the
// connector API for concurrency (moveEvent/cancelEvent), not in a card prompt.
export const calendarPromptProjection = (event: CalendarItem): Omit<CalendarItem, 'etag' | 'operation_marker'> => {
  const { etag: _etag, operation_marker: _marker, ...projection } = event;
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
    super(kind === 'auth' ? 401 : kind === 'transient' && providerStatus && (providerStatus === 429 || providerStatus >= 500) ? providerStatus : 502, kind === 'auth' ? 'google token failed: invalid_grant' : `google token ${kind} failure`);
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
export type ThreadMessage = Readonly<{ id: string; from: string; subject: string; at: string; body: string; message_id?: string; references?: readonly string[] }>;
export type DraftInput = Readonly<{ to: readonly string[]; cc?: readonly string[]; bcc?: readonly string[]; subject: string; body: string; threadId?: string; messageId?: string; inReplyTo?: string; references?: readonly string[] }>;
export type DraftEvidence = Readonly<{ draft_id: string; message_id: string; thread_id: string; raw: string }>;

// Conservative wire Message-ID validation: never interpolate model/provider header text.
export const validMessageId = (value: unknown): value is string => typeof value === 'string' && value.length <= 900 && /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/.test(value);
export type SentEvidence = Readonly<{ message_id: string; thread_id: string; rfc822_message_id: string; label_ids: readonly string[] }>;
export const verifiedSent = (value: unknown, messageId: string, threadId?: string): value is SentEvidence =>
  isObject(value) && typeof value.message_id === 'string' && !!value.message_id && typeof value.thread_id === 'string' && !!value.thread_id
  && value.rfc822_message_id === messageId && Array.isArray(value.label_ids) && value.label_ids.includes('SENT') && (!threadId || value.thread_id === threadId);

// Canonical MIME for the send rail: fixed header order, CRLF, no display names. The digest the
// owner approves binds these exact bytes; Message-ID (set by us) is the reconciliation handle
// when the send result is ambiguous (timeout after Gmail accepted).
export const buildMime = (input: DraftInput & { messageId?: string }): string => {
  if ((input.messageId && !validMessageId(input.messageId)) || (input.inReplyTo && !validMessageId(input.inReplyTo)) || input.references?.some(id => !validMessageId(id))) throw new Error('invalid MIME threading headers');
  const clean = (value: string) => value.replace(/[\r\n]+/g, ' ');
  const headers = [
    `To: ${clean(input.to.join(', '))}`,
    ...(input.cc?.length ? [`Cc: ${clean(input.cc.join(', '))}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${clean(input.bcc.join(', '))}`] : []),
    `Subject: ${clean(input.subject)}`,
    ...(input.messageId ? [`Message-ID: ${input.messageId}`, 'MIME-Version: 1.0'] : []),
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references?.length ? [input.references.reduce((line, id) => {
      const last = line.split('\r\n').at(-1)!;
      return `${line}${last.length + id.length + 1 > 78 ? '\r\n\t' : ' '}${id}`;
    }, 'References:')] : []),
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${input.body}`;
};

// Compare the reopened resource against the exact frozen draft. A Message-ID search hit
// alone is not proof of its recipients/content, particularly after the owner edits Gmail.
export const verifiedDraft = (evidence: unknown, input: DraftInput): evidence is DraftEvidence => {
  if (!isObject(evidence) || !validGoogleId(evidence.draft_id) || !validGoogleId(evidence.message_id) || !validGoogleId(evidence.thread_id) || typeof evidence.raw !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(evidence.raw) || evidence.raw.length > 400_000 || input.threadId && evidence.thread_id !== input.threadId) return false;
  const parse = (text: string) => {
    const canonical = text.replace(/\r?\n/g, '\r\n');
    const split = canonical.indexOf('\r\n\r\n');
    if (split < 0) throw new Error('invalid MIME');
    const values = new Map<string, string>();
    for (const line of canonical.slice(0, split).replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon < 1) throw new Error('invalid MIME header');
      const name = line.slice(0, colon).toLowerCase();
      if (values.has(name)) throw new Error('duplicate MIME header');
      values.set(name, line.slice(colon + 1).trim());
    }
    return { values, body: canonical.slice(split + 4) };
  };
  try {
    const expected = parse(buildMime(input));
    const observed = parse(b64urlDecode(evidence.raw));
    return expected.body === observed.body && ['to', 'cc', 'bcc', 'subject', 'message-id', 'in-reply-to', 'references', 'content-type', 'content-transfer-encoding'].every(name => expected.values.get(name) === observed.values.get(name));
  } catch { return false; }
};

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export type TaskStatusFilter = 'todo' | 'in_progress' | 'done' | 'all';
export type TaskItem = Readonly<{ id: string; title: string; status: 'todo' | 'done'; due?: string; updated?: string; notes?: string; parent?: string; position?: string; completed?: string; web_view_link?: string; task_list_id?: string }>;
type GoogleTask = Readonly<{ id: string; title?: string; status: string; due?: string; updated?: string; notes?: string; parent?: string; position?: string; completed?: string; webViewLink?: string }>;
export type TaskListItem = Readonly<{ id: string; title: string; updated?: string; etag?: string }>;
export type CalendarListItem = Readonly<{ id: string; title: string; timezone?: string; access_role: string; primary: boolean; selected: boolean; hidden: boolean; etag?: string }>;
export type GoogleCollectionPage<T> = Readonly<{ items: readonly T[]; next_page_token: string | null; fetched_count: number; account: CalendarPage['account']; observed_at: string }>;
export type TasksPage = Readonly<{ tasks: readonly TaskItem[]; next_page_token: string | null; fetched_count: number; task_list_ids: readonly string[]; account: CalendarPage['account']; observed_at: string }>;

const validPageLimit = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 && value <= max;
const validGoogleId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\r\n\0]/.test(value);
const validProviderToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048;
const optionalText = (value: unknown, max: number) => value === undefined || (typeof value === 'string' && value.length <= max);
const optionalInstant = (value: unknown) => value === undefined || validCalendarInstant(value);
const validTaskStatus = (value: string): value is TaskStatusFilter => ['todo', 'in_progress', 'done', 'all'].includes(value);
const collectionItems = (data: Record<string, unknown>, kind: string, limit: number, label: string): Record<string, unknown>[] => {
  if (!isObject(data) || data.kind !== kind || Object.hasOwn(data, 'error') || (data.items !== undefined && (!Array.isArray(data.items) || data.items.length > limit || !data.items.every(isObject))) || (data.nextPageToken !== undefined && !validProviderToken(data.nextPageToken))) throw new Error(`invalid ${label} page response`);
  return (data.items ?? []) as Record<string, unknown>[];
};
const validGoogleTask = (value: unknown): value is GoogleTask => isObject(value) && validGoogleId(value.id) && ['needsAction', 'completed'].includes(String(value.status)) && optionalText(value.title, 2000) && optionalText(value.notes, 100_000) && optionalText(value.parent, 1024) && optionalText(value.position, 1024) && optionalText(value.webViewLink, 2048) && optionalInstant(value.due) && optionalInstant(value.updated) && optionalInstant(value.completed);
const taskItem = (task: GoogleTask, taskListId: string): TaskItem => ({
  id: task.id, title: task.title ?? '(no title)', status: task.status === 'completed' ? 'done' : 'todo', task_list_id: taskListId,
  ...(task.due ? { due: task.due } : {}), ...(task.updated ? { updated: task.updated } : {}), ...(task.completed ? { completed: task.completed } : {}),
  ...(task.notes ? { notes: task.notes } : {}), ...(task.parent ? { parent: task.parent } : {}), ...(task.position ? { position: task.position } : {}), ...(task.webViewLink ? { web_view_link: task.webViewLink } : {}),
});

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
export type CalendarChangesPage = Readonly<{ events: readonly CalendarChange[]; next_page_token: string | null; fetched_count: number; calendar_id: string; account: CalendarPage['account']; observed_at: string }>;

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
  calendarListsPage?(limit: number, includeHidden: boolean, pageToken?: string): Promise<GoogleCollectionPage<CalendarListItem>>;
  taskListsPage?(limit: number, pageToken?: string): Promise<GoogleCollectionPage<TaskListItem>>;
  tasksPage?(taskListId: string, status: TaskStatusFilter, limit: number, pageToken?: string): Promise<TasksPage>;
  allTasksPage?(status: TaskStatusFilter, limit: number, pageToken?: string): Promise<TasksPage>;
  freeBusy(from:string,to:string,calendarIds:readonly string[],timezone:string):Promise<FreeBusyResult>;
  events(from: string, to: string, limit: number, includeDeclined: boolean): Promise<readonly CalendarItem[]>;
  findDraftByMessageId?(messageId: string): Promise<Readonly<{ draft_id: string; message_id?: string }> | null>;
  readDraft?(draftId: string): Promise<DraftEvidence>;
  draft(input: DraftInput): Promise<Readonly<{ draft_id: string; message_id?: string; thread_id?: string }>>;
  sendRaw(raw: string, threadId?: string): Promise<Readonly<{ message_id: string; thread_id?: string }>>;
  findSentByMessageId(messageId: string, threadId?: string): Promise<boolean | SentEvidence | Readonly<{ message_id: string }>>;
  event(id: string): Promise<CalendarItem>;
  createEvent(input: Readonly<{ title: string; start: string; end: string; id?: string; operationMarker?: string }>): Promise<CalendarItem>;
  moveEvent(id: string, start: string, end: string, etag?: string, operationMarker?: string): Promise<CalendarItem>;
  cancelEvent(id: string, etag?: string, operationMarker?: string): Promise<void>;
  changedEvents(since: number, from: number, to: number): Promise<readonly CalendarChange[]>;
  changedEventsPage?(calendarId: string, since: number, from: number, to: number, limit: number, pageToken?: string): Promise<CalendarChangesPage>;
  mailPage(query:string,limit:number,pageToken?:string):Promise<Readonly<{messages:readonly MailItem[];next_page_token:string|null;result_size_estimate:number|null}>>;
  newMail(since: number, limit: number): Promise<readonly MailItem[]>;
  searchMail(query: string, limit: number): Promise<readonly MailItem[]>;
  readThread(threadId: string, limit: number): Promise<readonly ThreadMessage[]>;
  threadPage?(threadId: string, limit: number, cursor?: string): Promise<Readonly<{messages: readonly ThreadMessage[]; cursor: string | null}>>;
  tasks(status: TaskStatusFilter, limit: number): Promise<readonly TaskItem[]>;
}>;

// Single source for the connector-proxy allowlist: the runtime's vault client and the Supabase
// connector-proxy Edge Function both build from this list, so a method added to GoogleClient but
// missed here fails `satisfies` / the parity test instead of breaking live calls on Vault installs.
export const GOOGLE_METHODS = ['calendarPage','calendarListsPage','taskListsPage','tasksPage','allTasksPage','mailPage','freeBusy', 'events', 'draft', 'findDraftByMessageId','readDraft', 'sendRaw', 'findSentByMessageId', 'event', 'createEvent', 'moveEvent', 'cancelEvent', 'changedEvents','changedEventsPage', 'newMail', 'searchMail', 'readThread', 'threadPage', 'tasks', 'driveListFiles', 'driveSearchFiles', 'driveGetFileMetadata','driveReadFileContent'] as const satisfies readonly (keyof GoogleClient)[];
export type GoogleMethod = (typeof GOOGLE_METHODS)[number];

const b64urlDecode = (data: string): string => {
  const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};

// Thread bodies enter model context only through the E1 verification-artifact quarantine
// (tools/live/google.ts); this cap is the second wall - a huge body never floods a turn.
const BODY_CAP = 32_000;
type GmailPayload = Readonly<{ mimeType?: string; body?: { data?: string }; parts?: GmailPayload[]; headers?: { name: string; value: string }[] }>;
type GmailFullMessage = Readonly<{ id?: string; threadId?: string; snippet?: string; internalDate?: string; payload?: GmailPayload }>;
const htmlText = (html: string): string => {
  const blocks = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article', 'hr']);
  let suppressed = 0;
  const chunks: string[] = [];
  const boundary = () => { if (!suppressed && chunks.length && chunks.at(-1) !== '\n') chunks.push('\n'); };
  new Parser({
    onopentag(name) { if (name === 'script' || name === 'style') suppressed++; else if (blocks.has(name)) boundary(); },
    ontext(text) { if (!suppressed) chunks.push(text); },
    onclosetag(name) { if (name === 'script' || name === 'style') suppressed = Math.max(0, suppressed - 1); else if (blocks.has(name)) boundary(); },
  }, { decodeEntities: true }).end(html);
  return chunks.join('').trim();
};
const threadBody = (payload: GmailPayload | undefined): string => {
  const partText = (part: GmailPayload, mime: string): string => {
    if (part.mimeType === mime && part.body?.data) return b64urlDecode(part.body.data);
    for (const child of part.parts ?? []) { const text = partText(child, mime); if (text.trim()) return text; }
    return '';
  };
  return (payload ? partText(payload, 'text/plain').trim() || htmlText(partText(payload, 'text/html')) : '').trim().slice(0, BODY_CAP);
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
export function googleClient(app: GoogleApp, tokens: GoogleTokens, fetcher: Fetch = fetch, health?: (error: string) => void, account: CalendarPage['account'] = {connection_id: null, email: tokens.email ?? null}): GoogleClient & Required<Pick<GoogleClient, 'calendarPage' | 'calendarListsPage' | 'taskListsPage' | 'tasksPage' | 'allTasksPage' | 'changedEventsPage'>> {
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
  // A continuation is authority to resume this exact account/query, never to select another
  // resource. The grant signs it; reconnecting with another grant requires a fresh first page.
  const collectionCursor = async (kind: string, query: readonly unknown[]) => {
    const binding = JSON.stringify([kind, account, ...query]);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(tokens.refresh_token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = async (body: string) => [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${binding}.${body}`)))].map(b => b.toString(16).padStart(2, '0')).join('');
    return {
      async encode(value: unknown): Promise<string> {
        const body = b64url(new TextEncoder().encode(JSON.stringify(value)));
        const cursor = `${body}.${await signature(body)}`;
        if (cursor.length > 16_384) throw new Error(`invalid ${kind} continuation size`);
        return cursor;
      },
      async decode(cursor: string): Promise<unknown> {
        try {
          if (typeof cursor !== 'string' || !cursor || cursor.length > 16_384) throw new Error();
          const parts = cursor.split('.');
          if (parts.length !== 2) throw new Error();
          const expected = await signature(parts[0]!);
          let mismatch = expected.length ^ parts[1]!.length;
          for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ (parts[1]!.charCodeAt(i) || 0);
          if (mismatch) throw new Error();
          return JSON.parse(b64urlDecode(parts[0]!));
        } catch { throw new Error(`invalid ${kind} cursor or query binding`); }
      },
    };
  };
  const providerCursor = async (kind: string, query: readonly unknown[], cursor?: string) => {
    const codec = await collectionCursor(kind, query);
    let token: string | undefined;
    if (cursor !== undefined) {
      const state = await codec.decode(cursor);
      if (!isObject(state) || Object.keys(state).length !== 2 || state.v !== 1 || !validProviderToken(state.token)) throw new Error(`invalid ${kind} cursor or query binding`);
      token = state.token;
    }
    return { token, next: (nextToken: string | undefined) => {
      if (token !== undefined && nextToken === token) throw new Error(`${kind} pagination made no progress`);
      return nextToken ? codec.encode({ v: 1, token: nextToken }) : Promise.resolve(null);
    } };
  };
  const taskListsPage = async (limit: number, pageToken?: string): Promise<GoogleCollectionPage<TaskListItem>> => {
    if (!validPageLimit(limit, 1000)) throw new Error('invalid task-list page request');
    const cursor = await providerCursor('task-list', [limit], pageToken);
    const url = new URL('https://tasks.googleapis.com/tasks/v1/users/@me/lists');
    url.search = new URLSearchParams({ maxResults: String(limit), ...(cursor.token ? { pageToken: cursor.token } : {}) }).toString();
    const data = await call(url.toString(), { signal: AbortSignal.timeout(30_000) });
    const items = collectionItems(data, 'tasks#taskLists', limit, 'task-list');
    if (!items.every(item => isObject(item) && validGoogleId(item.id) && typeof item.title === 'string' && item.title.length <= 2000 && optionalInstant(item.updated) && optionalText(item.etag, 1024))) throw new Error('invalid task-list page response');
    return { items: items.map(item => ({ id: item.id as string, title: item.title as string, ...(item.updated ? { updated: item.updated as string } : {}), ...(item.etag ? { etag: item.etag as string } : {}) })), next_page_token: await cursor.next(data.nextPageToken as string | undefined), fetched_count: items.length, account, observed_at: new Date().toISOString() };
  };
  const tasksPage = async (taskListId: string, status: TaskStatusFilter, limit: number, pageToken?: string): Promise<TasksPage> => {
    if (!validGoogleId(taskListId) || !validTaskStatus(status) || !validPageLimit(limit, 100)) throw new Error('invalid Tasks page request');
    const cursor = await providerCursor('Tasks', [taskListId, status, limit], pageToken);
    const url = new URL(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(taskListId)}/tasks`);
    url.search = new URLSearchParams({ maxResults: String(limit), showDeleted: 'false', showAssigned: 'true', showHidden: status === 'done' || status === 'all' ? 'true' : 'false', showCompleted: status === 'done' || status === 'all' ? 'true' : 'false', ...(cursor.token ? { pageToken: cursor.token } : {}) }).toString();
    const data = await call(url.toString(), { signal: AbortSignal.timeout(30_000) });
    const items = collectionItems(data, 'tasks#tasks', limit, 'Tasks');
    if (!items.every(validGoogleTask)) throw new Error('invalid Tasks page response');
    const want = status === 'done' ? 'completed' : 'needsAction';
    return { tasks: (items as GoogleTask[]).filter(task => status === 'all' || task.status === want).map(task => taskItem(task, taskListId)), next_page_token: await cursor.next(data.nextPageToken as string | undefined), fetched_count: items.length, task_list_ids: [taskListId], account, observed_at: new Date().toISOString() };
  };
  const allTasksPage = async (status: TaskStatusFilter, limit: number, pageToken?: string): Promise<TasksPage> => {
    if (!validTaskStatus(status) || !validPageLimit(limit, 100)) throw new Error('invalid all-list Tasks page request');
    const codec = await collectionCursor('all-list Tasks', [status, limit]);
    type State = { v: 1; list_id: string | null; list_token: string | null; task_token: string | null; lists_exhausted: boolean };
    let state: State = { v: 1, list_id: null, list_token: null, task_token: null, lists_exhausted: false };
    if (pageToken !== undefined) {
      const value = await codec.decode(pageToken);
      if (!isObject(value) || Object.keys(value).length !== 5 || value.v !== 1 || (value.list_id !== null && !validGoogleId(value.list_id)) || (value.list_token !== null && typeof value.list_token !== 'string') || (value.task_token !== null && typeof value.task_token !== 'string') || typeof value.lists_exhausted !== 'boolean' || (!value.list_id && value.task_token) || (!value.list_id && value.lists_exhausted)) throw new Error('invalid all-list Tasks cursor or query binding');
      state = value as State;
    }
    const tasks: TaskItem[] = [];
    const lists = new Set<string>();
    let fetched = 0;
    // Bound one tool invocation while retaining the next provider step. Even empty lists or
    // filtered completed pages cannot silently consume an unbounded request budget.
    for (let reads = 0; reads < 10 && tasks.length < limit; reads++) {
      if (state.list_id === null) {
        if (state.lists_exhausted) break;
        const page = await taskListsPage(1, state.list_token ?? undefined);
        state.list_token = page.next_page_token;
        state.lists_exhausted = page.next_page_token === null;
        state.list_id = page.items[0]?.id ?? null;
        if (state.list_id === null) continue;
      }
      lists.add(state.list_id);
      // A stable size keeps the inner provider cursor bound across separate invocations.
      const page = await tasksPage(state.list_id, status, limit, state.task_token ?? undefined);
      tasks.push(...page.tasks);
      fetched += page.fetched_count;
      state.task_token = page.next_page_token;
      if (page.next_page_token === null) state.list_id = null;
      // One provider task page may use the entire output allowance. Do not request another
      // list with a smaller size then replay its cursor at the original size after restart.
      if (tasks.length > 0) break;
    }
    return { tasks, fetched_count: fetched, task_list_ids: [...lists], next_page_token: state.list_id === null && state.lists_exhausted ? null : await codec.encode(state), account, observed_at: new Date().toISOString() };
  };
  const changedEventsPage = async (calendarId: string, since: number, from: number, to: number, limit: number, pageToken?: string): Promise<CalendarChangesPage> => {
    if (!validGoogleId(calendarId) || ![since, from, to].every(value => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())) || from >= to || !validPageLimit(limit, 50)) throw new Error('invalid Calendar changes page request');
    const cursor = await providerCursor('Calendar changes', [calendarId, since, from, to, limit], pageToken);
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.search = new URLSearchParams({ updatedMin: new Date(since).toISOString(), timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: 'true', showDeleted: 'true', maxResults: String(limit), ...(cursor.token ? { pageToken: cursor.token } : {}) }).toString();
    const data = await call(url.toString(), { signal: AbortSignal.timeout(30_000) });
    const items = collectionItems(data, 'calendar#events', limit, 'Calendar changes');
    if (!items.every(item => validCalendarEvent(item) && optionalInstant(item.updated) && optionalInstant(item.created))) throw new Error('invalid Calendar changes page response');
    return { events: (items as GoogleEvent[]).filter(event => event.status === 'cancelled' || event.attendees?.find(a => a.self)?.responseStatus !== 'declined').map(event => ({ ...toItem({ ...event, start: event.start ?? {}, end: event.end ?? {} }), status: event.status ?? 'confirmed', created: event.created ?? '' })), next_page_token: await cursor.next(data.nextPageToken as string | undefined), fetched_count: items.length, calendar_id: calendarId, account, observed_at: new Date().toISOString() };
  };
  const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const match = (etag?: string): Record<string, string> => (etag ? { 'if-match': etag } : {});
  const readEvent = async (id: string) => {
    if (!validGoogleId(id)) throw new Error('invalid Calendar event identifier');
    const value = await call(`${EVENTS}/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) });
    if (!validCalendarEvent(value) || value.id !== id) throw new Error('invalid Calendar event response');
    return value;
  };
  const send = async (url: string, method: string, body: Record<string, unknown>, etag?: string) => {
    const targetId = method === 'POST' ? body.id : decodeURIComponent(url.slice(EVENTS.length + 1));
    if (targetId !== undefined && !validGoogleId(targetId)) throw new Error('invalid Calendar mutation identifier');
    const mutation = await call(url, { method, headers: { 'content-type': 'application/json', ...match(etag) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!validCalendarEvent(mutation) || targetId !== undefined && mutation.id !== targetId) throw new Error('invalid Calendar mutation response; provider outcome needs readback');
    const current = await readEvent(mutation.id);
    const desiredMarker = (body.extendedProperties as GoogleEvent['extendedProperties'])?.private?.waldoOperation;
    const endpointMatches = (wanted: unknown, observed: unknown) => !wanted || isObject(wanted) && isObject(observed) && ['date', 'dateTime'].every(field => wanted[field] == null || wanted[field] === observed[field]);
    if ((body.summary !== undefined && body.summary !== current.summary) || (body.status === 'cancelled' ? current.status !== 'cancelled' : current.status === 'cancelled') || !endpointMatches(body.start, current.start) || !endpointMatches(body.end, current.end) || (desiredMarker && current.extendedProperties?.private?.waldoOperation !== desiredMarker) || (mutation.etag && current.etag !== mutation.etag)) throw new Error('Calendar final-state readback differs or changed; reconcile the provider before retrying');
    return toItem(current);
  };
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
  const threadPage = async (threadId: string, limit: number, cursor?: string): Promise<Readonly<{messages:readonly ThreadMessage[];cursor:string|null}>> => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid thread page limit');
      const json = await call(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`) as { id?:string; messages?: GmailFullMessage[] };
      if (!json || !Array.isArray(json.messages) || (json.id !== undefined && json.id !== threadId) || json.messages.some(m => !m || typeof m.id !== 'string' || !m.id || m.threadId !== undefined && m.threadId !== threadId)) throw new Error('invalid Gmail thread response');
      const ids = json.messages.map(message => message.id);
      const binding = await sha256Hex(JSON.stringify([account, threadId, ids]));
      let offset = 0;
      if (cursor) {
        try {
          const decoded = JSON.parse(b64urlDecode(cursor)) as {binding: string; offset: number};
          if (decoded.binding !== binding || !Number.isSafeInteger(decoded.offset) || decoded.offset < 1 || decoded.offset >= ids.length) throw new Error();
          offset = decoded.offset;
        } catch { throw new Error('invalid thread cursor or thread changed; read the first page again'); }
      }
      const messages = json.messages.slice(offset, offset + limit).map(message => {
        const header = (name: string) => message.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
        const messageIds = message.payload?.headers?.filter(h => h.name.toLowerCase() === 'message-id') ?? [];
        const messageId = messageIds.length === 1 ? messageIds[0]!.value.trim() : '';
        const references = (message.payload?.headers?.filter(h => h.name.toLowerCase() === 'references').map(h => h.value).join(' ') ?? '').trim().split(/\s+/).filter(Boolean);
        return { ...(validMessageId(messageId) ? {message_id:messageId} : {}), ...(references.length ? {references} : {}), id: message.id ?? '', from: header('From'), subject: header('Subject'), at: new Date(Number(message.internalDate ?? 0)).toISOString(), body: threadBody(message.payload) || (message.snippet ?? '').slice(0, BODY_CAP) };
      });
      const next = offset + messages.length;
      return {messages, cursor: next < ids.length ? b64url(new TextEncoder().encode(JSON.stringify({binding,offset:next}))) : null};
  };
  return {
    account,
    taskListsPage, tasksPage, allTasksPage, changedEventsPage,
    async calendarListsPage(limit, includeHidden, pageToken) {
      if (!validPageLimit(limit, 250) || typeof includeHidden !== 'boolean') throw new Error('invalid Calendar-list page request');
      const cursor = await providerCursor('Calendar-list', [limit, includeHidden], pageToken);
      const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
      url.search = new URLSearchParams({ maxResults: String(limit), showHidden: String(includeHidden), showDeleted: 'false', ...(cursor.token ? { pageToken: cursor.token } : {}) }).toString();
      const data = await call(url.toString(), { signal: AbortSignal.timeout(30_000) });
      const items = collectionItems(data, 'calendar#calendarList', limit, 'Calendar-list');
      if (!items.every(item => validGoogleId(item.id) && typeof item.summary === 'string' && item.summary.length <= 2000 && ['freeBusyReader', 'reader', 'writer', 'owner', 'writerWithoutPrivateAccess'].includes(String(item.accessRole)) && optionalText(item.timeZone, 128) && optionalText(item.etag, 1024) && [item.primary, item.selected, item.hidden].every(value => value === undefined || typeof value === 'boolean'))) throw new Error('invalid Calendar-list page response');
      return { items: items.map(item => ({ id: item.id as string, title: item.summary as string, access_role: item.accessRole as string, primary: item.primary === true, selected: item.selected === true, hidden: item.hidden === true, ...(item.timeZone ? { timezone: item.timeZone as string } : {}), ...(item.etag ? { etag: item.etag as string } : {}) })), next_page_token: await cursor.next(data.nextPageToken as string | undefined), fetched_count: items.length, account, observed_at: new Date().toISOString() };
    },
    freeBusy:async(from,to,calendarIds,timezone)=>{
      if(![from,to].every(s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s)))||Date.parse(from)>=Date.parse(to)||!Array.isArray(calendarIds)||!calendarIds.length||calendarIds.length>50||calendarIds.some(id=>typeof id!=='string'||!id.trim()||id.length>256)||new Set(calendarIds).size!==calendarIds.length)throw new Error('invalid freebusy request');
      const data=await call('https://www.googleapis.com/calendar/v3/freeBusy',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({timeMin:from,timeMax:to,timeZone:timezone,calendarExpansionMax:50,items:calendarIds.map(id=>({id}))})});
      const result=data as {timeMin?:string;timeMax?:string;calendars?:FreeBusyResult['calendars']};
      if(!result||typeof result!=='object'||!result.calendars||typeof result.calendars!=='object'||Array.isArray(result.calendars)||!Object.values(result.calendars).every(validFreeBusyCalendar)||Date.parse(result.timeMin??'')!==Date.parse(from)||Date.parse(result.timeMax??'')!==Date.parse(to))throw new Error('freebusy coverage differs');
      return {from:result.timeMin!,to:result.timeMax!,calendars:result.calendars};
    },
    event: async (id) => toItem(await readEvent(id)),
    // Preserve the provider's notification defaults; recovery markers do not authorize silent guest updates.
    createEvent: ({ title, start, end, id, operationMarker }) => send(EVENTS, 'POST', { ...(id ? { id } : {}), summary: title, ...calendarTimes(start, end), ...calendarMarker(operationMarker) }),
    moveEvent: (id, start, end, etag, operationMarker) => send(`${EVENTS}/${encodeURIComponent(id)}`, 'PATCH', { ...calendarTimes(start, end), ...calendarMarker(operationMarker) }, etag),
    async cancelEvent(id, etag, operationMarker) {
      // Put cancellation and its marker in one version-fenced mutation. A missing tombstone
      // marker later is ambiguous, even if a provider returns 404 or a bare cancelled event.
      if (operationMarker) await send(`${EVENTS}/${encodeURIComponent(id)}`, 'PATCH', { status: 'cancelled', ...calendarMarker(operationMarker) }, etag);
      else {
        await call(`${EVENTS}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: match(etag), signal: AbortSignal.timeout(30_000) });
        try { if ((await readEvent(id)).status !== 'cancelled') throw new Error('Calendar cancellation readback differs; check the provider before retrying'); }
        catch (error) { if (!(error instanceof GoogleError && (error.status === 404 || error.status === 410))) throw error; }
      }
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
        if (data.nextPageToken === providerToken) throw new Error('Calendar pagination made no progress');
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
      const changes: CalendarChange[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let pages = 0; pages < 100; pages++) {
        const page = await changedEventsPage('primary', since, from, to, 50, cursor);
        changes.push(...page.events);
        if (!page.next_page_token) return changes;
        if (seen.has(page.next_page_token)) throw new Error('Calendar change pagination made no progress; use the resumable page adapter');
        seen.add(page.next_page_token);
        cursor = page.next_page_token;
      }
      throw new Error('Calendar change collection needs continuation; use the resumable page adapter');
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
    async readThread(threadId, limit) {
      return (await threadPage(threadId, limit)).messages;
    },
    threadPage,
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
    async findDraftByMessageId(messageId) {
      if (!validMessageId(messageId)) throw new Error('invalid draft Message-ID');
      const list = new URL('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
      list.search = new URLSearchParams({ q: `rfc822msgid:${messageId}`, maxResults: '1' }).toString();
      const { drafts = [] } = await call(list.toString()) as { drafts?: { id: string; message?: { id: string } }[] };
      return drafts[0] ? { draft_id: drafts[0].id, ...(drafts[0].message ? { message_id: drafts[0].message.id } : {}) } : null;
    },
    async readDraft(draftId) {
      if (!validGoogleId(draftId)) throw new Error('invalid Gmail draft identifier');
      const data = await call(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}?format=raw`, { signal: AbortSignal.timeout(30_000) });
      const message = data.message;
      if (data.id !== draftId || !isObject(message) || !validGoogleId(message.id) || !validGoogleId(message.threadId) || typeof message.raw !== 'string' || message.raw.length > 400_000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(message.raw)) throw new Error('invalid Gmail draft readback');
      return { draft_id: draftId, message_id: message.id, thread_id: message.threadId, raw: message.raw };
    },
    async sendRaw(raw, threadId) {
      const json = await call('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
      }) as { id: string; threadId?: string };
      return { message_id: json.id, ...(json.threadId ? { thread_id: json.threadId } : {}) };
    },
    async findSentByMessageId(messageId, threadId) {
      if (!validMessageId(messageId)) throw new Error('invalid Sent Message-ID');
      const list = new URL(GMAIL);
      list.search = new URLSearchParams({ q: `in:sent rfc822msgid:${messageId.slice(1,-1)}`, maxResults: '10' }).toString();
      const { messages = [] } = await call(list.toString()) as { messages?: { id: string }[] };
      if (!Array.isArray(messages) || messages.length > 10) throw new Error('invalid Sent search response');
      for (const candidate of messages) {
        if (typeof candidate?.id !== 'string' || !candidate.id) continue;
        const value = await call(`${GMAIL}/${encodeURIComponent(candidate.id)}?format=metadata&metadataHeaders=Message-ID`) as { id?: string; threadId?: string; labelIds?: string[]; payload?: GmailPayload };
        const ids = value.payload?.headers?.filter(h => h.name.toLowerCase() === 'message-id');
        const evidence = { message_id: value.id, thread_id: value.threadId, label_ids: value.labelIds, rfc822_message_id: ids?.length === 1 ? ids[0]!.value.trim() : undefined };
        if (value.id === candidate.id && verifiedSent(evidence, messageId, threadId)) return evidence;
      }
      return false;
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
const calendarMarker = (operationMarker?: string) => operationMarker ? { extendedProperties: { private: { waldoOperation: operationMarker } } } : {};
const calendarTimes = (start: string, end: string) => {
  const date = (v: string) => /^\d{4}-\d\d-\d\d$/.test(v) && new Date(v).toISOString().slice(0,10) === v;
  const allDay = date(start) && date(end);
  if ((!allDay && (!validCalendarInstant(start) || !validCalendarInstant(end))) || Date.parse(start) >= Date.parse(end)) throw new Error('invalid Calendar mutation times');
  // PATCH merges nested fields, so explicitly clear the previous representation.
  return allDay ? {start:{date:start,dateTime:null},end:{date:end,dateTime:null}} : {start:{dateTime:start,date:null},end:{dateTime:end,date:null}};
};
const toItem = (event: GoogleEvent): CalendarItem => ({
  id: event.id, title: event.summary ?? '(no title)',
  start: event.start?.dateTime ?? event.start?.date ?? '', end: event.end?.dateTime ?? event.end?.date ?? '',
  all_day: event.start?.dateTime === undefined,
  ...(event.location ? { location: event.location } : {}),
  ...(event.description?.trim() ? { description: event.description.trim().slice(0, 2000) } : {}),
  ...(event.attendees?.length ? { attendees: event.attendees.length } : {}),
  ...(event.etag ? { etag: event.etag } : {}),
  ...(typeof event.extendedProperties?.private?.waldoOperation === 'string' ? { operation_marker: event.extendedProperties.private.waldoOperation } : {}),
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
  extendedProperties?: { private?: Record<string,string> };
  attendees?: { self?: boolean; responseStatus?: string; displayName?: string }[];
};
