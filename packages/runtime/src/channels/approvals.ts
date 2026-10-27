import { EffectNotAppliedError, EffectUnknownError, type OwnerEffectLedger, type EffectReceipt, type EffectReadback } from './owner-effect-ledger';
import type { ProxyIntent } from '../connectors/proxy-intent';
import { ProxyIntentError } from '../connectors/proxy-intent';
import { McpRefusal, McpToolFailed } from '../connectors/mcp-connections';
import { googleTaskProposalSchema, proposeGoogleTaskChangeArgsSchema, type BrowserTaskContinuation, type ProposeCalendarChangeArgs, type ProposeGoogleTaskChangeArgs } from '@waldo/contracts';
import { GoogleError, b64url, buildMime, sendRefused, sentCheck, sha256Hex, type GoogleClient, type SentEvidence } from '../connectors/google';
import { stableJson } from '../context-composer/canonical';
import { describeGoogleTaskChange, googleTaskExact, reviewGoogleTaskChange, type GoogleTaskApprovalAdapter, type GoogleTaskProposal } from './google-task-approvals';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { BrowserSubmitOutcome } from '../tools/live/browser';
import type { TurnLogEntry } from './telegram-listener';
import { MASK, isCredentialKey, maskedUrl, maskedValue } from './secret-fields';
import { APP_REVIEW_MAX_CHARS, appApprovalPart, type AppApprovalPart } from './surfaces/app';
import { SEND_NOW_ONLY } from './delivery-routes';
import { carriesTopic, hidesTopic } from '../memory/forget-guard';
import { replyApprovalPartV1Schema } from '@waldo/contracts';
import { appApprovalExactV1Schema, appApprovalHealthV1Schema, appApprovalMessageV1Schema, appApprovalV1Schema, type AppApprovalStateV1, type AppApprovalV1 } from '../../../contracts/src/app/approvals';
import { appApprovalStepUp } from './approval-step-up';
import type { ApprovalActionV1 } from '../../../contracts/src/app/parts';

export type TelegramCall = (method: string, body: object) => Promise<unknown>;
export type CallbackQuery = Readonly<{ id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } }>;

type Undo = ({ op: 'cancel'; id: string } | { op: 'move'; id: string; start: string; end: string }) & { applied_etag?: string; calendar_id?: string; send_updates?: 'all' | 'none' };
// card_waits_on: the surface whose card for this request waits for the owner's next message there.
type LedgerRow = { id: string; kind: string; status: string; summary: string; payload_json: string; undo_json: string | null; created_at: number; decided_at: number | null; proposal_digest?: string | null; origin_run_ref?: string | null; deferred_at?: number | null; card_waits_on?: string | null };
// running: approved, and its frozen call waits for or runs on the jobs lane.
type DeskStatus = 'card_unconfirmed' | 'open' | 'review_only' | 'changing' | 'skipped' | 'expired' | 'running' | 'done' | 'rejected' | 'failed' | 'stale' | 'uncertain' | 'unverified' | 'undone';
// One app state per desk status. An approval claimed before its effect resolves reads outcome_unknown, never done.
export const APP_APPROVAL_STATE: Readonly<Record<DeskStatus, AppApprovalStateV1>> = {
  card_unconfirmed: 'unconfirmed', open: 'open', review_only: 'review_only', changing: 'edit_requested', skipped: 'skipped', expired: 'expired',
  running: 'outcome_unknown', done: 'done', rejected: 'not_done', failed: 'not_done', stale: 'not_done', uncertain: 'outcome_unknown', unverified: 'outcome_unknown', undone: 'undone',
};
// How an approved action that ran on the jobs lane ended, as its card records it.
export type ReplayCardStatus = 'done' | 'rejected' | 'failed' | 'uncertain' | 'skipped';
export class EmailProposalError extends Error {
  constructor(readonly reason: 'identifier_reused' | 'card_unconfirmed' | 'already_handled') { super(reason); }
}


const SENT_RESEARCHES = 2;
const SENT_RESEARCH_GAP_MS = 1_500;
export const UNDO_WINDOW_MS = 10 * 60_000;
export const PROPOSAL_TTL_MS = 12 * 60 * 60_000;

// seen_start/seen_end: the event's time when the card was made, so a move shows what it moves from.
// time_zone: the zone the review's times were written in.
type Stored = ProposeCalendarChangeArgs & { seen_etag?: string; seen_start?: string; seen_end?: string; seen_guests?: number; operation_ref?: string; time_zone?: string };

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
// Gmail is handed exactly the words the card shows: the frozen bytes carry their digest and are the canonical MIME of the
// shown recipients, subject and body, and the subject stays one header line (MIME would fold a line break into a space).
const emailIntact = async (p: EmailSendProposal): Promise<boolean> => {
  if (/[\r\n]/.test(p.subject) || await sha256Hex(p.raw) !== p.digest) return false;
  try {
    return p.raw === b64url(new TextEncoder().encode(buildMime({ to: p.to, ...(p.cc ? { cc: p.cc } : {}), ...(p.bcc ? { bcc: p.bcc } : {}), subject: p.subject, body: p.body,
      messageId: p.message_id, ...(p.inReplyTo ? { inReplyTo: p.inReplyTo } : {}), ...(p.references ? { references: p.references } : {}) })));
  } catch { return false; }
};
// What the owner would receive: two proposals with the same content send the same email.
const emailContent = ({ account, to, cc, bcc, subject, body, thread_id, inReplyTo, references }: EmailSendProposal) =>
  JSON.stringify({ account, to, cc, bcc, subject, body, thread_id, inReplyTo, references });

// send_message proposals (ADR-0054): the exact channel + content the owner approved, replayed
// verbatim on Send it; the idempotency key collapses a second approval onto the first send.
export type MessageSendProposal = Readonly<{ operation_ref?: string; channel: string; content: string; idempotency_key: string }>;

// call_mcp_tool proposals: server + tool + args replayed on approval. The result is external
// content - reported to the owner bounded, never re-entered into model context. For a server the owner
// connected, the card also freezes the connection and the tool definition's digest, and any answers the
// owner gave to the server's questions (questions holds the server's wording for the card).
export type McpCallProposal = Readonly<{
  operation_ref?: string; server: string; tool: string; args: Record<string, unknown>;
  connection?: string; tool_digest?: string;
  answers?: Readonly<{ handle: string; responses: Readonly<Record<string, unknown>> }>;
  questions?: readonly Readonly<{ id: string; message: string }>[];
}>;
const isToolError = (value: unknown): value is { tool_error: string } => typeof value === 'object' && value !== null && typeof (value as { tool_error?: unknown }).tool_error === 'string';
// The frozen identity of an MCP card: everything that decides what runs.
const mcpDigest = (p: McpCallProposal) => sha256Hex(stableJson({ server: p.server, tool: p.tool, args: p.args, connection: p.connection ?? null, tool_digest: p.tool_digest ?? null, answers: p.answers ?? null }));
// A privileged tool call whose arguments came from external content (ADR-0049), frozen for the owner's approval: the
// tool, its validated arguments and their digest. On approval the host replays exactly that call once.
// preview: what the call would change, read from the owner's own stores when it was proposed (the memories a forget
// removes, the loop a close ends).
// It is shown on the card and never replayed; the frozen args and their digest are what runs.
export type TaintedActionProposal = Readonly<{ operation_ref?: string; tool: string; args: Record<string, unknown>; args_digest: string; reasoning: string; source: 'external'; preview?: readonly string[] }>;
// What the replay could honestly establish: done means the handler ran and returned ok; rejected means the dispatcher
// refused before the handler ran; failed means the tool reported its own typed failure; uncertain is everything else.
export type TaintedActionOutcome = Readonly<{ status: 'done' | 'rejected' | 'failed' | 'uncertain'; message: string }>;

export type ApprovalDecision = Readonly<{ toast: string; message: string }>;
// An approved call the desk does not run inside the decision: the host's jobs lane runs it later, under its own run scope.
// enqueue runs inside the decision's commit, so the card is claimed exactly when its job exists.
export type DeferredReplay = Readonly<{
  takes(tool: string): boolean;
  enqueue(approvalId: string, call: Readonly<{ tool: string; args: Record<string, unknown>; args_digest: string }>): void;
  // Wakes the jobs lane once the commit has landed.
  wake(): Promise<void>;
}>;
// a approve, s skip, e edit, u undo, d defer ("Not now": the row stays open and keeps its cards).
export type DeskAction = 'a' | 's' | 'e' | 'u' | 'd';
export type ApprovalSurface = 'telegram' | 'whatsapp' | 'imessage' | 'app' | 'console';
// Where a decision came from. messageRef names the tapped card when the surface reports one.
export type ApprovalVia = Readonly<{ surface: ApprovalSurface; messageRef?: string }>;
export type ApprovalReview =
  | Readonly<{ kind: 'email_send'; account?: string; to: readonly string[]; cc: readonly string[]; bcc: readonly string[]; subject: string; body: string; earlier_unknown_at?: string }>
  | Readonly<{ kind: 'message_send'; channel: string; content: string }>
  // A tool or action approval: the same frozen review its card and the app show (tool, masked arguments, what approving runs).
  | Readonly<{ kind: 'mcp_call' | 'tainted_action' | 'browser_submit'; text: string }>
  | Readonly<{ kind: 'google_task_change'; account: string; proposal: GoogleTaskProposal; proposal_digest: string }>
  | Readonly<{ kind: 'calendar_change'; account?: string; action: 'create' | 'move' | 'cancel'; title: string | null; event_id: string | null; start: string | null; end: string | null; reason: string;
      calendar_id?: string; attendees?: readonly string[]; send_updates?: 'all' | 'none'; location?: string; description?: string; add_meet_link?: boolean }>;
// What a calendar invite carries beyond the event and its times. The web surfaces (console and dashboards) render
// the stored review themselves and do not show these in full, so a change carrying any of them is approved in chat or the app.
export const calendarInviteDetails = (p: Readonly<{ calendar_id?: string; attendees?: readonly string[]; send_updates?: string; location?: string; description?: string; add_meet_link?: boolean }>): boolean =>
  Boolean((p.calendar_id && p.calendar_id !== 'primary') || p.attendees?.length || p.send_updates || p.location || p.description || p.add_meet_link);
// Where a proposal's card landed, and where a card that can approve it landed: on the proposing desk's own surface and in the app.
// waitsHere: the card for this surface waits for the owner's next message there.
// handsToApp: this chat surface never approves the kind, so its card hands the approval to the app.
// numbered: this surface shows no buttons, so the card here is approved by the owner replying 1 or 2.
export type CardPlacement = Readonly<{ here: boolean; hereApprovable: boolean; app: boolean; appApprovable: boolean; waitsHere?: boolean; handsToApp?: boolean; numbered?: boolean }>;
const NUMBERED_STATUS = 'sent to the owner as its own message ahead of your reply; it asks them to reply 1 to approve or 2 to skip, and a bare 1 or 2 after your reply answers it. Do not offer numbered choices in your reply.';
// What a proposing tool tells the model about the card, so a reply never points at buttons that are not there.
export const proposalStatus = (placement: CardPlacement | undefined, shownHere: string, nothingDone: string): string =>
  !placement || placement.hereApprovable ? placement?.numbered ? NUMBERED_STATUS : shownHere
    : placement.handsToApp && !placement.appApprovable ? `It cannot be approved in chat, and the Waldo app cannot approve it either. ${nothingDone}`
    : placement.handsToApp && placement.here ? `The review is shown here, but it is approved only in the Waldo app; the card carries the link. ${nothingDone}`
    : placement.appApprovable ? `${placement.here ? 'The full review card is in the Waldo app; it could not be shown in full here.'
      : placement.waitsHere ? 'The review card is in the Waldo app; here it goes out when the owner next writes.' : 'The review card is in the Waldo app; it could not be shown here.'} ${nothingDone}`
      : placement.waitsHere ? `The review card goes out here when the owner next writes, so it cannot be approved yet. ${nothingDone}`
        : `Only a summary card could be shown, so it cannot be approved yet. ${nothingDone}`;
export type ApprovalItem = Readonly<{ id: string; kind: string; summary: string; state: 'open' | 'done' | 'unconfirmed' | 'review_only'; undoable: boolean; review: ApprovalReview | null }>;
export type WaitingApproval = Readonly<{ approval_id: string; kind: string; summary: string; state: 'open' | 'review_only'; put_off: boolean }>;
export type ReraiseOutcome = Readonly<{ outcome: 'raised'; shown_on: readonly string[]; on_this_reply: boolean } | { outcome: 'expired' | 'not_put_off' | 'not_waiting' | 'unshown' }>;
// What Waldo writes to the ledger as done without asking the owner. It can never be a kind the owner decides: readers such as
// Patrol's access log list those kinds as approvals, so a recorded one would read as approved.
export type RecordedLedgerKind = 'email_draft' | 'browser_action' | 'browser_submit_proposed';
export type ApprovalDesk = Readonly<{
  propose(args: ProposeCalendarChangeArgs, turnKey?: string, operationRef?: string): Promise<string>;
  proposeGoogleTaskChange(args: ProposeGoogleTaskChangeArgs, operationRef?: string, ctx?: ToolDispatcherContext): Promise<string>;
  proposeBrowserSubmit(payload: BrowserSubmitProposal): Promise<string>;
  proposeSendEmail(payload: EmailSendProposal): Promise<string>;
  proposeSendMessage(payload: MessageSendProposal): Promise<string>;
  proposeMcpCall(payload: McpCallProposal): Promise<string>;
  proposeTaintedAction(payload: TaintedActionProposal): Promise<string>;
  // The unexpired tainted-action cards for this tool still waiting on the owner (put off included), with their frozen args.
  waitingTaintedActions(tool: string): readonly Readonly<{ approval_id: string; args: Readonly<Record<string, unknown>> }>[];
  record(kind: RecordedLedgerKind, summary: string, payload: unknown): void;
  callback(query: CallbackQuery, trace: string): Promise<void>;
  decide(id: string, action: DeskAction, trace: string, via?: ApprovalVia): Promise<ApprovalDecision>;
  pending(now: number): readonly ApprovalItem[];
  approvals(now: number, filter?: Readonly<{ state?: AppApprovalStateV1; id?: string }>): Promise<readonly AppApprovalV1[]>;
  // Approvals still waiting on the owner and unexpired, with the ones they put off marked.
  waiting(): readonly WaitingApproval[];
  // Shows an approval the owner put off to them again. Only one that is put off, still waiting and unexpired is raised.
  reraise(id: string): Promise<ReraiseOutcome>;
  // The owner just wrote on this desk's surface, so the cards that waited for that go out now.
  ownerWrote(): Promise<void>;
  // A message that is exactly 1 or 2 decides the latest numbered card on this surface while its request is open and `latest` says
  // that card (by its message ref) is still Waldo's latest message in the chat the reply came from; anything else is a turn (null).
  numberedReply(text: string, trace: string, latest: (messageRef: string) => boolean): Promise<ApprovalDecision | null>;
  placement(id: string): CardPlacement;
  // Approved cards whose call runs on the jobs lane and has not settled.
  replays(): readonly string[];
  // The owner's receipt for a settled replay, from the card's own frozen call.
  replayReceipt(id: string, status: ReplayCardStatus, message: string): string;
  // Whether a card is still running under the digest its replay job froze: anything else fences the replay before I/O.
  replayCurrent(id: string, argsDigest: string): Promise<boolean>;
  // Moves a running card to how its replay ended. Only a running card moves, so a settle is applied once.
  settleReplay(id: string, status: ReplayCardStatus): boolean;
  // Whether this decision on this approval needs the recent email check; an approval it cannot read needs it.
  stepUp(id: string, action: ApprovalActionV1): boolean;
  ledger(reminders: readonly Readonly<{ note: string; at: string; repeat: string }>[]): string;
}>;

const DECISION = { a: 'approve', e: 'edit', s: 'skip' } as const;
const CARDS: Readonly<Record<string, Readonly<{ title: string; approve: string; modify: boolean }>>> = {
  calendar_change: { title: 'Calendar change?', approve: 'Do it', modify: true }, google_task_change: { title: 'Google task change?', approve: 'Do it', modify: true },
  email_send: { title: 'Send this email?', approve: 'Send it', modify: true }, message_send: { title: 'Send this message?', approve: 'Send it', modify: true },
  browser_submit: { title: 'Approve this browser action?', approve: 'Do it', modify: false }, mcp_call: { title: 'Run this MCP tool?', approve: 'Do it', modify: false },
  tainted_action: { title: 'Run this action?', approve: 'Do it', modify: false },
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
// A browser expiry that isn't a safe integer closes the request when it was made.
const expiresAt = (entry: LedgerRow) => {
  const p = JSON.parse(entry.payload_json) as Partial<Stored> & Partial<BrowserSubmitProposal>;
  if (entry.kind === 'browser_submit') return p.approvalExpiresAt !== undefined && !Number.isSafeInteger(p.approvalExpiresAt)
    ? entry.created_at : Math.min(entry.created_at + BROWSER_SUBMIT_TTL_MS, p.approvalExpiresAt ?? Infinity);
  return entry.kind === 'calendar_change' && p.start ? Math.min(entry.created_at + PROPOSAL_TTL_MS, Date.parse(p.start)) : entry.created_at + PROPOSAL_TTL_MS;
};
// A request closes at expires_at; one with no readable expiry is closed.
const pastExpiry = (entry: LedgerRow, now: number) => !(expiresAt(entry) > now);
const operationRefOf = (entry: LedgerRow) => (JSON.parse(entry.payload_json) as { operation_ref?: string }).operation_ref ?? `approval:${entry.id}`;
// The statuses a request can still be decided or edited from, which its expiry closes.
const EXPIRING: readonly DeskStatus[] = ['card_unconfirmed', 'open', 'review_only', 'changing'];
// task_sources requests have no writer any more and approving one only answers that it expired, so they expire like the rest.
const EXPIRING_KINDS: readonly string[] = [...PROPOSAL_KINDS, 'task_sources'];
// The scope a browser approval names: the page without credentials, query string or fragment.
const pageOf = (url: string) => { const page = new URL(url); return `${page.origin}${page.pathname}`; };
const describeBrowser = (p: BrowserSubmitProposal) => {
  const binding = Object.entries(p.binding).map(([k, v]) => `${k}: ${isCredentialKey(k) || p.secretKeys?.includes(k) ? MASK : v}`).join(', ');
  return `${p.action.description} on ${maskedUrl(p.url)}${p.request ? ` via ${p.request.method} ${maskedUrl(p.request.url)}` : ''}${binding ? ` (${binding})` : ''}`;
};
const describeMcp = (p: McpCallProposal) => `Run ${p.tool} on the ${p.server} MCP server`;
// The heading over what the proposal read from the owner's own stores when it was made.
const PREVIEW_HEADING: Readonly<Record<string, string>> = { forget_memory: 'It forgets', close_loop: 'It closes' };
const clipped = (text: string) => text.length > 120 ? `${text.slice(0, 117)}...` : text;
// The reasoning was written in a turn that read outside text and can name anything, so a card that read the owner's own
// stores leads with that read, and the reasoning follows it as Waldo's.
const describeTaintedAction = (p: TaintedActionProposal) => p.preview?.length
  ? `${PREVIEW_HEADING[p.tool] ?? 'It changes'}: ${p.preview[0]}${p.preview.length > 1 ? ` and ${p.preview.length - 1} more` : ''}`
  : `Run ${p.tool}: ${clipped(p.reasoning)}`;
const reviewTaintedAction = (p: TaintedActionProposal) => !p.preview?.length ? describeTaintedAction(p)
  : `${p.preview.length === 1 ? describeTaintedAction(p) : `${PREVIEW_HEADING[p.tool] ?? 'It changes'}:\n${p.preview.map((line) => `- ${line}`).join('\n')}`}\n\nWaldo's reasoning: ${clipped(p.reasoning)}`;
const TAINTED_ACTION_WHY = 'It uses content from an email or web page, so it needs your approval before it runs.';
// Browser and MCP summaries are rebuilt from the payload, so a row stored before masking renders
// masked too. A payload that no longer parses shows the card title, never the stored summary.
const summaryOf = (entry: LedgerRow) => {
  if (entry.kind !== 'browser_submit' && entry.kind !== 'mcp_call' && entry.kind !== 'tainted_action') return entry.summary;
  try { return entry.kind === 'browser_submit' ? describeBrowser(JSON.parse(entry.payload_json)) : entry.kind === 'mcp_call' ? describeMcp(JSON.parse(entry.payload_json)) : describeTaintedAction(JSON.parse(entry.payload_json)); }
  catch { return CARDS[entry.kind]!.title; }
};
// The full review a card shows for each kind, rebuilt from the frozen payload.
const reviewText = (entry: LedgerRow): string => {
  const p = JSON.parse(entry.payload_json);
  if (entry.kind === 'email_send') return `Send this email?${p.earlier_unknown_at ? ` An identical email from ${p.earlier_unknown_at} may already have gone out; check Gmail's Sent folder before sending it again.\n` : ' '}${reviewEmail(p)}`;
  if (entry.kind === 'message_send') return `Send this message on ${p.channel}?\n\n${reviewMessage(p)}`;
  if (entry.kind === 'mcp_call') return `Run this MCP tool? ${describeMcp(p)}\n\nArgs:\n${JSON.stringify(maskedValue(p.args), null, 2)}${p.questions?.length ? `\n\nThe server asked (its words):\n${p.questions.map((q: { id: string; message: string }) => `- ${q.message}`).join('\n')}\n\nYour answers:\n${JSON.stringify(maskedValue(p.answers?.responses ?? {}), null, 2)}` : ''}`;
  if (entry.kind === 'tainted_action') return `Run this action? ${reviewTaintedAction(p)}\n\n${TAINTED_ACTION_WHY}\n\nTool: ${p.tool}\nArgs:\n${JSON.stringify(maskedValue(p.args), null, 2)}`;
  if (entry.kind === 'browser_submit') return `Approve this browser action? ${describeBrowser(p)}`;
  if (entry.kind === 'google_task_change') return reviewGoogleTaskChange(googleTaskProposalSchema.parse(p));
  // A calendar change states the change itself, so the same text reads true before the owner decides and after it is done.
  // Notes go to Google with the event and every guest can read them, so the owner reviews them word for word.
  return `${entry.summary}${p.description ? `\n\nNotes on the event${p.attendees?.length ? ', which every guest can read' : ''}:\n${p.description}` : ''}`;
};
// The app's review: the same full review as a card, approvable while it fits the app's reply budget.
const appReview = (entry: LedgerRow): Readonly<{ text: string; full: boolean }> => {
  const text = reviewText(entry);
  return text.length <= APP_REVIEW_MAX_CHARS ? { text, full: true } : { text: unreviewable(CARDS[entry.kind]!.title, summaryOf(entry)), full: false };
};
// What each kind changes, from the frozen payload, exposing no more than the app review.
// everyDetail keeps a calendar change's details even where the app's schema would drop them, so classifying never loses one.
const exactFor = (entry: LedgerRow, everyDetail = false): AppApprovalV1['exact'] => {
  const p = JSON.parse(entry.payload_json);
  // The draft is the frozen words that go out, carried only whole: a body past the contract's bound, or a subject that
  // breaks its header line (Gmail would not be sent it as shown), leaves no draft to approve against.
  const whole = (message: Readonly<{ subject: string | null; body: string }>) => appApprovalMessageV1Schema.safeParse(message).success ? { message } : {};
  if (entry.kind === 'email_send') return { recipients: { to: p.to, cc: p.cc ?? [], bcc: p.bcc ?? [] }, ...(p.account ? { scope: p.account } : {}), ...whole({ subject: p.subject, body: p.body }) };
  if (entry.kind === 'message_send') return { recipients: { to: [p.channel], cc: [], bcc: [] }, ...whole({ subject: null, body: p.content }) };
  if (entry.kind === 'browser_submit') return { scope: pageOf(p.url) };
  if (entry.kind === 'mcp_call') return { scope: `${p.tool} on the ${p.server} server` };
  if (entry.kind === 'tainted_action') return { scope: `${p.tool} from external content` };
  if (entry.kind === 'google_task_change') return { task: googleTaskExact(googleTaskProposalSchema.parse(p)) };
  const guestCount = p.action === 'create' ? p.attendees?.length ?? 0 : p.seen_guests ?? 0;
  const first = { action: p.action, title: p.title ?? null, start: p.start ?? null, end: p.end ?? null };
  // Each detail appears exactly when describe() wrote it into the frozen review. A detail that does not fit its
  // schema (a provider time without an offset, say) drops the details, never the card: every build still sees it.
  const detailed = { changes: { ...first,
    ...(p.attendees?.length ? { guests: p.attendees } : {}), ...(guestCount ? { emails_guests: p.send_updates === 'all' } : {}),
    ...(p.location ? { location: p.location } : {}), ...(p.calendar_id && p.calendar_id !== 'primary' ? { calendar: p.calendar_id } : {}),
    ...(p.account ? { account: p.account } : {}), ...(p.action === 'move' && p.seen_start && p.seen_end ? { previous: { start: p.seen_start, end: p.seen_end } } : {}),
    ...(p.time_zone ? { time_zone: p.time_zone } : {}) } };
  return everyDetail || appApprovalExactV1Schema.safeParse(detailed).success ? detailed : { changes: first };
};
// A proposal the health trigger raised is the one whose operation_ref it minted with this prefix (tool calls mint tool:).
// Its stored reason is the model's own line, shown to the app beside the card; a reason the contract cannot carry is left
// out rather than costing the card.
const HEALTH_REF_PREFIX = 'health:';
const healthOf = (entry: LedgerRow): Pick<AppApprovalV1, 'health'> => {
  if (entry.kind !== 'calendar_change') return {};
  const stored = JSON.parse(entry.payload_json) as { operation_ref?: unknown; reason?: unknown };
  if (typeof stored.operation_ref !== 'string' || !stored.operation_ref.startsWith(HEALTH_REF_PREFIX)) return {};
  const health = appApprovalHealthV1Schema.safeParse({ reason: stored.reason });
  return health.success ? { health: health.data } : {};
};
// The chat surfaces where a send to another person, and every other kind the app gates behind the recent email check, is
// handed to the app rather than approved. Which kinds is the app's own rule; a request that cannot be classified is handed over.
const HANDS_TO_APP: ReadonlySet<ApprovalSurface> = new Set(['whatsapp', 'imessage']);
// Classified from every detail of the frozen request, never the app card's trimmed one.
const stepUpFor = (entry: LedgerRow, action: ApprovalActionV1): boolean => {
  try { return appApprovalStepUp({ kind: entry.kind as AppApprovalV1['kind'], exact: exactFor(entry, true) }, action); } catch { return true; }
};
// iMessage shows no buttons, so a card chat approves there asks for the owner's next message, 1 or 2, naming the change 1 makes.
const NUMBERED_VERBS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  calendar_change: { create: 'add it', move: 'move it', cancel: 'cancel it' },
  google_task_change: { create: 'add it', update: 'change it', complete: 'mark it done', reopen: 'reopen it' },
};
const numberedVerb = (entry: LedgerRow) => {
  const p = JSON.parse(entry.payload_json);
  return NUMBERED_VERBS[entry.kind]?.[entry.kind === 'google_task_change' ? p.args?.action : p.action] ?? 'do it';
};
// The surfaces that show no buttons and approve a one-tap card by the owner's numbered reply.
const NUMBERED: ReadonlySet<ApprovalSurface> = new Set(['imessage']);
// The reply protocol, not a reading of intent: only a message that is the digit itself decides.
const NUMBERED_REPLY = /^\s*([12])\s*$/;
const approvedInApp = (entry: LedgerRow): boolean => stepUpFor(entry, 'approve');
const HANDED_TO_APP = 'It reaches other people or acts beyond your own things, so it is approved in the Waldo app after a recent email check, not in chat.';
const NOT_IN_APP = "It can't be approved in the Waldo app either, so it can't be approved at all.";
// Asking for a new draft acts on nothing, so the app takes it without the email check; chat hands it over all the same.
const CHANGED_IN_APP = 'It reaches other people or acts beyond your own things, so changes to it are asked for in the Waldo app, not in chat.';
const NOT_CHANGED_IN_APP = "It can't be changed in the Waldo app either. Ask me for a fresh one instead.";
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
// The statuses in which a card that waits for the owner's next message can still go out.
const CARD_WAITING = "status IN ('card_unconfirmed', 'open', 'review_only')";
const hasCardWaits = (sql: SqlStorage) => sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('ledger') WHERE name = 'card_waits_on'").toArray().length > 0;

// Owner forget: a card still waiting for the owner's next message would carry the forgotten text to them, rebuilt from its
// ledger row, which the purge does not rewrite. Each such approval ends as skipped, so no surface sends it and nothing can
// approve it. remaining counts waiting cards that still carry a text afterwards, for the caller's verdict.
export const forgetWaitingCards = (sql: SqlStorage, texts: readonly string[], now: number): Readonly<{ ended: number; remaining: number }> => {
  const topics = [...new Set(texts.map(text => text.trim()).filter(Boolean))];
  if (!topics.length || !hasCardWaits(sql)) return { ended: 0, remaining: 0 };
  const carries = (row: Readonly<{ summary: string; payload_json: string }>) =>
    topics.some(topic => [row.summary, row.payload_json].some(value => carriesTopic(value, topic) || hidesTopic(value, topic)));
  const waiting = () => sql.exec<{ id: string; summary: string; payload_json: string }>(`SELECT id, summary, payload_json FROM ledger WHERE card_waits_on IS NOT NULL AND ${CARD_WAITING}`).toArray().filter(carries);
  let ended = 0;
  for (const { id } of waiting()) {
    ended += sql.exec(`UPDATE ledger SET status = 'skipped', decided_at = ?, card_waits_on = NULL WHERE id = ? AND card_waits_on IS NOT NULL AND ${CARD_WAITING}`, now, id).rowsWritten;
  }
  return { ended, remaining: waiting().length };
};

// A cancelled or forgotten background task: an approval card its run raised (a browser submit) asked the owner to finish
// work they have since stopped, so each one still waiting ends as skipped and its cards are retired. Nothing it carries
// can then be approved. Answers how many ended.
export const withdrawRunCards = (sql: SqlStorage, runRef: string, now: number): number => {
  if (sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('ledger') WHERE name = 'origin_run_ref'").toArray().length === 0) return 0;
  const ids = sql.exec<{ id: string }>(`SELECT id FROM ledger WHERE origin_run_ref = ? AND ${CARD_WAITING}`, runRef).toArray().map(({ id }) => id);
  for (const id of ids) {
    sql.exec(`UPDATE ledger SET status = 'skipped', decided_at = ? WHERE id = ? AND ${CARD_WAITING}`, now, id);
    sql.exec('UPDATE approval_presentations SET retired_at = ? WHERE approval_id = ? AND retired_at IS NULL', now, id);
  }
  return ids.length;
};

// The surface was bound to another number, or unbound: a card that waited for the owner's next message there was made for the
// number that is gone, so it no longer waits. Synchronous, for the transaction that changes the binding.
export const endCardWaits = (sql: SqlStorage, surface: string): void => {
  if (hasCardWaits(sql)) sql.exec('UPDATE ledger SET card_waits_on = NULL WHERE card_waits_on = ?', surface);
};

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
  // Replays an approved tainted action once through the dispatcher; the outcome says only what the replay established.
  replayTaintedAction?: (proposal: TaintedActionProposal, approvalRef: string) => Promise<TaintedActionOutcome>;
  replayLater?: DeferredReplay;
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
  // Whether this desk's surface lets Waldo write first now (WhatsApp, only within 24 hours of the owner's last message). A card
  // it refuses while it does not waits for the owner's next message there; without this, a refused card is a failed presentation.
  writesFirstNow?: () => boolean;
}>): ApprovalDesk => {
  sql.exec(`CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL,
    undo_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)`);
  for (const column of ['proposal_digest', 'origin_run_ref', 'card_waits_on']) {
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
  // Who gets an invite or an email is what the owner is approving, so the card always says it.
  const guests = (p: Stored) => {
    const count = p.action === 'create' ? p.attendees?.length ?? 0 : p.seen_guests ?? 0;
    const people = `${count === 1 ? 'the guest' : `the ${count} guests`}`;
    return [
      ...(p.attendees?.length ? [`Guests: ${p.attendees.join(', ')}.`] : []),
      ...(p.location ? [`Place: ${p.location}.`] : []),
      ...(p.add_meet_link ? ['With a Meet link.'] : []),
      ...(count ? [p.send_updates === 'all' ? `Google emails ${people}.` : `Google does not email ${people}.`] : []),
    ].map((part) => ` ${part}`).join('');
  };
  const describe = (p: Stored) => {
    const name = p.title ? `"${p.title}"` : 'the event';
    const where = `${p.calendar_id && p.calendar_id !== 'primary' ? ` on ${p.calendar_id}` : ''}${p.account ? ` (${p.account})` : ''}`;
    const details = guests(p);
    const tail = details ? `.${details.replace(/\.$/, '')}` : '';
    // A block's kind decides whether it counts toward the owner's load, so the card names it for them to correct.
    const kind = p.block === 'rest' ? " (rest: it won't add to your day's load)" : p.block === 'deep_work' ? " (deep work: it adds to your day's load)" : '';
    if (p.action === 'create') return `Add ${name}, ${when(p.start!)} to ${when(p.end!)}${where}${kind}${tail}`;
    if (p.action === 'move') return `Move ${name}${p.seen_start && p.seen_end ? ` from ${span(p.seen_start, p.seen_end)}` : ''} to ${span(p.start!, p.end!)}${where}${tail}`;
    return `Cancel ${name}${where}${tail}`;
  };
  const row = (id: string) => sql.exec<LedgerRow>('SELECT * FROM ledger WHERE id = ?', id).toArray()[0];
  // A card that waits for the owner's next message is as pending as an open one, so a repeat of its proposal finds it.
  const cardWaits = (entry: LedgerRow) => entry.status === 'card_unconfirmed' && entry.card_waits_on != null;
  const setStatus = (id: string, status: DeskStatus, undo: Undo | null = null) =>
    sql.exec('UPDATE ledger SET status = ?, undo_json = ?, decided_at = ? WHERE id = ?', status, undo ? JSON.stringify(undo) : null, deps.now(), id);
  const say = (text: string, buttons?: [string, string][], nowOnly = false) =>
    deps.call('sendMessage', { chat_id: deps.owner, text, ...(buttons ? { reply_markup: { inline_keyboard: [buttons.map(([label, data]) => ({ text: label, callback_data: data }))] } } : {}), ...(nowOnly ? { [SEND_NOW_ONLY]: true } : {}) });

  const describeEmail = (p: EmailSendProposal) => `Send email${p.account ? ` from ${p.account}` : ''} to ${p.to.join(', ')}: "${p.subject}"`;
  const describeMessage = (p: MessageSendProposal) => `Send this on ${p.channel}: "${p.content.length > 120 ? `${p.content.slice(0, 117)}...` : p.content}"`;

  const sentRef = (sent: unknown) => {
    const ack = sent as { message_id?: unknown; chat?: { id?: unknown }; messages?: readonly { id?: unknown }[] } | null;
    if (ack?.message_id !== undefined) return `${String(ack.chat?.id ?? deps.owner)}:${String(ack.message_id)}`;
    return ack?.messages?.[0]?.id !== undefined ? String(ack.messages[0].id) : 'unreferenced';
  };
  // The latest card on this surface that offered numbers. The numbers answer it alone, and only while it waits.
  const latestNumbered = () => sql.exec<{ approval_id: string; message_ref: string; retired_at: number | null }>(
    'SELECT approval_id, message_ref, retired_at FROM approval_presentations WHERE surface = ? AND approvable = 1 ORDER BY presented_at DESC, rowid DESC LIMIT 1', surface).toArray()[0];
  // Where a request a chat surface hands to the app can be approved: in the app, by its link when there is one, or nowhere.
  const appHandoff = (id: string, inApp: boolean) => !inApp ? `${NOT_IN_APP} Nothing was done.` : deps.appLink ? `Review and approve it there: ${deps.appLink(id)}` : 'Approve it in the Waldo app.';
  // A row opens only once a surface recorded the review: the origin card's provider acknowledgement
  // and, when the owner has the app, an app card that parses. Approvability is per surface, by how
  // much review that surface can show. The presentation rows and the status flip commit together.
  // A raise shows the card again for the current run and ends the deferral in the same commit as its presentations.
  // A card goes out now or not at all, so a surface never keeps it as text whose delivery nobody records. One refused while
  // the surface does not let Waldo write first waits, unrecorded, for the owner's next message there (ownerWrote).
  const present = async (id: string, raise?: Readonly<{ runRef: string | undefined }>) => {
    const entry = row(id)!;
    const deferrable = raise !== undefined || entry.deferred_at == null;
    const card = reviewText(entry), buttons = buttonsFor(entry, deferrable), title = CARDS[entry.kind]!.title;
    const digest = `sha256:${await sha256Hex(entry.payload_json)}`;
    const shown: { surface: string; message_ref: string; approvable: boolean }[] = [];
    let journalFailure: unknown, sendFailure: unknown, inApp: Readonly<{ approvable: boolean }> | null = null, sentHere = false, waits = false;
    // A request this chat surface hands to the app is put there even before the owner has the app, so the link has a card to open.
    const handsToApp = HANDS_TO_APP.has(surface) && approvedInApp(entry);
    if (surface === 'app' || handsToApp || deps.appIdentity?.()) {
      try {
        const approvable = appReview(entry).full;
        const part = appApprovalPart(appPartOf(entry, { actions: withDefer(entry, approvable ? approveActions(entry) : ['skip']), payload_digest: digest }));
        // The app may show only a card it can also decide: the approvals-list item must parse first.
        appApprovalV1Schema.parse({ approval_id: id, kind: part.kind, state: approvable ? 'open' : 'review_only', review: part.review, exact: exactFor(entry), payload_digest: digest, expires_at: part.expires_at, actions: part.actions, ...healthOf(entry) });
        inApp = { approvable };
      } catch (error) {
        journalFailure = error;
        deps.log({ trace: id, hop: 'approval_app_card', ms: 0, ok: false, code: 'unrepresentable' });
      }
    }
    if (surface !== 'app') {
      const fits = card.length <= REVIEW_BUDGET, approvable = fits && !handsToApp, numbered = NUMBERED.has(surface);
      const link = inApp?.approvable && deps.appLink ? ` You can review and approve it in the Waldo app: ${deps.appLink(id)}` : '';
      const earlier = numbered && approvable ? latestNumbered() : undefined;
      const replaces = earlier && earlier.approval_id !== id && earlier.retired_at === null && row(earlier.approval_id)?.status === 'open' ? ' These numbers now answer this card, not the earlier one.' : '';
      const text = handsToApp ? `${fits ? card : `${title} ${summaryOf(entry).slice(0, 1000)}`}\n\n${HANDED_TO_APP} ${appHandoff(id, inApp?.approvable === true)}`
        : approvable ? numbered ? `${card}\n\nReply 1 to ${numberedVerb(entry)}, or 2 to skip.${replaces}` : card : `${unreviewable(title, summaryOf(entry))}${link}`;
      try {
        const sent = await say(text, numbered ? undefined : approvable ? buttons : laterButtons(id, deferrable), true);
        if (sent != null) { shown.push({ surface, message_ref: sentRef(sent), approvable }); sentHere = true; }
        else if (deps.writesFirstNow?.() === false) waits = true;
        else sendFailure = new Error('Approval card not confirmed');
      } catch (error) { sendFailure = error; }
    }
    const runRef = raise ? raise.runRef : entry.origin_run_ref;
    if (inApp) shown.push({ surface: 'app', message_ref: runRef ? `run:${runRef}` : `approval:${id}`, approvable: inApp.approvable });
    if (!shown.length && !waits) throw sendFailure ?? journalFailure ?? new Error('Approval card not confirmed');
    commit(() => {
      for (const s of shown) sql.exec('INSERT OR IGNORE INTO approval_presentations (approval_id, surface, message_ref, presented_at, approvable, payload_digest, retired_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        id, s.surface, s.message_ref, deps.now(), s.approvable ? 1 : 0, digest);
      if (shown.length) sql.exec("UPDATE ledger SET status = ? WHERE id = ? AND status = 'card_unconfirmed'", shown.some(s => s.approvable) ? 'open' : 'review_only', id);
      if (waits || sentHere) sql.exec('UPDATE ledger SET card_waits_on = ? WHERE id = ?', waits ? surface : null, id);
      if (raise) sql.exec("UPDATE ledger SET deferred_at = NULL WHERE id = ? AND deferred_at IS NOT NULL AND status IN ('open', 'review_only')", id);
    });
    return shown;
  };
  // Approving or modifying needs a card that showed the full review on the deciding surface. The console renders the
  // stored review itself, so any full-review presentation serves it, for the kinds it shows in full: a send's draft and a
  // calendar change without invite details, the rules waitingMaySend and consoleMayApprove apply at the route. Every other kind is approved
  // in chat or the app, whatever the route that asked. Answers the presentations that authorize the decision.
  const deciding = (entry: LedgerRow, via: ApprovalVia) => {
    const live = sql.exec<{ surface: string; message_ref: string; approvable: number; payload_digest: string }>('SELECT surface, message_ref, approvable, payload_digest FROM approval_presentations WHERE approval_id = ? AND retired_at IS NULL', entry.id).toArray();
    const approves = (p: { surface: string; approvable: number }) => p.approvable === 1 && (p.surface !== 'app' || appShowsInFull(entry));
    // Whatever its card recorded, even one shown before this rule: a kind the app gates is never approved from chat.
    if (HANDS_TO_APP.has(via.surface) && approvedInApp(entry)) return [];
    if (via.surface === 'console') return entry.kind === 'email_send' || entry.kind === 'message_send' || (entry.kind === 'calendar_change' && !calendarInviteDetails(JSON.parse(entry.payload_json))) ? live.filter(approves) : [];
    const mine = live.filter(p => p.surface === via.surface || (p.surface === 'legacy' && via.surface !== 'app'));
    const tapped = mine.filter(p => p.message_ref === via.messageRef);
    return (tapped.length ? tapped : mine).filter(approves);
  };
  const presentedTo = (entry: LedgerRow, via: ApprovalVia) => deciding(entry, via).length > 0;
  // A send goes out only as a card showed it: some card that authorizes the decision carries the digest of what is stored now.
  const shownAsStored = async (entry: LedgerRow, via: ApprovalVia) => {
    const digest = `sha256:${await sha256Hex(entry.payload_json)}`;
    return deciding(entry, via).some(p => p.payload_digest === digest);
  };
  // Said the same whether the stored draft changed, its bytes disagree with its words, or its card recorded no digest.
  const changedSend = (entry: LedgerRow): ApprovalDecision => entry.kind === 'email_send'
    ? { toast: 'Email changed', message: `I couldn't confirm the stored email is the one on the card you reviewed, so nothing was sent: ${describeEmail(JSON.parse(entry.payload_json) as EmailSendProposal)}. Ask me again and I'll prepare a fresh one.` }
    : { toast: 'Message changed', message: "I couldn't confirm the stored message is the one on the card you reviewed, so nothing was sent. Ask me again and I'll prepare a fresh one." };
  const notPresented = (entry: LedgerRow, via: ApprovalVia, action: 'a' | 'e'): ApprovalDecision => {
    const id = entry.id;
    const shownInApp = appShowsInFull(entry) && sql.exec("SELECT 1 FROM approval_presentations WHERE approval_id = ? AND surface = 'app' AND approvable = 1 AND retired_at IS NULL", id).toArray().length > 0;
    const handed = HANDS_TO_APP.has(via.surface) && approvedInApp(entry);
    // A kind with no Modify is only approved or declined, in the app as here.
    const change = action === 'e' && CARDS[entry.kind]?.modify === true;
    if (!handed) return shownInApp && deps.appLink
      ? { toast: 'Review it in the app', message: `That approval wasn't shown in full here, so it can't be ${change ? 'changed' : 'approved'} here. Nothing was done. Review and ${change ? 'change' : 'approve'} it in the Waldo app: ${deps.appLink(id)}` }
      : { toast: 'Not available here', message: `That approval wasn't shown in full here, so it can't be ${change ? 'changed' : 'approved'} here. Nothing was done.` };
    const why = change ? CHANGED_IN_APP : HANDED_TO_APP;
    if (shownInApp && deps.appLink) return { toast: 'Review it in the app', message: `${why} Nothing was done. ${change ? 'Ask for the change' : 'Review and approve it'} in the Waldo app: ${deps.appLink(id)}` };
    return { toast: 'Review it in the app', message: `${why} Nothing was done. ${shownInApp ? `${change ? 'Ask for the change' : 'Approve it'} in the Waldo app.` : change ? NOT_CHANGED_IN_APP : NOT_IN_APP}` };
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
      ...(surfaces.length ? { presented_surfaces: surfaces as AppApprovalV1['presented_surfaces'] } : {}), ...healthOf(entry) };
  };
  const describeAny = (entry: LedgerRow) => {
    if (entry.kind === 'task_sources') return 'Task sources (expired)';
    if (entry.kind === 'browser_submit') return describeBrowser(JSON.parse(entry.payload_json) as BrowserSubmitProposal);
    if (entry.kind === 'email_send') return describeEmail(JSON.parse(entry.payload_json) as EmailSendProposal);
    if (entry.kind === 'message_send') return describeMessage(JSON.parse(entry.payload_json) as MessageSendProposal);
    if (entry.kind === 'mcp_call') return describeMcp(JSON.parse(entry.payload_json) as McpCallProposal);
    if (entry.kind === 'tainted_action') return describeTaintedAction(JSON.parse(entry.payload_json) as TaintedActionProposal);
    if (entry.kind === 'google_task_change') return describeGoogleTaskChange(googleTaskProposalSchema.parse(JSON.parse(entry.payload_json)));
    return describe(JSON.parse(entry.payload_json) as Stored);
  };
  // ADR-0054 exactly-once: a second approval of the same idempotency key collapses onto the
  // first send instead of double-delivering.
  const keyHolder = (key: string, selfId: string) =>
    sql.exec<{ id: string; status: string; payload_json: string }>("SELECT id, status, payload_json FROM ledger WHERE kind = 'message_send' AND status IN ('done', 'uncertain') AND id != ? AND json_extract(payload_json, '$.idempotency_key') = ? LIMIT 1", selfId, key).toArray()[0];
  // Once the apply effect is on record the change may have happened, so expiry never closes that request.
  const applyOnRecord = (entry: LedgerRow) => !!deps.effects?.get(`${operationRefOf(entry)}:apply`);
  // A request closes at its expiry the first time a read or a decision sees it. Only its status changes: every reader
  // gates on status, and a messaging card keeps its buttons until a tap, which answers with the expiry.
  const expireDue = (id?: string) => {
    const now = deps.now();
    const rows = sql.exec<LedgerRow>(`SELECT * FROM ledger WHERE kind IN (${EXPIRING_KINDS.map(() => '?').join(', ')}) AND status IN (${EXPIRING.map(() => '?').join(', ')})${id === undefined ? '' : ' AND id = ?'}`,
      ...EXPIRING_KINDS, ...EXPIRING, ...(id === undefined ? [] : [id])).toArray();
    let closed = 0;
    for (const entry of rows) {
      let closes: boolean;
      try { closes = pastExpiry(entry, now) && !applyOnRecord(entry); }
      catch { deps.log({ trace: entry.id, hop: 'approval_expiry', ms: 0, ok: false, code: 'unreadable' }); continue; }
      if (closes) closed += sql.exec("UPDATE ledger SET status = 'expired', decided_at = ? WHERE id = ? AND status = ?", now, entry.id, entry.status).rowsWritten;
    }
    if (closed) deps.log({ trace: 'approvals', hop: 'approvals_sweep', ms: 0, ok: true, code: 'approvals_expired', detail: String(closed) });
  };
  const expiredReply = (entry: LedgerRow): ApprovalDecision =>
    ({ toast: 'This proposal expired', message: `That proposal expired, so nothing happened: ${describeAny(entry)}. Ask me again if you still want it.` });
  // An approval that awaited after its checks can find its request gone: a read may have closed it at its expiry.
  const noLongerOpen = (id: string): ApprovalDecision => {
    const current = row(id);
    return current?.status === 'expired' ? expiredReply(current) : { toast: 'Already handled.', message: 'Already handled.' };
  };
  // Synchronous compare-and-claim of an open request, right before its effect.
  const claimOpen = (id: string): ApprovalDecision | null => {
    sql.exec("UPDATE ledger SET status = 'uncertain', decided_at = ? WHERE id = ? AND status = 'open'", deps.now(), id);
    return sql.exec<{ claimed: number }>('SELECT changes() AS claimed').one().claimed === 1 ? null : noLongerOpen(id);
  };
  const apply = async (client: GoogleClient, p: Stored, eventId?: string, marker?: string): Promise<Undo | null | 'stale'> => {
    // No choice sends no options, so a change proposed before calendars and emailing existed keeps its intent bytes.
    const target = p.calendar_id || p.send_updates ? { ...(p.calendar_id ? { calendarId: p.calendar_id } : {}), ...(p.send_updates ? { sendUpdates: p.send_updates } : {}) } : undefined;
    const undoTarget = { ...(p.calendar_id ? { calendar_id: p.calendar_id } : {}), ...(p.send_updates ? { send_updates: p.send_updates } : {}) };
    if (p.action === 'create') {
      const applied = await client.createEvent({ title: p.title!, start: p.start!, end: p.end!, ...(eventId ? { id: eventId } : {}), ...(marker ? { operationMarker:marker } : {}), ...target,
        ...(p.attendees ? { attendees: p.attendees } : {}), ...(p.description ? { description: p.description } : {}), ...(p.location ? { location: p.location } : {}), ...(p.add_meet_link ? { meet: true } : {}), ...(p.block ? { block: p.block } : {}) });
      return applied.etag ? { op: 'cancel', id: applied.id, applied_etag: applied.etag, ...undoTarget } : null;
    }
    const before = await client.event(p.event_id!, p.calendar_id);
    if (p.seen_etag && before.etag !== p.seen_etag) return 'stale';
    try {
      if (p.action === 'move') {
        const applied = await client.moveEvent(p.event_id!, p.start!, p.end!, before.etag, marker, target);
        return applied.etag ? { op: 'move', id: p.event_id!, start: before.start, end: before.end, applied_etag: applied.etag, ...undoTarget } : null;
      }
      await client.cancelEvent(p.event_id!, before.etag, marker, target);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 412) return 'stale';
      throw error;
    }
    return null;
  };
  const revert = async (client: GoogleClient, undo: Undo, marker?: string): Promise<'undone' | 'stale' | 'unavailable'> => {
    // Legacy entries have no applied version. A fresh owner edit never grants Undo authority.
    if (!undo.applied_etag) return 'unavailable';
    // Undo reaches the same calendar and emails the guests exactly as the change did.
    const target = undo.calendar_id || undo.send_updates ? { ...(undo.calendar_id ? { calendarId: undo.calendar_id } : {}), ...(undo.send_updates ? { sendUpdates: undo.send_updates } : {}) } : undefined;
    const current = await client.event(undo.id, undo.calendar_id);
    if (current.etag !== undo.applied_etag) return 'stale';
    try {
      if (undo.op === 'cancel') await client.cancelEvent(undo.id, undo.applied_etag, marker, target);
      else await client.moveEvent(undo.id, undo.start, undo.end, undo.applied_etag, marker, target);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 412) return 'stale';
      throw error;
    }
    return 'undone';
  };

  const replayAccepted = (entry: LedgerRow): ApprovalDecision =>
    ({ toast: 'Approved', message: `Approved: ${describeAny(entry)}. It runs in the background, and I'll tell you how it went.` });
  const decide = async (id: string, action: DeskAction, trace: string, via: ApprovalVia = { surface }): Promise<ApprovalDecision> => {
    const started = deps.now();
    expireDue(id);
    const entry = row(id);
    if (entry?.status === 'expired' && action !== 'u') return expiredReply(entry);
    const operationRef = entry ? operationRefOf(entry) : `approval:${id}`;
    const expected = action === 'u' ? 'done' : 'open';
    if (deps.effects?.isActive(`${operationRef}:${action === 'u' ? 'undo' : 'apply'}`)) return { toast: 'Already handled.', message: 'Already handled.' };
    // An uncertain row with no effect record never reached dispatch (the record is written before the provider call), so it is safe to run again; a record sends it through reconcile instead.
    const recovering = entry?.status === 'uncertain' && deps.effects !== undefined && (action === 'a' || action === 'u' && entry.kind === 'calendar_change' && !!entry.undo_json && !!deps.effects.get(`${operationRef}:undo`));
    // An approved card whose call waits for or runs on the jobs lane answers every later decision with its approval's
    // receipt; the owner hears how it ended when it ends.
    if (entry?.status === 'running') return replayAccepted(entry);
    if (entry?.status === 'uncertain' && entry.kind !== 'browser_submit' && action === 'a' && !recovering) return { toast: 'Outcome unknown', message: 'The outcome of that approval is unknown. Check the result before retrying; nothing was sent again.' };
    if (entry?.status === 'card_unconfirmed' && entry.card_waits_on != null) return { toast: 'Not out yet', message: `That card has not reached you on ${entry.card_waits_on} yet; it goes out there when you next write. Nothing was done.` };
    if (!entry || (entry.status !== expected && !((action === 's' || action === 'd') && entry.status === 'review_only') && !recovering)) return { toast: 'Already handled.', message: 'Already handled.' };
    if ((action === 'a' || action === 'e') && entry.status === 'open' && !presentedTo(entry, via)) return notPresented(entry, via, action);
    if (action === 'a' && entry.status === 'open' && (entry.kind === 'email_send' || entry.kind === 'message_send') && !await shownAsStored(entry, via)) {
      setStatus(id, 'failed');
      return changedSend(entry);
    }
    const proposal = JSON.parse(entry.payload_json) as Stored;
    try {
      let out: ApprovalDecision;
      if (!applyOnRecord(entry) && action !== 'u' && action !== 's' && pastExpiry(entry, deps.now())) {
        setStatus(id, 'expired');
        out = expiredReply(entry);
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
            const lost = claimOpen(id);
            if (lost) return lost;
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
              const lost = claimOpen(id);
              if (lost) return lost;
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
          } else if (!await emailIntact(ep)) {
            setStatus(id, 'failed');
            out = changedSend(entry);
          } else {
            if (!recovering) {
              const lost = claimOpen(id);
              if (lost) return lost;
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
            const lost = claimOpen(id);
            if (lost) return lost;
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
      } else if (entry.kind === 'tainted_action') {
        const tp = JSON.parse(entry.payload_json) as TaintedActionProposal;
        if (action === 'u') {
          out = { toast: "Can't be undone", message: 'An approved action cannot be undone from here. Nothing was reversed.' };
        } else if (!deps.replayTaintedAction && !deps.replayLater?.takes(tp.tool)) {
          out = { toast: 'Not available', message: 'This action cannot be run from here. Nothing was done.' };
        } else if (!entry.proposal_digest || await sha256Hex(stableJson(tp.args)) !== entry.proposal_digest || tp.args_digest !== entry.proposal_digest) {
          setStatus(id, 'failed');
          out = { toast: 'Action changed', message: `The stored action no longer matches what you approved, so nothing ran: ${describeTaintedAction(tp)}. Ask me again and I'll propose it afresh.` };
        } else if (deps.replayLater?.takes(tp.tool)) {
          // A replay that ended uncertain has no effect record (its job was the intent), so it is never retried from here.
          if (entry.status !== 'open') return { toast: 'Outcome unknown', message: 'The outcome of that approval is unknown. Check the result before retrying; nothing was run again.' };
          // Intent before I/O: the claim and the frozen call's job land in one commit; nothing runs in the decision.
          const replay = deps.replayLater;
          const lost = commit(() => {
            sql.exec("UPDATE ledger SET status = 'running', decided_at = ? WHERE id = ? AND status = 'open'", deps.now(), id);
            if (sql.exec<{ claimed: number }>('SELECT changes() AS claimed').one().claimed !== 1) return noLongerOpen(id);
            replay.enqueue(id, { tool: tp.tool, args: tp.args, args_digest: tp.args_digest });
            return null;
          });
          if (lost) return lost;
          await replay.wake();
          out = replayAccepted(entry);
        } else {
          if (!recovering) {
            const lost = claimOpen(id);
            if (lost) return lost;
          }
          let outcome: TaintedActionOutcome | undefined;
          try {
            const receipt = await effect(`${operationRef}:apply`, tp.tool, tp, async () => {
              outcome = await deps.replayTaintedAction!(tp, id);
              if (outcome.status === 'rejected' || outcome.status === 'failed') throw new EffectNotAppliedError();
              if (outcome.status !== 'done') throw new EffectUnknownError();
              return { provider_id: `${operationRef}:apply`, result: outcome.message };
            }, async () => outcome?.status === 'rejected' || outcome?.status === 'failed' ? { status: 'not_applied' } : { status: 'unknown' });
            setStatus(id, 'done');
            out = { toast: 'Done', message: `Done: ${describeTaintedAction(tp)}. ${String(receipt.result)}` };
          } catch (error) {
            if (outcome?.status === 'rejected' || outcome?.status === 'failed') {
              setStatus(id, outcome.status);
              out = { toast: outcome.status === 'rejected' ? 'Not done' : 'That failed', message: `Nothing was done: ${outcome.message}` };
            } else {
              deps.log({ trace, hop: 'tainted_action_unknown', ms: 0, ok: false, error: String(error) });
              setStatus(id, 'uncertain');
              out = { toast: 'Outcome unknown', message: 'The outcome of that action is unknown. Check the result before retrying; nothing was run again.' };
            }
          }
        }
      } else if (entry.kind === 'mcp_call') {
        const cp = JSON.parse(entry.payload_json) as McpCallProposal;
        if (action === 'u') {
          out = { toast: "Can't be undone", message: 'An MCP call cannot be undone from here. Nothing was reversed.' };
        } else if (!deps.mcpCall) {
          out = { toast: 'MCP is not set up', message: 'I could not run that because MCP execution is not set up on this Waldo yet.' };
        } else if ((entry.proposal_digest || cp.connection) && (!entry.proposal_digest || await mcpDigest(cp) !== entry.proposal_digest)) {
          setStatus(id, 'failed');
          out = { toast: 'Call changed', message: `The stored call no longer matches what you approved, so nothing ran: ${describeMcp(cp)}. Ask me again and I'll propose it afresh.` };
        } else {
          if (!recovering) {
            const lost = claimOpen(id);
            if (lost) return lost;
          }
          // A refusal that proves nothing ran (the server was never reached, or it answered with an auth
          // challenge, a rate limit or a question) settles as not done; any other failure stays unknown.
          let notRun: McpRefusal | undefined, toolFailed: McpToolFailed | undefined;
          try {
            const receipt = await effect(`${operationRef}:apply`, 'call_mcp_tool', cp, async () => {
              let result: string | EffectReceipt;
              try { result = await deps.mcpCall!(cp, { id: `approval:${id}:apply` }); }
              catch (error) {
                // The tool answered with its own error: the call completed, so the ledger records that answer.
                if (error instanceof McpToolFailed) { toolFailed = error; return { provider_id: `${operationRef}:apply`, result: { tool_error: error.message } }; }
                if (error instanceof McpRefusal && error.notApplied) notRun = error;
                throw error;
              }
              if (typeof result !== 'string') return result; if (deps.effects) throw new EffectUnknownError(); return { provider_id: `${operationRef}:apply`, result };
            }, async () => (notRun ? { status: 'not_applied' } : { status: 'unknown' }));
            const failure = toolFailed?.message ?? (isToolError(receipt.result) ? receipt.result.tool_error : undefined);
            if (failure !== undefined) {
              setStatus(id, 'failed');
              return { toast: 'That failed', message: `${describeMcp(cp)} ran and failed. ${failure}` };
            }
            const outcome = String(receipt.result);
            setStatus(id, 'done');
            out = { toast: 'Done', message: `Done: ${describeMcp(cp)}. ${outcome}` };
          } catch (error) {
            if (notRun && (error instanceof EffectNotAppliedError || error === notRun)) {
              setStatus(id, 'failed');
              return { toast: 'Nothing ran', message: `Nothing ran: ${notRun.message}` };
            }
            const recorded = deps.effects?.get(`${operationRef}:apply`);
            if(recorded && recorded.state !== 'rejected') {setStatus(id,'uncertain');return {toast:'Outcome unknown',message:'The MCP outcome is unknown. Check the result before retrying; nothing was run again.'};}
            if(error instanceof EffectUnknownError || error instanceof ProxyIntentError || (error instanceof GoogleError && error.message==='intent_pending') || error instanceof McpRefusal) {setStatus(id,'uncertain');return {toast:'Outcome unknown',message:'The MCP outcome is unknown. Check it before retrying; nothing was run again.'};}
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
          // A read may have closed the request during the awaits above. The effect is reserved synchronously
          // from here, so a later read sees it on record and leaves the request open.
          if (!recovering && row(id)?.status !== 'open') return noLongerOpen(id);
          const receipt = await effect(`${operationRef}:apply`, 'calendar_change', proposal, async () => {
            const undo = await apply(client, proposal, deps.effects ? eventId : undefined, marker);
            return { provider_id: eventId, result: undo };
          }, async () => {
            try {
              const current = await client.event(eventId, proposal.calendar_id);
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
                const current = await client.event(undo.id, undo.calendar_id);
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
    replays: () => sql.exec<{ id: string }>("SELECT id FROM ledger WHERE status = 'running' ORDER BY decided_at").toArray().map(entry => entry.id),
    replayReceipt(id, status, message) {
      const entry = row(id);
      const what = entry ? describeAny(entry) : 'the approved action';
      if (status === 'done') return `Done: ${what}. ${message}`;
      if (status === 'skipped') return `Stopped before it ran, so nothing was done: ${what}.`;
      if (status === 'uncertain') return `The outcome is unknown: ${what}. ${message} Check the result before asking again; nothing was run again.`;
      return `Nothing was done: ${what}. ${message}`;
    },
    async replayCurrent(id, argsDigest) {
      const entry = row(id);
      if (entry?.status !== 'running' || entry.kind !== 'tainted_action' || entry.proposal_digest !== argsDigest) return false;
      const tp = JSON.parse(entry.payload_json) as TaintedActionProposal;
      return tp.args_digest === argsDigest && await sha256Hex(stableJson(tp.args)) === argsDigest;
    },
    settleReplay(id, status) {
      return sql.exec("UPDATE ledger SET status = ?, decided_at = ? WHERE id = ? AND status = 'running'", status, deps.now(), id).rowsWritten > 0;
    },
    waiting() {
      expireDue();
      return sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status IN ('open', 'review_only') ORDER BY created_at").toArray()
        .filter(waitingRow)
        .map(entry => ({ approval_id: entry.id, kind: entry.kind, summary: summaryOf(entry), state: entry.status as 'open' | 'review_only', put_off: entry.deferred_at != null }));
    },
    async reraise(id) {
      expireDue(id);
      const entry = row(id);
      // A read may already have closed it at its expiry: that answer is the expiry, not that nothing waits.
      if (entry?.status === 'expired' && PROPOSAL_KINDS.includes(entry.kind) && entry.id.startsWith('p')) {
        await retire(id, { surface });
        return { outcome: 'expired' };
      }
      if (!entry || !waitingRow(entry)) return { outcome: 'not_waiting' };
      if (raising.has(id)) return { outcome: 'not_put_off' };
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
    async numberedReply(text, trace, latest) {
      const number = NUMBERED_REPLY.exec(text)?.[1];
      const card = NUMBERED.has(surface) && number ? latestNumbered() : undefined;
      if (!card || card.retired_at !== null) return null;
      // The ledger decides whether the card still waits: one past its expiry, closed or not, takes no number.
      expireDue(card.approval_id);
      if (row(card.approval_id)?.status !== 'open' || !latest(card.message_ref)) return null;
      return decideOnce(card.approval_id, number === '1' ? 'a' : 's', trace, { surface, messageRef: card.message_ref });
    },
    // Oldest first, and only while the approval still waits on the owner and is not put off. Each card is claimed before its
    // send, so one whose send ends unknown is never sent twice. One refused again waits again and, like a failure, ends the pass.
    async ownerWrote() {
      expireDue();
      const passStarted = deps.now();
      const due = sql.exec<{ id: string }>(`SELECT id FROM ledger WHERE card_waits_on = ? AND ${CARD_WAITING} AND deferred_at IS NULL ORDER BY created_at, id`, surface).toArray();
      // Shown in this pass: an older presentation of a card that was put off and raised does not count.
      const shownHere = (id: string) => sql.exec('SELECT 1 FROM approval_presentations WHERE approval_id = ? AND surface = ? AND presented_at >= ?', id, surface, passStarted).toArray().length > 0;
      let shown = 0;
      for (const { id } of due) {
        // Claimed against the row as it is now: one decided, put off or forgotten while an earlier card was sending is skipped.
        if (!sql.exec(`UPDATE ledger SET card_waits_on = NULL WHERE id = ? AND card_waits_on = ? AND ${CARD_WAITING} AND deferred_at IS NULL`, id, surface).rowsWritten) continue;
        // A card refused again, or whose send failed or ended unknown, is not shown here, even when the app showed it.
        if (!await present(id).then(() => shownHere(id), () => false)) {
          deps.log({ trace: id, hop: 'approval_card_waited', ms: 0, ok: false, code: row(id)?.card_waits_on != null ? 'waits_again' : 'unshown' });
          break;
        }
        shown += 1;
      }
      if (shown) deps.log({ trace: 'approvals', hop: 'approval_card_waited', ms: 0, ok: true, detail: String(shown) });
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
          if (prior.status === 'open' || cardWaits(prior)) return prior.id;
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
        if (prior.status === 'open' || prior.status === 'review_only' || cardWaits(prior)) return prior.id;
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
      const detail = url ? ` You can also review it at ${url}.` : '';
      const appApproves = shown.some(s => s.surface === 'app' && s.approvable), inApp = deps.appLink && appApproves;
      const receipt = HANDS_TO_APP.has(surface) && approvedInApp(row(id)!) ? `Email ready for review: the card above has the exact recipients, subject and body. ${HANDED_TO_APP} ${appHandoff(id, appApproves)}${appApproves ? ' Nothing has been sent.' : ''}`
        : card.approvable
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
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at, proposal_digest) VALUES (?, 'mcp_call', 'card_unconfirmed', ?, ?, NULL, ?, NULL, ?)", id, summary, JSON.stringify(payload), deps.now(), await mcpDigest(payload));
      bindOrigin(id, originRunRef);
      await present(id);
      return id;
    },
    async proposeTaintedAction(payload) {
      // The row's digest is recomputed from the stored arguments at approval, so a changed payload never runs.
      if (await sha256Hex(stableJson(payload.args)) !== payload.args_digest) throw new Error('tainted action digest mismatch');
      const originRunRef = deps.currentRunRef?.();
      const id = `p${deps.newId()}`;
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at, proposal_digest) VALUES (?, 'tainted_action', 'card_unconfirmed', ?, ?, NULL, ?, NULL, ?)", id, describeTaintedAction(payload), JSON.stringify(payload), deps.now(), payload.args_digest);
      bindOrigin(id, originRunRef);
      await present(id);
      return id;
    },
    waitingTaintedActions(tool) {
      expireDue();
      return sql.exec<LedgerRow>("SELECT * FROM ledger WHERE kind = 'tainted_action' AND json_extract(payload_json, '$.tool') = ? AND status IN ('open', 'review_only', 'card_unconfirmed') ORDER BY created_at", tool).toArray()
        .filter(entry => entry.status !== 'card_unconfirmed' || cardWaits(entry))
        .map(entry => ({ approval_id: entry.id, args: (JSON.parse(entry.payload_json) as TaintedActionProposal).args }));
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
        if (entry && (entry.status === 'open' || cardWaits(entry)) && !pastExpiry(entry, deps.now())) return id;
      }
      const prepare = async () => {
        const id = `p${deps.newId()}`;
        const client = await deps.google({id:`approval:${id}:apply`},'calendar',p.account);
        if((p.event_id || p.account)&&!client)throw new Error('The calendar account is unavailable; no proposal was prepared.');
        if (p.account && client?.account?.email?.toLowerCase() !== p.account.toLowerCase()) throw new Error('Selected calendar account is unavailable');
        const bound = { ...p, ...(client?.account?.email ? {account:client.account.email} : {}) };
        const before = client && bound.event_id ? await client.event(bound.event_id, bound.calendar_id) : undefined;
        const seen = before?.etag;
        const seenTime = before && !before.all_day && before.start && before.end ? { seen_start: before.start, seen_end: before.end } : {};
        const stored: Stored = { ...bound, ...(seen ? { seen_etag: seen } : {}), ...seenTime, ...(before?.attendees ? { seen_guests: before.attendees } : {}), ...(operationRef ? { operation_ref: operationRef } : {}), time_zone: deps.timezone };
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
      expireDue();
      const open = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'open' ORDER BY created_at").toArray();
      const unconfirmed = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE kind IN ('email_send', 'google_task_change') AND status = 'card_unconfirmed' ORDER BY created_at").toArray();
      const reviewOnly = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'review_only' ORDER BY created_at").toArray();
      const undoable = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'done' AND undo_json IS NOT NULL AND decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT 5").toArray();
      const review = (r: LedgerRow): ApprovalReview | null => {
        try {
          if (r.kind === 'email_send') {
            const p = JSON.parse(r.payload_json) as EmailSendProposal;
            if (!Array.isArray(p.to) || !p.to.length || !p.to.every((address) => typeof address === 'string') || !Array.isArray(p.cc ?? []) || !Array.isArray(p.bcc ?? []) || !(p.cc ?? []).every((address) => typeof address === 'string') || !(p.bcc ?? []).every((address) => typeof address === 'string') || typeof p.subject !== 'string' || typeof p.body !== 'string') return null;
            return { kind: 'email_send', ...(p.account ? {account:p.account} : {}), to: p.to, cc: p.cc ?? [], bcc: p.bcc ?? [], subject: p.subject, body: p.body,
              ...(typeof p.earlier_unknown_at === 'string' ? { earlier_unknown_at: p.earlier_unknown_at } : {}) };
          }
          if (r.kind === 'message_send') {
            const p = JSON.parse(r.payload_json) as MessageSendProposal;
            return typeof p.channel === 'string' && typeof p.content === 'string' ? { kind: 'message_send', channel: p.channel, content: p.content } : null;
          }
          if (r.kind === 'mcp_call' || r.kind === 'tainted_action' || r.kind === 'browser_submit') return { kind: r.kind, text: appReview(r).text };
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
            return { kind: 'calendar_change', ...(p.account ? {account:p.account} : {}), action: p.action, title: p.title ?? null, event_id: p.event_id ?? null, start: p.start ?? null, end: p.end ?? null, reason: p.reason,
              ...(p.calendar_id ? { calendar_id: p.calendar_id } : {}), ...(p.attendees?.length ? { attendees: p.attendees } : {}), ...(p.send_updates ? { send_updates: p.send_updates } : {}),
              ...(p.location ? { location: p.location } : {}), ...(p.description ? { description: p.description } : {}), ...(p.add_meet_link ? { add_meet_link: true } : {}) };
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
    stepUp(id, action) {
      const entry = row(id);
      return !entry || stepUpFor(entry, action);
    },
    placement(id) {
      const shown = sql.exec<{ surface: string; approvable: number }>('SELECT surface, approvable FROM approval_presentations WHERE approval_id = ?', id).toArray();
      const entry = row(id), appFull = !!entry && appShowsInFull(entry);
      const on = (where: string, approvable = false) => shown.some(p => p.surface === where && (!approvable || p.approvable === 1 && (where !== 'app' || appFull)));
      const waitsHere = sql.exec('SELECT 1 FROM ledger WHERE id = ? AND card_waits_on = ?', id, surface).toArray().length > 0;
      const handsToApp = !!entry && HANDS_TO_APP.has(surface) && approvedInApp(entry), numbered = NUMBERED.has(surface) && on(surface, true);
      return { here: on(surface), hereApprovable: on(surface, true), app: on('app'), appApprovable: on('app', true), ...(waitsHere ? { waitsHere } : {}), ...(handsToApp ? { handsToApp } : {}), ...(numbered ? { numbered } : {}) };
    },
    async approvals(now, filter = {}) {
      expireDue();
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
      expireDue();
      const open = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status IN ('open', 'changing') ORDER BY created_at").toArray();
      const unconfirmed = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE kind IN ('email_send', 'browser_submit', 'message_send', 'mcp_call', 'calendar_change', 'google_task_change') AND status = 'card_unconfirmed' ORDER BY created_at").toArray();
      const reviewOnly = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'review_only' ORDER BY created_at").toArray();
      const done = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status NOT IN ('open', 'changing', 'card_unconfirmed', 'review_only') ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 8").toArray();
      const lines = [
        'Open',
        ...(open.length || unconfirmed.length || reviewOnly.length ? open.map((r) => `- ${summaryOf(r)} (waiting on you${r.deferred_at != null ? '; put off for later' : ''})`) : ['- nothing waiting on you']),
        ...unconfirmed.map((r) => `- ${summaryOf(r)} (${r.card_waits_on ? 'review card goes out when you next write; cannot approve yet' : 'review card delivery unconfirmed; cannot approve'})`),
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
