import type { ApprovalItem, ApprovalReview } from './approvals';
import type { Claim, ConstellationEdge, ConstellationNode, profile } from '../memory/claims';
import type { Proactivity } from './loops';
import type { E2EStep, TraceRow } from './harness';
import type { StoredFile } from './files';

export const CONSOLE_PATH = '/console';
export const CONSOLE_ACTION_PATH = `${CONSOLE_PATH}/action`;
export const CONSOLE_GOOGLE_PATH = `${CONSOLE_PATH}/google`;
export const CONSOLE_FILE_PATH = `${CONSOLE_PATH}/file`;
// B9: the background task list as a first-class read-only JSON endpoint (same console session).
export const CONSOLE_RUNS_PATH = `${CONSOLE_PATH}/runs`;
export const CONSOLE_COOKIE = 'waldo_console';
const LINK_MS = 10 * 60_000;
const SESSION_MS = 12 * 60 * 60_000;

type Store = Readonly<{ get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<boolean> }>;
type Grant = Readonly<{ token: string; expires: number }>;
export type ConsoleSession = Readonly<{ token: string; csrf: string; expires: number }>;

const randomToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// One-time link from Telegram -> short session cookie. Only the owner's DM can mint a link.
// Sessions are per browser: redeeming with a live session cookie refreshes that session instead of stacking.
export const consoleAccess = (store: Store, now: () => number = Date.now) => {
  const readSessions = async (): Promise<Record<string, ConsoleSession>> => (await store.get<Record<string, ConsoleSession>>('console:sessions')) ?? {};
  const writeSessions = async (sessions: Record<string, ConsoleSession>): Promise<void> => {
    const live = Object.fromEntries(Object.entries(sessions).filter(([, session]) => session.expires >= now()));
    if (Object.keys(live).length > 0) await store.put('console:sessions', live);
    else await store.delete('console:sessions');
  };
  const addSession = async (): Promise<string> => {
    const session: ConsoleSession = { token: randomToken(), csrf: randomToken(), expires: now() + SESSION_MS };
    const sessions = await readSessions();
    sessions[session.token] = session;
    await writeSessions(sessions);
    return session.token;
  };
  return {
    async mintLink(origin: string): Promise<string> {
      const token = randomToken();
      await store.put('console:link', { token, expires: now() + LINK_MS } satisfies Grant);
      return `${origin}${CONSOLE_PATH}?t=${token}`;
    },
    async redeem(token: string, current: string | null = null): Promise<string | null> {
      const link = await store.get<Grant>('console:link');
      if (!link || link.token !== token || link.expires < now()) return null;
      await store.delete('console:link');
      if (current) {
        const sessions = await readSessions();
        const existing = sessions[current];
        if (existing && existing.expires >= now()) {
          sessions[current] = { ...existing, expires: now() + SESSION_MS };
          await writeSessions(sessions);
          return current;
        }
      }
      return addSession();
    },
    async session(token: string | null): Promise<ConsoleSession | null> {
      if (!token) return null;
      const session = (await readSessions())[token];
      return session && session.expires >= now() ? session : null;
    },
    grant: addSession,
    async signOut(token: string): Promise<void> {
      const sessions = await readSessions();
      delete sessions[token];
      await writeSessions(sessions);
    },
    async list(): Promise<readonly ConsoleSession[]> {
      return Object.values(await readSessions()).filter((session) => session.expires >= now());
    },
    async signOutAll(): Promise<void> {
      await store.delete('console:sessions');
    },
  };
};

// Link previews (Telegram fetches URLs it sees) must not burn the one-time token, so opening the
// link only shows a button; the token is spent by the POST that button sends.
export const signInPage = (token: string): Response => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Waldo console</title><style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:#1A1A1A;display:grid;place-items:center;min-height:100vh;margin:0}form{text-align:center}button{font:inherit;font-size:18px;padding:12px 28px;border:0;border-radius:10px;background:#1A1A1A;color:#FAFAF8;cursor:pointer}</style></head><body><form method="post" action="${CONSOLE_PATH}"><p>Waldo console</p><input type="hidden" name="t" value="${token.replace(/[^0-9a-f]/g, '')}"><button>Open console</button></form></body></html>`,
  { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } },
);

export const sessionCookie = (request: Request): string | null =>
  (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim().split('=')).find(([name]) => name === CONSOLE_COOKIE)?.[1] ?? null;

export const CONSOLE_ACTIONS = ['spot.confirm', 'spot.dismiss', 'spot.forget', 'node.forget', 'proactivity.set', 'card.today', 'card.pin', 'card.unpin', 'google.connect', 'google.disconnect', 'session.signout', 'session.signout.all', 'approval.approve', 'approval.skip', 'approval.undo', 'file.remove', 'telegram.link', 'telegram.unlink', 'timezone.set', 'invite.create', 'invite.revoke', 'invite.member', 'account.delete'] as const;
export type ConsoleAction = Readonly<{ action: (typeof CONSOLE_ACTIONS)[number]; id: string; value: string }>;

// The trace detail for a console action. The form id is free-form text (parseConsoleAction
// accepts any string, and several actions ignore the id entirely), so it must never reach the
// trace sinks: only an integer target id is content-free enough to log next to the enum action.
export const consoleActionTraceDetail = (action: string, id: string): string => {
  const numeric = Number(id);
  return id !== '' && Number.isInteger(numeric) ? `${action} ${numeric}` : action;
};

// Linked means a telegram subject is actually bound to this owner (set when presence routing
// delivers a message to this DO) and a console unlink has not tombstoned it. Reading the
// unlink flag alone inverts the truth for a fresh owner: an unset flag is not a link.
export const telegramLinked = (identity: Readonly<{ get: <T>(key: string) => T | undefined }>): boolean =>
  identity.get<string>('telegram_subject') !== undefined && identity.get<boolean>('telegram_unlinked') !== true;

export const parseConsoleAction = (form: FormData, csrf: string): ConsoleAction | null => {
  const action = CONSOLE_ACTIONS.find((name) => name === form.get('action'));
  if (!action || form.get('csrf') !== csrf) return null;
  const value = action === 'proactivity.set' ? ['quiet_start', 'quiet_end', 'volume'].map((key) => String(form.get(key) ?? '').trim()).join('|') : String(form.get('value') ?? '').trim();
  return { action, id: String(form.get('id') ?? ''), value };
};

export const NOTICES: Readonly<Record<string, string>> = {
  'spot.dismiss': 'Spot dismissed. Waldo will stop using it.',
  'proactivity.set': 'Saved. Waldo will reach out on your new settings.',
  'invite.create': 'Invite saved. Send the code to the intended person yourself; Waldo did not email anyone.',
  'invite.member': 'Invite saved. Send the code yourself; Waldo did not email anyone.',
  'invite.revoke': 'Invite revoked.',
  'telegram.unlink': 'Telegram unlinked. Waldo will not message it again until you link an account.',
  'timezone.set': 'Time zone saved. Cards and reminders follow it from now on.',
  'spot.confirm': 'Confirmed. It now counts as something you said.',
  'spot.forget': 'Removed from long-term memory and blocked from relearning. The current chat may still mention it until the conversation moves on.',
  'spot.forget.incomplete': 'Forget is incomplete: part of memory storage could not be updated, so the text may still be in that store. The trace log records which store failed; try again or ask in chat.',
  'node.forget.incomplete': 'The pattern was hidden and blocked from relearning, but retained conversation text could not be fully redacted. Supporting Spots remain. Ask Waldo in chat to inspect the incomplete removal; no dashboard retry target is available.',
  'node.forget': 'Pattern hidden from memory views and its name blocked from relearning. The spots behind it stay - forget those too to remove them. The current chat may still mention it until the conversation moves on.',
  'card.today': 'Card time set for today.',
  'card.pin': 'Card pinned. Waldo will use this time every day.',
  'card.unpin': 'Pin cleared. Waldo plans this card again.',
  'google.disconnect': 'Google disconnected. Waldo no longer reads your calendar or mail.',
  'google.connected': 'Google connected.',
  'google.connect.failed': 'Google connect could not start. Try again.',
  'file.remove': 'File removed from this list. It stays in your Telegram chat.',
  'file.unavailable': 'That file could not be fetched from Telegram.',
  invalid: 'That change could not be applied.',
};

export type ConsoleCard = Readonly<{ id: string; name: string; defaultTime: string; time: string | null; reason: string; sent: boolean; pin: string | null }>;

export type ConsoleView = Readonly<{
  release: string;
  timezone: string;
  now: string;
  sessionUntil: string;
  sessionCount: number;
  approvals: readonly ApprovalItem[];
  usage: readonly Readonly<{ model: string; calls: number; input: number; cached: number; output: number; usd: number }>[];
  csrf: string;
  notice: string | null;
  google: Readonly<{ accounts: readonly Readonly<{ id: string; email: string; error: string | null; calendar: boolean; mail: boolean; tasks: boolean }>[]; connectAvailable: boolean }>;
  telegram: Readonly<{ linked: boolean; unlinkAvailable: boolean }>;
  profile: ReturnType<typeof profile>;
  barriers: number;
  spots: readonly Claim[];
  retiredSpots: readonly Claim[];
  forgettingSpots: readonly Claim[];
  holds: readonly Readonly<{ id: number; kind: string; reason: string; created_at: string }>[];
  nodes: readonly ConstellationNode[];
  edges: readonly ConstellationEdge[];
  cards: readonly ConsoleCard[];
  ledger: string;
  proactivity: Proactivity;
  files: readonly StoredFile[];
  steps: readonly E2EStep[];
  trace: readonly TraceRow[];
  // A5b: recent background runs (delegate children, fires, beats) with their trace hops.
  runs: readonly Readonly<{ id: string; kind: string; status: string; summary: string | null; parent_id: string | null; started: string; ended: string | null }>[];
  // Keyset cursors for the activity lists: *_before is the next older page, *_applied
  // marks the page currently being viewed (null/absent = the latest page).
  page?: { trace_before: number | null; runs_before: number | null; trace_applied?: number | null; runs_applied?: number | null };
}>;

const esc = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const day = (iso: string) => iso.slice(0, 10);
const empty = (text: string) => `<p class="empty">${esc(text)}</p>`;

const form = (csrf: string, action: string, label: string, fields: Readonly<Record<string, string>> = {}, opts: Readonly<{ tone?: 'quiet' | 'danger' | 'primary'; confirm?: string; extra?: string }> = {}) =>
  `<form method="post" action="${CONSOLE_ACTION_PATH}"${opts.confirm ? ` onsubmit="return confirm('${esc(opts.confirm)}')"` : ''}><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="${action}">${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`).join('')}${opts.extra ?? ''}<button class="btn ${opts.tone ?? 'quiet'}">${esc(label)}</button></form>`;

// Semantic status-chip taxonomy: a closed set of honest states, each derived from real view
// data. good = settled positive state (Done, Sent, Connected; ontology Energized/Steady zones,
// Protected window, Improving slope). neutral = informational label (kinds, sources, Holding/
// Mixed slope). muted = not built, dismissed, stale. danger = wrong, needs action (Removal
// incomplete; ontology Depleted zone). provisional = unconfirmed or untrusted-derived (inferred
// spots, shared-content origin; ontology Drooping zone).
type ChipState = 'good' | 'neutral' | 'muted' | 'danger' | 'provisional';
const chip = (text: string, state: ChipState = 'neutral') => `<span class="chip${state === 'neutral' ? '' : ` ${state}`}">${esc(text)}</span>`;
const status = (on: boolean, text: string) => `<span class="status ${on ? 'on' : 'off'}"><i></i>${esc(text)}</span>`;
const meter = (value: number) => `<span class="meter"><span style="width:${Math.round(Math.max(0, Math.min(1, value)) * 100)}%"></span></span><span class="num">${value.toFixed(2)}</span>`;

const connectors = (view: ConsoleView) => {
  const { google, telegram, csrf } = view;
  const telegramAction = form(csrf, 'telegram.link', 'Link a Telegram account', {}, {})
    + (telegram.linked && telegram.unlinkAvailable ? form(csrf, 'telegram.unlink', 'Unlink', {}, { tone: 'danger', confirm: 'Unlink Telegram? Waldo stops messaging it. Sign in here with your email to link again.' }) : '');
  const row = (name: string, detail: string, state: string, action: string) =>
    `<div class="row conn"><div><div class="name">${esc(name)}</div><div class="sub">${detail}</div></div><div class="state">${state}</div><div class="act">${action}</div></div>`;
  return [
    ...google.accounts.map((account) => {
      const disconnect = form(csrf, 'google.disconnect', 'Disconnect', { id: account.id }, { tone: 'danger', confirm: `Disconnect ${account.email}? Waldo loses this Google access.` });
      const action = account.error && google.connectAvailable ? form(csrf, 'google.connect', 'Reconnect', { value: 'calendar' }, { tone: 'primary' }) + disconnect : disconnect;
      const granted = [account.calendar ? 'Calendar' : '', account.mail ? 'Gmail' : '', account.tasks ? 'Tasks' : ''].filter(Boolean).join(', ');
      const detail = account.error ? `Waldo could not refresh access (${esc(account.error)}). Reconnect and pick <b>${esc(account.email)}</b> to fix it.`
        : `Google access granted${granted ? ` for ${granted}` : ''}. This does not confirm that live reads work; check a real request in chat. Mail is only sent with your approval.`;
      return row(`Google: ${account.email}`, detail, status(!account.error, account.error ? 'Needs reconnect' : 'Access granted'), action);
    }),
    row(google.accounts.length ? 'Another Google account' : 'Google Calendar, Gmail and Tasks', google.accounts.length ? 'Connect a second account, such as work and personal. Google asks which one.' : 'Google asks for Calendar, Gmail and Tasks access together. A connected account is not proof that any tool works yet.',
      google.accounts.length ? '' : status(false, 'Not connected'),
      google.connectAvailable ? form(csrf, 'google.connect', google.accounts.length ? 'Add account' : 'Connect Google', { value: 'calendar' }, { tone: google.accounts.length ? 'quiet' : 'primary' }) : '<span class="note">OAuth app keys are not set on this server yet</span>'),
    row('Telegram', 'Your owner DM. Chat, cards and reminders arrive here, and it is how you sign in to this console.', status(telegram.linked, telegram.linked ? 'Connected' : 'Unlinked'), telegramAction),
    row('Console session', `Signed in until ${esc(view.sessionUntil)} on ${view.sessionCount} ${view.sessionCount === 1 ? 'browser' : 'browsers'}. Send /console on Telegram for a fresh link.`, status(true, 'Active'),
      form(csrf, 'session.signout', 'Sign out') + (view.sessionCount > 1 ? form(csrf, 'session.signout.all', 'Sign out everywhere', {}, { tone: 'danger', confirm: 'Sign out of every browser?' }) : '')),
    row('WhatsApp', 'The channel route exists, but this page cannot verify a linked WhatsApp number or live delivery. Ask Waldo in chat before relying on it.', chip('Status unknown here', 'provisional'), ''),
    row('Phone number and OTP sign-in', 'This console currently offers invite-gated email OTP and Telegram one-time links, not phone OTP sign-in.', chip('Not available', 'muted'), ''),
    row('Health data', 'Apple Health / Apple Watch first, then Health Connect, Samsung and WHOOP.', chip('Not built yet', 'muted'), ''),
  ].join('');
};

// Service access is grant state, not a live capability test. Keep the same state in
// the HTML dashboard and the session-protected JSON view for the future app client.
const serviceStatus = (view: ConsoleView) => {
  const healthy = view.google.accounts.filter((account) => !account.error);
  const services = [
    ['Calendar', 'calendar', 'Ask Waldo about an event to test a real read.'],
    ['Gmail', 'mail', 'Ask Waldo to find an email to test a real read. Drafts are not sends.'],
    ['Tasks', 'tasks', 'Ask Waldo to list your open tasks to test a real read.'],
  ] as const;
  return `<div class="service-grid">${services.map(([name, key, hint]) => {
    const granted = healthy.filter((account) => account[key]);
    const label = granted.length ? 'Access granted · read unverified' : 'No active access';
    const accounts = granted.length ? `<div class="sub">${granted.map((account) => esc(account.email)).join(', ')}</div>` : '';
    const reconnect = view.google.accounts.some((account) => account.error && account[key]);
    return `<div class="service-card"><div class="service-name">${name}</div>${chip(label, granted.length ? 'provisional' : 'muted')}${reconnect ? ` ${chip('Reconnect needed', 'danger')}` : ''}${accounts}<p class="sub">${hint}</p></div>`;
  }).join('')}</div><p class="note">These are permission states, not proof that a tool succeeded. Recent activity below shows requests Waldo actually ran.</p>`;
};

// Sends need a bound sender account and exact destination in addition to words. The current
// proposal stores neither for every channel, so console APPROVAL stays chat-only for sends.
// Dismissal is the safe direction - it can only prevent a send, never cause one - so the
// console offers Not now for open send proposals. That also un-strands proposals whose
// Telegram approval card lost its inline keyboard (2026-09-28 staging receipt).
// Open email/message send proposals the console may only dismiss (approve stays in chat).
export const consoleMayDismiss = (item: ApprovalItem): boolean =>
  (item.state === 'open' || item.state === 'review_only') && !(consoleMayApprove(item) && item.review?.kind === item.kind) && (item.kind === 'email_send' || item.kind === 'message_send');
export const consoleMayApprove = (item: ApprovalItem | undefined): boolean => Boolean(item && item.state === 'open' && item.kind === 'calendar_change' && item.review?.kind === 'calendar_change');

const APPROVAL_LABELS: Readonly<Record<string, string>> = {
  calendar_change: 'Calendar adjustment', email_send: 'Email send', message_send: 'Message send',
  browser_submit: 'Browser action', mcp_call: 'MCP tool call',
};
const reviewDetails = (review: ApprovalReview): string => {
  if (review.kind === 'email_send') return `<div class="approval-review"><div>To: ${esc(review.to.join(', '))}</div>${review.cc.length ? `<div>CC: ${esc(review.cc.join(', '))}</div>` : ''}${review.bcc.length ? `<div>BCC: ${esc(review.bcc.join(', '))}</div>` : ''}<div>Subject: ${esc(review.subject)}</div><pre>${esc(review.body)}</pre></div>`;
  if (review.kind === 'message_send') return `<div class="approval-review"><div>Channel: ${esc(review.channel)}</div><pre>${esc(review.content)}</pre></div>`;
  return `<div class="approval-review"><div>Action: ${esc(review.action)}</div>${review.title ? `<div>Event: ${esc(review.title)}</div>` : ''}${review.event_id ? `<div>Event ID: ${esc(review.event_id)}</div>` : ''}${review.start ? `<div>Start: ${esc(review.start)}</div>` : ''}${review.end ? `<div>End: ${esc(review.end)}</div>` : ''}<div>Reason: ${esc(review.reason)}</div></div>`;
};
const approvals = (view: ConsoleView) => {
  if (view.approvals.length === 0) return empty('Nothing waiting on you. When Waldo proposes a change, it appears here and in your chat.');
  return view.approvals.map((item) => {
    const label = APPROVAL_LABELS[item.kind] ?? 'Proposed action';
    const safeReview = item.review?.kind === item.kind ? item.review : null;
    const canApprove = consoleMayApprove(item) && safeReview !== null;
    // Open send proposals are dismissible here: skipping changes nothing external, it only
    // closes the loop. Approving a send stays in chat with the exact words on the card.
    const dismissible = consoleMayDismiss(item);
    const actions = canApprove
      ? form(view.csrf, 'approval.approve', 'Do it', { id: item.id }, { tone: 'primary' }) + form(view.csrf, 'approval.skip', 'Not now', { id: item.id })
      : item.state === 'open' || item.state === 'review_only'
        ? dismissible ? form(view.csrf, 'approval.skip', 'Not now', { id: item.id }) : ''
        : item.undoable ? form(view.csrf, 'approval.undo', 'Undo', { id: item.id }, { tone: 'danger', confirm: 'Undo this calendar change?' }) : '';
    const review = safeReview ? reviewDetails(safeReview) : '';
    const holdReason = item.state === 'review_only' ? '<div class="sub">The full email did not fit in the chat card, so no Send it button was offered. Nothing has been sent. Ask for a shorter version or a draft to review.</div>' : item.state === 'unconfirmed' ? '<div class="sub">Review card delivery was not confirmed. This email cannot be approved here or in chat; nothing has been sent. Check chat before making a fresh request.</div>' : item.state !== 'open' || canApprove ? '' : item.kind === 'email_send' || item.kind === 'message_send'
      ? '<div class="sub">Review the exact sender, recipient and words in your chat - approving this send happens there. Not now dismisses it, here or in chat.</div>'
      : '<div class="sub">Full action details are not available here. This console cannot approve or dismiss it. Ask Waldo to show the proposal in full before deciding.</div>';
    const changeHint = (item.state === 'open' || item.state === 'review_only') && ['calendar_change', 'email_send', 'message_send'].includes(item.kind)
      ? '<div class="sub">Want to change it? Ask Waldo to prepare a new proposal before approving.</div>' : '';
    return `<div class="row approval-row"><div class="main"><div class="sub">${chip(label)}</div><div class="line">${esc(item.summary)}</div>${review}${holdReason}${changeHint}</div>${chip(item.state === 'review_only' ? 'Too long to approve' : item.state === 'unconfirmed' ? 'Card unconfirmed' : item.state === 'open' ? 'Waiting on you' : 'Done', item.state === 'done' ? 'good' : 'neutral')}<div class="act">${actions}</div></div>`;
  }).join('');
};

const usage = (view: ConsoleView) => {
  if (view.usage.length === 0) return empty('No model calls recorded yet. Usage appears here after Waldo thinks.');
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
  const rows = view.usage.map((row) => `<div class="row"><div class="main"><div class="line">${esc(row.model)}</div><div class="sub">${row.calls} calls, ${k(row.input)} in (${row.input > 0 ? Math.round((100 * row.cached) / row.input) : 0}% cached), ${k(row.output)} out</div></div><div class="state">$${row.usd.toFixed(4)}</div><div class="act"></div></div>`).join('');
  const total = view.usage.reduce((sum, row) => sum + row.usd, 0);
  return rows + `<div class="row"><div class="main"><div class="line">Total</div></div><div class="state">$${total.toFixed(4)}</div><div class="act"></div></div>`;
};

const checklist = (view: ConsoleView) => {
  const item = (done: boolean, label: string, hint: string) =>
    `<div class="row conn"><div><div class="name">${esc(label)}</div><div class="sub">${hint}</div></div><div class="state">${status(done, done ? 'Done' : 'To do')}</div><div class="act"></div></div>`;
  const connected = view.google.accounts.some((account) => !account.error);
  return [
    item(view.telegram.linked, 'Link Telegram', 'Send /console to Waldo on Telegram so cards, reminders and sign-in links reach you.'),
    item(connected, 'Connect Google', 'Calendar, Gmail and Tasks permissions are requested together. A successful connection does not prove a live read; try a real Calendar and Gmail request in chat.'),
    item(view.proactivity.quiet_start !== null, 'Set quiet hours', 'Tell Waldo when not to message you, in Your day below.'),
  ].join('');
};

const SOURCE_LABEL: Readonly<Record<string, string>> = { stated: 'You said this', confirmed: 'You confirmed this', inferred: 'Waldo\'s inference' };

// A source pointer is an audit hint, never proof that the note is true. Only the
// owner-DO source id may become a local episode search link; never emit a guessed
// provider or cross-origin URL from claim data.
const spotProvenance = (spot: Claim): string => {
  const status = spot.verification_status === 'owner-grounded' ? chip('Owner-grounded', 'good')
    : chip('Provenance unverified', 'provisional');
  const source = spot.source_ref && /^owner, tg-[\w-]+$/.test(spot.source_ref)
    ? ` <span>Source ID: ${esc(spot.source_ref)}</span>` : '';
  const validity = spot.valid_to ? ` <span>Valid until ${esc(day(spot.valid_to))}</span>` : '';
  return `${status}${source}${validity}`;
};

const spots = (view: ConsoleView) => view.spots.length === 0 ? empty('No spots yet. Waldo adds them as it learns from your chats.')
  : `<div class="memory-guide">A spot is a claim Waldo holds. Its evidence note is not a link to the original message. Source IDs are audit hints, not proof of current truth. If one is wrong, dismiss it and tell Waldo the correction in chat. Forget removes it from memory; if that cannot finish, the spot stays here for retry.</div>${view.spots.map((spot) => `<div class="row spot"><div class="main"><div class="line">${esc(spot.text)}</div><div class="sub">${chip(spot.kind)} ${chip(SOURCE_LABEL[spot.source] ?? 'Source unverified', spot.source === 'inferred' || !SOURCE_LABEL[spot.source] ? 'provisional' : 'neutral')}${spot.origin === 'untrusted' ? ` ${chip('from shared content', 'provisional')}` : ''} ${spotProvenance(spot)} <span>Seen ${spot.seen_count}×, last ${esc(day(spot.last_seen_at))}</span></div><div class="evidence">Evidence note: ${esc(spot.evidence)}</div></div><div class="act">${spot.source === 'inferred' ? form(view.csrf, 'spot.confirm', 'That\'s right', { id: String(spot.id) }) : ''}${form(view.csrf, 'spot.dismiss', 'Dismiss', { id: String(spot.id) })}${form(view.csrf, 'spot.forget', 'Forget', { id: String(spot.id) }, { tone: 'danger', confirm: 'Forget this spot for good?' })}</div></div>`).join('')}`;

const constellation = (view: ConsoleView) => {
  if (view.nodes.length === 0) return empty('No constellation yet. Each night Waldo turns repeated spots into lasting patterns.');
  const label = new Map(view.nodes.map((node) => [node.id, node.label]));
  const nodes = view.nodes.map((node) => `<div class="row node"><div class="main"><div class="line"><b>${esc(node.label)}</b> ${chip(node.domain)} ${chip('Tentative association', 'provisional')}${node.status === 'stale' ? ` ${chip('stale', 'muted')}` : ''}</div><div class="sub">${esc(node.summary)} · last recorded ${esc(day(node.last_confirmed))} · supporting spots ${esc(node.supporting_spots)}</div></div><div class="strength">${meter(node.strength)}</div><div class="act">${form(view.csrf, 'node.forget', 'Forget', { id: String(node.id) }, { tone: 'danger', confirm: 'Forget this pattern and its links?' })}</div></div>`).join('');
  const edges = view.edges.length === 0 ? '' : `<h3>Links</h3>${view.edges.map((edge) => `<div class="row edge"><div class="main"><b>${esc(label.get(edge.from_id) ?? `#${edge.from_id}`)}</b> <span class="rel">${esc(edge.relation)}</span> <b>${esc(label.get(edge.to_id) ?? `#${edge.to_id}`)}</b><div class="sub">Tentative link · ${edge.evidence_count} supporting observations</div></div><div class="strength">${meter(edge.strength)}</div></div>`).join('')}`;
  return nodes + edges;
};

// Holds never store text (the admission gate refuses before write), so this list shows
// kind + reason + day only - the owner sees the gate working without the refused words
// ever entering memory or this page.
const held = (view: ConsoleView) => view.holds.length === 0 ? '' : `<details><summary>Held at the gate (${view.holds.length})</summary><div class="sub">Waldo declined to remember these - the words were never stored, only what kind of thing it was and why.</div>${view.holds.map((hold) => `<div class="row"><div class="main"><div class="line">${chip(hold.kind)} ${chip(hold.reason.replace(/-/g, ' '), 'muted')}</div></div><div class="sub">${esc(day(hold.created_at))}</div></div>`).join('')}</details>`;

const retired = (view: ConsoleView) => view.retiredSpots.length === 0 ? '' : `<details><summary>Dismissed and promoted spots (${view.retiredSpots.length})</summary>${view.retiredSpots.map((spot) => `<div class="row"><div class="main"><div class="line">${esc(spot.text)}</div></div>${chip(spot.status === 'promoted' ? 'In constellation' : 'Dismissed', spot.status === 'promoted' ? 'good' : 'muted')}</div>`).join('')}</details>`;

// A claim stuck mid-scrub (status 'purging') must stay visible with a working retry path -
// the 'spot.forget.incomplete' notice tells the owner to try again, so the row and its Forget
// action cannot just vanish. act() already selects purging rows for spot.forget.
const forgetting = (view: ConsoleView) => view.forgettingSpots.length === 0 ? '' : `<div class="forgetting"><h3>Forget in progress (${view.forgettingSpots.length})</h3><div class="sub">These removals could not finish: part of memory storage still holds the text. Retry completes the removal.</div>${view.forgettingSpots.map((spot) => `<div class="row spot"><div class="main"><div class="line">${esc(spot.text)}</div></div>${chip('Removal incomplete', 'danger')}<div class="act">${form(view.csrf, 'spot.forget', 'Retry forget', { id: String(spot.id) }, { tone: 'danger', confirm: 'Retry forgetting this spot?' })}</div></div>`).join('')}</div>`;

const cards = (view: ConsoleView) => [...view.cards].sort((a, b) => (a.time ?? a.defaultTime).localeCompare(b.time ?? b.defaultTime)).map((card) => {
  const when = card.time ?? 'Skipped today';
  const controls = card.sent ? '' : `<form class="card-edit" method="post" action="${CONSOLE_ACTION_PATH}"><input type="hidden" name="csrf" value="${view.csrf}"><input type="hidden" name="id" value="${esc(card.id)}"><input type="time" name="value" value="${esc(card.time ?? card.defaultTime)}" required><button class="btn quiet" name="action" value="card.today">Set for today</button><button class="btn quiet" name="action" value="card.pin">Always at this time</button></form>`;
  return `<div class="row card"><div class="time">${esc(when)}</div><div class="main"><div class="line"><b>${esc(card.name)}</b> ${card.sent ? chip('Sent', 'good') : chip('Upcoming')} ${card.pin ? chip(`Pinned ${card.pin}`, 'good') : ''}</div><div class="sub">${esc(card.reason)}</div>${controls}${card.pin ? form(view.csrf, 'card.unpin', 'Clear pin', { id: card.id }) : ''}</div></div>`;
}).join('');

const VOLUMES: readonly (readonly [string, string])[] = [['low', 'Low: only the three day cards'], ['normal', 'Normal: plus updates that change your day'], ['high', 'High: plus smaller useful updates']];

const timezone = (view: ConsoleView) => `<form class="card-edit" method="post" action="${CONSOLE_ACTION_PATH}"><input type="hidden" name="csrf" value="${view.csrf}"><input type="hidden" name="action" value="timezone.set"><label>Time zone <input name="value" id="tz" value="${esc(view.timezone)}" autocomplete="off"></label><button class="btn quiet" type="button" onclick="document.getElementById('tz').value=Intl.DateTimeFormat().resolvedOptions().timeZone">Use this device</button><button class="btn quiet">Save</button></form><div class="sub">Waldo plans your day and fires reminders in this time zone. Change it when you travel.</div>`;

const proactivity = (view: ConsoleView) => `<form class="card-edit" method="post" action="${CONSOLE_ACTION_PATH}"><input type="hidden" name="csrf" value="${view.csrf}"><input type="hidden" name="action" value="proactivity.set"><label>Quiet from <input type="time" name="quiet_start" value="${esc(view.proactivity.quiet_start ?? '')}"></label><label>until <input type="time" name="quiet_end" value="${esc(view.proactivity.quiet_end ?? '')}"></label><select name="volume">${VOLUMES.map(([value, label]) => `<option value="${value}"${view.proactivity.volume === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select><button class="btn quiet">Save</button></form><div class="sub">During quiet hours Waldo holds cards, updates and event briefs. Reminders you set still fire. Leave both times empty for no quiet hours.</div>`;

const size = (bytes: number | null) => bytes === null ? '' : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const KIND_LABEL: Readonly<Record<string, string>> = { photo: 'Photo', document: 'Document', voice: 'Voice note', audio: 'Audio' };

const files = (view: ConsoleView) => {
  const list = view.files.length === 0 ? empty('No files yet. Anything you send Waldo on Telegram shows up here.')
    : view.files.map((file) => `<div class="row file"><div class="main"><div class="line">${esc(file.name)}</div><div class="sub">${chip(KIND_LABEL[file.kind] ?? file.kind)} <span>${esc([size(file.size), file.caption ? `"${file.caption}"` : ''].filter(Boolean).join(' · '))}</span></div></div><div class="act"><a class="btn quiet" href="${CONSOLE_FILE_PATH}?id=${file.id}">Open</a>${form(view.csrf, 'file.remove', 'Remove', { id: String(file.id) }, { tone: 'danger', confirm: 'Remove this file from the list?' })}</div></div>`).join('');
  return list + `<div class="row conn"><div><div class="name">Share with someone</div><div class="sub">Send a file or a summary to a person or their Waldo, with your approval each time.</div></div><div class="state">${chip('Not built yet', 'muted')}</div><div class="act"></div></div>`;
};

const memory = (view: ConsoleView) => {
  const panels = view.profile.length === 0 ? empty('Nothing yet. Your profile fills in from what you tell Waldo.')
    : `<div class="grid2">${view.profile.map((section) => `<div class="panel"><div class="panel-title">${esc(section.title)}</div><pre>${esc(section.lines.join('\n'))}</pre></div>`).join('')}</div>`;
  return panels + (view.barriers ? `<div class="sub">${view.barriers} do-not-relearn ${view.barriers === 1 ? 'note' : 'notes'} from things you asked Waldo to forget.</div>` : '');
};

const pageHref = (trace: number | null | undefined, runs: number | null | undefined) => {
  const params = [trace ? `trace_before=${trace}` : '', runs ? `runs_before=${runs}` : ''].filter(Boolean).join('&');
  return `${CONSOLE_PATH}/activity${params ? `?${params}` : ''}`;
};
const pageLinks = (older: string | null, latestHref: string | null) =>
  (latestHref ? `<a class="btn" href="${latestHref}">&larr; Latest</a> ` : '') + (older ?? '');

const activity = (view: ConsoleView) => {
  const seen = view.steps.filter((step) => step.state === 'ok').length;
  const traceOlder = view.page?.trace_before ? `<a class="btn" href="${pageHref(view.page.trace_before, view.page.runs_applied ?? null)}">Older activity &rarr;</a>` : null;
  const runsOlder = view.page?.runs_before ? `<a class="btn" href="${pageHref(view.page.trace_applied ?? null, view.page.runs_before)}">Older tasks &rarr;</a>` : null;
  const steps = view.steps.map((step) => `<div class="row step"><span class="mark ${step.state}">${step.state === 'ok' ? '✓' : step.state === 'failed' ? '!' : ''}</span><div class="main"><div class="line">${esc(step.step)}</div>${step.at ? `<div class="sub">${step.state === 'failed' ? 'Failed' : 'Last ran'} ${esc(step.at)}${step.note ? ` · ${esc(step.note)}` : ''}</div>` : '<div class="sub">Not seen yet</div>'}</div></div>`).join('');
  const runs = view.runs.length === 0 ? empty('No background tasks yet.') : `<div class="trace">${view.runs.map((run) => `<div class="t ${run.status === 'failed' ? 'bad' : ''}"><span>${esc(run.started)}</span><span>${esc(run.kind)}</span><span>${esc(run.status)}</span><span class="note">${esc(run.summary ?? (run.parent_id ? 'from ' + run.parent_id : ''))}</span></div>`).join('')}</div>`;
  const trace = view.trace.length === 0 ? empty('No activity recorded yet.') : `<div class="trace">${[...view.trace].reverse().map((row) => `<div class="t ${row.ok ? '' : 'bad'}"><span>${esc(row.time)}</span><span>${esc(row.hop)}</span><span>${row.ms} ms</span><span class="note">${esc(row.note || row.trace)}</span></div>`).join('')}</div>`;
  return `<div class="grid2 wide-left"><div><h3>End-to-end checklist <span class="count">${seen} of ${view.steps.length}</span></h3>${steps}</div><div><h3>Recent activity</h3>${trace}<p>${pageLinks(traceOlder, view.page?.trace_applied ? pageHref(null, view.page.runs_applied ?? null) : null)}</p></div></div><h3>Background tasks</h3>${runs}<p>${pageLinks(runsOlder, view.page?.runs_applied ? pageHref(view.page.trace_applied ?? null, null) : null)}</p><h3>Ledger and reminders</h3><pre>${esc(view.ledger)}</pre>`;
};

// Overview uses only persisted owner state. It is a summary, not a generated Brief:
// no claim about a card's contents or an effect can be inferred from its schedule.
const overview = (view: ConsoleView) => {
  const hour = Number(view.now.split(' ')[1]?.split(':')[0]);
  const greeting = Number.isFinite(hour) && hour < 12 ? 'Morning.' : Number.isFinite(hour) && hour < 18 ? 'Afternoon.' : 'Evening.';
  const waiting = view.approvals.filter((approval) => approval.state === 'open' || approval.state === 'review_only' || approval.state === 'unconfirmed');
  const latestRun = view.page?.runs_applied ? undefined : view.runs[0];
  const latestTrace = view.page?.trace_applied ? undefined : view.trace.at(-1);
  const lastMovement = latestRun
    ? `<div class="overview-event">${chip(latestRun.status, latestRun.status === 'failed' ? 'danger' : latestRun.status === 'completed' ? 'good' : 'neutral')} <span>${esc(latestRun.kind)} · ${esc(latestRun.started)}</span><p>${esc(latestRun.summary ?? 'No summary recorded.')}</p></div>`
    : latestTrace ? `<div class="overview-event">${chip(latestTrace.ok ? 'Ran' : 'Failed', latestTrace.ok ? 'good' : 'danger')} <span>${esc(latestTrace.hop)} · ${esc(latestTrace.time)}</span><p>${esc(latestTrace.note || 'No detail recorded.')}</p></div>`
      : empty('Nothing recorded yet. Activity appears when Waldo runs a task.');
  const currentTime = view.now.split(' ')[1] ?? '';
  const nextCard = [...view.cards].filter((card) => !card.sent && card.time !== null && card.time >= currentTime).sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''))[0];
  const brief = view.cards.find((card) => card.id === 'card:brief');
  const briefState = brief?.sent ? 'Sent today' : brief?.time === null ? 'Not scheduled today' : 'Not sent yet';
  const google = view.google.accounts.some((account) => !account.error);
  return `<div class="overview-top"><div><div class="eyebrow">Your Waldo · ${esc(view.now)} ${esc(view.timezone)}</div><h1>${greeting}<br><em>Here is where things stand.</em></h1><p>What needs you, what ran, and what comes next. No guesswork.</p></div><div class="overview-status">${chip(waiting.length ? `${waiting.length} waiting on you` : 'Nothing waiting on you', waiting.length ? 'provisional' : 'good')}<span>${google ? 'Google access saved. Live reads still need a real check.' : 'Google is not connected.'}</span></div></div>
<div class="overview-grid"><div class="overview-feature"><div class="eyebrow">The Brief · ${esc(briefState)}</div><h3>${brief?.sent ? 'The Brief is marked sent.' : 'No Brief to read here yet.'}</h3><p>${brief?.sent ? 'Waldo recorded a send. This does not confirm delivery or show the message text; open your chat to check it.' : 'Waldo has not recorded a sent Brief for today. This page will not make one up.'}</p><a href="${CONSOLE_PATH}/day" class="text-link">See the day cards →</a></div>
<div class="overview-side"><div class="eyebrow">The Handoff</div><h3>${waiting.length ? `${waiting.length} ${waiting.length === 1 ? 'decision' : 'decisions'} waiting.` : 'Nothing needs your approval.'}</h3><p>${waiting.length ? esc(waiting[0]!.summary) : 'If Waldo proposes a change, review its exact details before anything happens.'}</p><a href="${CONSOLE_PATH}/waiting" class="text-link">${waiting.length ? 'Review the proposal' : 'See approvals'} →</a></div>
<div class="overview-side"><div class="eyebrow">Next on the day</div><h3>${nextCard ? `${esc(nextCard.time!)} · ${esc(nextCard.name)}` : 'No more cards scheduled ahead.'}</h3><p>${nextCard ? esc(nextCard.reason) : 'There is no future card recorded in today’s plan.'}</p><a href="${CONSOLE_PATH}/day" class="text-link">See the plan →</a></div></div>
<div class="overview-foot"><div><div class="eyebrow">The Patrol · latest recorded movement</div>${lastMovement}</div><a href="${CONSOLE_PATH}/activity" class="text-link">All activity →</a></div>`;
};

const FONT_SHEET = 'https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Inter:wght@400;500;600&display=swap';
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="${FONT_SHEET}">`;

const STYLE = `
.overview-top{display:flex;justify-content:space-between;gap:32px;align-items:flex-end;padding:24px 0 28px;border-bottom:1px solid var(--rule)}
.overview-top h1{font:400 clamp(38px,5vw,68px)/1.05 'Instrument Serif',Georgia,serif;letter-spacing:-.035em;margin:14px 0 16px}.overview-top h1 em{font:400 1em 'Instrument Serif',Georgia,serif;color:var(--teal-ink)}
.overview-top p,.overview-feature p,.overview-side p{color:var(--ink2);margin:0 0 16px}.overview-status{display:flex;flex-direction:column;gap:10px;max-width:200px;font-size:12px;color:var(--ink2);text-align:right;align-items:flex-end}
.eyebrow{font:600 11px/1.3 Inter,system-ui,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:var(--teal-ink)}
.overview-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(245px,1fr);grid-template-rows:auto auto;gap:14px;margin-top:18px}.overview-feature,.overview-side{border:1px solid var(--rule);border-radius:16px;padding:22px;background:#fff}.overview-feature{grid-row:1/3;min-height:288px;background:var(--sand);display:flex;flex-direction:column;align-items:flex-start}.overview-feature h3,.overview-side h3{font:400 30px/1.12 'Instrument Serif',Georgia,serif;letter-spacing:-.02em;margin:20px 0 12px}.overview-feature h3{font-size:40px}.overview-feature .text-link{margin-top:auto}.overview-side h3{font-size:24px;margin:12px 0 8px}
.text-link{font:600 14px/24px Inter,system-ui,sans-serif;color:var(--teal-ink);text-decoration:none}.text-link:hover{text-decoration:underline}.overview-foot{margin-top:14px;border-top:1px solid var(--rule);padding:18px 0;display:flex;align-items:center;justify-content:space-between;gap:20px}.overview-event{margin-top:8px}.overview-event span{color:var(--ink2)}.overview-event p{margin:4px 0 0}.overview-foot>.text-link{white-space:nowrap}
@media(max-width:740px){.overview-top{display:block}.overview-status{max-width:none;text-align:left;align-items:flex-start;margin-top:18px}.overview-grid{display:block}.overview-feature,.overview-side{margin-top:12px;min-height:0}.overview-feature{min-height:230px}.overview-foot{align-items:flex-start;flex-direction:column}}
:root{--regular:400;--medium:500;--semibold:600;--bold:700;--ink:#251f21;--ink2:#585254;--ink4:#c0bebf;--rule:#eae9ea;--sand:#f4efec;--teal:#73a89a;--teal-ink:#3f7568;--red:#ed313e}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:400 14px/24px Inter,system-ui,sans-serif;letter-spacing:-.01em;-webkit-font-smoothing:antialiased}
.wrap{max-width:1040px;margin:0 auto;padding:24px}@media(min-width:760px){.wrap{padding:36px}}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand{font-family:'Instrument Serif',Georgia,serif;font-size:36px;line-height:40px;letter-spacing:-.025em}.brand small{font:400 14px Inter,sans-serif;color:var(--ink2);margin-left:8px;letter-spacing:0}
.env{color:var(--ink2);font-size:12px}
nav{position:sticky;top:0;background:rgba(255,255,255,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--rule);margin:20px -24px 0;padding:0 24px;display:flex;gap:4px;overflow-x:auto;z-index:2}
nav a{color:var(--ink2);text-decoration:none;padding:12px 10px;white-space:nowrap;border-bottom:2px solid transparent;transition:color .15s ease-out,border-color .15s ease-out}nav a:hover{color:var(--ink);border-color:var(--teal)}
nav a[aria-current="page"]{color:var(--ink);border-color:var(--teal)}
.notice{margin-top:20px;background:var(--sand);border-radius:8px;padding:10px 14px}
.service-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:14px 0}.service-card{border:1px solid var(--rule);border-radius:12px;padding:16px;min-width:0}.service-name{font-family:'Instrument Serif',Georgia,serif;font-size:22px;margin-bottom:8px}.service-card p{margin:12px 0 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-top:24px}
.stat{border:1px solid var(--rule);border-radius:16px;padding:18px 16px;transition:border-color .15s ease-out}.stat:hover{border-color:var(--ink4)}.stat b{display:block;font-family:'Instrument Serif',Georgia,serif;font-size:34px;line-height:40px;letter-spacing:-.02em}.stat span{display:block;margin-top:2px;color:var(--ink2);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
section{margin-top:44px;scroll-margin-top:60px}
h2{font-family:'Instrument Serif',Georgia,serif;font-size:26px;line-height:32px;letter-spacing:-.025em;margin:0 0 4px}
.intro{color:var(--ink2);margin:0 0 12px;max-width:640px}
h3{font-size:14px;margin:24px 0 4px}.count{color:var(--ink2);margin-left:6px}
.approval-row{align-items:flex-start}.approval-review{margin:10px 0;padding:12px;border:1px solid var(--rule);border-radius:8px;overflow-wrap:anywhere}.approval-review pre{max-height:320px;overflow:auto;margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere}
.row{display:flex;align-items:center;gap:16px;padding:14px 0;border-bottom:1px solid var(--rule)}.row .main{flex:1;min-width:0}
.line{}.sub{color:var(--ink2);font-size:13px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.evidence{color:var(--ink2);font-size:13px;font-style:italic}.memory-guide{border-left:2px solid var(--teal);padding:8px 14px;color:var(--ink2);background:var(--sand);border-radius:0 8px 8px 0}
.conn>div:first-child{flex:1}.conn .name{}.state{width:140px}.act{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.chip{display:inline-block;font-size:12px;line-height:18px;padding:0 8px;border:1px solid transparent;border-radius:999px;background:var(--sand);color:var(--ink2)}.chip.good{background:#e6f0ed;color:var(--teal-ink)}.chip.muted{background:#f5f5f5;color:#8b8587}.chip.danger{background:#fdeaeb;color:var(--red)}.chip.provisional{background:#fff;border-style:dashed;border-color:var(--ink4)}
.status{display:inline-flex;align-items:center;gap:6px}.status i{width:8px;height:8px;border-radius:50%;background:var(--ink4)}.status.on{color:var(--teal-ink)}.status.on i{background:var(--teal)}.status.off{color:var(--ink2)}
.btn{font:500 13px Inter,sans-serif;border:1px solid var(--rule);background:#fff;color:var(--ink);border-radius:4px;padding:6px 12px;cursor:pointer;text-decoration:none;display:inline-block;line-height:18px;transition:border-color .15s ease-out,background-color .15s ease-out,color .15s ease-out,transform .06s ease-out}.btn:hover{border-color:var(--ink4)}.btn:active{transform:translateY(1px)}
.btn.primary{background:var(--ink);color:#fff;border-color:var(--ink)}.btn.danger{color:var(--red)}form{display:inline-flex;gap:6px;align-items:center;margin:0}
.note{color:var(--ink2);font-size:12px}
.meter{display:inline-block;width:90px;height:6px;border-radius:3px;background:var(--rule);vertical-align:middle;overflow:hidden}.meter span{display:block;height:100%;background:var(--teal)}.num{margin-left:8px;font-size:13px}
.rel{color:var(--teal-ink);margin:0 4px}
.card .time{font-family:'Instrument Serif',Georgia,serif;font-size:26px;width:92px;align-self:flex-start}.card-edit{display:flex;gap:8px;flex-wrap:wrap;margin:10px 8px 0 0}
input[type=time]{font:inherit;border:1px solid var(--rule);border-radius:4px;padding:3px 6px}
.grid2{display:grid;gap:16px 32px}@media(min-width:760px){.grid2{grid-template-columns:1fr 1fr}.grid2.wide-left{grid-template-columns:1fr 1.2fr}}
.panel{border:1px solid var(--rule);border-radius:8px;padding:14px 16px}.panel-title{margin-bottom:6px}
pre{white-space:pre-wrap;font:13px/21px ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;background:#faf9f8;border-radius:8px;padding:10px 12px}.panel pre{background:none;padding:0}
.empty{color:var(--ink2);margin:8px 0}
.mark{width:22px;height:22px;border-radius:50%;border:1.5px solid var(--ink4);display:inline-flex;align-items:center;justify-content:center;font-size:12px;flex:none}.mark.ok{background:var(--teal);border-color:var(--teal);color:#fff}.mark.failed{border-color:var(--red);color:var(--red)}
.trace{font:12px/20px ui-monospace,Menlo,monospace}.t{display:grid;grid-template-columns:46px 120px 64px 1fr;gap:8px;padding:5px 0;border-bottom:1px solid var(--rule)}.t .note{color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.t.bad span:nth-child(2){color:var(--red)}
details{margin-top:16px}summary{cursor:pointer;color:var(--ink2);transition:color .15s ease-out}summary:hover{color:var(--ink)}
footer{margin:48px 0 12px;color:var(--ink2);font-size:12px}
@media(max-width:640px){.row{flex-wrap:wrap}.state{width:auto}.act{justify-content:flex-start;width:100%}.card .time{width:auto}.t{grid-template-columns:42px 1fr 56px}.t .note{grid-column:1/-1}}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
a:focus-visible,.btn:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
nav a,.line,summary{font-weight:var(--medium)}
.stat b,h2,.count{font-weight:var(--regular)}
h3,.conn .name,.chip.good,.status,.num,.rel,.panel-title,.t.bad span:nth-child(2){font-weight:var(--semibold)}
.mark{font-weight:var(--bold)}
`;

// Console pages: the console is one page per concern. The slug is the path segment under
// /console ('' = the overview at /console itself); action/google/file/runs/admin paths are
// matched before pages in the handler and are not pages.
export const CONSOLE_PAGES = [
  { slug: '', title: 'Overview' },
  { slug: 'waiting', title: 'Waiting' },
  { slug: 'setup', title: 'Setup' },
  { slug: 'connections', title: 'Connections' },
  { slug: 'spots', title: 'Spots' },
  { slug: 'constellation', title: 'Constellation' },
  { slug: 'day', title: 'Your day' },
  { slug: 'memory', title: 'Memory' },
  { slug: 'files', title: 'Files' },
  { slug: 'usage', title: 'Usage' },
  { slug: 'activity', title: 'Activity' },
  { slug: 'account', title: 'Account' },
] as const;

export const renderConsole = (view: ConsoleView, page: string = '', banner = ''): string => {
  const sentToday = view.cards.filter((card) => card.sent).length;
  const seen = view.steps.filter((step) => step.state === 'ok').length;
  const section = (id: string, title: string, intro: string, body: string) => `<section id="${id}"><h2>${esc(title)}</h2><p class="intro">${esc(intro)}</p>${body}</section>`;
  const pages: Readonly<Record<string, string>> = {
    '': `<section id="overview" aria-label="Overview">${overview(view)}</section>
<div class="stats"><div class="stat"><b>${view.google.accounts.length ? String(view.google.accounts.length) : 'Off'}</b><span>Google connection</span></div><div class="stat"><b>${view.spots.length}</b><span>Active spots</span></div><div class="stat"><b>${view.nodes.length}</b><span>Constellation patterns</span></div><div class="stat"><b>${sentToday}/${view.cards.length}</b><span>Cards sent today</span></div><div class="stat"><b>${seen}/${view.steps.length}</b><span>End-to-end steps seen</span></div></div>`,
    waiting: section('approvals', 'Waiting on you', 'Changes Waldo proposed. You can approve calendar changes here; email sends can only be approved on the full review card in chat.', approvals(view)),
    setup: section('checklist', 'Setup checklist', 'The few steps that make Waldo useful. Connection status shows access, not a passed tool test.', checklist(view)),
    connections: section('connections', 'Connections', 'What Waldo has permission to reach. To verify a tool, try a real request in chat and check Activity below.', serviceStatus(view) + connectors(view)),
    spots: section('spots', 'Spots', 'Small things Waldo has noticed about you. You can confirm, dismiss, or forget a spot here; corrections go through chat.', spots(view) + forgetting(view) + retired(view) + held(view)),
    constellation: section('constellation', 'Constellation', 'Lasting patterns built each night from repeated spots, and how they link. Strength is Waldo\'s uncalibrated estimate from 0 to 1, not a probability of truth.', constellation(view)),
    day: section('day', 'Your day', 'Waldo plans when each card arrives. Change a time for today, or pin it so Waldo always uses it.', cards(view) + '<h3>Time zone</h3>' + timezone(view) + '<h3>Quiet hours and volume</h3>' + proactivity(view)),
    memory: section('memory', 'Memory', 'What Waldo keeps about you. It updates after chats and each night.', memory(view)),
    files: section('files', 'Files', 'What you have sent Waldo on Telegram. Files stay stored with Telegram; this list keeps a reference so you can open them again.', files(view)),
    usage: section('usage', 'Usage and cost', 'Real per-model totals from Waldo\'s own trace log, most expensive first.', usage(view)),
    activity: section('activity', 'Activity', 'What ran, when, and whether it worked.', activity(view)),
    account: section('account', 'Account', 'Deleting your account erases your memory, connections, settings and files. This cannot be undone.', `<div class="row conn"><div><div class="name">Delete your Waldo account</div><div class="sub">Everything Waldo knows and every connection goes. You can sign up again later, but nothing is recovered.</div></div><div class="state"></div><div class="act">${form(view.csrf, 'account.delete', 'Delete account', {}, { tone: 'danger', confirm: 'Delete your Waldo account? Memory, connections and settings are erased and cannot be recovered.' })}</div></div>`),
  };
  const nav = CONSOLE_PAGES.map((item) => `<a href="${CONSOLE_PATH}${item.slug ? `/${item.slug}` : ''}"${item.slug === page ? ' aria-current="page"' : ''}>${item.title}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Waldo console</title>
${FONTS}<style>${STYLE}</style></head><body><div class="wrap">
${banner}<header><div class="brand">Waldo<small>Console</small></div><div class="env">Staging · ${esc(view.release)} · ${esc(view.now)} ${esc(view.timezone)}</div></header>
<nav>${nav}<a href="${CONSOLE_PATH}/invites">Invites</a></nav>
${view.notice ? `<div class="notice">${esc(view.notice)}</div>` : ''}
${pages[page] ?? pages['']}
<footer>Only you can open this page. Links come from your Telegram DM and expire after 10 minutes; a session lasts 12 hours.</footer>
</div></body></html>`;
};
