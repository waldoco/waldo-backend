import type { Claim, ConstellationEdge, ConstellationNode, profile } from '../memory/claims';
import type { Proactivity } from './loops';
import type { E2EStep, TraceRow } from './harness';
import type { StoredFile } from './files';

export const CONSOLE_PATH = '/console';
export const CONSOLE_ACTION_PATH = `${CONSOLE_PATH}/action`;
export const CONSOLE_GOOGLE_PATH = `${CONSOLE_PATH}/google`;
export const CONSOLE_FILE_PATH = `${CONSOLE_PATH}/file`;
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

export const CONSOLE_ACTIONS = ['spot.confirm', 'spot.dismiss', 'spot.forget', 'node.forget', 'proactivity.set', 'card.today', 'card.pin', 'card.unpin', 'google.connect', 'google.disconnect', 'session.signout', 'session.signout.all', 'approval.approve', 'approval.skip', 'approval.undo', 'approval.reconcile', 'approval.notsent', 'file.remove', 'telegram.link', 'telegram.unlink', 'timezone.set', 'invite.create', 'invite.revoke', 'account.delete'] as const;
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
  'invite.create': 'Invite saved. That address can now sign in.',
  'invite.revoke': 'Invite revoked.',
  'telegram.unlink': 'Telegram unlinked. Waldo will not message it again until you link an account.',
  'timezone.set': 'Time zone saved. Cards and reminders follow it from now on.',
  'spot.confirm': 'Confirmed. It now counts as something you said.',
  'spot.forget': 'Forgotten and deleted. Waldo keeps a short do-not-relearn note so it does not pick it up again.',
  'node.forget': 'Pattern forgotten, along with its links. Waldo keeps a short do-not-relearn note.',
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
  approvals: readonly Readonly<{ id: string; summary: string; state: 'open' | 'done' | 'unknown'; undoable: boolean }>[];
  usage: readonly Readonly<{ model: string; calls: number; input: number; cached: number; output: number; usd: number }>[];
  csrf: string;
  notice: string | null;
  google: Readonly<{ accounts: readonly Readonly<{ id: string; email: string; error: string | null; mail: boolean }>[]; connectAvailable: boolean }>;
  telegram: Readonly<{ linked: boolean; unlinkAvailable: boolean }>;
  profile: ReturnType<typeof profile>;
  barriers: number;
  spots: readonly Claim[];
  retiredSpots: readonly Claim[];
  nodes: readonly ConstellationNode[];
  edges: readonly ConstellationEdge[];
  cards: readonly ConsoleCard[];
  ledger: string;
  proactivity: Proactivity;
  files: readonly StoredFile[];
  steps: readonly E2EStep[];
  trace: readonly TraceRow[];
}>;

const esc = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const day = (iso: string) => iso.slice(0, 10);
const empty = (text: string) => `<p class="empty">${esc(text)}</p>`;

const form = (csrf: string, action: string, label: string, fields: Readonly<Record<string, string>> = {}, opts: Readonly<{ tone?: 'quiet' | 'danger' | 'primary'; confirm?: string; extra?: string }> = {}) =>
  `<form method="post" action="${CONSOLE_ACTION_PATH}"${opts.confirm ? ` onsubmit="return confirm('${esc(opts.confirm)}')"` : ''}><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="${action}">${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`).join('')}${opts.extra ?? ''}<button class="btn ${opts.tone ?? 'quiet'}">${esc(label)}</button></form>`;

const chip = (text: string, tone: 'teal' | 'plain' | 'muted' | 'red' = 'plain') => `<span class="chip ${tone}">${esc(text)}</span>`;
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
      const disconnect = form(csrf, 'google.disconnect', 'Disconnect', { id: account.id }, { tone: 'danger', confirm: `Disconnect ${account.email}? Waldo stops reading its calendar and mail.` });
      const action = account.error && google.connectAvailable ? form(csrf, 'google.connect', 'Reconnect', { value: 'calendar' }, { tone: 'primary' }) + disconnect
        : `${!account.mail && google.connectAvailable ? form(csrf, 'google.connect', 'Allow Gmail', { value: 'mail' }) : ''}${disconnect}`;
      const detail = account.error ? `Waldo could not refresh access (${esc(account.error)}). Reconnect and pick <b>${esc(account.email)}</b> to fix it.`
        : `Waldo reads this calendar${account.mail ? ' and mail, and sends mail only after you approve it' : '. Allow Gmail to let Waldo read mail and send what you approve'}.`;
      return row(`Google: ${account.email}`, detail, status(!account.error, account.error ? 'Needs reconnect' : 'Connected'), action);
    }),
    row(google.accounts.length ? 'Another Google account' : 'Google Calendar and Gmail', google.accounts.length ? 'Connect a second account, such as work and personal. Google asks which one.' : 'Lets Waldo read your calendar. Gmail is a separate step. Nothing is sent without your approval.',
      google.accounts.length ? '' : status(false, 'Not connected'),
      google.connectAvailable ? form(csrf, 'google.connect', google.accounts.length ? 'Add account' : 'Connect Google', { value: 'calendar' }, { tone: google.accounts.length ? 'quiet' : 'primary' }) : '<span class="note">OAuth app keys are not set on this server yet</span>'),
    row('Telegram', 'Your owner DM. Chat, cards and reminders arrive here, and it is how you sign in to this console.', status(telegram.linked, telegram.linked ? 'Connected' : 'Unlinked'), telegramAction),
    row('Console session', `Signed in until ${esc(view.sessionUntil)} on ${view.sessionCount} ${view.sessionCount === 1 ? 'browser' : 'browsers'}. Send /console on Telegram for a fresh link.`, status(true, 'Active'),
      form(csrf, 'session.signout', 'Sign out') + (view.sessionCount > 1 ? form(csrf, 'session.signout.all', 'Sign out everywhere', {}, { tone: 'danger', confirm: 'Sign out of every browser?' }) : '')),
    row('WhatsApp', 'Chat with Waldo on WhatsApp. Needs a Meta WhatsApp Business number and token.', chip('Not built yet', 'muted'), ''),
    row('Phone number and OTP sign-in', 'Sign in with your phone number and a one-time code instead of a Telegram link.', chip('Not built yet', 'muted'), ''),
    row('Health data', 'Apple Health / Apple Watch first, then Health Connect, Samsung and WHOOP.', chip('Not built yet', 'muted'), ''),
  ].join('');
};

const approvals = (view: ConsoleView) => {
  if (view.approvals.length === 0) return empty('Nothing waiting on you. When Waldo proposes a calendar change, it lands here and in Telegram.');
  return view.approvals.map((item) => {
    // An unreconciled send is NOT Done: render it explicitly with its recovery actions, or the
    // dashboard shows a false success receipt for an email whose delivery was never proven.
    if (item.state === 'unknown') {
      const guidance = 'Send unconfirmed - it may already be in Sent. Check Sent first so it never goes twice.';
      const recovery = form(view.csrf, 'approval.reconcile', 'Check Sent', { id: item.id }, { tone: 'primary' })
        + form(view.csrf, 'approval.notsent', 'I checked Sent - not there', { id: item.id }, { tone: 'danger', confirm: 'Only use this after checking your Sent folder yourself. This closes the send and lets Waldo propose a fresh email.' });
      return `<div class="row"><div class="main"><div class="line">${esc(item.summary)}</div><div class="sub">${guidance}</div></div>${chip('Send unconfirmed', 'red')}<div class="act">${recovery}</div></div>`;
    }
    const actions = item.state === 'open'
      ? form(view.csrf, 'approval.approve', 'Do it', { id: item.id }, { tone: 'primary' }) + form(view.csrf, 'approval.skip', 'Not now', { id: item.id })
      : item.undoable ? form(view.csrf, 'approval.undo', 'Undo', { id: item.id }, { tone: 'danger', confirm: 'Undo this change in your calendar?' }) : '';
    return `<div class="row"><div class="main"><div class="line">${esc(item.summary)}</div></div>${chip(item.state === 'open' ? 'Waiting on you' : 'Done', item.state === 'open' ? 'plain' : 'teal')}<div class="act">${actions}</div></div>`;
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
  const gmail = view.google.accounts.some((account) => account.mail);
  return [
    item(view.telegram.linked, 'Link Telegram', 'Send /console to Waldo on Telegram so cards, reminders and sign-in links reach you.'),
    item(view.google.accounts.length > 0, 'Connect Google', 'Lets Waldo read your calendar. Use the Connections section below.'),
    item(gmail, 'Allow Gmail', 'A separate Google step so Waldo can read mail and send only what you approve.'),
    item(view.proactivity.quiet_start !== null, 'Set quiet hours', 'Tell Waldo when not to message you, in Your day below.'),
  ].join('');
};

const SOURCE_LABEL: Readonly<Record<string, string>> = { stated: 'You said this', confirmed: 'You confirmed this', inferred: 'Waldo\'s inference' };

const spots = (view: ConsoleView) => view.spots.length === 0 ? empty('No spots yet. Waldo adds them as it learns from your chats.')
  : view.spots.map((spot) => `<div class="row spot"><div class="main"><div class="line">${esc(spot.text)}</div><div class="sub">${chip(spot.kind)} ${chip(SOURCE_LABEL[spot.source] ?? spot.source, spot.source === 'inferred' ? 'plain' : 'teal')} <span>Seen ${spot.seen_count}×, last ${esc(day(spot.last_seen_at))}</span></div><div class="evidence">Why: ${esc(spot.evidence)}</div></div><div class="act">${spot.source === 'inferred' ? form(view.csrf, 'spot.confirm', 'That\'s right', { id: String(spot.id) }) : ''}${form(view.csrf, 'spot.dismiss', 'Dismiss', { id: String(spot.id) })}${form(view.csrf, 'spot.forget', 'Forget', { id: String(spot.id) }, { tone: 'danger', confirm: 'Forget this spot for good?' })}</div></div>`).join('');

const constellation = (view: ConsoleView) => {
  if (view.nodes.length === 0) return empty('No constellation yet. Each night Waldo turns repeated spots into lasting patterns.');
  const label = new Map(view.nodes.map((node) => [node.id, node.label]));
  const nodes = view.nodes.map((node) => `<div class="row node"><div class="main"><div class="line"><b>${esc(node.label)}</b> ${chip(node.domain)}${node.status === 'stale' ? ` ${chip('stale', 'muted')}` : ''}</div><div class="sub">${esc(node.summary)} · confirmed ${esc(day(node.last_confirmed))}</div></div><div class="strength">${meter(node.strength)}</div><div class="act">${form(view.csrf, 'node.forget', 'Forget', { id: String(node.id) }, { tone: 'danger', confirm: 'Forget this pattern and its links?' })}</div></div>`).join('');
  const edges = view.edges.length === 0 ? '' : `<h3>Links</h3>${view.edges.map((edge) => `<div class="row edge"><div class="main"><b>${esc(label.get(edge.from_id) ?? `#${edge.from_id}`)}</b> <span class="rel">${esc(edge.relation)}</span> <b>${esc(label.get(edge.to_id) ?? `#${edge.to_id}`)}</b><div class="sub">${edge.evidence_count} supporting observations</div></div><div class="strength">${meter(edge.strength)}</div></div>`).join('')}`;
  return nodes + edges;
};

const retired = (view: ConsoleView) => view.retiredSpots.length === 0 ? '' : `<details><summary>Dismissed and promoted spots (${view.retiredSpots.length})</summary>${view.retiredSpots.map((spot) => `<div class="row"><div class="main"><div class="line">${esc(spot.text)}</div></div>${chip(spot.status === 'promoted' ? 'In constellation' : 'Dismissed', spot.status === 'promoted' ? 'teal' : 'muted')}</div>`).join('')}</details>`;

const cards = (view: ConsoleView) => [...view.cards].sort((a, b) => (a.time ?? a.defaultTime).localeCompare(b.time ?? b.defaultTime)).map((card) => {
  const when = card.time ?? 'Skipped today';
  const controls = card.sent ? '' : `<form class="card-edit" method="post" action="${CONSOLE_ACTION_PATH}"><input type="hidden" name="csrf" value="${view.csrf}"><input type="hidden" name="id" value="${esc(card.id)}"><input type="time" name="value" value="${esc(card.time ?? card.defaultTime)}" required><button class="btn quiet" name="action" value="card.today">Set for today</button><button class="btn quiet" name="action" value="card.pin">Always at this time</button></form>`;
  return `<div class="row card"><div class="time">${esc(when)}</div><div class="main"><div class="line"><b>${esc(card.name)}</b> ${card.sent ? chip('Sent', 'teal') : chip('Upcoming')} ${card.pin ? chip(`Pinned ${card.pin}`, 'teal') : ''}</div><div class="sub">${esc(card.reason)}</div>${controls}${card.pin ? form(view.csrf, 'card.unpin', 'Clear pin', { id: card.id }) : ''}</div></div>`;
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

const activity = (view: ConsoleView) => {
  const seen = view.steps.filter((step) => step.state === 'ok').length;
  const steps = view.steps.map((step) => `<div class="row step"><span class="mark ${step.state}">${step.state === 'ok' ? '✓' : step.state === 'failed' ? '!' : ''}</span><div class="main"><div class="line">${esc(step.step)}</div>${step.at ? `<div class="sub">${step.state === 'failed' ? 'Failed' : 'Last ran'} ${esc(step.at)}${step.note ? ` · ${esc(step.note)}` : ''}</div>` : '<div class="sub">Not seen yet</div>'}</div></div>`).join('');
  const trace = view.trace.length === 0 ? empty('No activity recorded yet.') : `<div class="trace">${[...view.trace].reverse().map((row) => `<div class="t ${row.ok ? '' : 'bad'}"><span>${esc(row.time)}</span><span>${esc(row.hop)}</span><span>${row.ms} ms</span><span class="note">${esc(row.note || row.trace)}</span></div>`).join('')}</div>`;
  return `<div class="grid2 wide-left"><div><h3>End-to-end checklist <span class="count">${seen} of ${view.steps.length}</span></h3>${steps}</div><div><h3>Recent activity</h3>${trace}</div></div><h3>Ledger and reminders</h3><pre>${esc(view.ledger)}</pre>`;
};

const FONT_SHEET = 'https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Inter:wght@400;500;600&display=swap';
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="${FONT_SHEET}">`;

const STYLE = `
:root{--regular:400;--medium:500;--semibold:600;--bold:700;--ink:#251f21;--ink2:#585254;--ink4:#c0bebf;--rule:#eae9ea;--sand:#f4efec;--teal:#73a89a;--teal-ink:#3f7568;--red:#ed313e}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:400 14px/24px Inter,system-ui,sans-serif;letter-spacing:-.01em;-webkit-font-smoothing:antialiased}
.wrap{max-width:1040px;margin:0 auto;padding:24px}@media(min-width:760px){.wrap{padding:36px}}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand{font-family:'Instrument Serif',Georgia,serif;font-size:36px;line-height:40px;letter-spacing:-.025em}.brand small{font:400 14px Inter,sans-serif;color:var(--ink2);margin-left:8px;letter-spacing:0}
.env{color:var(--ink2);font-size:12px}
nav{position:sticky;top:0;background:rgba(255,255,255,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--rule);margin:20px -24px 0;padding:0 24px;display:flex;gap:4px;overflow-x:auto;z-index:2}
nav a{color:var(--ink2);text-decoration:none;padding:12px 10px;white-space:nowrap;border-bottom:2px solid transparent}nav a:hover{color:var(--ink);border-color:var(--teal)}
.notice{margin-top:20px;background:var(--sand);border-radius:8px;padding:10px 14px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-top:24px}
.stat{border:1px solid var(--rule);border-radius:12px;padding:16px}.stat b{display:block;font-family:'Instrument Serif',Georgia,serif;font-size:34px;line-height:40px}.stat span{color:var(--ink2);font-size:12px}
section{margin-top:44px;scroll-margin-top:60px}
h2{font-family:'Instrument Serif',Georgia,serif;font-size:26px;line-height:32px;letter-spacing:-.025em;margin:0 0 4px}
.intro{color:var(--ink2);margin:0 0 12px;max-width:640px}
h3{font-size:14px;margin:24px 0 4px}.count{color:var(--ink2);margin-left:6px}
.row{display:flex;align-items:center;gap:16px;padding:14px 0;border-bottom:1px solid var(--rule)}.row .main{flex:1;min-width:0}
.line{}.sub{color:var(--ink2);font-size:13px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.evidence{color:var(--ink2);font-size:13px;font-style:italic}
.conn>div:first-child{flex:1}.conn .name{}.state{width:140px}.act{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.chip{display:inline-block;font-size:12px;line-height:20px;padding:0 8px;border-radius:999px;background:var(--sand);color:var(--ink2)}.chip.teal{background:#e6f0ed;color:var(--teal-ink)}.chip.muted{background:#f5f5f5;color:#8b8587}
.status{display:inline-flex;align-items:center;gap:6px}.status i{width:8px;height:8px;border-radius:50%;background:var(--ink4)}.status.on{color:var(--teal-ink)}.status.on i{background:var(--teal)}.status.off{color:var(--ink2)}
.btn{font:500 13px Inter,sans-serif;border:1px solid var(--rule);background:#fff;color:var(--ink);border-radius:4px;padding:6px 12px;cursor:pointer;text-decoration:none;display:inline-block;line-height:18px}.btn:hover{border-color:var(--ink4)}
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
details{margin-top:16px}summary{cursor:pointer;color:var(--ink2)}
footer{margin:48px 0 12px;color:var(--ink2);font-size:12px}
@media(max-width:640px){.row{flex-wrap:wrap}.state{width:auto}.act{justify-content:flex-start;width:100%}.card .time{width:auto}.t{grid-template-columns:42px 1fr 56px}.t .note{grid-column:1/-1}}
nav a,.line,summary{font-weight:var(--medium)}
.stat b,h2,.count{font-weight:var(--regular)}
h3,.conn .name,.chip.teal,.status,.num,.rel,.panel-title,.t.bad span:nth-child(2){font-weight:var(--semibold)}
.mark{font-weight:var(--bold)}
`;

export const renderConsole = (view: ConsoleView, banner = ''): string => {
  const sentToday = view.cards.filter((card) => card.sent).length;
  const seen = view.steps.filter((step) => step.state === 'ok').length;
  const section = (id: string, title: string, intro: string, body: string) => `<section id="${id}"><h2>${esc(title)}</h2><p class="intro">${esc(intro)}</p>${body}</section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Waldo console</title>
${FONTS}<style>${STYLE}</style></head><body><div class="wrap">
${banner}<header><div class="brand">Waldo<small>Console</small></div><div class="env">Staging · ${esc(view.release)} · ${esc(view.now)} ${esc(view.timezone)}</div></header>
<nav><a href="#approvals">Waiting</a><a href="#checklist">Setup</a><a href="#connections">Connections</a><a href="#spots">Spots</a><a href="#constellation">Constellation</a><a href="#day">Your day</a><a href="#memory">Memory</a><a href="#files">Files</a><a href="#usage">Usage</a><a href="#activity">Activity</a></nav>
${view.notice ? `<div class="notice">${esc(view.notice)}</div>` : ''}
<div class="stats"><div class="stat"><b>${view.google.accounts.length ? String(view.google.accounts.length) : 'Off'}</b><span>Google connection</span></div><div class="stat"><b>${view.spots.length}</b><span>Active spots</span></div><div class="stat"><b>${view.nodes.length}</b><span>Constellation patterns</span></div><div class="stat"><b>${sentToday}/${view.cards.length}</b><span>Cards sent today</span></div><div class="stat"><b>${seen}/${view.steps.length}</b><span>End-to-end steps seen</span></div></div>
${section('approvals', 'Waiting on you', 'Changes Waldo proposed. Do it or not now, here or in Telegram - one decision, both places update.', approvals(view))}
${section('checklist', 'Setup checklist', 'The few steps that make Waldo useful. Everything here reflects real state.', checklist(view))}
${section('connections', 'Connections', 'What Waldo can reach, and the switches to change it. Items marked not built yet are on the plan but not wired.', connectors(view))}
${section('spots', 'Spots', 'Small things Waldo has noticed about you. Dismiss one that is wrong, or forget it completely.', spots(view) + retired(view))}
${section('constellation', 'Constellation', 'Lasting patterns built each night from repeated spots, and how they link. Strength is Waldo\'s confidence, from 0 to 1.', constellation(view))}
${section('day', 'Your day', 'Waldo plans when each card arrives. Change a time for today, or pin it so Waldo always uses it.', cards(view) + '<h3>Time zone</h3>' + timezone(view) + '<h3>Quiet hours and volume</h3>' + proactivity(view))}
${section('memory', 'Memory', 'What Waldo keeps about you. It updates after chats and each night.', memory(view))}
${section('files', 'Files', 'What you have sent Waldo on Telegram. Files stay stored with Telegram; this list keeps a reference so you can open them again.', files(view))}
${section('usage', 'Usage and cost', 'Real per-model totals from Waldo\'s own trace log, most expensive first.', usage(view))}
${section('activity', 'Activity', 'What ran, when, and whether it worked.', activity(view))}
${section('danger', 'Account', 'Deleting your account erases your memory, connections, settings and files. This cannot be undone.', `<div class="row conn"><div><div class="name">Delete your Waldo account</div><div class="sub">Everything Waldo knows and every connection goes. You can sign up again later, but nothing is recovered.</div></div><div class="state"></div><div class="act">${form(view.csrf, 'account.delete', 'Delete account', {}, { tone: 'danger', confirm: 'Delete your Waldo account? Memory, connections and settings are erased and cannot be recovered.' })}</div></div>`)}
<footer>Only you can open this page. Links come from your Telegram DM and expire after 10 minutes; a session lasts 12 hours.</footer>
</div></body></html>`;
};
