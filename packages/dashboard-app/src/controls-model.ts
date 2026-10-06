import { SignInRequired } from './model';

export type ControlsView = 'day' | 'connections' | 'waiting' | 'activity' | 'profile' | 'setup' | 'usage' | 'files';
type Base<V extends ControlsView, D> = { version: 1; view: V; state: 'available'; csrf: string; revision: string; data: D };
export type DayRecord = Base<'day', {
  timezone: string;
  date: string;
  cards: { id: string; name: string; defaultTime: string; time: string | null; reason: string; sent: boolean; pin: string | null }[];
  proactivity: { quiet_start: string | null; quiet_end: string | null; volume: 'low' | 'normal' | 'high' };
}>;
export type ConnectionsRecord = Base<'connections', {
  google: { connectAvailable: boolean; accounts: { id: string; email: string; calendar: boolean; mail: boolean; tasks: boolean; health: 'access_granted' | 'needs_reconnect' }[] };
  telegram: { linked: boolean; unlinkAvailable: boolean };
  sessions: { until: string; count: number; items: { signed_in: string; until: string; current: boolean }[] };
}>;
export type ProposalReview = { kind: 'email_send'; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string }
  | { kind: 'message_send'; channel: string; content: string }
  | { kind: 'calendar_change'; action: 'create' | 'move' | 'cancel'; title: string | null; event_id: string | null; start: string | null; end: string | null; reason: string };
export type WaitingRecord = Base<'waiting', { proposals: { id: string; kind: string; summary: string; state: 'open' | 'done' | 'unconfirmed' | 'review_only'; review: ProposalReview | null; actions: ('approval.approve' | 'approval.skip' | 'approval.undo')[] }[] }>;
export type ActivityCursors = { trace_before?: number | null; runs_before?: number | null };
export type ActivityRecord = Base<'activity', {
  steps: { step: string; state: 'ok' | 'failed' | 'unseen'; at: string | null; note: string | null }[];
  trace: { time: string; hop: string; ok: boolean; ms: number; summary: string | null }[];
  runs: { id: string; kind: string; status: string; summary: string | null; started: string; ended: string | null }[];
  page: { trace_before: number | null; runs_before: number | null; trace_applied: number | null; runs_applied: number | null };
  ledger: string;
}>;
export type ProfileRecord = Base<'profile', { sections: { title: string; lines: string[] }[]; barriers: number; removal: { state: 'incomplete' | 'none_recorded'; pending_count: number; items?:{id:string;status:'purging'}[] }; holds: { kind: string; reason: string; created_at: string }[] }>;
export type SetupRecord = Base<'setup', { telegram_linked: boolean; google_access_granted: boolean; quiet_hours_set: boolean }>;
export type UsageRecord = Base<'usage', { rows: { model: string; calls: number; input: number; cached: number; output: number; usd: number }[] }>;
export type FilesRecord = Base<'files', { storage: 'telegram_reference'; items: { id: number; kind: string; name: string; mime: string | null; size: number | null; caption: string; at: number }[] }>;
type Records = { day: DayRecord; connections: ConnectionsRecord; waiting: WaitingRecord; activity: ActivityRecord; profile: ProfileRecord; setup: SetupRecord; usage: UsageRecord; files: FilesRecord };
export type ControlRecord = Records[ControlsView];
export type ControlAction = 'spot.confirm' | 'spot.dismiss' | 'spot.forget' | 'node.forget' | 'card.today' | 'card.pin' | 'card.unpin' | 'timezone.set' | 'proactivity.set' | 'google.connect' | 'google.disconnect' | 'telegram.link' | 'telegram.unlink' | 'session.signout' | 'session.signout.all' | 'approval.approve' | 'approval.skip' | 'approval.undo' | 'file.remove';
export type ControlFields = { id?: string; value?: string; quiet_start?: string; quiet_end?: string; volume?: string };
export type ActionReceipt = { state: 'recorded' | 'incomplete' | 'rejected' | 'unconfirmed'; message: string; navigation?: string; signed_out?: boolean };
export type ActionResult = { receipt: ActionReceipt; duplicate: boolean };
export class ControlsActionError extends Error {
  constructor(readonly code: string, message: string, readonly uncertain = false) { super(message); }
}
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string';
const clock = (v: unknown): v is string => string(v) && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v);
const optionalClock = (v: unknown): v is string | null => v === null || clock(v);
const optionalString = (v: unknown): v is string | null => v === null || string(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(string);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const cursor = (v: unknown): v is number | null => v === null || count(v) && v > 0;
const shapeError = () => new Error('These controls are unavailable or their read is unsupported. Refresh the records.');

function readProposalReview(value: unknown): ProposalReview | null {
  if (value === null) return null;
  if (!obj(value)) throw shapeError();
  if (value.kind === 'email_send' && strings(value.to) && strings(value.cc) && strings(value.bcc) && string(value.subject) && string(value.body)) return { kind: value.kind, to: [...value.to], cc: [...value.cc], bcc: [...value.bcc], subject: value.subject, body: value.body };
  if (value.kind === 'message_send' && string(value.channel) && string(value.content)) return { kind: value.kind, channel: value.channel, content: value.content };
  if (value.kind === 'calendar_change' && ['create', 'move', 'cancel'].includes(String(value.action)) && [value.title, value.event_id, value.start, value.end].every(optionalString) && string(value.reason)) return { kind: value.kind, action: value.action as 'create' | 'move' | 'cancel', title: value.title as string | null, event_id: value.event_id as string | null, start: value.start as string | null, end: value.end as string | null, reason: value.reason };
  throw shapeError();
}

export function readControls<V extends ControlsView>(value: unknown, expected: V): Records[V] {
  if (!obj(value) || value.version !== 1 || value.view !== expected || value.state !== 'available' || !string(value.csrf) || !value.csrf || !string(value.revision) || !/^[a-f0-9]{64}$/.test(value.revision) || !obj(value.data)) throw shapeError();
  const data = value.data;
  const base = { version: 1 as const, state: 'available' as const, csrf: value.csrf, revision: value.revision };
  if (expected === 'day') {
    if (!string(data.timezone) || !string(data.date) || !/^\d{4}-\d{2}-\d{2}$/.test(data.date) || !Array.isArray(data.cards) || !data.cards.every(card => obj(card) && string(card.id) && string(card.name) && clock(card.defaultTime) && optionalClock(card.time) && string(card.reason) && typeof card.sent === 'boolean' && optionalClock(card.pin)) || !obj(data.proactivity) || !optionalClock(data.proactivity.quiet_start) || !optionalClock(data.proactivity.quiet_end) || !['low', 'normal', 'high'].includes(String(data.proactivity.volume))) throw shapeError();
    return { ...base, view: 'day', data: {
      timezone: data.timezone,
      date:data.date,
      cards: data.cards.map(card => ({ id: card.id, name: card.name, defaultTime: card.defaultTime, time: card.time, reason: card.reason, sent: card.sent, pin: card.pin })),
      proactivity: { quiet_start: data.proactivity.quiet_start, quiet_end: data.proactivity.quiet_end, volume: data.proactivity.volume },
    } } as Records[V];
  }
  if (expected === 'connections') {
    if (!obj(data.google) || typeof data.google.connectAvailable !== 'boolean' || !Array.isArray(data.google.accounts) || !data.google.accounts.every(account => obj(account) && string(account.id) && string(account.email) && ['calendar', 'mail', 'tasks'].every(key => typeof account[key] === 'boolean') && ['access_granted', 'needs_reconnect'].includes(String(account.health))) || !obj(data.telegram) || typeof data.telegram.linked !== 'boolean' || typeof data.telegram.unlinkAvailable !== 'boolean' || !obj(data.sessions) || !string(data.sessions.until) || !Number.isSafeInteger(data.sessions.count) || Number(data.sessions.count) < 1 || !Array.isArray(data.sessions.items) || !data.sessions.items.every(item => obj(item) && string(item.signed_in) && string(item.until) && typeof item.current === 'boolean')) throw shapeError();
    return { ...base, view: 'connections', data: {
    google: { connectAvailable: data.google.connectAvailable, accounts: data.google.accounts.map(account => ({ id: account.id, email: account.email, calendar: account.calendar, mail: account.mail, tasks: account.tasks, health: account.health })) },
    telegram: { linked: data.telegram.linked, unlinkAvailable: data.telegram.unlinkAvailable },
    sessions: { until: data.sessions.until, count: data.sessions.count, items: (data.sessions.items as { signed_in: string; until: string; current: boolean }[]).map(item => ({ signed_in: item.signed_in, until: item.until, current: item.current })) },
    } } as Records[V];
  }
  if (expected === 'waiting') {
    if (!Array.isArray(data.proposals)) throw shapeError();
    const proposals = data.proposals.map(item => {
      if (!obj(item) || !string(item.id) || !string(item.kind) || !string(item.summary) || !['open', 'done', 'unconfirmed', 'review_only'].includes(String(item.state)) || !strings(item.actions) || !item.actions.every(action => ['approval.approve', 'approval.skip', 'approval.undo'].includes(action))) throw shapeError();
      const review = readProposalReview(item.review);
      if (review && review.kind !== item.kind || item.actions.includes('approval.approve') && (item.kind !== 'calendar_change' || item.state !== 'open' || review?.kind !== 'calendar_change') || item.actions.includes('approval.undo') && (item.kind !== 'calendar_change' || item.state !== 'done')) throw shapeError();
      return { id: item.id, kind: item.kind, summary: item.summary, state: item.state, review, actions: [...item.actions] };
    });
    return { ...base, view: 'waiting', data: { proposals } } as Records[V];
  }
  if (expected === 'activity') {
    if (!Array.isArray(data.steps) || !data.steps.every(row => obj(row) && string(row.step) && ['ok', 'failed', 'unseen'].includes(String(row.state)) && optionalString(row.at) && optionalString(row.note)) || !Array.isArray(data.trace) || !data.trace.every(row => obj(row) && string(row.time) && string(row.hop) && typeof row.ok === 'boolean' && finite(row.ms) && optionalString(row.summary)) || !Array.isArray(data.runs) || !data.runs.every(row => obj(row) && string(row.id) && string(row.kind) && string(row.status) && optionalString(row.summary) && string(row.started) && optionalString(row.ended)) || !obj(data.page) || ![data.page.trace_before, data.page.runs_before, data.page.trace_applied, data.page.runs_applied].every(cursor) || !string(data.ledger)) throw shapeError();
    return { ...base, view: 'activity', data: {
      steps: data.steps.map(row => ({ step: row.step, state: row.state, at: row.at, note: row.note })), trace: data.trace.map(row => ({ time: row.time, hop: row.hop, ok: row.ok, ms: row.ms, summary: row.summary })),
      runs: data.runs.map(row => ({ id: row.id, kind: row.kind, status: row.status, summary: row.summary, started: row.started, ended: row.ended })),
      page: { trace_before: data.page.trace_before, runs_before: data.page.runs_before, trace_applied: data.page.trace_applied, runs_applied: data.page.runs_applied }, ledger: data.ledger,
    } } as Records[V];
  }
  if (expected === 'profile') {
    if (!Array.isArray(data.sections) || !data.sections.every(section => obj(section) && string(section.title) && strings(section.lines)) || !count(data.barriers) || !obj(data.removal) || !count(data.removal.pending_count) || !['incomplete', 'none_recorded'].includes(String(data.removal.state)) || !Array.isArray(data.holds) || !data.holds.every(hold => obj(hold) && string(hold.kind) && string(hold.reason) && string(hold.created_at))) throw shapeError();
    if (data.removal.state === 'incomplete' && (data.removal.pending_count === 0 || data.sections.length !== 0) || data.removal.state === 'none_recorded' && data.removal.pending_count !== 0) throw shapeError();
    if(data.removal.items!==undefined&&(!Array.isArray(data.removal.items)||!data.removal.items.every((item:unknown)=>obj(item)&&string(item.id)&&item.status==='purging')))throw shapeError();
    return { ...base, view: 'profile', data: { sections: data.sections.map(section => ({ title: section.title, lines: [...section.lines] })), barriers: data.barriers, removal: { state: data.removal.state, pending_count: data.removal.pending_count,items:Array.isArray(data.removal.items)?data.removal.items.filter((item:unknown)=>obj(item)&&string(item.id)&&item.status==='purging').map((item:{id:string})=>({id:item.id,status:'purging' as const})):[] }, holds: data.holds.map(hold => ({ kind: hold.kind, reason: hold.reason, created_at: hold.created_at })) } } as Records[V];
  }
  if (expected === 'setup') {
    if (![data.telegram_linked, data.google_access_granted, data.quiet_hours_set].every(value => typeof value === 'boolean')) throw shapeError();
    return { ...base, view: 'setup', data: { telegram_linked: data.telegram_linked, google_access_granted: data.google_access_granted, quiet_hours_set: data.quiet_hours_set } } as Records[V];
  }
  if (expected === 'usage') {
    if (!Array.isArray(data.rows) || !data.rows.every(row => obj(row) && string(row.model) && [row.calls, row.input, row.cached, row.output].every(count) && finite(row.usd))) throw shapeError();
    return { ...base, view: 'usage', data: { rows: data.rows.map(row => ({ model: row.model, calls: row.calls, input: row.input, cached: row.cached, output: row.output, usd: row.usd })) } } as Records[V];
  }
  if (expected === 'files') {
    if (data.storage !== 'telegram_reference' || !Array.isArray(data.items) || !data.items.every(item => obj(item) && count(item.id) && item.id > 0 && string(item.kind) && string(item.name) && optionalString(item.mime) && (item.size === null || count(item.size)) && string(item.caption) && typeof item.at === 'number' && Number.isFinite(item.at))) throw shapeError();
    return { ...base, view: 'files', data: { storage: 'telegram_reference', items: data.items.map(item => ({ id: item.id, kind: item.kind, name: item.name, mime: item.mime, size: item.size, caption: item.caption, at: item.at })) } } as Records[V];
  }
  throw shapeError();
}

export async function fetchControls<V extends ControlsView>(view: V, signal?: AbortSignal, page: ActivityCursors = {}): Promise<Records[V]> {
  const params = new URLSearchParams({ view });
  for (const key of ['trace_before', 'runs_before'] as const) {
    const value = page[key];
    if (value === null || value === undefined) continue;
    if (view !== 'activity' || !cursor(value)) throw shapeError();
    params.set(key, String(value));
  }
  const response = await fetch(`/console/dashboard/api/v1/controls?${params}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, signal });
  if (response.status === 401) throw new SignInRequired();
  if (!response.ok) throw new Error('The controls could not be loaded. Retry the read; no empty state has been assumed.');
  let value: unknown;
  try { value = await response.json(); } catch { throw shapeError(); }
  return readControls(value, view);
}

// Existing connectUrl issues a first-party /c/<22-character ticket>. Direct
// Google authorization is constrained to the exact existing provider endpoint.
export function allowedControlNavigation(value: string, origin: string): string {
  let url: URL;
  try { url = new URL(value, origin); } catch { throw new ControlsActionError('navigation_unavailable', 'The connection link is unavailable. Refresh before connecting again.', true); }
  const localTicket = url.origin === origin && /^\/c\/[A-Za-z0-9_-]{22}$/.test(url.pathname) && !url.search && !url.hash;
  const google = url.hostname === 'accounts.google.com' && url.port === '' && url.pathname === '/o/oauth2/v2/auth' && !url.hash;
  if (url.protocol !== 'https:' || url.username || url.password || (!localTicket && !google)) throw new ControlsActionError('navigation_unavailable', 'The connection link is unavailable. Refresh before connecting again.', true);
  return url.href;
}

export function readActionResult(value: unknown, action: ControlAction, origin: string): ActionResult {
  if (!obj(value) || typeof value.duplicate !== 'boolean' || !obj(value.receipt) || !['recorded', 'incomplete', 'rejected', 'unconfirmed'].includes(String(value.receipt.state)) || !string(value.receipt.message) || (value.receipt.signed_out !== undefined && typeof value.receipt.signed_out !== 'boolean') || (value.receipt.navigation !== undefined && !string(value.receipt.navigation))) throw new ControlsActionError('receipt_unavailable', 'The action receipt is unavailable. Check this request before trying another change.', true);
  const receipt: ActionReceipt = { state: value.receipt.state as ActionReceipt['state'], message: value.receipt.message };
  if (value.receipt.signed_out !== undefined) {
    if (!action.startsWith('session.signout') || receipt.state !== 'recorded') throw new ControlsActionError('receipt_unavailable', 'The session receipt is unsupported. Sign in again to check the session.', true);
    receipt.signed_out = value.receipt.signed_out;
  }
  if (value.receipt.navigation !== undefined) {
    if (action !== 'google.connect' || receipt.state !== 'recorded') throw new ControlsActionError('receipt_unavailable', 'The navigation receipt is unsupported. Refresh the controls.', true);
    receipt.navigation = allowedControlNavigation(value.receipt.navigation, origin);
  }
  return { receipt, duplicate: value.duplicate };
}

export async function submitControl(data: Pick<ControlRecord,'csrf'|'revision'> & {view:ControlsView|'memory'}, action: ControlAction, fields: ControlFields, requestId: string, origin = globalThis.location?.origin ?? ''): Promise<ActionResult> {
  const body = new FormData();
  body.set('csrf', data.csrf); body.set('view', data.view); body.set('revision', data.revision); body.set('request_id', requestId); body.set('action', action);
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.set(key, value);
  let response: Response;
  try { response = await fetch('/console/dashboard/api/v1/actions', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, body }); }
  catch { throw new ControlsActionError('outcome_unavailable', 'The response was lost. Check this same request before making another change.', true); }
  if (response.status === 401) throw new SignInRequired();
  let value: unknown;
  try { value = await response.json(); } catch { throw new ControlsActionError('receipt_unavailable', 'The action receipt could not be read. Check this request before trying another change.', true); }
  if (obj(value) && obj(value.receipt)) {
    const result = readActionResult(value, action, origin);
    const coherent = response.ok && ['recorded', 'incomplete'].includes(result.receipt.state)
      || response.status === 409 && result.receipt.state === 'rejected'
      || response.status === 503 && result.receipt.state === 'unconfirmed';
    if (!coherent) throw new ControlsActionError('receipt_unavailable', 'The action response and receipt disagree. Check this request before making another change.', true);
    return result;
  }
  if (response.status === 409) {
    const code = obj(value) && string(value.error) && ['stale_read', 'no_longer_eligible', 'request_reused'].includes(value.error) ? value.error : 'not_completed';
    throw new ControlsActionError(code, 'These records or action eligibility changed. Refresh and review the controls before deciding again.');
  }
  if (response.status === 403) throw new ControlsActionError('invalid_action', 'The action was not accepted. Reload the controls to renew the session before trying again.');
  throw new ControlsActionError('outcome_unavailable', 'The outcome is unavailable. Check this request before making another change.', true);
}
