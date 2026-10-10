import { EffectUnknownError, type OwnerEffectLedger, type EffectReceipt, type EffectReadback } from './owner-effect-ledger';
import type { ProxyIntent } from '../connectors/proxy-intent';
import { ProxyIntentError } from '../connectors/proxy-intent';
import { googleTaskProposalSchema, proposeGoogleTaskChangeArgsSchema, type BrowserTaskContinuation, type ProposeCalendarChangeArgs, type ProposeGoogleTaskChangeArgs } from '@waldo/contracts';
import { GoogleError, sha256Hex, verifiedSent, type GoogleClient } from '../connectors/google';
import { describeGoogleTaskChange, googleTaskExact, reviewGoogleTaskChange, type GoogleTaskApprovalAdapter, type GoogleTaskProposal } from './google-task-approvals';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { BrowserSubmitOutcome } from '../tools/live/browser';
import type { TurnLogEntry } from './telegram-listener';
import { APP_REVIEW_MAX_CHARS, type AppApprovalPart } from './surfaces/app';
import { replyApprovalPartV1Schema } from '@waldo/contracts';
import type { AppApprovalStateV1, AppApprovalV1 } from '../../../contracts/src/app/approvals';

export type TelegramCall = (method: string, body: object) => Promise<unknown>;
export type CallbackQuery = Readonly<{ id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } }>;

type Undo = ({ op: 'cancel'; id: string } | { op: 'move'; id: string; start: string; end: string }) & { applied_etag?: string };
type LedgerRow = { id: string; kind: string; status: string; summary: string; payload_json: string; undo_json: string | null; created_at: number; decided_at: number | null; proposal_digest?: string | null; origin_run_ref?: string | null };
type DeskStatus = 'card_unconfirmed' | 'open' | 'review_only' | 'changing' | 'skipped' | 'expired' | 'done' | 'rejected' | 'failed' | 'stale' | 'uncertain' | 'unverified' | 'undone';
// One app state per desk status. An approval claimed before its effect resolves reads outcome_unknown, never done.
export const APP_APPROVAL_STATE: Readonly<Record<DeskStatus, AppApprovalStateV1>> = {
  card_unconfirmed: 'unconfirmed', open: 'open', review_only: 'review_only', changing: 'edit_requested', skipped: 'skipped', expired: 'expired',
  done: 'done', rejected: 'not_done', failed: 'not_done', stale: 'not_done', uncertain: 'outcome_unknown', unverified: 'outcome_unknown', undone: 'undone',
};
export class EmailProposalError extends Error {
  constructor(readonly reason: 'identifier_reused' | 'card_unconfirmed' | 'already_handled') { super(reason); }
}


export const UNDO_WINDOW_MS = 10 * 60_000;
export const PROPOSAL_TTL_MS = 12 * 60 * 60_000;

type Stored = ProposeCalendarChangeArgs & { seen_etag?: string; operation_ref?: string };

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
}>;
const BROWSER_SUBMIT_TTL_MS = 30 * 60_000;

// The gmail send rail's stored proposal: the canonical MIME bytes the owner approved plus the
// sha256 digest binding them. Approval replays payload.raw verbatim; a digest mismatch fails
// closed instead of sending; message_id reconciles an ambiguous send via Sent-mail lookup.
export type EmailSendProposal = Readonly<{
  operation_ref?: string;
  to: readonly string[]; cc?: readonly string[]; bcc?: readonly string[];
  account?: string; subject: string; body: string; inReplyTo?: string; references?: readonly string[]; thread_id?: string; message_id: string; raw: string; digest: string; dedupe_key?: string;
}>;

// send_message proposals (ADR-0054): the exact channel + content the owner approved, replayed
// verbatim on Send it; the idempotency key collapses a second approval onto the first send.
export type MessageSendProposal = Readonly<{ operation_ref?: string; channel: string; content: string; idempotency_key: string }>;

// call_mcp_tool proposals: server + tool + args replayed on approval. The result is external
// content - reported to the owner bounded, never re-entered into model context.
export type McpCallProposal = Readonly<{ operation_ref?: string; server: string; tool: string; args: Record<string, unknown> }>;

export type ApprovalDecision = Readonly<{ toast: string; message: string }>;
export type ApprovalSurface = 'telegram' | 'whatsapp' | 'app' | 'console';
// Where a decision came from. messageRef names the tapped card when the surface reports one.
export type ApprovalVia = Readonly<{ surface: ApprovalSurface; messageRef?: string }>;
export type ApprovalReview =
  | Readonly<{ kind: 'email_send'; account?: string; to: readonly string[]; cc: readonly string[]; bcc: readonly string[]; subject: string; body: string }>
  | Readonly<{ kind: 'message_send'; channel: string; content: string }>
  | Readonly<{ kind: 'google_task_change'; account: string; proposal: GoogleTaskProposal; proposal_digest: string }>
  | Readonly<{ kind: 'calendar_change'; account?: string; action: 'create' | 'move' | 'cancel'; title: string | null; event_id: string | null; start: string | null; end: string | null; reason: string }>;
export type ApprovalItem = Readonly<{ id: string; kind: string; summary: string; state: 'open' | 'done' | 'unconfirmed' | 'review_only'; undoable: boolean; review: ApprovalReview | null }>;
export type ApprovalDesk = Readonly<{
  propose(args: ProposeCalendarChangeArgs, turnKey?: string, operationRef?: string): Promise<string>;
  proposeGoogleTaskChange(args: ProposeGoogleTaskChangeArgs, operationRef?: string, ctx?: ToolDispatcherContext): Promise<string>;
  proposeBrowserSubmit(payload: BrowserSubmitProposal): Promise<string>;
  proposeSendEmail(payload: EmailSendProposal): Promise<string>;
  proposeSendMessage(payload: MessageSendProposal): Promise<string>;
  proposeMcpCall(payload: McpCallProposal): Promise<string>;
  record(kind: string, summary: string, payload: unknown): void;
  callback(query: CallbackQuery, trace: string): Promise<void>;
  decide(id: string, action: 'a' | 's' | 'e' | 'u', trace: string, via?: ApprovalVia): Promise<ApprovalDecision>;
  pending(now: number): readonly ApprovalItem[];
  approvals(now: number, filter?: Readonly<{ state?: AppApprovalStateV1; id?: string }>): Promise<readonly AppApprovalV1[]>;
  ledger(reminders: readonly Readonly<{ note: string; at: string; repeat: string }>[]): string;
}>;

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
  // The surface this desk's cards go out on. Every desk on the DO shares the ledger and its presentations.
  surface?: Exclude<ApprovalSurface, 'console'>;
  // The app's journaled copy of a card, or null when the owner has no app identity. Throws on a part that does not parse.
  appJournal?: (part: Omit<AppApprovalPart, 'type'>) => string | null;
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
  const presentationsExisted = sql.exec('PRAGMA table_info(approval_presentations)').toArray().length > 0;
  sql.exec(`CREATE TABLE IF NOT EXISTS approval_presentations (
    approval_id TEXT NOT NULL, surface TEXT NOT NULL, message_ref TEXT NOT NULL, presented_at INTEGER NOT NULL, approvable INTEGER NOT NULL,
    payload_digest TEXT NOT NULL, part_json TEXT, retired_at INTEGER, PRIMARY KEY (approval_id, surface, message_ref))`);
  // Cards opened before presentations were recorded stay decidable where they were shown; the app can only skip them.
  if (!presentationsExisted) sql.exec("INSERT INTO approval_presentations (approval_id, surface, message_ref, presented_at, approvable, payload_digest, part_json, retired_at) SELECT id, 'legacy', 'legacy', created_at, status = 'open', 'legacy', NULL, NULL FROM ledger WHERE status IN ('open', 'review_only')");
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
  const describe = (p: ProposeCalendarChangeArgs) => {
    const name = p.title ? `"${p.title}"` : 'the event';
    if (p.action === 'create') return `Add ${name}, ${when(p.start!)} to ${when(p.end!)}${p.account ? ` (${p.account})` : ''}`;
    if (p.action === 'move') return `Move ${name} to ${when(p.start!)} to ${when(p.end!)}${p.account ? ` (${p.account})` : ''}`;
    return `Cancel ${name}${p.account ? ` (${p.account})` : ''}`;
  };
  const row = (id: string) => sql.exec<LedgerRow>('SELECT * FROM ledger WHERE id = ?', id).toArray()[0];
  const setStatus = (id: string, status: DeskStatus, undo: Undo | null = null) =>
    sql.exec('UPDATE ledger SET status = ?, undo_json = ?, decided_at = ? WHERE id = ?', status, undo ? JSON.stringify(undo) : null, deps.now(), id);
  const say = (text: string, buttons?: [string, string][]) =>
    deps.call('sendMessage', { chat_id: deps.owner, text, ...(buttons ? { reply_markup: { inline_keyboard: [buttons.map(([label, data]) => ({ text: label, callback_data: data }))] } } : {}) });

  const describeBrowser = (p: BrowserSubmitProposal) => {
    const binding = Object.entries(p.binding).map(([k, v]) => `${k}: ${v}`).join(', ');
    return `${p.action.description} on ${p.url}${p.request ? ` via ${p.request.method} ${p.request.url}` : ''}${binding ? ` (${binding})` : ''}`;
  };
  const describeEmail = (p: EmailSendProposal) => `Send email${p.account ? ` from ${p.account}` : ''} to ${p.to.join(', ')}: "${p.subject}"`;
  const describeMessage = (p: MessageSendProposal) => `Send this on ${p.channel}: "${p.content.length > 120 ? `${p.content.slice(0, 117)}...` : p.content}"`;
  const describeMcp = (p: McpCallProposal) => `Run ${p.tool} on the ${p.server} MCP server`;

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
  const unreviewable = (kind: string, summary: string) =>
    `${kind} ${summary}\n\nThe full content doesn't fit in this card, so it can't be approved here - approving would send text you haven't reviewed. Use the Not now instruction on the card and ask me to show you the full text first.`;
  const expiresAt = (entry: LedgerRow) => {
    const p = JSON.parse(entry.payload_json) as Partial<Stored> & Partial<BrowserSubmitProposal>;
    if (entry.kind === 'browser_submit') return Math.min(entry.created_at + BROWSER_SUBMIT_TTL_MS, p.approvalExpiresAt ?? Infinity);
    return entry.kind === 'calendar_change' && p.start ? Math.min(entry.created_at + PROPOSAL_TTL_MS, Date.parse(p.start)) : entry.created_at + PROPOSAL_TTL_MS;
  };
  const DECISION = { a: 'approve', e: 'edit', s: 'skip' } as const;
  const CARDS: Readonly<Record<string, Readonly<{ title: string; approve: string; modify: boolean }>>> = {
    calendar_change: { title: 'Calendar change?', approve: 'Do it', modify: true }, google_task_change: { title: 'Google task change?', approve: 'Do it', modify: true },
    email_send: { title: 'Send this email?', approve: 'Send it', modify: true }, message_send: { title: 'Send this message?', approve: 'Send it', modify: true },
    browser_submit: { title: 'Approve this browser action?', approve: 'Do it', modify: false }, mcp_call: { title: 'Run this MCP tool?', approve: 'Do it', modify: false },
  };
  const PROPOSAL_KINDS = Object.keys(CARDS);
  const buttonsFor = (entry: LedgerRow): [string, string][] => {
    const card = CARDS[entry.kind]!;
    return [[card.approve, `a:${entry.id}`], ...(card.modify ? [['Modify', `e:${entry.id}`] as [string, string]] : []), ['Not now', `s:${entry.id}`]];
  };
  // The full review a card shows for each kind, rebuilt from the frozen payload; the app shows the same text.
  const reviewText = (entry: LedgerRow): string => {
    const p = JSON.parse(entry.payload_json);
    if (entry.kind === 'email_send') return `Send this email? ${reviewEmail(p)}`;
    if (entry.kind === 'message_send') return `Send this message on ${p.channel}?\n\n${reviewMessage(p)}`;
    if (entry.kind === 'mcp_call') return `Run this MCP tool? ${entry.summary}\n\nArgs:\n${JSON.stringify(p.args, null, 2)}`;
    if (entry.kind === 'browser_submit') return `Approve this browser action? ${entry.summary}`;
    if (entry.kind === 'google_task_change') return reviewGoogleTaskChange(googleTaskProposalSchema.parse(p));
    return `Proposed: ${entry.summary}`;
  };
  // What each kind changes, from the frozen payload, exposing no more than the review: never raw MIME, ids or MCP arguments.
  const exactFor = (entry: LedgerRow): AppApprovalV1['exact'] => {
    const p = JSON.parse(entry.payload_json);
    if (entry.kind === 'email_send') return { recipients: { to: p.to, cc: p.cc ?? [], bcc: p.bcc ?? [] }, ...(p.account ? { scope: p.account } : {}) };
    if (entry.kind === 'message_send') return { recipients: { to: [p.channel], cc: [], bcc: [] } };
    if (entry.kind === 'browser_submit') return { scope: p.url };
    if (entry.kind === 'mcp_call') return { scope: `${p.tool} on the ${p.server} server` };
    // v1 has no form for a cleared due date; such a row fails the item parse and stays decidable only where its card was shown.
    if (entry.kind === 'google_task_change') return { task: googleTaskExact(googleTaskProposalSchema.parse(p)) as NonNullable<AppApprovalV1['exact']['task']> };
    return { changes: { action: p.action, title: p.title ?? null, start: p.start ?? null, end: p.end ?? null } };
  };
  const sentRef = (sent: unknown) => {
    const ack = sent as { message_id?: unknown; chat?: { id?: unknown }; messages?: readonly { id?: unknown }[] } | null;
    if (ack?.message_id !== undefined) return `${String(ack.chat?.id ?? deps.owner)}:${String(ack.message_id)}`;
    return ack?.messages?.[0]?.id !== undefined ? String(ack.messages[0].id) : 'unreferenced';
  };
  // A row opens only once a surface recorded the review: the origin card's provider acknowledgement
  // and, when the owner has the app, its journaled copy. Approvability is per surface, by how much
  // review that surface can show. The presentation rows and the status flip commit together.
  const present = async (id: string) => {
    const entry = row(id)!;
    const card = reviewText(entry), buttons = buttonsFor(entry), title = CARDS[entry.kind]!.title;
    const digest = `sha256:${await sha256Hex(entry.payload_json)}`;
    const appApprovable = card.length <= APP_REVIEW_MAX_CHARS;
    const shown: { surface: string; message_ref: string; approvable: boolean; part_json: string | null }[] = [];
    let journalFailure: unknown, sendFailure: unknown, part: string | null = null;
    try {
      part = deps.appJournal?.({ approval_id: id, kind: entry.kind as AppApprovalPart['kind'], review: appApprovable ? card : unreviewable(title, entry.summary), payload_digest: digest,
        actions: appApprovable ? buttons.map(([, data]) => DECISION[data[0] as keyof typeof DECISION]) : ['skip'], expires_at: expiresAt(entry), fallback_text: entry.summary.slice(0, 4000) }) ?? null;
    } catch (error) {
      journalFailure = error;
      deps.log({ trace: id, hop: 'approval_app_journal', ms: 0, ok: false, error: String(error) });
    }
    if (surface !== 'app') {
      const approvable = card.length <= REVIEW_BUDGET;
      const link = part && appApprovable && deps.appLink ? ` You can review and approve it in the Waldo app: ${deps.appLink(id)}` : '';
      try {
        const sent = await say(approvable ? card : `${unreviewable(title, entry.summary)}${link}`, approvable ? buttons : [['Not now', `s:${id}`]]);
        if (sent == null) sendFailure = new Error('Approval card not confirmed');
        else shown.push({ surface, message_ref: sentRef(sent), approvable, part_json: null });
      } catch (error) { sendFailure = error; }
    }
    if (part) shown.push({ surface: 'app', message_ref: entry.origin_run_ref ? `run:${entry.origin_run_ref}` : `approval:${id}`, approvable: appApprovable, part_json: part });
    if (!shown.length) throw sendFailure ?? journalFailure ?? new Error('Approval card not confirmed');
    commit(() => {
      for (const s of shown) sql.exec('INSERT OR IGNORE INTO approval_presentations (approval_id, surface, message_ref, presented_at, approvable, payload_digest, part_json, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
        id, s.surface, s.message_ref, deps.now(), s.approvable ? 1 : 0, digest, s.part_json);
      sql.exec("UPDATE ledger SET status = ? WHERE id = ? AND status = 'card_unconfirmed'", shown.some(s => s.approvable) ? 'open' : 'review_only', id);
    });
    return shown;
  };
  // Approving or modifying needs a card that showed the full review on the deciding surface. The
  // console renders the stored review itself, so any full-review presentation serves it.
  const presentedTo = (id: string, via: ApprovalVia) => {
    const live = sql.exec<{ surface: string; message_ref: string; approvable: number }>('SELECT surface, message_ref, approvable FROM approval_presentations WHERE approval_id = ? AND retired_at IS NULL', id).toArray();
    if (via.surface === 'console') return live.some(p => p.approvable === 1);
    const mine = live.filter(p => p.surface === via.surface || (p.surface === 'legacy' && via.surface !== 'app'));
    const tapped = mine.filter(p => p.message_ref === via.messageRef);
    return (tapped.length ? tapped : mine).some(p => p.approvable === 1);
  };
  const notPresented = (id: string): ApprovalDecision => {
    const inApp = deps.appLink && sql.exec("SELECT 1 FROM approval_presentations WHERE approval_id = ? AND surface = 'app' AND approvable = 1 AND retired_at IS NULL", id).toArray().length > 0;
    return inApp
      ? { toast: 'Review it in the app', message: `That approval wasn't shown in full here, so it can't be approved here. Nothing was done. Review and approve it in the Waldo app: ${deps.appLink!(id)}` }
      : { toast: 'Not available here', message: "That approval wasn't shown in full here, so it can't be approved here. Nothing was done." };
  };
  // The app's view of a proposal: its current state, the review as the app was shown it (or as the
  // card shows it, for rows the app never journaled), and only decisions the desk accepts now.
  const project = async (entry: LedgerRow, now: number): Promise<AppApprovalV1> => {
    const shown = sql.exec<{ surface: string; approvable: number; part_json: string | null; retired_at: number | null }>('SELECT surface, approvable, part_json, retired_at FROM approval_presentations WHERE approval_id = ? ORDER BY presented_at, surface', entry.id).toArray();
    const inApp = shown.find(p => p.surface === 'app' && p.part_json !== null);
    const part = inApp ? JSON.parse(inApp.part_json!) as AppApprovalPart : null;
    const state = APP_APPROVAL_STATE[entry.status as DeskStatus];
    const full = reviewText(entry);
    const actions = state === 'open' ? (part && inApp!.approvable === 1 && inApp!.retired_at === null ? part.actions : ['skip'] as const)
      : state === 'review_only' ? ['skip'] as const
        : state === 'done' && entry.undo_json && entry.decided_at !== null && now - entry.decided_at <= UNDO_WINDOW_MS ? ['undo'] as const : [];
    const surfaces = [...new Set(shown.map(p => p.surface).filter(surface => surface !== 'legacy'))];
    return { approval_id: entry.id, kind: entry.kind as AppApprovalV1['kind'], state,
      review: part?.review ?? (full.length <= APP_REVIEW_MAX_CHARS ? full : unreviewable(CARDS[entry.kind]!.title, entry.summary)),
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

  const decide = async (id: string, action: 'a' | 's' | 'e' | 'u', trace: string, via: ApprovalVia = { surface }): Promise<ApprovalDecision> => {
    const started = deps.now();
    const entry = row(id);
    const operationRef = entry ? (JSON.parse(entry.payload_json) as { operation_ref?: string }).operation_ref ?? `approval:${id}` : `approval:${id}`;
    const expected = action === 'u' ? 'done' : 'open';
    if (entry?.status === 'review_only' && action === 's') {
      setStatus(id, 'skipped');
      return { toast: 'Not now', message: 'Left it. Nothing changed.' };
    }
    if (deps.effects?.isActive(`${operationRef}:${action === 'u' ? 'undo' : 'apply'}`)) return { toast: 'Already handled.', message: 'Already handled.' };
    // An uncertain row with no effect record never reached dispatch (the record is written before the provider call), so it is safe to run again; a record sends it through reconcile instead.
    const recovering = entry?.status === 'uncertain' && deps.effects !== undefined && (action === 'a' || action === 'u' && entry.kind === 'calendar_change' && !!entry.undo_json && !!deps.effects.get(`${operationRef}:undo`));
    if (entry?.status === 'uncertain' && entry.kind !== 'browser_submit' && action === 'a' && !recovering) return { toast: 'Outcome unknown', message: 'The outcome of that approval is unknown. Check the result before retrying; nothing was sent again.' };
    if (!entry || (entry.status !== expected && !recovering)) return { toast: 'Already handled.', message: 'Already handled.' };
    if ((action === 'a' || action === 'e') && entry.status === 'open' && !presentedTo(id, via)) return notPresented(id);
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
            try {
              await effect(`${operationRef}:apply`, 'send_email', ep, async () => {
                const sent = await client.sendRaw(ep.raw, ep.thread_id);
                const landed = await client.findSentByMessageId(ep.message_id, ep.thread_id);
                if (!verifiedSent(landed, ep.message_id, ep.thread_id) || landed.message_id !== sent.message_id) throw new EffectUnknownError();
                return { provider_id: landed.message_id, result: landed };
              }, async () => {
                const landed = await client.findSentByMessageId(ep.message_id, ep.thread_id);
                return verifiedSent(landed, ep.message_id, ep.thread_id) ? { status: 'done', receipt: { provider_id: landed.message_id, result: landed } } : { status: 'unknown' };
              });
              setStatus(id, 'done');
              out = { toast: 'Sent', message: `Sent: ${describeEmail(ep)}. This one can't be undone.` };
            } catch (error) {
              if (!deps.effects && !(error instanceof ProxyIntentError)) {
                const landed = await client.findSentByMessageId(ep.message_id, ep.thread_id).catch((readError) => { deps.log({ trace, hop: 'email_readback', ms: 0, ok: false, error: String(readError) }); return false; });
                if (verifiedSent(landed, ep.message_id, ep.thread_id)) { setStatus(id, 'done'); return { toast: 'Sent', message: `Sent: ${describeEmail(ep)}. Gmail confirmed it after a hiccup; it went out exactly once.` }; }
              }
              setStatus(id, 'uncertain');
              out = { toast: 'Outcome unknown', message: 'The send outcome is unknown. Check Gmail before retrying; nothing was sent again.' };
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
              if (proposal.action !== 'cancel' && current.status !== 'cancelled' && (proposal.action !== 'create' || current.title === proposal.title) && current.start === proposal.start && current.end === proposal.end && current.etag
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
  const decideOnce = async (id: string, action: 'a' | 's' | 'e' | 'u', trace: string, via: ApprovalVia = { surface }): Promise<ApprovalDecision> => {
    const before = row(id)?.status;
    const out = await decide(id, action, trace, via);
    if ((before === 'open' || before === 'review_only') && row(id)?.status !== before) await retire(id, via);
    return out;
  };
  return {
    decide: decideOnce,
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
        const was = JSON.parse(prior.payload_json) as EmailSendProposal;
        const semantic = ({ account, to, cc, bcc, subject, body, thread_id, inReplyTo, references }: EmailSendProposal) => JSON.stringify({ account, to, cc, bcc, subject, body, thread_id, inReplyTo, references });
        if (semantic(was) !== semantic(payload)) throw new EmailProposalError('identifier_reused');
        if (prior.status === 'open' || prior.status === 'review_only') return prior.id;
        if (prior.status === 'card_unconfirmed') throw new EmailProposalError('card_unconfirmed');
        throw new EmailProposalError('already_handled');
      }
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
        const summary = `${describe(bound)}. ${bound.reason}`;
        const before = client && bound.event_id ? await client.event(bound.event_id) : undefined;
        const seen = before?.etag;
        const stored: Stored = { ...bound, ...(seen ? { seen_etag: seen } : {}), ...(operationRef ? { operation_ref: operationRef } : {}) };
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
        ...open.map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, state: 'open' as const, undoable: false, review: review(r) })),
        ...unconfirmed.map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, state: 'unconfirmed' as const, undoable: false, review: review(r) })),
        ...reviewOnly.map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, state: 'review_only' as const, undoable: false, review: review(r) })),
        ...undoable.map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, state: 'done' as const, undoable: r.decided_at !== null && now - r.decided_at <= UNDO_WINDOW_MS, review: review(r) })),
      ];
    },
    async approvals(now, filter = {}) {
      const statuses = filter.state ? (Object.keys(APP_APPROVAL_STATE) as DeskStatus[]).filter(status => APP_APPROVAL_STATE[status] === filter.state) : null;
      if (statuses?.length === 0) return [];
      const where = [`kind IN (${PROPOSAL_KINDS.map(() => '?').join(', ')})`, "substr(id, 1, 1) = 'p'", ...(filter.id ? ['id = ?'] : []), ...(statuses ? [`status IN (${statuses.map(() => '?').join(', ')})`] : [])];
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
      if (query.from.id !== deps.owner || !id || !['a', 's', 'e', 'u'].includes(action)) return void (await answer('Not available.'));
      if (query.message) await deps.call('editMessageReplyMarkup', { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      const out = await decideOnce(id, action as 'a' | 's' | 'e' | 'u', trace, { surface, ...(query.message ? { messageRef: `${query.message.chat.id}:${query.message.message_id}` } : {}) });
      // An uncertain card may have reached the owner before a channel timeout. It has
      // no valid send approval until reconciled, so tell the owner what to do next.
      const unconfirmedRow = out.toast === 'Already handled.' ? row(id) : undefined;
      const reported = unconfirmedRow?.status === 'card_unconfirmed'
        ? { toast: 'Review not confirmed', message: unconfirmedRow.kind === 'email_send'
          ? 'That review card was not confirmed, so I cannot use its Send it instruction. No email was sent. Check this chat and ask for a fresh proposal if you still want the email.'
          : 'That approval card was not confirmed, so I cannot use its button. Nothing was done. Check this chat and ask for a fresh proposal if you still want it.' }
        : out;
      await answer(reported.toast);
      await say(reported.message, action === 'a' && out.toast === 'Done' && out.message.includes('Undo is available') ? [['Undo', `u:${id}`]] : undefined);
    },
    ledger(reminders) {
      const open = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status IN ('open', 'changing') ORDER BY created_at").toArray();
      const unconfirmed = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE kind IN ('email_send', 'browser_submit', 'message_send', 'mcp_call', 'calendar_change') AND status = 'card_unconfirmed' ORDER BY created_at").toArray();
      const reviewOnly = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'review_only' ORDER BY created_at").toArray();
      const done = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status NOT IN ('open', 'changing', 'card_unconfirmed', 'review_only') ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 8").toArray();
      const lines = [
        'Open',
        ...(open.length || unconfirmed.length || reviewOnly.length ? open.map((r) => `- ${r.summary} (waiting on you)`) : ['- nothing waiting on you']),
        ...unconfirmed.map((r) => `- ${r.summary} (review card delivery unconfirmed; cannot approve)`),
        ...reviewOnly.map((r) => `- ${r.summary} (too long for approval card; cannot send)`),
        '', 'Reminders',
        ...(reminders.length ? reminders.map((r) => `- ${r.at.replace('T', ' ')} ${r.note}${r.repeat === 'daily' ? ' (daily)' : ''}`) : ['- none set']),
        '', 'Recent',
        ...(done.length ? done.map((r) => `- ${r.status}: ${r.summary}`) : ['- nothing yet']),
      ];
      return lines.join('\n');
    },
  };
};

// The approval parts the app journaled for one run, exactly as presented: the history view of the
// assistant reply to that run. The current state of each approval comes from the approvals list.
export const appApprovalParts = (sql: SqlStorage) => (parentId: string): AppApprovalPart[] => {
  if (!sql.exec('PRAGMA table_info(approval_presentations)').toArray().length) return [];
  return sql.exec<{ part_json: string }>("SELECT part_json FROM approval_presentations WHERE surface = 'app' AND message_ref = ? AND part_json IS NOT NULL ORDER BY presented_at, approval_id", `run:${parentId}`).toArray()
    .flatMap(row => { const part = replyApprovalPartV1Schema.safeParse(JSON.parse(row.part_json)); return part.success ? [part.data] : []; });
};
