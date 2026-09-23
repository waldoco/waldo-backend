import type { ProposeCalendarChangeArgs } from '@waldo/contracts';
import { GoogleError, type GoogleClient } from '../connectors/google';
import type { TurnLogEntry } from './telegram-listener';

export type TelegramCall = (method: string, body: object) => Promise<unknown>;
export type CallbackQuery = Readonly<{ id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } }>;

type Undo = { op: 'cancel'; id: string } | { op: 'move'; id: string; start: string; end: string };
type LedgerRow = { id: string; kind: string; status: string; summary: string; payload_json: string; undo_json: string | null; created_at: number; decided_at: number | null };

export const UNDO_WINDOW_MS = 10 * 60_000;
export const PROPOSAL_TTL_MS = 12 * 60 * 60_000;

type Stored = ProposeCalendarChangeArgs & { seen_etag?: string };

export type ApprovalDesk = Readonly<{
  propose(args: ProposeCalendarChangeArgs): Promise<string>;
  record(kind: string, summary: string, payload: unknown): void;
  callback(query: CallbackQuery, trace: string): Promise<void>;
  ledger(reminders: readonly Readonly<{ note: string; at: string; repeat: string }>[]): string;
}>;

// The owner's "door" for effects: proposals become Telegram cards with Do it / Modify / Not now,
// nothing reaches the calendar before Do it, and every effect lands in one ledger with a
// 10-minute undo where the provider allows it.
export const approvalDesk = (sql: SqlStorage, deps: Readonly<{
  call: TelegramCall;
  owner: number;
  google(): Promise<GoogleClient | null>;
  newId(): string;
  now(): number;
  timezone: string;
  log(entry: TurnLogEntry): void;
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

  const expired = (entry: LedgerRow, p: Stored) =>
    deps.now() - entry.created_at > PROPOSAL_TTL_MS || (p.start !== undefined && Date.parse(p.start) <= deps.now());
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

  return {
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
    async callback(query, trace) {
      const started = deps.now();
      const [action, id] = (query.data ?? '').split(':');
      const answer = (text: string) => deps.call('answerCallbackQuery', { callback_query_id: query.id, text }).catch(() => undefined);
      if (query.from.id !== deps.owner || !id) return void (await answer('Not available.'));
      const entry = row(id);
      const expected = action === 'u' ? 'done' : 'open';
      if (!entry || entry.status !== expected) return void (await answer('Already handled.'));
      if (query.message) await deps.call('editMessageReplyMarkup', { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      const proposal = JSON.parse(entry.payload_json) as Stored;
      try {
        if (action !== 'u' && action !== 's' && expired(entry, proposal)) {
          setStatus(id, 'expired');
          await answer('This proposal expired');
          await say(`That proposal expired, so I left your calendar as it is: ${describe(proposal)}. Ask me again if you still want it.`);
        } else if (action === 's') {
          setStatus(id, 'skipped');
          await answer('Not now');
          await say('Left it. Nothing changed.');
        } else if (action === 'e') {
          setStatus(id, 'changing');
          await answer('Tell me what to change');
          await say(`What should I change? (${describe(proposal)})`);
        } else if (action === 'a' || action === 'u') {
          const client = await deps.google();
          if (client === null) {
            await answer('Google is not connected');
            await say('I could not do that because Google is not connected.');
          } else if (action === 'a') {
            const undo = await apply(client, proposal);
            if (undo === 'stale') {
              setStatus(id, 'stale');
              await answer('The event changed');
              await say(`The event changed in your calendar after I proposed this, so I didn't apply it: ${describe(proposal)}. Ask me again and I'll look at the new version.`);
            } else {
              setStatus(id, 'done', undo);
              await answer('Done');
              await say(`Done: ${describe(proposal)}.${undo ? '' : " This one can't be undone from here."}`, undo ? [['Undo', `u:${id}`]] : undefined);
            }
          } else if (entry.undo_json && entry.decided_at !== null && deps.now() - entry.decided_at <= UNDO_WINDOW_MS) {
            await revert(client, JSON.parse(entry.undo_json) as Undo);
            setStatus(id, 'undone');
            await answer('Undone');
            await say(`Undone: ${describe(proposal)}.`);
          } else {
            await answer('Too late to undo');
            await say('The 10-minute undo window has passed, so I left it as it is.');
          }
        }
        deps.log({ trace, hop: `approval_${action}`, ms: deps.now() - started, ok: true, detail: id });
      } catch (error) {
        deps.log({ trace, hop: `approval_${action}`, ms: deps.now() - started, ok: false, error: String(error) });
        await answer('That failed');
        await say(`That didn't work: ${error instanceof Error ? error.message : String(error)}`);
      }
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
