import { EffectUnknownError, type OwnerEffectLedger, type EffectReceipt, type EffectReadback } from './owner-effect-ledger';
import { stableJson } from '../context-composer/canonical';
import { redactSecretUrls } from './egress-guard';
import type { EffectRecord } from './owner-effect-ledger';
import type { ProxyIntent } from '../connectors/proxy-intent';
import { ProxyIntentError } from '../connectors/proxy-intent';
import { googleTaskProposalSchema, proposeGoogleTaskChangeArgsSchema, proposeCalendarChangeArgsSchema, type BrowserTaskContinuation, type ProposeCalendarChangeArgs, type ProposeGoogleTaskChangeArgs, type GoogleTaskProposal } from '@waldo/contracts';
import { describeGoogleTaskChange, type GoogleTaskApprovalAdapter } from './google-task-approvals';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import { appApprovalReviewV1Schema } from '../../../contracts/src/app/controls';
import { appWorkApprovalV1Schema, type AppWorkApprovalV1 } from '../../../contracts/src/app/work';
import { taskSourceClient } from '../tools/task-source-io';
import { GoogleError, sha256Hex, verifiedSent, type CalendarEffectOptions, type CalendarItem, type GoogleClient } from '../connectors/google';
import type { BrowserSubmitOutcome } from '../tools/live/browser';
import type { TurnLogEntry } from './telegram-listener';

export type TelegramCall = (method: string, body: object) => Promise<unknown>;
export type CallbackQuery = Readonly<{ id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } }>;

type Undo = ({ op: 'cancel'; id: string } | { op: 'move'; id: string; start: string; end: string }) & { applied_etag?: string; calendar_id?: string; send_updates?: CalendarEffectOptions['send_updates']; expected_attendees?: readonly string[] };
type LedgerRow = { id: string; kind: string; status: string; summary: string; payload_json: string; undo_json: string | null; created_at: number; decided_at: number | null; proposal_digest?: string | null; origin_run_ref?: string | null };
export class EmailProposalError extends Error {
  constructor(readonly reason: 'identifier_reused' | 'card_unconfirmed' | 'already_handled') { super(reason); }
}


export const UNDO_WINDOW_MS = 10 * 60_000;
export const PROPOSAL_TTL_MS = 12 * 60 * 60_000;

type Stored = ProposeCalendarChangeArgs & { review_timezone?: string; seen_etag?: string; operation_ref?: string; connection_ref?: string; expected_attendees?: readonly string[]; preserved_description?: string; preserved_location?: string };

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
export type ApprovalReview =
  | Readonly<{ kind: 'email_send'; account?: string; to: readonly string[]; cc: readonly string[]; bcc: readonly string[]; subject: string; body: string }>
  | Readonly<{ kind: 'message_send'; channel: string; content: string }>
  | Readonly<{ kind: 'google_task_change'; account: string; proposal: GoogleTaskProposal; proposal_digest: string }>
  | Readonly<{ kind: 'browser_submit'; url: string; action: BrowserSubmitProposal['action']; binding: BrowserSubmitProposal['binding']; steps: readonly string[]; request?: BrowserSubmitProposal['request']; expires_at: number }>
  | Readonly<{ kind: 'mcp_call'; server: string; tool: string; args: Record<string, unknown>; expires_at: number }>
  | Readonly<{ kind: 'calendar_change'; review_timezone?: string; account?: string; action: 'create' | 'move' | 'cancel'; title: string | null; event_id: string | null; start: string | null; end: string | null; reason: string; calendar_id?: string; connection_ref?: string; attendees?: readonly string[]; send_updates?: CalendarEffectOptions['send_updates']; description?: string; location?: string; seen_etag?: string; proposal_digest?: string }>;
export type ApprovalItem = Readonly<{ id: string; kind: string; summary: string; state: 'open' | 'done' | 'unconfirmed' | 'review_only'; undoable: boolean; review: ApprovalReview | null }>;
export type ApprovalDesk = Readonly<{
  propose(args: ProposeCalendarChangeArgs, turnKey?: string, operationRef?: string, assertCurrent?:()=>Promise<void>): Promise<string>;
  proposeGoogleTaskChange?(args: ProposeGoogleTaskChangeArgs, operationRef?: string, ctx?: ToolDispatcherContext): Promise<string>;
  proposeBrowserSubmit(payload: BrowserSubmitProposal): Promise<string>;
  proposeSendEmail(payload: EmailSendProposal): Promise<string>;
  proposeSendMessage(payload: MessageSendProposal): Promise<string>;
  proposeMcpCall(payload: McpCallProposal): Promise<string>;
  record(kind: string, summary: string, payload: unknown): void;
  callback(query: CallbackQuery, trace: string): Promise<void>;
  decide(id: string, action: 'a' | 's' | 'e' | 'u', trace: string, assertCurrent?:()=>Promise<void>, nativeReviewDigest?:string): Promise<ApprovalDecision>;
  pending(now: number): readonly ApprovalItem[];
  workApprovals(now: number, assertCurrent?: () => Promise<void>): Promise<readonly AppWorkApprovalV1[]>;
  reconcileEffect(record: EffectRecord, assertCurrent: () => Promise<void>): Promise<EffectReadback>;
  ledger(reminders: readonly Readonly<{ note: string; at: string; repeat: string }>[]): string;
}>;

// The owner's "door" for effects: proposals become Telegram cards with Do it / Modify / Not now,
// nothing reaches the calendar before Do it, and every effect lands in one ledger with a
// 10-minute undo where the provider allows it.
export const approvalDesk = (sql: SqlStorage, deps: Readonly<{
  effects?: OwnerEffectLedger;
  call: TelegramCall;
  owner: number;
  effectOwnerRef?: string;
  googleTasks?: () => GoogleTaskApprovalAdapter;
  google(intent?: ProxyIntent, feature?: 'mail' | 'calendar', account?: string, assertCurrent?:()=>Promise<void>): Promise<GoogleClient | null>;
  captureDecisionGuard?:()=>()=>Promise<void>;
  // Captured by the owning host from the exact admitted RunEffectScope.
  currentRunRef?: () => string | undefined;
  newId(): string;
  now(): number;
  timezone: string;
  reviewUrl?: () => Promise<string | null>;
  log(entry: TurnLogEntry): void;
  browserSubmit?: (proposal: BrowserSubmitProposal, approvalRef?: string) => Promise<BrowserSubmitOutcome>;
  browserReconcile?: (proposal: BrowserSubmitProposal, approvalRef: string) => Promise<BrowserSubmitOutcome>;
  browserDeny?: (proposal: BrowserSubmitProposal) => Promise<void>;
  browserReceiptVerified?: (proposal: BrowserSubmitProposal, receipt: Extract<BrowserSubmitOutcome, { status: 'verified_with_receipt' }>['receipt']) => Promise<boolean>;
  messageReconcile?: (proposal: MessageSendProposal, operationId: string) => Promise<EffectReadback>;
  mcpReconcile?: (proposal: McpCallProposal, operationId: string) => Promise<EffectReadback>;
  sendMessage?: (proposal: MessageSendProposal) => Promise<void | Readonly<{ provider_id: string }>>;
  // Returns a bounded owner-facing outcome line (the result is external content).
  mcpCall?: (proposal: McpCallProposal, intent: ProxyIntent) => Promise<string | EffectReceipt>;
}>): ApprovalDesk => {
  sql.exec(`CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL,
    undo_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)`);
  if (!sql.exec<{name:string}>('PRAGMA table_info(ledger)').toArray().some(column => column.name === 'proposal_digest')) sql.exec('ALTER TABLE ledger ADD COLUMN proposal_digest TEXT');
  if (!sql.exec<{name:string}>('PRAGMA table_info(ledger)').toArray().some(column => column.name === 'origin_run_ref')) sql.exec('ALTER TABLE ledger ADD COLUMN origin_run_ref TEXT');
  const bindOrigin = (id: string, origin: string | undefined) => {
    if (origin === undefined) return;
    if (!origin || origin.length > 256 || /[\u0000-\u001f]/.test(origin)) throw new Error('invalid approval origin');
    sql.exec('UPDATE ledger SET origin_run_ref = ? WHERE id = ? AND origin_run_ref IS NULL', origin, id);
  };
  const effectOrigin = (operationId: string) => {
    const operationRef = operationId.replace(/:(apply|undo)$/, '');
    return sql.exec<{origin_run_ref:string|null}>("SELECT origin_run_ref FROM ledger WHERE id = ? OR json_extract(payload_json, '$.operation_ref') = ? ORDER BY created_at LIMIT 1", operationRef.replace(/^approval:/, ''), operationRef).toArray()[0]?.origin_run_ref ?? undefined;
  };
  const effect = async (operationId: string, tool: string, payload: unknown, dispatch: () => Promise<EffectReceipt>, reconcile: () => Promise<EffectReadback>, guard?:()=>Promise<void>) => {
    if (guard) await guard();
    const checkedDispatch = async () => { if (guard) await guard(); const value = await dispatch(); if (guard) await guard(); return value; };
    const checkedReconcile = async () => { if (guard) await guard(); const value = await reconcile(); if (guard) await guard(); return value; };
    if (!deps.effects) return checkedDispatch();
    // Existing physical-owner records retain their original identity during recovery.
    // New approvals use the surface-neutral owner binding supplied by the host.
    const ownerRef = deps.effects.get(operationId)?.owner_ref ?? deps.effectOwnerRef ?? String(deps.owner);
    return deps.effects.execute({ operationId, owner_ref: ownerRef, tool, payload }, { dispatch:checkedDispatch, reconcile:checkedReconcile }, effectOrigin(operationId));
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
  const setStatus = (id: string, status: string, undo: Undo | null = null) =>
    sql.exec('UPDATE ledger SET status = ?, undo_json = ?, decided_at = ? WHERE id = ?', status, undo ? JSON.stringify(undo) : null, deps.now(), id);
  const say = (text: string, buttons?: [string, string][]) =>
    deps.call('sendMessage', { chat_id: deps.owner, text, ...(buttons ? { reply_markup: { inline_keyboard: [buttons.map(([label, data]) => ({ text: label, callback_data: data }))] } } : {}) });

  // A card the owner never saw cannot be approved: a blocked send (no message returned) leaves the row unconfirmed and fails the proposal.
  const sayCard = async (id: string, text: string, buttons?: [string, string][], approvable = true) => {
    if ((await say(text, buttons)) == null) throw new Error('Approval card not confirmed');
    sql.exec("UPDATE ledger SET status = ? WHERE id = ? AND status = 'card_unconfirmed'", approvable ? 'open' : 'review_only', id);
  };

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
  const secretSafeReview = (value: unknown): boolean => {
    const encoded = JSON.stringify(value);
    if (encoded.length > 24_576 || redactSecretUrls(encoded).count) return false;
    const inspect = (item: unknown, depth = 0): boolean => {
      if (depth > 12) return false;
      if (Array.isArray(item)) return item.length <= 256 && item.every(next => inspect(next, depth + 1));
      if (item && typeof item === 'object') return Object.entries(item).every(([key, next]) =>
        !/(?:password|passwd|authorization|cookie|(?:access|refresh|id|auth|api)[_-]?token|^token$|api[_-]?key|private[_-]?key|client[_-]?secret|credential)/i.test(key) && inspect(next, depth + 1));
      return typeof item !== 'string' || !/(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i.test(item);
    };
    return inspect(value);
  };

  const browserReview = (p: BrowserSubmitProposal, createdAt: number) => ({ kind: 'browser_submit' as const, url: p.url, action: p.action, binding: p.binding, steps: p.steps,
    ...(p.request ? { request: p.request } : {}), expires_at: Math.min(createdAt + BROWSER_SUBMIT_TTL_MS, p.approvalExpiresAt ?? Infinity) });
  const mcpReview = (p: McpCallProposal, createdAt: number) => ({ kind: 'mcp_call' as const, server: p.server, tool: p.tool, args: p.args, expires_at: createdAt + PROPOSAL_TTL_MS });
  const reviewableExternal = (candidate: unknown) => secretSafeReview(candidate) && appApprovalReviewV1Schema.safeParse(candidate).success;
  const withheldExternal = (kind: string) => `${kind === 'browser_submit' ? 'Browser action' : 'MCP tool call'} needs a review without credentials. Nothing was approved or sent.`;

  const reviewEmail = (p: EmailSendProposal) =>
    [...(p.account ? [`From: ${p.account}`] : []), `To: ${p.to.join(', ')}`,
      ...(p.cc?.length ? [`Cc: ${p.cc.join(', ')}`] : []),
      ...(p.bcc?.length ? [`Bcc: ${p.bcc.join(', ')}`] : []),
      `Subject: ${p.subject}`, '', p.body].join('\n');
  const reviewMessage = (p: MessageSendProposal) => p.content;
  const unreviewable = (kind: string, summary: string) =>
    `${kind} ${summary}\n\nThe full content doesn't fit in this card, so it can't be approved here - approving would send text you haven't reviewed. Use the Not now instruction on the card and ask me to show you the full text first.`;
  const describeAny = (entry: LedgerRow) => {
    if (entry.kind === 'task_sources') return 'Task sources (expired)';
    if (entry.kind === 'google_task_change') return describeGoogleTaskChange(googleTaskProposalSchema.parse(JSON.parse(entry.payload_json)));
    if (entry.kind === 'browser_submit') return describeBrowser(JSON.parse(entry.payload_json) as BrowserSubmitProposal);
    if (entry.kind === 'email_send') return describeEmail(JSON.parse(entry.payload_json) as EmailSendProposal);
    if (entry.kind === 'message_send') return describeMessage(JSON.parse(entry.payload_json) as MessageSendProposal);
    if (entry.kind === 'mcp_call') return describeMcp(JSON.parse(entry.payload_json) as McpCallProposal);
    return describe(JSON.parse(entry.payload_json) as Stored);
  };
  // ADR-0054 exactly-once: a second approval of the same idempotency key collapses onto the
  // first send instead of double-delivering.
  const keyHolder = (key: string, selfId: string) =>
    sql.exec<{ id: string; status: string; payload_json: string }>("SELECT id, status, payload_json FROM ledger WHERE kind = 'message_send' AND status IN ('done', 'uncertain') AND id != ? AND json_extract(payload_json, '$.idempotency_key') = ? LIMIT 1", selfId, key).toArray()[0];
  const expired = (entry: LedgerRow, p: Stored) =>
    (entry.kind === 'browser_submit' && (p as unknown as BrowserSubmitProposal).approvalExpiresAt !== undefined && (!Number.isSafeInteger((p as unknown as BrowserSubmitProposal).approvalExpiresAt) || deps.now() >= (p as unknown as BrowserSubmitProposal).approvalExpiresAt!)) ||
    deps.now() - entry.created_at > (entry.kind === 'browser_submit' ? BROWSER_SUBMIT_TTL_MS : PROPOSAL_TTL_MS) || (entry.kind !== 'browser_submit' && p.start !== undefined && Date.parse(p.start) <= deps.now());
  const readCalendarEvent = (client: GoogleClient, calendarId: string, id: string): Promise<CalendarItem> => {
    if (client.eventInCalendar) return client.eventInCalendar(calendarId, id);
    if (calendarId !== 'primary') throw new Error('Selected Calendar readback is unavailable; nothing was retargeted');
    return client.event(id);
  };
  const sameTime = (observed: string, expected: string | undefined) => expected !== undefined && (observed === expected || (!/^\d{4}-\d{2}-\d{2}$/.test(expected) && Number.isFinite(Date.parse(observed)) && Date.parse(observed) === Date.parse(expected)));
  const sameAudience = (observed: CalendarItem, expected: readonly string[] | undefined) => expected === undefined || observed.attendees_complete === true && JSON.stringify(observed.attendee_emails) === JSON.stringify([...expected].map(email => email.toLowerCase()).sort());
  const calendarOptions = (p: Stored): CalendarEffectOptions => ({ calendar_id:p.calendar_id ?? 'primary', ...(p.send_updates !== undefined ? {send_updates:p.send_updates} : {}), ...(p.expected_attendees !== undefined ? {expected_attendees:p.expected_attendees} : {}) });
  const apply = async (client: GoogleClient, p: Stored, eventId?: string, marker?: string): Promise<Undo | null | 'stale'> => {
    const options=calendarOptions(p);
    if (p.action === 'create') {
      const applied = await client.createEvent({ title:p.title!, start:p.start!, end:p.end!, calendar_id:options.calendar_id, ...(p.attendees ? {attendees:p.attendees} : {}), ...(p.send_updates !== undefined ? {send_updates:p.send_updates} : {}), ...(p.description !== undefined ? {description:p.description} : {}), ...(p.location !== undefined ? {location:p.location} : {}), ...(eventId ? { id:eventId } : {}), ...(marker ? { operationMarker:marker } : {}) });
      return applied.etag ? { op:'cancel', id:applied.id, applied_etag:applied.etag, ...options } : null;
    }
    const before = await readCalendarEvent(client,options.calendar_id!,p.event_id!);
    if (!p.seen_etag || before.etag !== p.seen_etag || !sameAudience(before,p.expected_attendees)) return 'stale';
    try {
      if (p.action === 'move') {
        const applied = await client.moveEvent(p.event_id!,p.start!,p.end!,before.etag,marker,options);
        return applied.etag ? { op:'move', id:p.event_id!, start:before.start, end:before.end, applied_etag:applied.etag, ...options } : null;
      }
      await client.cancelEvent(p.event_id!,before.etag,marker,options);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 412) return 'stale';
      throw error;
    }
    return null;
  };
  const revert = async (client: GoogleClient, undo: Undo, marker?: string): Promise<'undone' | 'stale' | 'unavailable'> => {
    // Legacy entries have no applied version. A fresh owner edit never grants Undo authority.
    if (!undo.applied_etag) return 'unavailable';
    const calendarId=undo.calendar_id ?? 'primary';
    const current = await readCalendarEvent(client,calendarId,undo.id);
    if (current.etag !== undo.applied_etag || !sameAudience(current,undo.expected_attendees)) return 'stale';
    const options:CalendarEffectOptions={calendar_id:calendarId,...(undo.send_updates!==undefined?{send_updates:undo.send_updates}:{}),...(undo.expected_attendees!==undefined?{expected_attendees:undo.expected_attendees}:{})};
    try {
      if (undo.op === 'cancel') await client.cancelEvent(undo.id,undo.applied_etag,marker,options);
      else await client.moveEvent(undo.id,undo.start,undo.end,undo.applied_etag,marker,options);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 412) return 'stale';
      throw error;
    }
    return 'undone';
  };

  const decide = async (id: string, action: 'a' | 's' | 'e' | 'u', trace: string, requestedGuard?:()=>Promise<void>, nativeReviewDigest?:string): Promise<ApprovalDecision> => {
    const guard=requestedGuard??deps.captureDecisionGuard?.();if(guard)await guard();
    const checkedGoogle=async(intent?:ProxyIntent,feature?:'mail'|'calendar',account?:string)=>{await guard?.();const client=await deps.google(intent,feature,account,guard);await guard?.();return client?taskSourceClient(client,{assertTaskSourceCurrent:guard}):null;};
    const started = deps.now();
    let entry = row(id);
    // The app can show the complete frozen review when a transport card cannot.
    // Only its authenticated, projection-bound decision supplies this digest;
    // channel callbacks never promote a card that lacked an approval button.
    if (entry?.status === 'review_only' && ['a', 'e'].includes(action) && nativeReviewDigest && requestedGuard) {
      const before = entry, shown = desk.pending(started).find(item => item.id === id)?.review;
      if (!shown || !appApprovalReviewV1Schema.safeParse(shown).success || await sha256Hex(before.payload_json) !== nativeReviewDigest) throw new Error('Native approval review changed');
      await requestedGuard();
      const current = row(id);
      if (!current || current.status !== before.status || current.payload_json !== before.payload_json) throw new Error('Native approval review changed');
      sql.exec("UPDATE ledger SET status = 'open' WHERE id = ? AND status = 'review_only' AND payload_json = ?", id, before.payload_json);
      entry = row(id);
    }
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
        if (action !== 'a' || !deps.googleTasks || !deps.effects) {
          out = { toast: 'Not available', message: 'This Google task approval cannot be applied here. Nothing was changed.' };
        } else {
          const taskProposal = googleTaskProposalSchema.parse(JSON.parse(entry.payload_json));
          if (!entry.proposal_digest || await sha256Hex(JSON.stringify(taskProposal)) !== entry.proposal_digest) {setStatus(id,'failed');throw new Error('Google task proposal identity changed');}
          if (guard) await guard();
          if (!recovering) {
            sql.exec("UPDATE ledger SET status = 'uncertain', decided_at = ? WHERE id = ? AND status = 'open'", deps.now(), id);
            if (sql.exec<{claimed:number}>('SELECT changes() AS claimed').one().claimed !== 1) return { toast: 'Already handled.', message: 'Already handled.' };
          }
          const result = await deps.googleTasks().apply(id, taskProposal, operationRef,{assertTaskSourceCurrent:guard});
          if (result.status === 'done') { setStatus(id, 'done'); out = { toast: 'Done', message: `The Google task change was applied and independently read back: ${describeGoogleTaskChange(taskProposal)}` }; }
          else if (result.status === 'stale') { setStatus(id, 'rejected'); out = { toast: 'The task changed', message: 'The Google task changed after your review. Nothing was changed; ask for a fresh proposal.' }; }
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
                }, async () => deps.browserReconcile ? checkedBrowser(await deps.browserReconcile(bp, id)) : outcome?.status === 'rejected' ? { status: 'not_applied' } : { status: 'unknown' },guard);
                outcome = receipt.result as BrowserSubmitOutcome;
              } else {if(guard)await guard();outcome=await deps.browserSubmit(bp,id);if(guard)await guard();}
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
          const client = await checkedGoogle({id:`approval:${id}:apply`},'mail',ep.account);
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
              },guard);
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
            await effect(`${operationRef}:apply`, 'send_message', mp, async () => { const sent = await deps.sendMessage!(mp); if (deps.effects && !sent?.provider_id) throw new EffectUnknownError(); return { provider_id: sent?.provider_id ?? mp.idempotency_key, result: null }; }, async () => ({ status: 'unknown' }),guard);
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
            if(!recovering){sql.exec("UPDATE ledger SET status = 'uncertain', decided_at = ? WHERE id = ? AND status = 'open'",deps.now(),id);if(sql.exec<{claimed:number}>('SELECT changes() AS claimed').one().claimed!==1)return {toast:'Already handled.',message:'Already handled.'};}
            const receipt = await effect(`${operationRef}:apply`, 'call_mcp_tool', cp, async () => { const result = await deps.mcpCall!(cp,{id:`approval:${id}:apply`}); if (typeof result !== 'string') return result; if (deps.effects) throw new EffectUnknownError(); return { provider_id: `${operationRef}:apply`, result }; }, async () => ({ status: 'unknown' }),guard);
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
        const client = await checkedGoogle({id:`approval:${id}:${action==='u'?'undo':'apply'}`,requireRoute:action==='u'||proposal.action!=='create'},'calendar',proposal.account);
        if (client === null || (proposal.account && client.account?.email?.toLowerCase() !== proposal.account.toLowerCase()) || proposal.connection_ref && client.account?.connection_id !== proposal.connection_ref) {
          out = { toast: 'Google is not connected', message: 'I could not do that because Google is not connected.' };
        } else if (action === 'a') {
          if(!entry.proposal_digest || await sha256Hex(entry.payload_json)!==entry.proposal_digest){setStatus(id,'failed');return {toast:'Calendar proposal changed',message:'The calendar proposal no longer matches the reviewed payload. Nothing was changed; ask for a fresh proposal.'};}
          const eventId = proposal.action === 'create' ? await sha256Hex(`${operationRef}:apply`) : proposal.event_id!;
          const marker = await sha256Hex(`${operationRef}:apply`);
          if(!recovering){if(guard)await guard();sql.exec("UPDATE ledger SET status = 'uncertain', decided_at = ? WHERE id = ? AND status = 'open'",deps.now(),id);if(sql.exec<{claimed:number}>('SELECT changes() AS claimed').one().claimed!==1)return {toast:'Already handled.',message:'Already handled.'};}
          const receipt = await effect(`${operationRef}:apply`, 'calendar_change', proposal, async () => {
            const undo = await apply(client, proposal, deps.effects ? eventId : undefined, marker);
            return { provider_id: eventId, result: undo };
          }, async () => {
            try {
              const current = await readCalendarEvent(client,proposal.calendar_id ?? 'primary',eventId);
              if (current.operation_marker !== marker) return {status:'unknown'};
              if (proposal.action !== 'cancel' && current.status !== 'cancelled' && (proposal.action !== 'create' || current.title === proposal.title) && sameTime(current.start, proposal.start) && sameTime(current.end, proposal.end) && current.etag
                && (!proposal.seen_etag || current.etag !== proposal.seen_etag) && sameAudience(current,proposal.expected_attendees)
                && (proposal.action==='create' ? (current.description ?? '')===(proposal.description ?? '') && (current.location ?? '')===(proposal.location ?? '') : current.title===proposal.title && (current.description ?? '')===(proposal.preserved_description ?? '') && (current.location ?? '')===(proposal.preserved_location ?? ''))) {
                // A marker can survive a later owner edit. Recovery proves the effect, but
                // cannot establish the exact applied ETag needed for safe Undo.
                return { status: 'done', receipt: { provider_id: current.id, result: null } };
              }
              if (proposal.action === 'cancel' && current.status === 'cancelled') return { status: 'done', receipt: { provider_id: eventId, result: null } };
            } catch (error) {
              deps.log({ trace, hop: 'calendar_readback', ms: 0, ok: false, error: String(error) });
            }
            return { status: 'unknown' };
          },guard);
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
                const current = await readCalendarEvent(client,undo.calendar_id ?? 'primary',undo.id);
                if (current.operation_marker === marker && (undo.op === 'cancel' ? current.status === 'cancelled' : current.status !== 'cancelled' && sameTime(current.start,undo.start) && sameTime(current.end,undo.end) && sameAudience(current,undo.expected_attendees)))
                  return {status:'done',receipt:{provider_id:undo.id,result:'undone'}};
              } catch (error) { deps.log({trace,hop:'calendar_undo_readback',ms:0,ok:false,error:String(error)}); }
              return {status:'unknown'};
            },guard);
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
  const desk: ApprovalDesk = {
    decide,
    async reconcileEffect(record, guard) {
      await guard();
      if (!deps.effects || deps.effects.get(record.operationId)?.identity !== record.identity) return { status: 'unknown' };
      const operationRef = record.operationId.replace(/:(apply|undo)$/, '');
      const entry = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE id = ? OR json_extract(payload_json, '$.operation_ref') = ? ORDER BY created_at LIMIT 1", operationRef.replace(/^approval:/, ''), operationRef).toArray()[0];
      if (!entry) return { status: 'unknown' };
      const undoing = record.operationId.endsWith(':undo'), payload = JSON.parse(undoing ? entry.undo_json ?? 'null' : entry.payload_json);
      if (stableJson(record.payload) !== stableJson(payload)) return { status: 'unknown' };
      const outcome = await deps.effects.reconcile(record.operationId, { assertCurrent: guard, readback: async (): Promise<EffectReadback> => {
        await guard();
        if (entry.kind === 'google_task_change' && !undoing && deps.googleTasks) return deps.googleTasks().reconcile(entry.id, googleTaskProposalSchema.parse(payload), operationRef, { assertTaskSourceCurrent: guard });
        if (entry.kind === 'browser_submit' && !undoing && deps.browserReconcile) {
          const result = await deps.browserReconcile(payload as BrowserSubmitProposal, entry.id); await guard();
          if (result.status === 'rejected') return { status: 'not_applied' };
          if (result.status === 'verified_with_receipt' && await deps.browserReceiptVerified?.(payload as BrowserSubmitProposal, result.receipt) === true) { await guard(); return { status: 'done', receipt: { provider_id: result.receipt.id, result } }; }
          return { status: 'unknown' };
        }
        if (entry.kind === 'message_send' && !undoing) return deps.messageReconcile?.(payload as MessageSendProposal, record.operationId) ?? { status: 'unknown' };
        if (entry.kind === 'mcp_call' && !undoing) return deps.mcpReconcile?.(payload as McpCallProposal, record.operationId) ?? { status: 'unknown' };
        if (entry.kind !== 'calendar_change' && entry.kind !== 'email_send') return { status: 'unknown' };
        const p = JSON.parse(entry.payload_json) as Stored;
        const selected = await deps.google({ id: `approval:${entry.id}:${undoing ? 'undo' : 'apply'}`, requireRoute: true }, entry.kind === 'email_send' ? 'mail' : 'calendar', p.account, guard); await guard();
        if (!selected || p.account && selected.account?.email?.toLowerCase() !== p.account.toLowerCase() || p.connection_ref && selected.account?.connection_id !== p.connection_ref) return { status: 'unknown' };
        const client = taskSourceClient(selected, { assertTaskSourceCurrent: guard });
        if (entry.kind === 'email_send' && !undoing) {
          const ep = payload as EmailSendProposal;
          if (await sha256Hex(ep.raw) !== ep.digest) return { status: 'unknown' }; await guard();
          const landed = await client.findSentByMessageId(ep.message_id, ep.thread_id); await guard();
          return verifiedSent(landed, ep.message_id, ep.thread_id) ? { status: 'done', receipt: { provider_id: landed.message_id, result: landed } } : { status: 'unknown' };
        }
        const marker = await sha256Hex(record.operationId); await guard();
        const target = undoing ? (payload as Undo).id : p.action === 'create' ? marker : p.event_id!;
        const observed = await readCalendarEvent(client, undoing ? (payload as Undo).calendar_id ?? 'primary' : p.calendar_id ?? 'primary', target); await guard();
        if (observed.operation_marker !== marker) return { status: 'unknown' };
        if (undoing) {
          const undo = payload as Undo;
          return (undo.op === 'cancel' ? observed.status === 'cancelled' : observed.status !== 'cancelled' && sameTime(observed.start, undo.start) && sameTime(observed.end, undo.end) && sameAudience(observed, undo.expected_attendees))
            ? { status: 'done', receipt: { provider_id: target, result: 'undone' } } : { status: 'unknown' };
        }
        if (p.action === 'cancel') return observed.status === 'cancelled' ? { status: 'done', receipt: { provider_id: target, result: null } } : { status: 'unknown' };
        const verified = observed.status !== 'cancelled' && observed.title === p.title && sameTime(observed.start, p.start) && sameTime(observed.end, p.end) && observed.etag
          && (!p.seen_etag || observed.etag !== p.seen_etag) && sameAudience(observed, p.expected_attendees)
          && (observed.description ?? '') === (p.description ?? p.preserved_description ?? '') && (observed.location ?? '') === (p.location ?? p.preserved_location ?? '');
        return verified ? { status: 'done', receipt: { provider_id: target, result: null } } : { status: 'unknown' };
      } });
      await guard();
      if (outcome.status === 'done' && entry.status === 'uncertain') setStatus(entry.id, undoing ? 'undone' : 'done');
      if (outcome.status === 'not_applied' && entry.status === 'uncertain') setStatus(entry.id, 'rejected');
      return outcome;
    },
    async proposeGoogleTaskChange(args, operationRef, ctx) {
      const originRunRef = deps.currentRunRef?.();
      if (!deps.googleTasks || !deps.effects) throw new Error('Google task approval custody is unavailable');
      args=proposeGoogleTaskChangeArgsSchema.parse(args);
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
      const proposal = googleTaskProposalSchema.parse({ ...await deps.googleTasks().prepare(id, args, ctx), ...(operationRef ? {operation_ref:operationRef} : {}) });
      const digest = await sha256Hex(JSON.stringify(proposal));
      if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
      const summary = describeGoogleTaskChange(proposal);
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at, proposal_digest) VALUES (?, 'google_task_change', 'card_unconfirmed', ?, ?, NULL, ?, NULL, ?)", id, summary, JSON.stringify(proposal), deps.now(), digest);
      bindOrigin(id, originRunRef);
      const review = `Proposed Google task change:\n${JSON.stringify(proposal, null, 2)}`;
      await sayCard(id, review.length <= REVIEW_BUDGET ? review : unreviewable('Google task change?', summary), review.length <= REVIEW_BUDGET ? [['Do it', `a:${id}`], ['Modify', `e:${id}`], ['Not now', `s:${id}`]] : [['Not now', `s:${id}`]], review.length <= REVIEW_BUDGET);
      return id;
    },
    async proposeBrowserSubmit(payload) {
      const originRunRef = deps.currentRunRef?.();
      const id = `p${deps.newId()}`;
      const createdAt = deps.now(), safe = reviewableExternal(browserReview(payload, createdAt));
      const summary = safe ? describeBrowser(payload) : withheldExternal('browser_submit');
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, 'browser_submit', 'card_unconfirmed', ?, ?, NULL, ?, NULL)", id, summary, JSON.stringify(payload), createdAt);
      bindOrigin(id, originRunRef);
      const text = `Approve this browser action? ${summary}\n\nExact action:\n${JSON.stringify(browserReview(payload, createdAt), null, 2)}`, approvable = safe && text.length <= REVIEW_BUDGET;
      await sayCard(id, safe ? approvable ? text : unreviewable('Browser action?', summary) : summary,
        approvable ? [['Do it', `a:${id}`], ['Not now', `s:${id}`]] : [['Not now', `s:${id}`]], approvable);
      return id;
    },
    async proposeSendEmail(payload) {
      const originRunRef = deps.currentRunRef?.();
      // The turn/content key binds ingress retries; Message-ID is the fallback for exact desk
      // retries. A prior card whose delivery is unknown is not issued again blindly:
      // duplicate cards could each approve one effect.
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
      const text = `Send this email? ${reviewEmail(payload)}`;
      const approvable = text.length <= REVIEW_BUDGET;
      try {
        const delivered = await say(approvable ? text : unreviewable('Send this email?', summary),
          approvable ? [['Send it', `a:${id}`], ['Modify', `e:${id}`], ['Not now', `s:${id}`]] : [['Not now', `s:${id}`]]);
        if (delivered == null) throw new EmailProposalError('card_unconfirmed');
      } catch {
        // A timeout can mean the card arrived. Leave it unapprovable until reconciled;
        // never say a card was delivered or attempt a second blind send.
        throw new EmailProposalError('card_unconfirmed');
      }
      sql.exec("UPDATE ledger SET status = ? WHERE id = ? AND status = 'card_unconfirmed'", approvable ? 'open' : 'review_only', id);
      const url = await deps.reviewUrl?.().catch(() => null);
      const detail = url ? ` View details: ${url}. This page cannot approve email sends.` : '';
      const receipt = approvable
        ? 'Email ready for review. The card above has the exact recipients, subject and body. If it is right, use the Send it instruction on that card. Nothing has been sent.'
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
      const text = `Send this message on ${payload.channel}?\n\n${reviewMessage(payload)}`;
      await sayCard(id, text.length <= REVIEW_BUDGET ? text : unreviewable('Send this message?', summary),
        text.length <= REVIEW_BUDGET ? [['Send it', `a:${id}`], ['Modify', `e:${id}`], ['Not now', `s:${id}`]] : [['Not now', `s:${id}`]], text.length <= REVIEW_BUDGET);
      return id;
    },
    async proposeMcpCall(payload) {
      const originRunRef = deps.currentRunRef?.();
      const id = `p${deps.newId()}`;
      const createdAt = deps.now(), safe = reviewableExternal(mcpReview(payload, createdAt));
      const summary = safe ? describeMcp(payload) : withheldExternal('mcp_call');
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, 'mcp_call', 'card_unconfirmed', ?, ?, NULL, ?, NULL)", id, summary, JSON.stringify(payload), createdAt);
      bindOrigin(id, originRunRef);
      const text = safe ? `Run this MCP tool? ${summary}\n\nArgs:\n${JSON.stringify(payload.args, null, 2)}` : summary, approvable = safe && text.length <= REVIEW_BUDGET;
      await sayCard(id, safe ? approvable ? text : unreviewable('Run this MCP tool?', summary) : summary,
        approvable ? [['Do it', `a:${id}`], ['Not now', `s:${id}`]] : [['Not now', `s:${id}`]], approvable);
      return id;
    },
    async propose(p, turnKey, operationRef, requestedGuard) {
      const originRunRef = deps.currentRunRef?.();
      p=proposeCalendarChangeArgsSchema.parse(p);
      const guard=requestedGuard??deps.captureDecisionGuard?.();
      if(guard)await guard();
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
        const selected = await deps.google({id:`approval:${id}:apply`},'calendar',p.account,guard);
        if(guard)await guard();
        const client=selected?taskSourceClient(selected,{assertTaskSourceCurrent:guard}):null;
        if((p.event_id || p.account)&&!client)throw new Error('The calendar account is unavailable; no proposal was prepared.');
        if (p.account && client?.account?.email?.toLowerCase() !== p.account.toLowerCase()) throw new Error('Selected calendar account is unavailable');
        const calendarId=p.calendar_id ?? 'primary';
        if(calendarId!=='primary'&&!client?.eventInCalendar)throw new Error('Selected Calendar readback is unavailable; no proposal was prepared');
        const before = client && p.event_id ? await readCalendarEvent(client,calendarId,p.event_id) : undefined;
        if(before&&(!before.etag||before.status==='cancelled'))throw new Error('The event has no current usable version; no proposal was prepared');
        if(before?.attendees_complete===true&&before.attendee_emails?.length&&p.send_updates===undefined)throw new Error('An event with guests requires an explicit notification choice');
        if(before&&p.send_updates!==undefined&&before.attendees_complete!==true)throw new Error('The complete calendar attendee audience is unavailable; no notification proposal was prepared');
        const bound = {...p,calendar_id:calendarId,...(before?{title:before.title}:{}),...(client?.account?.email?{account:client.account.email}:{})};
        const summary = `${describe(bound)}. ${bound.reason}`;
        const seen = before?.etag;
        const audience=before?.attendees_complete===true?before.attendee_emails:p.action==='create'&&(client?.eventInCalendar||p.attendees)?p.attendees??[]:undefined;
        const stored:Stored={...bound,review_timezone:deps.timezone,...(seen?{seen_etag:seen}:{}),...(client?.account?.connection_id?{connection_ref:client.account.connection_id}:{}),...(audience!==undefined?{expected_attendees:[...audience].map(email=>email.toLowerCase()).sort()}:{}),...(before?{preserved_description:before.description??'',preserved_location:before.location??''}:{}),...(operationRef?{operation_ref:operationRef}:{})};
        const payload=JSON.stringify(stored),proposalDigest=await sha256Hex(payload);
        if(guard)await guard();
        sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at, proposal_digest) VALUES (?, 'calendar_change', 'card_unconfirmed', ?, ?, NULL, ?, NULL, ?)",id,summary,payload,deps.now(),proposalDigest);
        bindOrigin(id, originRunRef);
        const review=[`Proposed: ${summary}`,`Calendar: ${calendarId}`,`Review timezone: ${deps.timezone}`,...(stored.start?[`Start: ${stored.start}`]:[]),...(stored.end?[`End (exclusive): ${stored.end}`]:[]),...(stored.connection_ref?[`Account connection: ${stored.connection_ref}`]:[]),...(stored.expected_attendees!==undefined?[`Attendees: ${stored.expected_attendees.join(', ')||'none'}`]:[]),`Guest updates: ${stored.send_updates??'provider default; delivery unverified'}`,...(stored.description!==undefined?[`Description: ${stored.description}`]:[]),...(stored.location!==undefined?[`Location: ${stored.location}`]:[]),...(before?[`Preserved description: ${stored.preserved_description}`,`Preserved location: ${stored.preserved_location}`,`Reviewed version: ${stored.seen_etag}`]:[]),`Proposal digest: ${proposalDigest}`].join('\n');
        const approvable=review.length<=REVIEW_BUDGET;
        await sayCard(id,approvable?review:unreviewable('Calendar change?',summary),approvable?[['Do it',`a:${id}`],['Modify',`e:${id}`],['Not now',`s:${id}`]]:[['Not now',`s:${id}`]],approvable);
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
      const id = `l${deps.newId()}`;
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, ?, 'done', ?, ?, NULL, ?, ?)", id, kind, summary, JSON.stringify(payload), deps.now(), deps.now());
      bindOrigin(id, deps.currentRunRef?.());
    },
    // The console must show the *stored* recipient, words and final calendar effect before
    // offering an approval action. Never expose raw MIME, tokens or arbitrary MCP args here.
    pending(now) {
      const open = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'open' ORDER BY created_at").toArray();
      const unconfirmed = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE kind IN ('email_send','message_send','google_task_change','calendar_change','browser_submit','mcp_call') AND status = 'card_unconfirmed' ORDER BY created_at").toArray();
      const reviewOnly = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'review_only' ORDER BY created_at").toArray();
      const uncertain = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'uncertain' ORDER BY created_at").toArray();
      const undoable = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'done' AND undo_json IS NOT NULL AND decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT 5").toArray();
      const review = (r: LedgerRow): ApprovalReview | null => {
        try {
          if (r.kind === 'browser_submit') {
            const p = JSON.parse(r.payload_json) as BrowserSubmitProposal;
            const candidate = browserReview(p, r.created_at);
            return reviewableExternal(candidate) ? candidate : null;
          }
          if (r.kind === 'mcp_call') {
            const p = JSON.parse(r.payload_json) as McpCallProposal;
            const candidate = mcpReview(p, r.created_at);
            return reviewableExternal(candidate) ? candidate : null;
          }
          if (r.kind === 'google_task_change') {
            const proposal = googleTaskProposalSchema.parse(JSON.parse(r.payload_json));
            return r.proposal_digest ? { kind: 'google_task_change', account: proposal.account.email, proposal, proposal_digest: r.proposal_digest } : null;
          }
          if (r.kind === 'email_send') {
            const p = JSON.parse(r.payload_json) as EmailSendProposal;
            if (!Array.isArray(p.to) || !p.to.length || !p.to.every((address) => typeof address === 'string') || !Array.isArray(p.cc ?? []) || !Array.isArray(p.bcc ?? []) || !(p.cc ?? []).every((address) => typeof address === 'string') || !(p.bcc ?? []).every((address) => typeof address === 'string') || typeof p.subject !== 'string' || typeof p.body !== 'string') return null;
            return { kind: 'email_send', ...(p.account ? {account:p.account} : {}), to: p.to, cc: p.cc ?? [], bcc: p.bcc ?? [], subject: p.subject, body: p.body };
          }
          if (r.kind === 'message_send') {
            const p = JSON.parse(r.payload_json) as MessageSendProposal;
            return typeof p.channel === 'string' && typeof p.content === 'string' ? { kind: 'message_send', channel: p.channel, content: p.content } : null;
          }
          if (r.kind === 'calendar_change') {
            const p = JSON.parse(r.payload_json) as Stored;
            if (!['create', 'move', 'cancel'].includes(p.action) || typeof p.reason !== 'string') return null;
            if (p.action === 'create' && (!p.title || !p.start || !p.end)) return null;
            if (p.action === 'move' && (!p.event_id || !p.title || !p.start || !p.end)) return null;
            if (p.action === 'cancel' && (!p.event_id || !p.title)) return null;
            return {kind:'calendar_change',...(p.review_timezone?{review_timezone:p.review_timezone}:{}),...(p.account?{account:p.account}:{}),action:p.action,title:p.title??null,event_id:p.event_id??null,start:p.start??null,end:p.end??null,reason:p.reason,...(p.calendar_id?{calendar_id:p.calendar_id}:{}),...(p.connection_ref?{connection_ref:p.connection_ref}:{}),...(p.expected_attendees!==undefined?{attendees:p.expected_attendees}:{}),...(p.send_updates!==undefined?{send_updates:p.send_updates}:{}),...(p.description!==undefined||p.preserved_description!==undefined?{description:p.description??p.preserved_description}:{}),...(p.location!==undefined||p.preserved_location!==undefined?{location:p.location??p.preserved_location}:{}),...(p.seen_etag?{seen_etag:p.seen_etag}:{}),...(r.proposal_digest?{proposal_digest:r.proposal_digest}:{})};
          }
          return null;
        } catch { return null; }
      };
      const display = (r: LedgerRow, state: ApprovalItem['state'], undoable = false): ApprovalItem => {
        const shown = review(r), external = r.kind === 'browser_submit' || r.kind === 'mcp_call';
        return { id: r.id, kind: r.kind, summary: external && !shown ? withheldExternal(r.kind) : r.summary, state, undoable, review: shown };
      };
      return [
        ...open.map(r => display(r, 'open')),
        ...unconfirmed.map(r => display(r, 'unconfirmed')),
        ...reviewOnly.map(r => display(r, 'review_only')),
        ...uncertain.map(r => display(r, 'unconfirmed')),
        ...undoable.map(r => display(r, 'done', r.decided_at !== null && now - r.decided_at <= UNDO_WINDOW_MS)),
      ];
    },
    async workApprovals(now, assertCurrent) {
      if (assertCurrent) await assertCurrent();
      const visible = new Map(desk.pending(now).map(item => [item.id, item]));
      const proposals = await Promise.all([...visible.values()].map(async item => {
        const frozen = row(item.id);
        if (!frozen) throw new Error('Approval changed during projection');
        const computed = await sha256Hex(frozen.payload_json);
        const digest = frozen.proposal_digest && frozen.proposal_digest !== computed ? null : computed;
        const supported = item.review !== null && appApprovalReviewV1Schema.safeParse(item.review).success && digest !== null && (!('expires_at' in item.review) || item.review.expires_at > now)
          && (item.state === 'done' || !expired(frozen, JSON.parse(frozen.payload_json) as Stored));
        const actions: AppWorkApprovalV1['actions'] = supported && (item.state === 'open' || item.state === 'review_only')
          ? ['approve', 'deny', 'edit'] : supported && item.state === 'done' && item.undoable ? ['undo'] : [];
        const stored = JSON.parse(frozen.payload_json) as { operation_ref?: unknown };
        return appWorkApprovalV1Schema.parse({ ...item, proposal_digest: digest,
          operation_ref: typeof stored.operation_ref === 'string' ? stored.operation_ref : null, actions });
      }));
      if (assertCurrent) await assertCurrent();
      return proposals;
    },
    async callback(query, trace) {
      const [action = '', id] = (query.data ?? '').split(':');
      const answer = (text: string) => deps.call('answerCallbackQuery', { callback_query_id: query.id, text }).catch(() => undefined);
      if (query.from.id !== deps.owner || !id || !['a', 's', 'e', 'u'].includes(action)) return void (await answer('Not available.'));
      if (query.message) await deps.call('editMessageReplyMarkup', { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      const out = await decide(id, action as 'a' | 's' | 'e' | 'u', trace);
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
      const unconfirmed = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE kind IN ('email_send', 'browser_submit', 'message_send', 'mcp_call', 'calendar_change', 'google_task_change') AND status = 'card_unconfirmed' ORDER BY created_at").toArray();
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
  return desk;
};
