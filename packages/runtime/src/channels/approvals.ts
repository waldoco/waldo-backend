import type { ProposeCalendarChangeArgs } from '@waldo/contracts';
import { GoogleError, sha256Hex, type GoogleClient } from '../connectors/google';
import type { TurnLogEntry } from './telegram-listener';

export type TelegramCall = (method: string, body: object) => Promise<unknown>;
export type CallbackQuery = Readonly<{ id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } }>;

type Undo = { op: 'cancel'; id: string } | { op: 'move'; id: string; start: string; end: string };
type LedgerRow = { id: string; kind: string; status: string; summary: string; payload_json: string; undo_json: string | null; created_at: number; decided_at: number | null };

export const UNDO_WINDOW_MS = 10 * 60_000;
export const PROPOSAL_TTL_MS = 12 * 60 * 60_000;

type Stored = ProposeCalendarChangeArgs & { seen_etag?: string };

// B-tool-3: the exact thing the owner approved. The executor replays it in a fresh browser
// session and re-reads the binding from the page before acting - a changed price/item/destination
// aborts, approval does not carry across a changed page.
export type BrowserSubmitProposal = Readonly<{
  url: string;
  action: Readonly<{ selector: string; description: string; method?: string; arguments?: string[] }>;
  binding: Readonly<Record<string, string>>;
  steps: readonly string[];
}>;
const BROWSER_SUBMIT_TTL_MS = 30 * 60_000;

// The gmail send rail's stored proposal: the canonical MIME bytes the owner approved plus the
// sha256 digest binding them. Approval replays payload.raw verbatim; a digest mismatch fails
// closed instead of sending; message_id reconciles an ambiguous send via Sent-mail lookup.
export type EmailSendProposal = Readonly<{
  to: readonly string[]; cc?: readonly string[]; bcc?: readonly string[];
  subject: string; body: string; thread_id?: string; message_id: string; raw: string; digest: string;
}>;

export type ApprovalDecision = Readonly<{ toast: string; message: string }>;
export type ApprovalItem = Readonly<{ id: string; summary: string; state: 'open' | 'done'; undoable: boolean }>;
export type ApprovalDesk = Readonly<{
  propose(args: ProposeCalendarChangeArgs): Promise<string>;
  proposeBrowserSubmit(payload: BrowserSubmitProposal): Promise<string>;
  proposeSendEmail(payload: EmailSendProposal): Promise<string>;
  record(kind: string, summary: string, payload: unknown): void;
  callback(query: CallbackQuery, trace: string): Promise<void>;
  decide(id: string, action: 'a' | 's' | 'e' | 'u', trace: string): Promise<ApprovalDecision>;
  pending(now: number): readonly ApprovalItem[];
  ledger(reminders: readonly Readonly<{ note: string; at: string; repeat: string }>[]): string;
}>;

// The owner's "door" for effects: proposals become Telegram cards with Do it / Modify / Not now,
// nothing reaches the calendar before Do it, and every effect lands in one ledger with a
// 10-minute undo where the provider allows it.
export const approvalDesk = (sql: SqlStorage, deps: Readonly<{
  call: TelegramCall;
  owner: number;
  // sendIntent binds the proxy send idempotency gate to the approved proposal: the email rail
  // passes its approval entry id, so a replayed approval can never fire a second provider send.
  google(sendIntent?: string): Promise<GoogleClient | null>;
  newId(): string;
  now(): number;
  timezone: string;
  log(entry: TurnLogEntry): void;
  browserSubmit?: (proposal: BrowserSubmitProposal) => Promise<string>;
}>): ApprovalDesk => {
  sql.exec(`CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL,
    undo_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)`);
  const when = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: deps.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const describe = (p: ProposeCalendarChangeArgs) => {
    const name = p.title ? `"${p.title}"` : 'the event';
    if (p.action === 'create') return `Add ${name}, ${when(p.start!)} to ${when(p.end!)}`;
    if (p.action === 'move') return `Move ${name} to ${when(p.start!)} to ${when(p.end!)}`;
    return `Cancel ${name}`;
  };
  const row = (id: string) => sql.exec<LedgerRow>('SELECT * FROM ledger WHERE id = ?', id).toArray()[0];
  const setStatus = (id: string, status: string, undo: Undo | null = null) =>
    sql.exec('UPDATE ledger SET status = ?, undo_json = ?, decided_at = ? WHERE id = ?', status, undo ? JSON.stringify(undo) : null, deps.now(), id);
  const say = (text: string, buttons?: [string, string][]) =>
    deps.call('sendMessage', { chat_id: deps.owner, text, ...(buttons ? { reply_markup: { inline_keyboard: [buttons.map(([label, data]) => ({ text: label, callback_data: data }))] } } : {}) });

  const describeBrowser = (p: BrowserSubmitProposal) => {
    const binding = Object.entries(p.binding).map(([k, v]) => `${k}: ${v}`).join(', ');
    return `${p.action.description} on ${p.url}${binding ? ` (${binding})` : ''}`;
  };
  // The card is the approval surface: it must show the exact recipients and body the digest
  // binds, or "Send it" approves content the owner never inspected. Body is capped to fit a
  // Telegram message; the cut is stated, never silent.
  const EMAIL_CARD_BODY_LIMIT = 3000;
  const describeEmail = (p: EmailSendProposal) => {
    const lines = [`To: ${p.to.join(', ')}`];
    if (p.cc?.length) lines.push(`Cc: ${p.cc.join(', ')}`);
    if (p.bcc?.length) lines.push(`Bcc: ${p.bcc.join(', ')}`);
    lines.push(`Subject: ${p.subject}`, '');
    lines.push(p.body.length > EMAIL_CARD_BODY_LIMIT ? `${p.body.slice(0, EMAIL_CARD_BODY_LIMIT)}\n[cut: ${p.body.length - EMAIL_CARD_BODY_LIMIT} more characters not shown]` : p.body);
    return lines.join('\n');
  };
  const describeAny = (entry: LedgerRow) => {
    if (entry.kind === 'browser_submit') return describeBrowser(JSON.parse(entry.payload_json) as BrowserSubmitProposal);
    if (entry.kind === 'email_send') return describeEmail(JSON.parse(entry.payload_json) as EmailSendProposal);
    return describe(JSON.parse(entry.payload_json) as Stored);
  };
  const expired = (entry: LedgerRow, p: Stored) =>
    deps.now() - entry.created_at > (entry.kind === 'browser_submit' ? BROWSER_SUBMIT_TTL_MS : PROPOSAL_TTL_MS) || (entry.kind !== 'browser_submit' && p.start !== undefined && Date.parse(p.start) <= deps.now());
  const apply = async (client: GoogleClient, p: Stored): Promise<Undo | null | 'stale'> => {
    if (p.action === 'create') return { op: 'cancel', id: (await client.createEvent({ title: p.title!, start: p.start!, end: p.end! })).id };
    const before = await client.event(p.event_id!);
    if (p.seen_etag && before.etag && before.etag !== p.seen_etag) return 'stale';
    try {
      if (p.action === 'move') {
        await client.moveEvent(p.event_id!, p.start!, p.end!, before.etag);
        return { op: 'move', id: p.event_id!, start: before.start, end: before.end };
      }
      await client.cancelEvent(p.event_id!, before.etag);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 412) return 'stale';
      throw error;
    }
    return null;
  };
  const revert = async (client: GoogleClient, undo: Undo) => {
    if (undo.op === 'cancel') await client.cancelEvent(undo.id);
    else await client.moveEvent(undo.id, undo.start, undo.end);
  };

  const decide = async (id: string, action: 'a' | 's' | 'e' | 'u', trace: string): Promise<ApprovalDecision> => {
    const started = deps.now();
    const entry = row(id);
    const expected = action === 'u' ? 'done' : 'open';
    if (!entry || entry.status !== expected) return { toast: 'Already handled.', message: 'Already handled.' };
    const proposal = JSON.parse(entry.payload_json) as Stored;
    try {
      let out: ApprovalDecision;
      if (action !== 'u' && action !== 's' && expired(entry, proposal)) {
        setStatus(id, 'expired');
        out = { toast: 'This proposal expired', message: `That proposal expired, so nothing happened: ${describeAny(entry)}. Ask me again if you still want it.` };
      } else if (action === 's') {
        setStatus(id, 'skipped');
        out = { toast: 'Not now', message: 'Left it. Nothing changed.' };
      } else if (action === 'e') {
        setStatus(id, 'changing');
        out = { toast: 'Tell me what to change', message: `What should I change? (${describeAny(entry)})` };
      } else if (entry.kind === 'browser_submit') {
        const bp = JSON.parse(entry.payload_json) as BrowserSubmitProposal;
        if (action === 'a') {
          if (!deps.browserSubmit) {
            out = { toast: 'Browsing is not set up', message: 'I could not do that because browsing is not set up on this Waldo yet.' };
          } else {
            const outcome = await deps.browserSubmit(bp);
            setStatus(id, 'done');
            out = { toast: 'Done', message: outcome };
          }
        } else {
          out = { toast: "Can't be undone", message: 'A browser submit cannot be undone from here. Nothing was reversed.' };
        }
      } else if (entry.kind === 'email_send') {
        const ep = JSON.parse(entry.payload_json) as EmailSendProposal;
        if (action === 'u') {
          out = { toast: "Can't be undone", message: 'A sent email cannot be undone. Nothing was reversed.' };
        } else {
          // Atomic claim BEFORE any provider I/O: exactly one concurrent approval crosses
          // open -> sending; the other reads the flipped row and is Already handled. The
          // UPDATE is synchronous in the DO, so two interleaved approvals cannot both pass.
          const claimed = sql.exec("UPDATE ledger SET status = 'sending' WHERE id = ? AND status = 'open'", id).rowsWritten === 1;
          if (!claimed) {
            out = { toast: 'Already handled.', message: 'Already handled.' };
          } else {
            const client = await deps.google(`email_send:${id}`);
            if (client === null) {
              setStatus(id, 'open'); // claimed but never attempted: release it for a connected retry
              out = { toast: 'Google is not connected', message: 'I could not send that because Google is not connected.' };
            } else if (await sha256Hex(ep.raw) !== ep.digest) {
              setStatus(id, 'failed');
              out = { toast: 'Email changed', message: `The stored email no longer matches what you approved, so nothing was sent: ${describeEmail(ep)}. Ask me again and I'll prepare a fresh one.` };
            } else {
              try {
                await client.sendRaw(ep.raw, ep.thread_id);
                setStatus(id, 'done');
                out = { toast: 'Sent', message: `Sent: ${describeEmail(ep)}. This one can't be undone.` };
              } catch (error) {
                // Typed outcome, never a guess: ONLY a positive Sent-mail reconciliation proves
                // delivery. A negative or unavailable lookup proves nothing (index lag,
                // ambiguous network), so the outcome stays unknown - claiming "nothing was
                // delivered" would invite a duplicate resend.
                const cause = error instanceof Error ? error.message : String(error);
                let landed: boolean | null = null;
                if (typeof ep.message_id === 'string' && ep.message_id.length > 0) {
                  landed = await client.findSentByMessageId(ep.message_id).then((found) => found, () => null);
                }
                if (landed === true) {
                  setStatus(id, 'done');
                  out = { toast: 'Sent', message: `Sent: ${describeEmail(ep)}. Gmail confirmed it after a hiccup; it went out exactly once.` };
                } else {
                  setStatus(id, 'unknown');
                  out = { toast: 'Send unconfirmed', message: `I could not confirm whether that email went out (${cause}). It may be in your Sent folder - check there before asking me to resend, so it never goes twice.` };
                }
              }
            }
          }
        }
      } else {
        const client = await deps.google();
        if (client === null) {
          out = { toast: 'Google is not connected', message: 'I could not do that because Google is not connected.' };
        } else if (action === 'a') {
          const undo = await apply(client, proposal);
          if (undo === 'stale') {
            setStatus(id, 'stale');
            out = { toast: 'The event changed', message: `The event changed in your calendar after I proposed this, so I didn't apply it: ${describe(proposal)}. Ask me again and I'll look at the new version.` };
          } else {
            setStatus(id, 'done', undo);
            out = { toast: 'Done', message: `Done: ${describe(proposal)}.${undo ? ' Undo is available for 10 minutes.' : " This one can't be undone from here."}` };
          }
        } else if (entry.undo_json && entry.decided_at !== null && deps.now() - entry.decided_at <= UNDO_WINDOW_MS) {
          await revert(client, JSON.parse(entry.undo_json) as Undo);
          setStatus(id, 'undone');
          out = { toast: 'Undone', message: `Undone: ${describe(proposal)}.` };
        } else {
          out = { toast: 'Too late to undo', message: 'The 10-minute undo window has passed, so I left it as it is.' };
        }
      }
      deps.log({ trace, hop: `approval_${action}`, ms: deps.now() - started, ok: true, detail: id });
      return out;
    } catch (error) {
      deps.log({ trace, hop: `approval_${action}`, ms: deps.now() - started, ok: false, error: String(error) });
      return { toast: 'That failed', message: `That didn't work: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  return {
    decide,
    async proposeBrowserSubmit(payload) {
      const id = `p${deps.newId()}`;
      const summary = describeBrowser(payload);
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, 'browser_submit', 'open', ?, ?, NULL, ?, NULL)", id, summary, JSON.stringify(payload), deps.now());
      await say(`Approve this browser action? ${summary}`, [['Do it', `a:${id}`], ['Not now', `s:${id}`]]);
      return id;
    },
    async proposeSendEmail(payload) {
      // Idempotent on the logical send: the Message-ID encodes owner + turn + content, so a
      // tool-loop retry after an ambiguous card timeout re-sends the SAME proposal's card
      // instead of minting a second one. A same-content send on a new turn carries a new
      // Message-ID and is a separate proposal - intents never collapse, and Sent-mail
      // reconciliation can never match an older send.
      const existing = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE kind = 'email_send' AND status = 'open'").toArray()
        .find((r) => { try { return (JSON.parse(r.payload_json) as EmailSendProposal).message_id === payload.message_id; } catch { return false; } });
      if (existing) {
        await say(`Send this email? ${existing.summary}`, [['Send it', `a:${existing.id}`], ['Modify', `e:${existing.id}`], ['Not now', `s:${existing.id}`]]);
        return existing.id;
      }
      const id = `p${deps.newId()}`;
      const summary = describeEmail(payload);
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, 'email_send', 'open', ?, ?, NULL, ?, NULL)", id, summary, JSON.stringify(payload), deps.now());
      await say(`Send this email? ${summary}`, [['Send it', `a:${id}`], ['Modify', `e:${id}`], ['Not now', `s:${id}`]]);
      return id;
    },
    async propose(p) {
      const id = `p${deps.newId()}`;
      const summary = `${describe(p)}. ${p.reason}`;
      const client = p.event_id ? await deps.google() : null;
      const seen = client && p.event_id ? (await client.event(p.event_id)).etag : undefined;
      const stored: Stored = seen ? { ...p, seen_etag: seen } : p;
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, 'calendar_change', 'open', ?, ?, NULL, ?, NULL)", id, summary, JSON.stringify(stored), deps.now());
      await say(`Proposed: ${summary}`, [['Do it', `a:${id}`], ['Modify', `e:${id}`], ['Not now', `s:${id}`]]);
      return id;
    },
    record(kind, summary, payload) {
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, undo_json, created_at, decided_at) VALUES (?, ?, 'done', ?, ?, NULL, ?, ?)", `l${deps.newId()}`, kind, summary, JSON.stringify(payload), deps.now(), deps.now());
    },
    pending(now) {
      const open = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'open' ORDER BY created_at").toArray();
      const undoable = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status = 'done' AND undo_json IS NOT NULL AND decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT 5").toArray();
      return [
        ...open.map((r) => ({ id: r.id, summary: r.summary, state: 'open' as const, undoable: false })),
        ...undoable.map((r) => ({ id: r.id, summary: r.summary, state: 'done' as const, undoable: r.decided_at !== null && now - r.decided_at <= UNDO_WINDOW_MS })),
      ];
    },
    async callback(query, trace) {
      const [action = '', id] = (query.data ?? '').split(':');
      const answer = (text: string) => deps.call('answerCallbackQuery', { callback_query_id: query.id, text }).catch(() => undefined);
      if (query.from.id !== deps.owner || !id || !['a', 's', 'e', 'u'].includes(action)) return void (await answer('Not available.'));
      if (query.message) await deps.call('editMessageReplyMarkup', { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      const out = await decide(id, action as 'a' | 's' | 'e' | 'u', trace);
      await answer(out.toast);
      await say(out.message, action === 'a' && out.toast === 'Done' && out.message.includes('Undo is available') ? [['Undo', `u:${id}`]] : undefined);
    },
    ledger(reminders) {
      const open = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status IN ('open', 'changing') ORDER BY created_at").toArray();
      const done = sql.exec<LedgerRow>("SELECT * FROM ledger WHERE status NOT IN ('open', 'changing') ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 8").toArray();
      const lines = [
        'Open',
        ...(open.length ? open.map((r) => `- ${r.summary} (waiting on you)`) : ['- nothing waiting on you']),
        '', 'Reminders',
        ...(reminders.length ? reminders.map((r) => `- ${r.at.replace('T', ' ')} ${r.note}${r.repeat === 'daily' ? ' (daily)' : ''}`) : ['- none set']),
        '', 'Recent',
        ...(done.length ? done.map((r) => `- ${r.status}: ${r.summary}`) : ['- nothing yet']),
      ];
      return lines.join('\n');
    },
  };
};
