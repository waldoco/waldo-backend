import { EffectNotAppliedError, EffectUnknownError, type OwnerEffectLedger, type EffectReceipt, type EffectReadback } from './owner-effect-ledger';
import type { ProxyIntent } from '../connectors/proxy-intent';
import { ProxyIntentError } from '../connectors/proxy-intent';
import { googleTaskProposalSchema, proposeGoogleTaskChangeArgsSchema, type BrowserTaskContinuation, type ProposeCalendarChangeArgs, type ProposeGoogleTaskChangeArgs } from '@waldo/contracts';
import { GoogleError, sendRefused, sentCheck, sha256Hex, type GoogleClient, type SentEvidence } from '../connectors/google';
import { describeGoogleTaskChange, googleTaskExact, reviewGoogleTaskChange, type GoogleTaskApprovalAdapter, type GoogleTaskProposal } from './google-task-approvals';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { BrowserSubmitOutcome } from '../tools/live/browser';
import type { TurnLogEntry } from './telegram-listener';
import { MASK, isCredentialKey, maskedUrl, maskedValue } from './secret-fields';
import { APP_REVIEW_MAX_CHARS, appApprovalPart, type AppApprovalPart } from './surfaces/app';
import { replyApprovalPartV1Schema } from '@waldo/contracts';
import { appApprovalV1Schema, type AppApprovalStateV1, type AppApprovalV1 } from '../../../contracts/src/app/approvals';

export type TelegramCall = (method: string, body: object) => Promise<unknown>;
export type CallbackQuery = Readonly<{ id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } }>;

type Undo = ({ op: 'cancel'; id: string } | { op: 'move'; id: string; start: string; end: string }) & { applied_etag?: string };
type LedgerRow = { id: string; kind: string; status: string; summary: string; payload_json: string; undo_json: string | null; created_at: number; decided_at: number | null; proposal_digest?: string | null; origin_run_ref?: string | null; deferred_at?: number | null };
type DeskStatus = 'card_unconfirmed' | 'open' | 'review_only' | 'changing' | 'skipped' | 'expired' | 'done' | 'rejected' | 'failed' | 'stale' | 'uncertain' | 'unverified' | 'undone';
// One app state per desk status. An approval claimed before its effect resolves reads outcome_unknown, never done.
export const APP_APPROVAL_STATE: Readonly<Record<DeskStatus, AppApprovalStateV1>> = {
  card_unconfirmed: 'unconfirmed', open: 'open', review_only: 'review_only', changing: 'edit_requested', skipped: 'skipped', expired: 'expired',
  done: 'done', rejected: 'not_done', failed: 'not_done', stale: 'not_done', uncertain: 'outcome_unknown', unverified: 'outcome_unknown', undone: 'undone',
};
export class EmailProposalError extends Error {
  constructor(readonly reason: 'identifier_reused' | 'card_unconfirmed' | 'already_handled') { super(reason); }
}


const SENT_RESEARCHES = 2;
const SENT_RESEARCH_GAP_MS = 1_500;
export const UNDO_WINDOW_MS = 10 * 60_000;
export const PROPOSAL_TTL_MS = 12 * 60 * 60_000;

// seen_start/seen_end: the event's time when the card was made, so a move shows what it moves from.
type Stored = ProposeCalendarChangeArgs & { seen_etag?: string; seen_start?: string; seen_end?: string; operation_ref?: string };

// B-tool-3: the exact thing the owner approved. The executor replays it in a fresh browser
// session and re-reads the binding from the page before acting - a changed price/item/destination
// aborts, approval does not carry across a changed page.
export type BrowserSubmitProposal = Readonly<{
  url: string;
  action: Readonly<{ selector: string; description: string; method?: string; arguments?: string[] }>;
  binding: Readonly<Record<string, string>>;
  steps: readonly string[];
  continuation?: BrowserTaskContinuation;
  request?: Readonly<{ url: string; method: 'POST'; fields: readonly string[] }>;
  approvalExpiresAt?: number;
  // Binding keys whose values are masked on every surface whatever their name, e.g. fields the page
  // marks with isSecretField. Display only: the executor still compares and submits the raw values.
  secretKeys?: readonly string[];
}>;
const BROWSER_SUBMIT_TTL_MS = 30 * 60_000;

// The gmail send rail's stored proposal: the canonical MIME bytes the owner approved plus the
// sha256 digest binding them. Approval replays payload.raw verbatim; a digest mismatch fails
// closed instead of sending; message_id reconciles an ambiguous send via Sent-mail lookup.
export type EmailSendProposal = Readonly<{
  operation_ref?: string;
  to: readonly string[]; cc?: readonly string[]; bcc?: readonly string[];
  account?: string; subject: string; body: string; inReplyTo?: string; references?: readonly string[]; thread_id?: string; message_id: string; raw: string; digest: string; dedupe_key?: string;
  // When an identical earlier send is still of unknown outcome: its time, in the owner's zone, for the card.
  earlier_unknown_at?: string;
}>;
// What the owner would receive: two proposals with the same content send the same email.
const emailContent = ({ account, to, cc, bcc, subject, body, thread_id, inReplyTo, references }: EmailSendProposal) =>
  JSON.stringify({ account, to, cc, bcc, subject, body, thread_id, inReplyTo, references });

// send_message proposals (ADR-0054): the exact channel + content the owner approved, replayed
// verbatim on Send it; the idempotency key collapses a second approval onto the first send.
export type MessageSendProposal = Readonly<{ operation_ref?: string; channel: string; content: string; idempotency_key: string }>;

// call_mcp_tool proposals: server + tool + args replayed on approval. The result is external
// content - reported to the owner bounded, never re-entered into model context.
export type McpCallProposal = Readonly<{ operation_ref?: string; server: string; tool: string; args: Record<string, unknown> }>;

export type ApprovalDecision = Readonly<{ toast: string; message: string }>;
// a approve, s skip, e edit, u undo, d defer ("Not now": the row stays open and keeps its cards).
export type DeskAction = 'a' | 's' | 'e' | 'u' | 'd';
export type ApprovalSurface = 'telegram' | 'whatsapp' | 'app' | 'console';
// Where a decision came from. messageRef names the tapped card when the surface reports one.
export type ApprovalVia = Readonly<{ surface: ApprovalSurface; messageRef?: string }>;
export type ApprovalReview =
  | Readonly<{ kind: 'email_send'; account?: string; to: readonly string[]; cc: readonly string[]; bcc: readonly string[]; subject: string; body: string }>
  | Readonly<{ kind: 'message_send'; channel: string; content: string }>
  | Readonly<{ kind: 'google_task_change'; account: string; proposal: GoogleTaskProposal; proposal_digest: string }>
  | Readonly<{ kind: 'calendar_change'; account?: string; action: 'create' | 'move' | 'cancel'; title: string | null; event_id: string | null; start: string | null; end: string | null; reason: string }>;
// Where a proposal's card landed, and where a card that can approve it landed: on the proposing desk's own surface and in the app.
export type CardPlacement = Readonly<{ here: boolean; hereApprovable: boolean; app: boolean; appApprovable: boolean }>;
// What a proposing tool tells the model about the card, so a reply never points at buttons that are not there.
export const proposalStatus = (placement: CardPlacement | undefined, shownHere: string, nothingDone: string): string =>
  !placement || placement.hereApprovable ? shownHere
    : placement.appApprovable ? `${placement.here ? 'The full review card is in the Waldo app; it could not be shown in full here.' : 'The review card is in the Waldo app; it could not be shown here.'} ${nothingDone}`
      : `Only a summary card could be shown, so it cannot be approved yet. ${nothingDone}`;
export type ApprovalItem = Readonly<{ id: string; kind: string; summary: string; state: 'open' | 'done' | 'unconfirmed' | 'review_only'; undoable: boolean; review: ApprovalReview | null }>;
export type WaitingApproval = Readonly<{ approval_id: string; kind: string; summary: string; state: 'open' | 'review_only'; put_off: boolean }>;
export type ReraiseOutcome = Readonly<{ outcome: 'raised'; shown_on: readonly string[]; on_this_reply: boolean } | { outcome: 'expired' | 'not_put_off' | 'not_waiting' | 'unshown' }>;
export type ApprovalDesk = Readonly<{
  propose(args: ProposeCalendarChangeArgs, turnKey?: string, operationRef?: string): Promise<string>;
  proposeGoogleTaskChange(args: ProposeGoogleTaskChangeArgs, operationRef?: string, ctx?: ToolDispatcherContext): Promise<string>;
  proposeBrowserSubmit(payload: BrowserSubmitProposal): Promise<string>;
  proposeSendEmail(payload: EmailSendProposal): Promise<string>;
  proposeSendMessage(payload: MessageSendProposal): Promise<string>;
  proposeMcpCall(payload: McpCallProposal): Promise<string>;
  record(kind: string, summary: string, payload: unknown): void;
  callback(query: CallbackQuery, trace: string): Promise<void>;
  decide(id: string, action: DeskAction, trace: string, via?: ApprovalVia): Promise<ApprovalDecision>;
  pending(now: number): readonly ApprovalItem[];
  approvals(now: number, filter?: Readonly<{ state?: AppApprovalStateV1; id?: string }>): Promise<readonly AppApprovalV1[]>;
  // Approvals still waiting on the owner and unexpired, with the ones they put off marked.
  waiting(): readonly WaitingApproval[];
  // Shows an approval the owner put off to them again. Only one that is put off, still waiting and unexpired is raised.
  reraise(id: string): Promise<ReraiseOutcome>;
  placement(id: string): CardPlacement;
  ledger(reminders: readonly Readonly<{ note: string; at: string; repeat: string }>[]): string;
}>;

const DECISION = { a: 'approve', e: 'edit', s: 'skip' } as const;
const CARDS: Readonly<Record<string, Readonly<{ title: string; approve: string; modify: boolean }>>> = {
  calendar_change: { title: 'Calendar change?', approve: 'Do it', modify: true }, google_task_change: { title: 'Google task change?', approve: 'Do it', modify: true },
  email_send: { title: 'Send this email?', approve: 'Send it', modify: true }, message_send: { title: 'Send this message?', approve: 'Send it', modify: true },
  browser_submit: { title: 'Approve this browser action?', approve: 'Do it', modify: false }, mcp_call: { title: 'Run this MCP tool?', approve: 'Do it', modify: false },
};
const PROPOSAL_KINDS = Object.keys(CARDS);
// Telegram's buttons. Not now puts the approval off and is offered once; Don't do this skips it.
const laterButtons = (id: string, deferrable: boolean): [string, string][] => [...(deferrable ? [['Not now', `d:${id}`] as [string, string]] : []), ["Don't do this", `s:${id}`]];
const buttonsFor = (entry: LedgerRow, deferrable = entry.deferred_at == null): [string, string][] => {
  const card = CARDS[entry.kind]!;
  return [[card.approve, `a:${entry.id}`], ...(card.modify ? [['Modify', `e:${entry.id}`] as [string, string]] : []), ...laterButtons(entry.id, deferrable)];
};
const approveActions = (entry: LedgerRow): AppApprovalPart['actions'] => buttonsFor(entry, false).map(([, data]) => DECISION[data[0] as keyof typeof DECISION]);
// Not now is offered wherever a card is open or review-only; it is desk state, so it never depends on the surface.
// Not now is offered once: an approval already put off offers only the decisions that move it.
const withDefer = (entry: LedgerRow, actions: AppApprovalPart['actions']): AppApprovalPart['actions'] => entry.deferred_at == null ? [...actions, 'defer'] : actions;

// Google writes an event's time in its calendar's offset; the proposal may name the same instant in another.
const sameInstant = (a: string, b: string) => a === b || Date.parse(a) === Date.parse(b);

// The approval card IS the owner's review of a send. Telegram caps a message at 4096 chars:
// when the full content fits, the card shows every recipient + the complete body and carries
// the Send it / Modify buttons; when it cannot fit, the card says so and carries NO approve
// button, because approving would send content the owner never saw.
const REVIEW_BUDGET = 3800;
const reviewEmail = (p: EmailSendProposal) =>
  [...(p.account ? [`From: ${p.account}`] : []), `To: ${p.to.join(', ')}`,
    ...(p.cc?.length ? [`Cc: ${p.cc.join(', ')}`] : []),
    ...(p.bcc?.length ? [`Bcc: ${p.bcc.join(', ')}`] : []),
    `Subject: ${p.subject}`, '', p.body].join('\n');
const reviewMessage = (p: MessageSendProposal) => p.content;
// The summary is bounded: a browser summary carries its bindings, which can be as long as the content that did not fit.
const unreviewable = (kind: string, summary: string) =>
  `${kind} ${summary.length > 1000 ? `${summary.slice(0, 999)}…` : summary}\n\nThe full content doesn't fit in this card, so it can't be approved here - approving would send text you haven't reviewed. Use the Not now instruction on the card and ask me to show you the full text first.`;
const expiresAt = (entry: LedgerRow) => {
  const p = JSON.parse(entry.payload_json) as Partial<Stored> & Partial<BrowserSubmitProposal>;
  if (entry.kind === 'browser_submit') return Math.min(entry.created_at + BROWSER_SUBMIT_TTL_MS, p.approvalExpiresAt ?? Infinity);
  return entry.kind === 'calendar_change' && p.start ? Math.min(entry.created_at + PROPOSAL_TTL_MS, Date.parse(p.start)) : entry.created_at + PROPOSAL_TTL_MS;
};
// The scope a browser approval names: the page without credentials, query string or fragment.
const pageOf = (url: string) => { const page = new URL(url); return `${page.origin}${page.pathname}`; };
const describeBrowser = (p: BrowserSubmitProposal) => {
  const binding = Object.entries(p.binding).map(([k, v]) => `${k}: ${isCredentialKey(k) || p.secretKeys?.includes(k) ? MASK : v}`).join(', ');
  return `${p.action.description} on ${maskedUrl(p.url)}${p.request ? ` via ${p.request.method} ${maskedUrl(p.request.url)}` : ''}${binding ? ` (${binding})` : ''}`;
};
const describeMcp = (p: McpCallProposal) => `Run ${p.tool} on the ${p.server} MCP server`;
// Browser and MCP summaries are rebuilt from the payload, so a row stored before masking renders
// masked too. A payload that no longer parses shows the card title, never the stored summary.
const summaryOf = (entry: LedgerRow) => {
  if (entry.kind !== 'browser_submit' && entry.kind !== 'mcp_call') return entry.summary;
  try { return entry.kind === 'browser_submit' ? describeBrowser(JSON.parse(entry.payload_json)) : describeMcp(JSON.parse(entry.payload_json)); }
  catch { return CARDS[entry.kind]!.title; }
};
// The full review a card shows for each kind, rebuilt from the frozen payload.
const reviewText = (entry: LedgerRow): string => {
  const p = JSON.parse(entry.payload_json);
  if (entry.kind === 'email_send') return `Send this email?${p.earlier_unknown_at ? ` An identical email from ${p.earlier_unknown_at} may already have gone out; check Gmail's Sent folder before sending it again.\n` : ' '}${reviewEmail(p)}`;
  if (entry.kind === 'message_send') return `Send this message on ${p.channel}?\n\n${reviewMessage(p)}`;
  if (entry.kind === 'mcp_call') return `Run this MCP tool? ${describeMcp(p)}\n\nArgs:\n${JSON.stringify(maskedValue(p.args), null, 2)}`;
  if (entry.kind === 'browser_submit') return `Approve this browser action? ${describeBrowser(p)}`;
  if (entry.kind === 'google_task_change') return reviewGoogleTaskChange(googleTaskProposalSchema.parse(p));
  return `Proposed: ${entry.summary}`;
};
// The app's review: the same full review as a card, approvable while it fits the app's reply budget.
const appReview = (entry: LedgerRow): Readonly<{ text: string; full: boolean }> => {
  const text = reviewText(entry);
  return text.length <= APP_REVIEW_MAX_CHARS ? { text, full: true } : { text: unreviewable(CARDS[entry.kind]!.title, summaryOf(entry)), full: false };
};
// What each kind changes, from the frozen payload, exposing no more than the app review.
const exactFor = (entry: LedgerRow): AppApprovalV1['exact'] => {
  const p = JSON.parse(entry.payload_json);
  if (entry.kind === 'email_send') return { recipients: { to: p.to, cc: p.cc ?? [], bcc: p.bcc ?? [] }, ...(p.account ? { scope: p.account } : {}) };
  if (entry.kind === 'message_send') return { recipients: { to: [p.channel], cc: [], bcc: [] } };
  if (entry.kind === 'browser_submit') return { scope: pageOf(p.url) };
  if (entry.kind === 'mcp_call') return { scope: `${p.tool} on the ${p.server} server` };
  if (entry.kind === 'google_task_change') return { task: googleTaskExact(googleTaskProposalSchema.parse(p)) };
  return { changes: { action: p.action, title: p.title ?? null, start: p.start ?? null, end: p.end ?? null } };
};
// The app's card, rendered from the ledger row and its presentation, so the payload has one stored form.
const appPartOf = (entry: LedgerRow, shown: Readonly<{ actions: AppApprovalPart['actions']; payload_digest: string }>): AppApprovalPart => {
  const review = appReview(entry);
  return { type: 'approval', approval_id: entry.id, kind: entry.kind as AppApprovalPart['kind'], review: review.text, payload_digest: shown.payload_digest,
    actions: shown.actions, expires_at: expiresAt(entry), fallback_text: review.full ? summaryOf(entry).slice(0, 4000) : review.text };
};
// An app card approves only while today's app review still shows the full content; a stored flag alone never does.
const appShowsInFull = (entry: LedgerRow) => { try { return appReview(entry).full; } catch { return false; } };

// The owner's "door" for effects: proposals become Telegram cards with Do it / Modify / Not now,
// nothing reaches the calendar before Do it, and every effect lands in one ledger with a
// 10-minute undo where the provider allows it.
export const approvalDesk = (sql: SqlStorage, deps: Readonly<{
  effects?: OwnerEffectLedger;
  call: TelegramCall;
  owner: number;
  // The owner's effect identity, shared by every surface's desk; aliases are earlier per-surface refs.
  ownerRef?: () => string;
  ownerRefAliases?: () => readonly string[];
  google(intent?: ProxyIntent, feature?: 'mail' | 'calendar', account?: string): Promise<GoogleClient | null>;
  newId(): string;
  now(): number;
  timezone: string;
  reviewUrl?: () => Promise<string | null>;
  log(entry: TurnLogEntry): void;
  // Pauses between Sent re-searches; defaults to a timer.
  wait?: (ms: number) => Promise<void>;
  browserSubmit?: (proposal: BrowserSubmitProposal, approvalRef?: string) => Promise<BrowserSubmitOutcome>;
  browserReconcile?: (proposal: BrowserSubmitProposal, approvalRef: string) => Promise<BrowserSubmitOutcome>;
  browserDeny?: (proposal: BrowserSubmitProposal) => Promise<void>;
  browserReceiptVerified?: (proposal: BrowserSubmitProposal, receipt: Extract<BrowserSubmitOutcome, { status: 'verified_with_receipt' }>['receipt']) => Promise<boolean>;
  sendMessage?: (proposal: MessageSendProposal) => Promise<void | Readonly<{ provider_id: string }>>;
  // Returns a bounded owner-facing outcome line (the result is external content).
  mcpCall?: (proposal: McpCallProposal, intent: ProxyIntent) => Promise<string | EffectReceipt>;
  googleTasks?: () => GoogleTaskApprovalAdapter;
  // Host-derived correlation of a proposal with the run that raised it; it never grants execution authority.
  currentRunRef?: () => string | undefined;
  // The app chat message this turn replies to, only on an app chat turn: a raised card is shown on that reply.
  appReplyRef?: () => string | undefined;
  // The surface this desk's cards go out on. Every desk on the DO shares the ledger and its presentations.
  surface?: Exclude<ApprovalSurface, 'console'>;
  // Whether the owner has the app, so this desk's cards also show there. An app desk always does.
  appIdentity?: () => boolean;
  appLink?: (approvalId: string) => string;
  commit?: <T>(work: () => T) => T;
  // Clears a messaging card's decision buttons once another surface decided; best effort.
  retire?: (presentation: Readonly<{ surface: string; message_ref: string }>) => Promise<void>;
  // Whether an approved message can go out on its named channel; checked before the decision is claimed.
  canSendMessage?: (channel: string) => boolean;
}>): ApprovalDesk => {
  sql.exec(`CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL,
    undo_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)`);
  for (const column of ['proposal_digest', 'origin_run_ref']) {
    if (!sql.exec<{ name: string }>('PRAGMA table_info(ledger)').toArray().some(existing => existing.name === column)) sql.exec(`ALTER TABLE ledger ADD COLUMN ${column} TEXT`);
  }
  if (!sql.exec<{ name: string }>('PRAGMA table_info(ledger)').toArray().some(existing => existing.name === 'deferred_at')) sql.exec('ALTER TABLE ledger ADD COLUMN deferred_at INTEGER');
  const presentationsExisted = sql.exec('PRAGMA table_info(approval_presentations)').toArray().length > 0;
  sql.exec(`CREATE TABLE IF NOT EXISTS approval_presentations (
    approval_id TEXT NOT NULL, surface TEXT NOT NULL, message_ref TEXT NOT NULL, presented_at INTEGER NOT NULL, approvable INTEGER NOT NULL,
    payload_digest TEXT NOT NULL, retired_at INTEGER, PRIMARY KEY (approval_id, surface, message_ref))`);
  // Cards opened before presentations were recorded stay decidable where they were shown; the app can only skip them.
  if (!presentationsExisted) sql.exec("INSERT INTO approval_presentations (approval_id, surface, message_ref, presented_at, approvable, payload_digest, retired_at) SELECT id, 'legacy', 'legacy', created_at, status = 'open', 'legacy', NULL FROM ledger WHERE status IN ('open', 'review_only')");
  const surface = deps.surface ?? 'telegram';
  const commit = deps.commit ?? (<T>(work: () => T) => work());
  const bindOrigin = (id: string, origin: string | undefined) => {
    if (origin === undefined) return;
    if (!origin || origin.length > 256 || /[\u0000-\u001f]/.test(origin)) throw new Error('invalid approval origin');
    sql.exec('UPDATE ledger SET origin_run_ref = ? WHERE id = ? AND origin_run_ref IS NULL', origin, id);
  };
  const effect = async (operationId: string, tool: string, payload: unknown, dispatch: () => Promise<EffectReceipt>, reconcile: () => Promise<EffectReadback>) => {
    if (!deps.effects) return dispatch();
    return deps.effects.execute({ operationId, owner_ref: deps.ownerRef?.() ?? String(deps.owner), tool, payload }, { dispatch, reconcile }, undefined, deps.ownerRefAliases?.());
  };
  // Owner turns run serially; keep only the current turn, never a cross-turn cache.
  let proposalTurn: string | undefined;
  const calendarProposals = new Map<string, Promise<string>>();
  const when = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: deps.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const day = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: deps.timezone, year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(iso));
  const hour = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: deps.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const span = (start: string, end: string) => day(start) === day(end) ? `${when(start)}–${hour(end)}` : `${when(start)} to ${when(end)}`;
  const describe = (p: Stored) => {
    const name = p.title ? `"${p.title}"` : 'the event';
    if (p.action === 'create') return `Add ${name}, ${when(p.start!)} to ${when(p.end!)}${p.account ? ` (${p.account})` : ''}`;
    if (p.action === 'move') return `Move ${name}${p.seen_start && p.seen_end ? ` from ${span(p.seen_start, p.seen_end)}` : ''} to ${span(p.start!, p.end!)}${p.account ? ` (${p.account})` : ''}`;
    return `Cancel ${name}${p.account ? ` (${p.account})` : ''}`;
  };
  const row = (id: string) => sql.exec<LedgerRow>('SELECT * FROM ledger WHERE id = ?', id).toArray()[0];
  const setStatus = (id: string, status: DeskStatus, undo: Undo | null = null) =>
    sql.exec('UPDATE ledger SET status = ?, undo_json = ?, decided_at = ? WHERE id = ?', status, undo ? JSON.stringify(undo) : null, deps.now(), id);
  const say = (text: string, buttons?: [string, string][]) =>
    deps.call('sendMessage', { chat_id: deps.owner, text, ...(buttons ? { reply_markup: { inline_keyboard: [buttons.map(([label, data]) => ({ text: label, callback_data: data }))] } } : {}) });

  const describeEmail = (p: EmailSendProposal) => `Send email${p.account ? ` from ${p.account}` : ''} to ${p.to.join(', ')}: "${p.subject}"`;
  const describeMessage = (p: MessageSendProposal) => `Send this on ${p.channel}: "${p.content.length > 120 ? `${p.content.slice(0, 117)}...` : p.content}"`;

  const sentRef = (sent: unknown) => {
    const ack = sent as { message_id?: unknown; chat?: { id?: unknown }; messages?: readonly { id?: unknown }[] } | null;
    if (ack?.message_id !== undefined) return `${String(ack.chat?.id ?? deps.owner)}:${String(ack.message_id)}`;
    return ack?.messages?.[0]?.id !== undefined ? String(ack.messages[0].id) : 'unreferenced';
  };
  // A row opens only once a surface recorded the review: the origin card's provider acknowledgement
  // and, when the owner has the app, an app card that parses. Approvability is per surface, by how
  // much review that surface can show. The presentation rows and the status flip commit together.
  // A raise shows the card again for the current run and ends the deferral in the same commit as its presentations.
  const present = async (id: string, raise?: Readonly<{ runRef: string | undefined }>) => {
    const entry = row(id)!;
    const deferrable = raise !== undefined || entry.deferred_at == null;
    const card = reviewText(entry), buttons = buttonsFor(entry, deferrable), title = CARDS[entry.kind]!.title;
    const digest = `sha256:${await sha256Hex(entry.payload_json)}`;
    const shown: { surface: string; message_ref: string; approvable: boolean }[] = [];
    let journalFailure: unknown, sendFailure: unknown, inApp: Readonly<{ approvable: boolean }> | null = null;
    if (surface === 'app' || deps.appIdentity?.()) {
      try {
        const approvable = appReview(entry).full;
        const part = appApprovalPart(appPartOf(entry, { actions: withDefer(entry, approvable ? approveActions(entry) : ['skip']), payload_digest: digest }));
        // The app may show only a card it can also decide: the approvals-list item must parse first.
        appApprovalV1Schema.parse({ approval_id: id, kind: part.kind, state: approvable ? 'open' : 'review_only', review: part.review, exact: exactFor(entry), payload_digest: digest, expires_at: part.expires_at, actions: part.actions });
        inApp = { approvable };
      } catch (error) {
        journalFailure = error;
        deps.log({ trace: id, hop: 'approval_app_card', ms: 0, ok: false, code: 'unrepresentable' });
      }
    }
    if (surface !== 'app') {
      const approvable = card.length <= REVIEW_BUDGET;
      const link = inApp?.approvable && deps.appLink ? ` You can review and approve it in the Waldo app: ${deps.appLink(id)}` : '';
      try {
        const sent = await say(approvable ? card : `${unreviewable(title, summaryOf(entry))}${link}`, approvable ? buttons : laterButtons(id, deferrable));
        if (sent == null) sendFailure = new Error('Approval card not confirmed');
        else shown.push({ surface, message_ref: sentRef(sent), approvable });
      } catch (error) { sendFailure = error; }
    }
    const runRef = raise ? raise.runRef : entry.origin_run_ref;
    if (inApp) shown.push({ surface: 'app', message_ref: runRef ? `run:${runRef}` : `approval:${id}`, approvable: inApp.approvable });
    if (!shown.length) throw sendFailure ?? journalFailure ?? new Error('Approval card not confirmed');
    commit(() => {
      for (const s of shown) sql.exec('INSERT OR IGNORE INTO approval_presentations (approval_id, surface, message_ref, presented_at, approvable, payload_digest, retired_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        id, s.surface, s.message_ref, deps.now(), s.approvable ? 1 : 0, digest);
      sql.exec("UPDATE ledger SET status = ? WHERE id = ? AND status = 'card_unconfirmed'", shown.some(s => s.approvable) ? 'open' : 'review_only', id);
      if (raise) sql.exec("UPDATE ledger SET deferred_at = NULL WHERE id = ? AND deferred_at IS NOT NULL AND status IN ('open', 'review_only')", id);
    });
    return shown;
  };
  // Approving or modifying needs a card that showed the full review on the deciding surface. The
  // console renders the stored review itself, so any full-review presentation serves it.
  const presentedTo = (entry: LedgerRow, via: ApprovalVia) => {
    const live = sql.exec<{ surface: string; message_ref: string; approvable: number }>('SELECT surface, message_ref, approvable FROM approval_presentations WHERE approval_id = ? AND retired_at IS NULL', entry.id).toArray();
    const approves = (p: { surface: string; approvable: number }) => p.approvable === 1 && (p.surface !== 'app' || appShowsInFull(entry));
    if (via.surface === 'console') return live.some(approves);
    const mine = live.filter(p => p.surface === via.surface || (p.surface === 'legacy' && via.surface !== 'app'));
    const tapped = mine.filter(p => p.message_ref === via.messageRef);
    return (tapped.length ? tapped : mine).some(approves);
  };
  const notPresented = (entry: LedgerRow): ApprovalDecision => {
    const id = entry.id;
    const inApp = deps.appLink && appShowsInFull(entry) && sql.exec("SELECT 1 FROM approval_presentations WHERE approval_id = ? AND surface = 'app' AND approvable = 1 AND retired_at IS NULL", id).toArray().length > 0;
    return inApp
      ? { toast: 'Review it in the app', message: `That approval wasn't shown in full here, so it can't be approved here. Nothing was done. Review and approve it in the Waldo app: ${deps.appLink!(id)}` }
      : { toast: 'Not available here', message: "That approval wasn't shown in full here, so it can't be approved here. Nothing was done." };
  };
  // The app's view of a proposal: its current state, the app review, and only decisions the desk accepts now.
  const project = async (entry: LedgerRow, now: number): Promise<AppApprovalV1> => {
    const shown = sql.exec<{ surface: string; approvable: number; retired_at: number | null }>('SELECT surface, approvable, retired_at FROM approval_presentations WHERE approval_id = ? ORDER BY presented_at, surface', entry.id).toArray();
    const inApp = shown.find(p => p.surface === 'app');
    const state = APP_APPROVAL_STATE[entry.status as DeskStatus];
    const actions = state === 'open' ? withDefer(entry, inApp?.approvable === 1 && inApp.retired_at === null && appShowsInFull(entry) ? approveActions(entry) : ['skip'])
      : state === 'review_only' ? withDefer(entry, ['skip'])
        : state === 'done' && entry.undo_json && entry.decided_at !== null && now - entry.decided_at <= UNDO_WINDOW_MS ? ['undo'] as const : [];
    const surfaces = [...new Set(shown.map(p => p.surface).filter(surface => surface !== 'legacy'))];
    return { approval_id: entry.id, kind: entry.kind as AppApprovalV1['kind'], state, review: appReview(entry).text,
      exact: exactFor(entry), payload_digest: `sha256:${await sha256Hex(entry.payload_json)}`, expires_at: expiresAt(entry), actions: [...actions],
      ...(surfaces.length ? { presented_surfaces: surfaces as AppApprovalV1['presented_surfaces'] } : {}) };
  };
  const describeAny = (entry: LedgerRow) => {
    if (entry.kind === 'task_sources') return 'Task sources (expired)';
    if (entry.kind === 'browser_submit') return describeBrowser(JSON.parse(entry.payload_json) as BrowserSubmitProposal);
    if (entry.kind === 'email_send') return describeEmail(JSON.parse(entry.payload_json) as EmailSendProposal);
    if (entry.kind === 'message_send') return describeMessage(JSON.parse(entry.payload_json) as MessageSendProposal);
    if (entry.kind === 'mcp_call') return describeMcp(JSON.parse(entry.payload_json) as McpCallProposal);
    if (entry.kind === 'google_task_change') return describeGoogleTaskChange(googleTaskProposalSchema.parse(JSON.parse(entry.payload_json)));
    return describe(JSON.parse(entry.payload_json) as Stored);
  };
  // ADR-0054 exactly-once: a second approval of the same idempotency key collapses onto the
  // first send instead of double-delivering.
  const keyHolder = (key: string, selfId: string) =>
    sql.exec<{ id: string; status: string; payload_json: string }>("SELECT id, status, payload_json FROM ledger WHERE kind = 'message_send' AND status IN ('done', 'uncertain') AND id != ? AND json_extract(payload_json, '$.idempotency_key') = ? LIMIT 1", selfId, key).toArray()[0];
  const expired = (entry: LedgerRow, p: Stored) =>
    (entry.kind === 'browser_submit' && (p as unknown as BrowserSubmitProposal).approvalExpiresAt !== undefined && (!Number.isSafeInteger((p as unknown as BrowserSubmitProposal).approvalExpiresAt) || deps.now() >= (p as unknown as BrowserSubmitProposal).approvalExpiresAt!)) ||
    deps.now() - entry.created_at > (entry.kind === 'browser_submit' ? BROWSER_SUBMIT_TTL_MS : PROPOSAL_TTL_MS) || (entry.kind !== 'browser_submit' && p.start !== undefined && Date.parse(p.start) <= deps.now());
  const apply = async (client: GoogleClient, p: Stored, eventId?: string, marker?: string): Promise<Undo | null | 'stale'> => {
    if (p.action === 'create') {
      const applied = await client.createEvent({ title: p.title!, start: p.start!, end: p.end!, ...(eventId ? { id: eventId } : {}), ...(marker ? { operationMarker:marker } : {}) });
      return applied.etag ? { op: 'cancel', id: applied.id, applied_etag: applied.etag } : null;
    }
    const before = await client.event(p.event_id!);
    if (p.seen_etag && before.etag !== p.seen_etag) return 'stale';
    try {
      if (p.action === 'move') {
        const applied = await client.moveEvent(p.event_id!, p.start!, p.end!, before.etag, marker);
        return applied.etag ? { op: 'move', id: p.event_id!, start: before.start, end: before.end, applied_etag: applied.etag } : null;
      }
      await client.cancelEvent(p.event_id!, before.etag, marker);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 412) return 'stale';
      throw error;
    }
    return null;
  };
  const revert = async (client: GoogleClient, undo: Undo, marker?: string): Promise<'undone' | 'stale' | 'unavailable'> => {
    // Legacy entries have no applied version. A fresh owner edit never grants Undo authority.
    if (!undo.applied_etag) return 'unavailable';
    const current = await client.event(undo.id);
    if (current.etag !== undo.applied_etag) return 'stale';
    try {
      if (undo.op === 'cancel') await client.cancelEvent(undo.id, undo.applied_etag, marker);
      else await client.moveEvent(undo.id, undo.start, undo.end, undo.applied_etag, marker);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 412) return 'stale';
      throw error;
    }
    return 'undone';
  };

  const decide = async (id: string, action: DeskAction, trace: string, via: ApprovalVia = { surface }): Promise<ApprovalDecision> => {
    const started = deps.now();
    const entry = row(id);
    const operationRef = entry ? (JSON.parse(entry.payload_json) as { operation_ref?: string }).operation_ref ?? `approval:${id}` : `approval:${id}`;
    const expected = action === 'u' ? 'done' : 'open';
    if (deps.effects?.isActive(`${operationRef}:${action === 'u' ? 'undo' : 'apply'}`)) return { toast: 'Already handled.', message: 'Already handled.' };
    // An uncertain row with no effect record never reached dispatch (the record is written before the provider call), so it is safe to run again; a record sends it through reconcile instead.
    const recovering = entry?.status === 'uncertain' && deps.effects !== undefined && (action === 'a' || action === 'u' && entry.kind === 'calendar_change' && !!entry.undo_json && !!deps.effects.get(`${operationRef}:undo`));
    if (entry?.status === 'uncertain' && entry.kind !== 'browser_submit' && action === 'a' && !recovering) return { toast: 'Outcome unknown', message: 'The outcome of that approval is unknown. Check the result before retrying; nothing was sent again.' };
    if (!entry || (entry.status !== expected && !((action === 's' || action === 'd') && entry.status === 'review_only') && !recovering)) return { toast: 'Already handled.', message: 'Already handled.' };
    if ((action === 'a' || action === 'e') && entry.status === 'open' && !presentedTo(entry, via)) return notPresented(entry);
    const proposal = JSON.parse(entry.payload_json) as Stored;
    try {
      let out: ApprovalDecision;
      if ((!recovering || !deps.effects?.get(`${operationRef}:apply`)) && action !== 'u' && action !== 's' && expired(entry, proposal)) {
        setStatus(id, 'expired');
        out = { toast: 'This proposal expired', message: `That proposal expired, so nothing happened: ${describeAny(entry)}. Ask me again if you still want it.` };
      } else if (action === 's') {
        setStatus(id, 'skipped');
        if (entry.kind === 'browser_submit') await deps.browserDeny?.(JSON.parse(entry.payload_json) as BrowserSubmitProposal);
        out = { toast: 'Not now', message: 'Left it. Nothing changed.' };
      } else if (action === 'd') {
        sql.exec("UPDATE ledger SET deferred_at = ? WHERE id = ? AND status IN ('open', 'review_only') AND deferred_at IS NULL", deps.now(), id);
        out = sql.exec<{ changed: number }>('SELECT changes() AS changed').one().changed === 1
          ? { toast: 'Later', message: 'Left it for later. It is still waiting, and it can still expire.' }
          : { toast: 'Already handled.', message: 'Already handled.' };
      } else if (action === 'e') {
        setStatus(id, 'changing');
        out = { toast: 'Tell me what to change', message: `What should I change? (${describeAny(entry)})` };
      } else if (entry.kind === 'task_sources') {
        setStatus(id, 'skipped');
        out = { toast: 'Expired', message: 'That request has expired; just ask again.' };
      } else if (entry.kind === 'google_task_change') {
        if (action === 'u') {
          out = { toast: "Can't be undone", message: 'A Google Tasks change cannot be undone from here. Nothing was reversed.' };
        } else if (action !== 'a' || !deps.googleTasks || !deps.effects) {
          out = { toast: 'Not available', message: 'This Google task approval cannot be applied here. Nothing was changed.' };
        } else {
          const taskProposal = googleTaskProposalSchema.parse(JSON.parse(entry.payload_json));
          if (!entry.proposal_digest || await sha256Hex(JSON.stringify(taskProposal)) !== entry.proposal_digest) { setStatus(id, 'failed'); throw new Error('Google task proposal identity changed'); }
          if (!recovering) {
            sql.exec("UPDATE ledger SET status = 'uncertain', decided_at = ? WHERE id = ? AND status = 'open'", deps.now(), id);
            if (sql.exec<{ claimed: number }>('SELECT changes() AS claimed').one().claimed !== 1) return { toast: 'Already handled.', message: 'Already handled.' };
          }
          const result = await deps.googleTasks().apply(id, taskProposal, operationRef);
          if (result.status === 'done') { setStatus(id, 'done'); out = { toast: 'Done', message: `The Google task change was applied and independently read back: ${describeGoogleTaskChange(taskProposal)}` }; }
          else if (result.status === 'stale') { setStatus(id, 'rejected'); out = { toast: 'The task changed', message: 'The Google task changed after your review. Nothing was changed; ask for a fresh proposal.' }; }
          else if (result.status === 'not_applied') { setStatus(id, 'rejected'); out = { toast: 'Nothing was changed', message: 'I could not reach that Google task before changing it, so nothing was changed. Ask me again to retry.' }; }
          else { setStatus(id, 'uncertain'); out = { toast: 'Outcome unknown', message: 'The Google task outcome is unknown. No request was repeated; check the selected account and task before retrying.' }; }
        }
      } else if (entry.kind === 'browser_submit') {
        const bp = JSON.parse(entry.payload_json) as BrowserSubmitProposal;
        if (action === 'a') {
          if (!deps.browserSubmit) {
            setStatus(id, 'rejected');
            out = { toast: 'Browsing is not set up', message: 'I could not do that because browsing is not set up on this Waldo yet.' };
          } else {
            // Synchronous compare-and-claim before external await. Replay and crash
            // leave a consumed uncertain decision, never another blind browser act.
            if (!recovering) {
              sql.exec("UPDATE ledger SET status = 'uncertain', decided_at = ? WHERE id = ? AND status = 'open'", deps.now(), id);
              const claimed = sql.exec<{ claimed: number }>('SELECT changes() AS claimed').one().claimed;
              if (claimed !== 1) return { toast: 'Already handled.', message: 'Already handled.' };
            }
            let outcome: BrowserSubmitOutcome | undefined;
            const checkedBrowser = async (value: BrowserSubmitOutcome): Promise<EffectReadback> => {
              outcome = value;
              if (value.status === 'rejected') return { status: 'not_applied' };
              if (value.status === 'verified_with_receipt' && await deps.browserReceiptVerified?.(bp, value.receipt) === true)
                return { status: 'done', receipt: { provider_id: value.receipt.id, result: value } };
              return { status: 'unknown' };
            };
            try {
              if (deps.effects) {
                const receipt = await effect(`${operationRef}:apply`, 'browser_submit', bp, async () => {
                  const checked = await checkedBrowser(await deps.browserSubmit!(bp, id));
                  if (checked.status !== 'done') throw new EffectUnknownError();
                  return checked.receipt;
                }, async () => deps.browserReconcile ? checkedBrowser(await deps.browserReconcile(bp, id)) : outcome?.status === 'rejected' ? { status: 'not_applied' } : { status: 'unknown' });
                outcome = receipt.result as BrowserSubmitOutcome;
              } else outcome = await deps.browserSubmit(bp, id);
            } catch (error) {
              deps.log({ trace, hop: 'browser_effect_unknown', ms: 0, ok: false, error: String(error) });
              outcome = { status: 'uncertain', message: 'The browser outcome is unknown. Check the result before retrying.' };
            }
            if (!outcome || typeof outcome !== 'object' || typeof outcome.message !== 'string' || !outcome.message.trim()) {
              outcome = { status: 'uncertain', message: 'The browser outcome is unknown. Check the result before retrying.' };
            }
            let receiptVerified = false;
            switch (outcome?.status) {
              case 'rejected':
                setStatus(id, 'rejected'); out = { toast: 'Not done', message: outcome.message }; break;
              case 'acknowledged_unverified':
                setStatus(id, 'unverified'); out = { toast: 'Result not verified', message: outcome.message }; break;
              case 'verified_with_receipt':
                // Only a host validator backed by the exact stored proposal/receipt
                // can promote completion. Missing/failed validation stays unverified.
                try { receiptVerified = await deps.browserReceiptVerified?.(bp, outcome.receipt) === true; } catch (error) { deps.log({ trace, hop: 'browser_receipt_unchecked', ms: 0, ok: false, error: String(error) }); }
                setStatus(id, receiptVerified ? 'done' : 'unverified');
                out = receiptVerified ? { toast: 'Verified', message: outcome.message } : { toast: 'Receipt not checked', message: 'The result receipt could not be checked, so completion is not verified.' }; break;
              default:
                setStatus(id, 'uncertain');
                out = { toast: 'Outcome unknown', message: 'The browser outcome is unknown. Check the result before retrying.' }; break;
            }
            deps.log({ trace, hop: 'browser_outcome', ms: deps.now() - started, ok: outcome?.status === 'acknowledged_unverified' || receiptVerified,
              code: outcome?.status === 'rejected' ? 'rejected' : outcome?.status === 'acknowledged_unverified' ? 'unverified' : outcome?.status === 'verified_with_receipt' ? receiptVerified ? 'receipt_verified' : 'receipt_unchecked' : 'uncertain' });
          }
        } else {
          out = { toast: "Can't be undone", message: 'A browser submit cannot be undone from here. Nothing was reversed.' };
        }
      } else if (entry.kind === 'email_send') {
        const ep = JSON.parse(entry.payload_json) as EmailSendProposal;
        if (action === 'u') {
          out = { toast: "Can't be undone", message: 'A sent email cannot be undone. Nothing was reversed.' };
        } else {
          const client = await deps.google({id:`approval:${id}:apply`},'mail',ep.account);
          if (client === null || (ep.account && client.account?.email?.toLowerCase() !== ep.account.toLowerCase())) {
            out = { toast: 'Google is not connected', message: 'I could not send that because Google is not connected.' };
          } else if (await sha256Hex(ep.raw) !== ep.digest) {
            setStatus(id, 'failed');
            out = { toast: 'Email changed', message: `The stored email no longer matches what you approved, so nothing was sent: ${describeEmail(ep)}. Ask me again and I'll prepare a fresh one.` };
          } else {
            if (!recovering) {
              sql.exec("UPDATE ledger SET status = 'uncertain', decided_at = ? WHERE id = ? AND status = 'open'", deps.now(), id);
              if (sql.exec<{ claimed: number }>('SELECT changes() AS claimed').one().claimed !== 1) return { toast: 'Already handled.', message: 'Already handled.' };
            }
            // Sent needs Gmail metadata with SENT, our exact Message-ID and the intended thread. Each step logs a
            // fixed code, never content, so a send that ends unknown says which check failed.
            const hop = (name: string, ok: boolean, code: string, from: number) => deps.log({ trace, hop: name, ms: deps.now() - from, ok, code });
            let sent: Awaited<ReturnType<GoogleClient['sendRaw']>> | undefined;
            let refused = false;
            const pause = deps.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
            // The thread the copy must be in: the proposal's, or else the one the send returned.
            const intendedThread = () => ep.thread_id ?? sent?.thread_id;
            const check = async (name: 'email_verify' | 'email_reconcile'): Promise<Readonly<{ code: string; landed?: SentEvidence }>> => {
              const from = deps.now();
              try {
                const landed = await client.findSentByMessageId(ep.message_id, ep.thread_id, sent?.message_id);
                const code = sentCheck(landed, ep.message_id, intendedThread(), sent?.message_id);
                const proven = code === 'verified' || code === 'rfc822_rewritten';
                hop(name, proven, code, from);
                return proven ? { code, landed: landed as SentEvidence } : { code };
              } catch { hop(name, false, 'unreadable', from); return { code: 'unreadable' }; }
            };
            const readback = async (name: 'email_verify' | 'email_reconcile') => (await check(name)).landed ?? null;
            // Gmail search can trail a send by seconds, so a miss is searched twice more before it stays unknown.
            // A copy that was found but failed a check is not searched again.
            const searched = async () => {
              for (let attempt = 0; ; attempt++) {
                const result = await check('email_verify');
                if (result.code !== 'not_found' || attempt === SENT_RESEARCHES) return result;
                await pause(SENT_RESEARCH_GAP_MS);
              }
            };
            // After a miss, whether the sent copy carries our Message-ID tells a slow search from a rewritten header.
            const diagnose = async (): Promise<string | undefined> => {
              const from = deps.now();
              let code = 'unavailable';
              let header: string | undefined;
              if (sent?.thread_id && client.threadPage) {
                try {
                  code = 'not_in_thread';
                  let cursor: string | undefined;
                  for (let page = 0; page < 5; page++) {
                    const read = await client.threadPage(sent.thread_id, 20, cursor);
                    const copy = read.messages.find(message => message.id === sent!.message_id);
                    if (copy) { code = copy.message_id === ep.message_id ? 'header_matches' : copy.message_id ? 'header_differs' : 'header_absent'; header = code === 'header_differs' ? copy.message_id : undefined; break; }
                    if (!read.cursor) break;
                    cursor = read.cursor;
                  }
                } catch { code = 'unreadable'; }
              }
              hop('email_diagnose', false, code, from);
              return header;
            };
            // Gmail can rewrite the Message-ID of an API send, so a search by ours never finds it. The header Gmail
            // gave the copy the send returned is searched strictly instead: SENT, that exact header, the intended
            // thread and the same Gmail id. A lost response has no id, so it never gets here and stays unknown.
            const rewritten = async (header: string): Promise<SentEvidence | null> => {
              for (let attempt = 0; ; attempt++) {
                const from = deps.now();
                let code: string;
                let landed: unknown;
                try { landed = await client.findSentByMessageId(header, ep.thread_id); code = sentCheck(landed, header, intendedThread(), sent!.message_id); }
                catch { code = 'unreadable'; }
                hop('email_verify', code === 'verified', code === 'verified' ? 'rfc822_rewritten' : code, from);
                if (code === 'verified') return landed as SentEvidence;
                if (code !== 'not_found' || attempt === 1) return null;
                await pause(SENT_RESEARCH_GAP_MS);
              }
            };
            hop('email_thread', true, ep.thread_id ? 'thread_set' : 'no_thread', deps.now());
            try {
              await effect(`${operationRef}:apply`, 'send_email', ep, async () => {
                const from = deps.now();
                try { sent = await client.sendRaw(ep.raw, ep.thread_id); }
                catch (error) { refused = sendRefused(error); hop('email_send', false, refused ? 'refused' : 'unknown', from); throw error; }
                hop('email_send', true, 'sent', from);
                // A search that also filters by the intended thread misses a copy Gmail filed in another thread.
                if (ep.thread_id) hop('email_thread_match', sent.thread_id === ep.thread_id, sent.thread_id === ep.thread_id ? 'same_thread' : 'other_thread', from);
                const { code, landed } = await searched();
                const header = !landed && code === 'not_found' ? await diagnose() : undefined;
                const proof = landed ?? (header ? await rewritten(header) : null);
                if (!proof) throw new EffectUnknownError();
                return { provider_id: proof.message_id, result: proof };
              }, async () => {
                const landed = await readback('email_reconcile');
                return landed ? { status: 'done', receipt: { provider_id: landed.message_id, result: landed } } : refused ? { status: 'not_applied' } : { status: 'unknown' };
              });
              setStatus(id, 'done');
              out = { toast: 'Sent', message: `Sent: ${describeEmail(ep)}. This one can't be undone.` };
            } catch (error) {
              if (!deps.effects && !(error instanceof ProxyIntentError) && await readback('email_reconcile')) {
                setStatus(id, 'done');
                return { toast: 'Sent', message: `Sent: ${describeEmail(ep)}. Gmail confirmed it after a hiccup; it went out exactly once.` };
              }
              if (error instanceof EffectNotAppliedError || (!deps.effects && refused)) {
                setStatus(id, 'failed');
                out = { toast: 'Not sent', message: `Gmail refused that send, so nothing went out: ${describeEmail(ep)}. Ask me again; if it keeps failing, reconnect Google.` };
              } else {
                setStatus(id, 'uncertain');
                out = { toast: 'Outcome unknown', message: 'The send outcome is unknown. Check Gmail before retrying; nothing was sent again.' };
              }
            }
          }
        }
      } else if (entry.kind === 'message_send') {
        const mp = JSON.parse(entry.payload_json) as MessageSendProposal;
        if (action === 'u') {
          out = { toast: "Can't be undone", message: 'A sent message cannot be undone. Nothing was reversed.' };
        } else if (!deps.sendMessage) {
          out = { toast: 'Messaging is not set up', message: 'I could not send that because messaging is not set up on this Waldo yet.' };
        } else if (deps.canSendMessage?.(mp.channel) === false) {
          out = { toast: 'Channel not connected', message: `I could not send that because ${mp.channel} is not connected to this Waldo. Nothing was sent.` };
        } else if (!recovering && (() => { const holder = keyHolder(mp.idempotency_key, id); if (!holder) return false; const held = JSON.parse(holder.payload_json) as MessageSendProposal; return held.channel !== mp.channel || held.content !== mp.content ? 'conflict' : holder.status; })()) {
          const holder = keyHolder(mp.idempotency_key, id)!;
          const held = JSON.parse(holder.payload_json) as MessageSendProposal;
          if (held.channel !== mp.channel || held.content !== mp.content) {
            setStatus(id, 'failed');
            out = { toast: 'Key already used', message: 'A different message already used this send key, so nothing was sent. Ask me again and I will prepare a fresh one.' };
          } else {
            setStatus(id, holder.status === 'done' ? 'done' : 'skipped');
            out = holder.status === 'done'
              ? { toast: 'Already sent', message: `That exact message already went out once, so nothing was sent twice: ${describeMessage(mp)}` }
              : { toast: 'Already handled.', message: 'That message is already being sent or its outcome is unknown. Nothing was sent again.' };
          }
        } else {
          if (!recovering) {
            sql.exec("UPDATE ledger SET status = 'uncertain', decided_at = ? WHERE id = ? AND status = 'open'", deps.now(), id);
            if (sql.exec<{ claimed: number }>('SELECT changes() AS claimed').one().claimed !== 1) return { toast: 'Already handled.', message: 'Already handled.' };
          }
          try {
            await effect(`${operationRef}:apply`, 'send_message', mp, async () => { const sent = await deps.sendMessage!(mp); if (deps.effects && !sent?.provider_id) throw new EffectUnknownError(); return { provider_id: sent?.provider_id ?? mp.idempotency_key, result: null }; }, async () => ({ status: 'unknown' }));
            setStatus(id, 'done');
            out = { toast: 'Sent', message: `Sent: ${describeMessage(mp)} This one can't be undone.` };
          } catch (error) {
            deps.log({ trace, hop: 'message_effect_unknown', ms: 0, ok: false, error: String(error) });
            setStatus(id, 'uncertain');
            out = { toast: 'Outcome unknown', message: 'The message outcome is unknown. Check the channel before retrying; nothing was sent again.' };
          }
        }
      } else if (entry.kind === 'mcp_call') {
        const cp = JSON.parse(entry.payload_json) as McpCallProposal;
        if (action === 'u') {
          out = { toast: "Can't be undone", message: 'An MCP call cannot be undone from here. Nothing was reversed.' };
        } else if (!deps.mcpCall) {
          out = { toast: 'MCP is not set up', message: 'I could not run that because MCP execution is not set up on this Waldo yet.' };
        } else {
          try {
            const receipt = await effect(`${operationRef}:apply`, 'call_mcp_tool', cp, async () => { const result = await deps.mcpCall!(cp,{id:`approval:${id}:apply`}); if (typeof result !== 'string') return result; if (deps.effects) throw new EffectUnknownError(); return { provider_id: `${operationRef}:apply`, result }; }, async () => ({ status: 'unknown' }));
            const outcome = String(receipt.result);
            setStatus(id, 'done');
            out = { toast: 'Done', message: `Done: ${describeMcp(cp)}. ${outcome}` };
          } catch (error) {
            const recorded = deps.effects?.get(`${operationRef}:apply`);
            if(recorded && recorded.state !== 'rejected') {setStatus(id,'uncertain');return {toast:'Outcome unknown',message:'The MCP outcome is unknown. Check the result before retrying; nothing was run again.'};}
            if(error instanceof EffectUnknownError || error instanceof ProxyIntentError || (error instanceof GoogleError && error.message==='intent_pending')) {setStatus(id,'uncertain');return {toast:'Outcome unknown',message:'The MCP outcome is unknown. Check it before retrying; nothing was run again.'};}
            setStatus(id, 'failed');
            out = { toast: 'That failed', message: `The call failed (${error instanceof Error ? error.message : String(error)}). Nothing else ran - ask me to try again.` };
          }
        }
      } else {
        const client = await deps.google({id:`approval:${id}:${action==='u'?'undo':'apply'}`,requireRoute:action==='u'||proposal.action!=='create'},'calendar',proposal.account);
        if (client === null || (proposal.account && client.account?.email?.toLowerCase() !== proposal.account.toLowerCase())) {
          out = { toast: 'Google is not connected', message: 'I could not do that because Google is not connected.' };
        } else if (action === 'a') {
          const eventId = proposal.action === 'create' ? await sha256Hex(`${operationRef}:apply`) : proposal.event_id!;
          const marker = await sha256Hex(`${operationRef}:apply`);
          const receipt = await effect(`${operationRef}:apply`, 'calendar_change', proposal, async () => {
            const undo = await apply(client, proposal, deps.effects ? eventId : undefined, marker);
            return { provider_id: eventId, result: undo };
          }, async () => {
            try {
              const current = await client.event(eventId);
              if (current.operation_marker !== marker) return {status:'unknown'};
              if (proposal.action !== 'cancel' && current.status !== 'cancelled' && (proposal.action !== 'create' || current.title === proposal.title) && sameInstant(current.start, proposal.start!) && sameInstant(current.end, proposal.end!) && current.etag
                && (!proposal.seen_etag || current.etag !== proposal.seen_etag)) {
                // A marker can survive a later owner edit. Recovery proves the effect, but
                // cannot establish the exact applied ETag needed for safe Undo.
                return { status: 'done', receipt: { provider_id: current.id, result: null } };
              }
              if (proposal.action === 'cancel' && current.status === 'cancelled') return { status: 'done', receipt: { provider_id: eventId, result: null } };
            } catch (error) {
              deps.log({ trace, hop: 'calendar_readback', ms: 0, ok: false, error: String(error) });
            }
            return { status: 'unknown' };
          });
          const undo = receipt.result as Undo | 'stale' | null;
          if (undo === 'stale') {
            setStatus(id, 'stale');
            out = { toast: 'The event changed', message: `The event changed in your calendar after I proposed this, so I didn't apply it: ${describe(proposal)}. Ask me again and I'll look at the new version.` };
          } else {
            setStatus(id, 'done', undo);
            out = { toast: 'Done', message: `Done: ${describe(proposal)}.${undo ? ' Undo is available for 10 minutes.' : " This one can't be undone from here."}` };
          }
        } else if (entry.undo_json && entry.decided_at !== null && (recovering || deps.now() - entry.decided_at <= UNDO_WINDOW_MS)) {
          const undo = JSON.parse(entry.undo_json) as Undo;
          const marker = await sha256Hex(`${operationRef}:undo`);
          const receipt = await effect(`${operationRef}:undo`, 'calendar_undo', undo,
            async () => ({ provider_id: undo.id, result: await revert(client, undo, marker) }), async () => {
              try {
                const current = await client.event(undo.id);
                if (current.operation_marker === marker && (undo.op === 'cancel' ? current.status === 'cancelled' : current.status !== 'cancelled' && current.start === undo.start && current.end === undo.end))
                  return {status:'done',receipt:{provider_id:undo.id,result:'undone'}};
              } catch (error) { deps.log({trace,hop:'calendar_undo_readback',ms:0,ok:false,error:String(error)}); }
              return {status:'unknown'};
            });
          const result = receipt.result as 'undone' | 'stale' | 'unavailable';
          if (result === 'undone') {
            setStatus(id, 'undone');
            out = { toast: 'Undone', message: `Undone: ${describe(proposal)}.` };
          } else if (result === 'stale') {
            out = { toast: 'The event changed', message: "The event changed after I applied this, so I didn't undo it. Your calendar was left as it is." };
          } else {
            out = { toast: "Can't be undone", message: 'I cannot safely undo this because its applied calendar version is unavailable. Nothing was reversed.' };
          }
        } else if (!entry.undo_json) {
          out = { toast: "Can't be undone", message: 'This calendar change cannot be safely undone from here. Nothing was reversed.' };
        } else {
          out = { toast: 'Too late to undo', message: 'The 10-minute undo window has passed, so I left it as it is.' };
        }
      }
      deps.log({ trace, hop: `approval_${action}`, ms: deps.now() - started, ok: true, detail: id });
      return out;
    } catch (error) {
      // A late duplicate failure cannot replace a confirmed Undo receipt.
      if (action === 'u' && row(id)?.status === 'undone') return { toast: 'Already handled.', message: 'Already handled.' };
      const durable = deps.effects?.get(`${operationRef}:${action === 'u' ? 'undo' : 'apply'}`);
      if(durable?.state === 'attempting' || durable?.state === 'unknown' || error instanceof EffectUnknownError || error instanceof ProxyIntentError || (error instanceof GoogleError && error.message==='intent_pending')) { if (action === 'u' && entry.kind === 'calendar_change') sql.exec("UPDATE ledger SET status = 'uncertain' WHERE id = ?", id); else setStatus(id,'uncertain');return {toast:'Outcome unknown',message:'The operation outcome is unknown. Check the result before retrying; nothing was run again.'}; }
      deps.log({ trace, hop: `approval_${action}`, ms: deps.now() - started, ok: false, error: String(error) });
      return { toast: 'That failed', message: `That didn't work: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  // Once a decision moves a row off its cards, every card is retired: durably first, then the
  // messaging buttons are cleared outside any transaction. The tapped card already cleared its own.
  const retire = async (id: string, via: ApprovalVia) => {
    const live = sql.exec<{ surface: string; message_ref: string }>('SELECT surface, message_ref FROM approval_presentations WHERE approval_id = ? AND retired_at IS NULL', id).toArray();
    sql.exec('UPDATE approval_presentations SET retired_at = ? WHERE approval_id = ? AND retired_at IS NULL', deps.now(), id);
    for (const p of live) {
      if (p.surface === 'app' || p.surface === 'legacy' || (p.surface === via.surface && p.message_ref === via.messageRef)) continue;
      await deps.retire?.({ surface: p.surface, message_ref: p.message_ref }).catch(() => deps.log({ trace: id, hop: 'approval_retire', ms: 0, ok: false, code: 'retire_failed' }));
    }
  };
  const decideOnce = async (id: string, action: DeskAction, trace: string, via: ApprovalVia = { surface }): Promise<ApprovalDecision> => {
    const before = row(id)?.status;
    const out = await decide(id, action, trace, via);
    if ((before === 'open' || before === 'review_only') && row(id)?.status !== before) await retire(id, via);
    return out;
  };
  const raising = new Set<string>();
  const waitingRow = (entry: LedgerRow) => PROPOSAL_KINDS.includes(entry.kind) && entry.id.startsWith('p') && (entry.status === 'open' || entry.status === 'review_only');
  return {
    decide: decideOnce,
    waiting() {
      return sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status IN ('open', 'review_only') ORDER BY created_at").toArray()
        .filter(entry => waitingRow(entry) && !expired(entry, JSON.parse(entry.payload_json) as Stored))
        .map(entry => ({ approval_id: entry.id, kind: entry.kind, summary: summaryOf(entry), state: entry.status as 'open' | 'review_only', put_off: entry.deferred_at != null }));
    },
    async reraise(id) {
      const entry = row(id);
      if (!entry || !waitingRow(entry)) return { outcome: 'not_waiting' };
      if (raising.has(id)) return { outcome: 'not_put_off' };
      if (expired(entry, JSON.parse(entry.payload_json) as Stored)) {
        setStatus(id, 'expired');
        await retire(id, { surface });
        return { outcome: 'expired' };
      }
      if (entry.deferred_at == null) return { outcome: 'not_put_off' };
      raising.add(id);
      try {
        const runRef = deps.appReplyRef?.();
        const shown = await present(id, { runRef });
        return { outcome: 'raised', shown_on: [...new Set(shown.map(s => s.surface))], on_this_reply: surface === 'app' && runRef !== undefined };
      } catch {
        deps.log({ trace: id, hop: 'approval_raise', ms: 0, ok: false, code: 'unshown' });
        return { outcome: 'unshown' };
      } finally { raising.delete(id); }
    },
    async proposeGoogleTaskChange(args, operationRef, ctx) {
      const originRunRef = deps.currentRunRef?.();
      if (!deps.googleTasks || !deps.effects) throw new Error('Google task approval custody is unavailable');
      args = proposeGoogleTaskChangeArgsSchema.parse(args);
      if (operationRef) {
        const prior = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE kind = 'google_task_change' AND json_extract(payload_json, '$.operation_ref') = ?", operationRef).toArray()[0];
        if (prior) {
          const stored = googleTaskProposalSchema.parse(JSON.parse(prior.payload_json));
          if (JSON.stringify(stored.args) !== JSON.stringify(args)) throw new Error('Google task operation identity reused');
          if (prior.status === 'open') return prior.id;
          throw new Error('Google task proposal already handled or delivery unconfirmed');
        }
      }
      const id = `p${deps.newId()}`;
      const proposal = googleTaskProposalSchema.parse({ ...await deps.googleTasks().prepare(id, args, ctx), ...(operationRef ? { operation_ref: operationRef } : {}) });
      const digest = await sha256Hex(JSON.stringify(proposal));
      if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
      const summary = describeGoogleTaskChange(proposal);
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at, proposal_digest) VALUES (?, 'google_task_change', 'card_unconfirmed', ?, ?, NULL, ?, NULL, ?)", id, summary, JSON.stringify(proposal), deps.now(), digest);
      bindOrigin(id, originRunRef);
      await present(id);
      return id;
    },
    async proposeBrowserSubmit(payload) {
      const originRunRef = deps.currentRunRef?.();
      const id = `p${deps.newId()}`;
      const summary = describeBrowser(payload);
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, 'browser_submit', 'card_unconfirmed', ?, ?, NULL, ?, NULL)", id, summary, JSON.stringify(payload), deps.now());
      bindOrigin(id, originRunRef);
      await present(id);
      return id;
    },
    async proposeSendEmail(payload) {
      // The turn/content key binds ingress retries; Message-ID is the fallback for exact desk
      // retries. A prior card whose delivery is unknown is not issued again blindly:
      // duplicate cards could each approve one effect.
      const originRunRef = deps.currentRunRef?.();
      const prior = payload.dedupe_key
        ? sql.exec<LedgerRow>("SELECT * FROM ledger WHERE kind = 'email_send' AND json_extract(payload_json, '$.dedupe_key') = ? ORDER BY created_at DESC LIMIT 1", payload.dedupe_key).toArray()[0]
        : sql.exec<LedgerRow>("SELECT * FROM ledger WHERE kind = 'email_send' AND json_extract(payload_json, '$.message_id') = ? ORDER BY created_at DESC LIMIT 1", payload.message_id).toArray()[0];
      if (prior) {
        if (emailContent(JSON.parse(prior.payload_json) as EmailSendProposal) !== emailContent(payload)) throw new EmailProposalError('identifier_reused');
        if (prior.status === 'open' || prior.status === 'review_only') return prior.id;
        if (prior.status === 'card_unconfirmed') throw new EmailProposalError('card_unconfirmed');
        throw new EmailProposalError('already_handled');
      }
      // A new turn may ask for the same email again. It is the owner's call, so the card says when an identical
      // send's outcome is still unknown instead of refusing.
      const unknown = sql.exec<{ payload_json: string; decided_at: number | null }>("SELECT payload_json, decided_at FROM ledger WHERE kind = 'email_send' AND status = 'uncertain' AND json_extract(payload_json, '$.subject') = ? ORDER BY decided_at DESC", payload.subject).toArray()
        .find(earlier => emailContent(JSON.parse(earlier.payload_json) as EmailSendProposal) === emailContent(payload));
      if (unknown?.decided_at != null) payload = { ...payload, earlier_unknown_at: when(new Date(unknown.decided_at).toISOString()) };
      const id = `p${deps.newId()}`;
      const summary = describeEmail(payload);
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, 'email_send', 'card_unconfirmed', ?, ?, NULL, ?, NULL)", id, summary, JSON.stringify(payload), deps.now());
      bindOrigin(id, originRunRef);
      let shown: Awaited<ReturnType<typeof present>>;
      try {
        shown = await present(id);
      } catch {
        // A timeout can mean the card arrived. Leave it unapprovable until reconciled;
        // never say a card was delivered or attempt a second blind send.
        throw new EmailProposalError('card_unconfirmed');
      }
      const card = shown.find(s => s.surface === surface && s.surface !== 'app');
      if (!card) return id;
      const url = await deps.reviewUrl?.().catch(() => null);
      const detail = url ? ` View details: ${url}. This page cannot approve email sends.` : '';
      const inApp = deps.appLink && shown.some(s => s.surface === 'app' && s.approvable);
      const receipt = card.approvable
        ? 'Email ready for review. The card above has the exact recipients, subject and body. If it is right, use the Send it instruction on that card. Nothing has been sent.'
        : inApp ? `The email is too long to approve from its chat card. No Send it approval was offered here and nothing has been sent. Review and approve it in the Waldo app: ${deps.appLink!(id)}`
          : 'The email is too long to approve from its chat card. No Send it approval was offered and nothing has been sent. Ask me for a shorter version or a draft to review.';
      try {
        await say(`${receipt}${detail}`);
      } catch {
        // The card itself is already the full review. A failed secondary receipt must not
        // make the model claim the proposal failed or recreate a duplicate card.
        deps.log({ trace: id, hop: 'email_review_receipt', ms: 0, ok: false, code: 'send_failed' });
      }
      return id;
    },
    async proposeSendMessage(payload) {
      const originRunRef = deps.currentRunRef?.();
      const id = `p${deps.newId()}`;
      const summary = describeMessage(payload);
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, 'message_send', 'card_unconfirmed', ?, ?, NULL, ?, NULL)", id, summary, JSON.stringify(payload), deps.now());
      bindOrigin(id, originRunRef);
      await present(id);
      return id;
    },
    async proposeMcpCall(payload) {
      const originRunRef = deps.currentRunRef?.();
      const id = `p${deps.newId()}`;
      const summary = describeMcp(payload);
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, 'mcp_call', 'card_unconfirmed', ?, ?, NULL, ?, NULL)", id, summary, JSON.stringify(payload), deps.now());
      bindOrigin(id, originRunRef);
      await present(id);
      return id;
    },
    async propose(p, turnKey, operationRef) {
      const originRunRef = deps.currentRunRef?.();
      if (proposalTurn !== turnKey) { calendarProposals.clear(); proposalTurn = turnKey; }
      const digest = turnKey === undefined ? undefined : await sha256Hex(JSON.stringify(
        Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))),
      ));
      const existing = digest === undefined ? undefined : calendarProposals.get(digest);
      if (existing) {
        const id = await existing;
        const entry = row(id);
        if (entry?.status === 'open' && !expired(entry, JSON.parse(entry.payload_json) as Stored)) return id;
      }
      const prepare = async () => {
        const id = `p${deps.newId()}`;
        const client = await deps.google({id:`approval:${id}:apply`},'calendar',p.account);
        if((p.event_id || p.account)&&!client)throw new Error('The calendar account is unavailable; no proposal was prepared.');
        if (p.account && client?.account?.email?.toLowerCase() !== p.account.toLowerCase()) throw new Error('Selected calendar account is unavailable');
        const bound = { ...p, ...(client?.account?.email ? {account:client.account.email} : {}) };
        const before = client && bound.event_id ? await client.event(bound.event_id) : undefined;
        const seen = before?.etag;
        const seenTime = before && !before.all_day && before.start && before.end ? { seen_start: before.start, seen_end: before.end } : {};
        const stored: Stored = { ...bound, ...(seen ? { seen_etag: seen } : {}), ...seenTime, ...(operationRef ? { operation_ref: operationRef } : {}) };
        const summary = `${describe(stored)}. ${bound.reason}`;
        sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, 'calendar_change', 'card_unconfirmed', ?, ?, NULL, ?, NULL)", id, summary, JSON.stringify(stored), deps.now());
        bindOrigin(id, originRunRef);
        await present(id);
        return id;
      };
      const pending = prepare();
      if (digest !== undefined) calendarProposals.set(digest, pending);
      try { return await pending; }
      catch (error) {
        if (digest !== undefined && calendarProposals.get(digest) === pending) calendarProposals.delete(digest);
        throw error;
      }
    },
    record(kind, summary, payload) {
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, ?, 'done', ?, ?, NULL, ?, ?)", `l${deps.newId()}`, kind, summary, JSON.stringify(payload), deps.now(), deps.now());
    },
    // The console must show the *stored* recipient, words and final calendar effect before
    // offering an approval action. Never expose raw MIME, tokens or arbitrary MCP args here.
    pending(now) {
      const open = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'open' ORDER BY created_at").toArray();
      const unconfirmed = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE kind IN ('email_send', 'google_task_change') AND status = 'card_unconfirmed' ORDER BY created_at").toArray();
      const reviewOnly = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'review_only' ORDER BY created_at").toArray();
      const undoable = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'done' AND undo_json IS NOT NULL AND decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT 5").toArray();
      const review = (r: LedgerRow): ApprovalReview | null => {
        try {
          if (r.kind === 'email_send') {
            const p = JSON.parse(r.payload_json) as EmailSendProposal;
            if (!Array.isArray(p.to) || !p.to.length || !p.to.every((address) => typeof address === 'string') || !Array.isArray(p.cc ?? []) || !Array.isArray(p.bcc ?? []) || !(p.cc ?? []).every((address) => typeof address === 'string') || !(p.bcc ?? []).every((address) => typeof address === 'string') || typeof p.subject !== 'string' || typeof p.body !== 'string') return null;
            return { kind: 'email_send', ...(p.account ? {account:p.account} : {}), to: p.to, cc: p.cc ?? [], bcc: p.bcc ?? [], subject: p.subject, body: p.body };
          }
          if (r.kind === 'message_send') {
            const p = JSON.parse(r.payload_json) as MessageSendProposal;
            return typeof p.channel === 'string' && typeof p.content === 'string' ? { kind: 'message_send', channel: p.channel, content: p.content } : null;
          }
          if (r.kind === 'google_task_change') {
            const proposal = googleTaskProposalSchema.parse(JSON.parse(r.payload_json));
            return r.proposal_digest ? { kind: 'google_task_change', account: proposal.account.email, proposal, proposal_digest: r.proposal_digest } : null;
          }
          if (r.kind === 'calendar_change') {
            const p = JSON.parse(r.payload_json) as Stored;
            if (!['create', 'move', 'cancel'].includes(p.action) || typeof p.reason !== 'string') return null;
            if (p.action === 'create' && (!p.title || !p.start || !p.end)) return null;
            if (p.action === 'move' && (!p.event_id || !p.title || !p.start || !p.end)) return null;
            if (p.action === 'cancel' && (!p.event_id || !p.title)) return null;
            return { kind: 'calendar_change', ...(p.account ? {account:p.account} : {}), action: p.action, title: p.title ?? null, event_id: p.event_id ?? null, start: p.start ?? null, end: p.end ?? null, reason: p.reason };
          }
          return null;
        } catch { return null; }
      };
      return [
        ...open.map((r) => ({ id: r.id, kind: r.kind, summary: summaryOf(r), state: 'open' as const, undoable: false, review: review(r) })),
        ...unconfirmed.map((r) => ({ id: r.id, kind: r.kind, summary: summaryOf(r), state: 'unconfirmed' as const, undoable: false, review: review(r) })),
        ...reviewOnly.map((r) => ({ id: r.id, kind: r.kind, summary: summaryOf(r), state: 'review_only' as const, undoable: false, review: review(r) })),
        ...undoable.map((r) => ({ id: r.id, kind: r.kind, summary: summaryOf(r), state: 'done' as const, undoable: r.decided_at !== null && now - r.decided_at <= UNDO_WINDOW_MS, review: review(r) })),
      ];
    },
    placement(id) {
      const shown = sql.exec<{ surface: string; approvable: number }>('SELECT surface, approvable FROM approval_presentations WHERE approval_id = ?', id).toArray();
      const entry = row(id), appFull = !!entry && appShowsInFull(entry);
      const on = (where: string, approvable = false) => shown.some(p => p.surface === where && (!approvable || p.approvable === 1 && (where !== 'app' || appFull)));
      return { here: on(surface), hereApprovable: on(surface, true), app: on('app'), appApprovable: on('app', true) };
    },
    async approvals(now, filter = {}) {
      const statuses = filter.state ? (Object.keys(APP_APPROVAL_STATE) as DeskStatus[]).filter(status => APP_APPROVAL_STATE[status] === filter.state) : null;
      if (statuses?.length === 0) return [];
      // The default list leaves out an approval the owner put off, while it is still open or review-only; any decision
      // that moves the row ends the deferral.
      const standing = !filter.id && !filter.state ? ["NOT (deferred_at IS NOT NULL AND status IN ('open', 'review_only'))"] : [];
      const where = [`kind IN (${PROPOSAL_KINDS.map(() => '?').join(', ')})`, "substr(id, 1, 1) = 'p'", ...(filter.id ? ['id = ?'] : []), ...(statuses ? [`status IN (${statuses.map(() => '?').join(', ')})`] : []), ...standing];
      const rows = sql.exec<LedgerRow>(`SELECT * FROM ledger WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 100`, ...PROPOSAL_KINDS, ...(filter.id ? [filter.id] : []), ...(statuses ?? [])).toArray();
      const items = await Promise.all(rows.map(entry => project(entry, now).catch(() => {
        deps.log({ trace: entry.id, hop: 'approval_projection', ms: 0, ok: false, code: 'dropped' });
        return null;
      })));
      return items.filter((item): item is AppApprovalV1 => item !== null);
    },
    async callback(query, trace) {
      const [action = '', id] = (query.data ?? '').split(':');
      const answer = (text: string) => deps.call('answerCallbackQuery', { callback_query_id: query.id, text }).catch(() => undefined);
      if (query.from.id !== deps.owner || !id || !['a', 's', 'e', 'u', 'd'].includes(action)) return void (await answer('Not available.'));
      if (query.message) await deps.call('editMessageReplyMarkup', { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      const messageRef = query.message ? `${query.message.chat.id}:${query.message.message_id}` : undefined;
      const out = await decideOnce(id, action as DeskAction, trace, { surface, ...(messageRef ? { messageRef } : {}) });
      // Not now leaves the card decidable: it keeps the buttons that still move the approval, also when it was already put off.
      const current = action === 'd' && query.message ? row(id) : undefined;
      const deferred = current && waitingRow(current) && current.deferred_at != null ? current : undefined;
      const stillPutOff = deferred !== undefined && out.toast === 'Already handled.';
      const tapped = deferred ? sql.exec<{ approvable: number }>('SELECT approvable FROM approval_presentations WHERE approval_id = ? AND surface = ? AND message_ref = ? AND retired_at IS NULL', id, surface, messageRef!).toArray()[0] : undefined;
      if (deferred && tapped) await deps.call('editMessageReplyMarkup', { chat_id: query.message!.chat.id, message_id: query.message!.message_id, reply_markup: { inline_keyboard: [(tapped.approvable === 1 ? buttonsFor(deferred) : laterButtons(id, false)).map(([text, data]) => ({ text, callback_data: data }))] } }).catch(() => deps.log({ trace: id, hop: 'approval_defer_card', ms: 0, ok: false, code: 'rerender_failed' }));
      // An uncertain card may have reached the owner before a channel timeout. It has
      // no valid send approval until reconciled, so tell the owner what to do next.
      const unconfirmedRow = out.toast === 'Already handled.' ? row(id) : undefined;
      const reported = unconfirmedRow?.status === 'card_unconfirmed'
        ? { toast: 'Review not confirmed', message: unconfirmedRow.kind === 'email_send'
          ? 'That review card was not confirmed, so I cannot use its Send it instruction. No email was sent. Check this chat and ask for a fresh proposal if you still want the email.'
          : 'That approval card was not confirmed, so I cannot use its button. Nothing was done. Check this chat and ask for a fresh proposal if you still want it.' }
        : out;
      // The desk's skip toast names the old button; on Telegram the owner tapped Don't do this.
      await answer(stillPutOff ? 'Already put off' : action === 's' && reported.toast === 'Not now' ? 'Skipped' : reported.toast);
      await say(stillPutOff ? 'It is already put off for later, and still waiting.' : reported.message, action === 'a' && out.toast === 'Done' && out.message.includes('Undo is available') ? [['Undo', `u:${id}`]] : undefined);
    },
    ledger(reminders) {
      const open = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status IN ('open', 'changing') ORDER BY created_at").toArray();
      const unconfirmed = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE kind IN ('email_send', 'browser_submit', 'message_send', 'mcp_call', 'calendar_change') AND status = 'card_unconfirmed' ORDER BY created_at").toArray();
      const reviewOnly = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'review_only' ORDER BY created_at").toArray();
      const done = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status NOT IN ('open', 'changing', 'card_unconfirmed', 'review_only') ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 8").toArray();
      const lines = [
        'Open',
        ...(open.length || unconfirmed.length || reviewOnly.length ? open.map((r) => `- ${summaryOf(r)} (waiting on you${r.deferred_at != null ? '; put off for later' : ''})`) : ['- nothing waiting on you']),
        ...unconfirmed.map((r) => `- ${summaryOf(r)} (review card delivery unconfirmed; cannot approve)`),
        ...reviewOnly.map((r) => `- ${summaryOf(r)} (too long for approval card; cannot send)`),
        '', 'Reminders',
        ...(reminders.length ? reminders.map((r) => `- ${r.at.replace('T', ' ')} ${r.note}${r.repeat === 'daily' ? ' (daily)' : ''}`) : ['- none set']),
        '', 'Recent',
        ...(done.length ? done.map((r) => `- ${r.status}: ${summaryOf(r)}`) : ['- nothing yet']),
      ];
      return lines.join('\n');
    },
  };
};

// The app cards presented for one run, rendered from their ledger rows, for the history view of the
// assistant reply to that run. Only a live approval (undecided, card not retired) is carried as a
// part; every card's fallback text stays available so the reply never reads blank. The current
// state of each approval comes from the approvals list. One row that cannot render drops only its card.
export type AppApprovalCards = Readonly<{ live: readonly AppApprovalPart[]; fallbacks: readonly string[] }>;
export const appApprovalParts = (sql: SqlStorage) => (parentId: string): AppApprovalCards => {
  if (!sql.exec('PRAGMA table_info(approval_presentations)').toArray().length) return { live: [], fallbacks: [] };
  const live: AppApprovalPart[] = [], fallbacks: string[] = [];
  let dropped = 0;
  for (const entry of sql.exec<LedgerRow & { approvable: number; payload_digest: string; retired_at: number | null }>("SELECT l.*, p.approvable, p.payload_digest, p.retired_at FROM approval_presentations p JOIN ledger l ON l.id = p.approval_id WHERE p.surface = 'app' AND p.message_ref = ? ORDER BY p.presented_at, l.id", `run:${parentId}`).toArray()) {
    try {
      const approvable = entry.status === 'open' && entry.approvable === 1 && appShowsInFull(entry);
      const part = replyApprovalPartV1Schema.safeParse(appPartOf(entry, { actions: withDefer(entry, approvable ? approveActions(entry) : ['skip']), payload_digest: entry.payload_digest }));
      if (!part.success) { dropped++; continue; }
      fallbacks.push(part.data.fallback_text);
      if (entry.retired_at === null && (entry.status === 'open' || entry.status === 'review_only')) live.push(part.data);
    } catch { dropped++; }
  }
  if (dropped) console.error(JSON.stringify({ hop: 'app_approval_parts', ok: false, dropped }));
  return { live, fallbacks };
};
