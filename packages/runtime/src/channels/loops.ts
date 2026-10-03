import {
  closeLoopArgsSchema, openLoopArgsSchema, setProactivityArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type CloseLoopArgs, type OpenLoopArgs, type SetProactivityArgs, type ToolHandler, type ToolName,
} from '@waldo/contracts';
import type { MailFollowupReceipt, FinalRecord } from './telegram-final-outbox';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import { localIso } from './reminders';

type Sql = Pick<SqlStorage, 'exec'>;
export type Loop = Readonly<{ id: string; title: string; due: string | null; status: string; created_at: number; closed_at: number | null; source_ref?: string | null; source_detail?: string | null; thread_id?: string | null; source_message_id?: string | null }>;
export type Proactivity = Readonly<{ quiet_start: string | null; quiet_end: string | null; volume: 'low' | 'normal' | 'high' }>;

const DEFAULT_PROACTIVITY: Proactivity = { quiet_start: null, quiet_end: null, volume: 'normal' };

export const loopBook = (sql: Sql, deps: Readonly<{ newId(): string; now(): number }>) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS loops (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, due TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, closed_at INTEGER)`);
  sql.exec('CREATE TABLE IF NOT EXISTS observed_mail (source_ref TEXT PRIMARY KEY, thread_id TEXT NOT NULL, observed_at INTEGER NOT NULL, message_id TEXT NOT NULL, judged INTEGER NOT NULL DEFAULT 0, update_id INTEGER, attached INTEGER NOT NULL DEFAULT 0)');
  sql.exec('CREATE TABLE IF NOT EXISTS loop_mail_sources (loop_id TEXT PRIMARY KEY, source_ref TEXT NOT NULL UNIQUE, nudged_due TEXT, nudged_timezone TEXT, delivery_state TEXT, nudged_message_id TEXT, review_after INTEGER)');
  sql.exec('CREATE INDEX IF NOT EXISTS loops_status_due_idx ON loops (status, due)');
  sql.exec('CREATE TABLE IF NOT EXISTS proactivity (id INTEGER PRIMARY KEY CHECK (id = 1), settings TEXT NOT NULL)');
  return {
    open(args: OpenLoopArgs): Loop {
      if (args.source_ref) {
        if (!sql.exec('SELECT 1 FROM observed_mail WHERE source_ref = ? AND update_id IS NOT NULL', args.source_ref).toArray().length) throw new Error('unobserved source');
        if (args.due === null) throw new Error('source follow-up requires due');
        const existing = sql.exec<Loop>('SELECT l.*, s.source_ref FROM loops l JOIN loop_mail_sources s ON s.loop_id = l.id WHERE s.source_ref = ?', args.source_ref).toArray()[0];
        if (existing) {
          if (existing.status === 'open' && (existing.due !== args.due || existing.title !== args.title)) {
            sql.exec("UPDATE loops SET title = ?, due = ? WHERE id = ? AND status = 'open'", args.title, args.due, existing.id);
            return { ...existing, title: args.title, due: args.due };
          }
          return existing;
        }
      }
      const loop: Loop = { id: `o${deps.newId()}`, title: args.title, due: args.due, status: 'open', created_at: deps.now(), closed_at: null };
      sql.exec('INSERT INTO loops (id, title, due, status, created_at) VALUES (?, ?, ?, ?, ?)', loop.id, loop.title, loop.due, loop.status, loop.created_at);
      if (args.source_ref) {
        sql.exec('INSERT INTO loop_mail_sources (loop_id, source_ref) VALUES (?, ?)', loop.id, args.source_ref);
        sql.exec('UPDATE observed_mail SET attached = 1 WHERE source_ref = ?', args.source_ref);
      }
      return { ...loop, ...(args.source_ref ? { source_ref: args.source_ref } : {}) };
    },
    close(id: string, outcome: CloseLoopArgs['outcome']): boolean {
      const closed = sql.exec("UPDATE loops SET status = ?, closed_at = ? WHERE id = ? AND status = 'open' RETURNING id", outcome, deps.now(), id).toArray().length > 0;
      if (closed) sql.exec('UPDATE observed_mail SET attached = 0 WHERE source_ref IN (SELECT source_ref FROM loop_mail_sources WHERE loop_id = ?)', id);
      return closed;
    },
    list: (status = 'open') => sql.exec<Loop>('SELECT l.*, s.source_ref FROM loops l LEFT JOIN loop_mail_sources s ON s.loop_id = l.id WHERE l.status = ? ORDER BY l.due IS NULL, l.due, l.created_at', status).toArray(),
    reviewDue(localNow: string, timezone = 'UTC', now = deps.now()): readonly Loop[] {
      return sql.exec<Loop>(`SELECT l.*, s.source_ref, json_extract(j.value, '$.detail') AS source_detail, m.thread_id, m.message_id AS source_message_id
        FROM loops l JOIN loop_mail_sources s ON s.loop_id = l.id JOIN observed_mail m ON m.source_ref = s.source_ref JOIN update_cards c ON c.id = m.update_id, json_each(c.changes) j
        WHERE json_extract(j.value, '$.source_ref') = m.source_ref AND json_extract(j.value, '$.source_message_id') = m.message_id AND l.status = 'open' AND l.due IS NOT NULL AND l.due <= ? AND (s.nudged_due IS NULL OR s.nudged_due != l.due OR s.nudged_timezone != ? OR s.nudged_message_id != m.message_id OR (s.delivery_state = 'skipped' AND s.review_after <= ?))
        ORDER BY l.due LIMIT 3`, localNow, timezone, now).toArray();
    },
    reviewEligible(receipt: MailFollowupReceipt, timezone: string): boolean {
      return receipt.timezone === timezone && sql.exec("SELECT 1 FROM loops l JOIN loop_mail_sources s ON s.loop_id = l.id JOIN observed_mail m ON m.source_ref = s.source_ref WHERE l.id = ? AND l.status = 'open' AND l.due = ? AND s.source_ref = ? AND m.message_id = ?", receipt.loopId, receipt.due, receipt.sourceRef, receipt.messageId).toArray().length > 0;
    },
    claimReview(receipt: MailFollowupReceipt): void {
      sql.exec("UPDATE loop_mail_sources SET nudged_due = ?, nudged_timezone = ?, nudged_message_id = ?, delivery_state = 'pending' WHERE loop_id = ?", receipt.due, receipt.timezone, receipt.messageId, receipt.loopId);
    },
    reviewSkipped(receipt: MailFollowupReceipt, now: number): void {
      sql.exec("UPDATE loop_mail_sources SET nudged_due = ?, nudged_timezone = ?, nudged_message_id = ?, delivery_state = 'skipped', review_after = ? WHERE loop_id = ?", receipt.due, receipt.timezone, receipt.messageId, now + 30 * 60_000, receipt.loopId);
    },
    settleReview(record: FinalRecord): void {
      if (!record.mailFollowup || record.status === 'pending') return;
      const r = record.mailFollowup;
      if (record.status === 'blocked') sql.exec('UPDATE loop_mail_sources SET nudged_due = NULL, nudged_timezone = NULL, delivery_state = ? WHERE loop_id = ? AND nudged_due = ? AND nudged_timezone = ? AND nudged_message_id = ?', 'blocked', r.loopId, r.due, r.timezone, r.messageId);
      else sql.exec('UPDATE loop_mail_sources SET delivery_state = ? WHERE loop_id = ? AND nudged_due = ? AND nudged_timezone = ? AND nudged_message_id = ?', record.status === 'delivered' ? 'delivered' : 'unknown', r.loopId, r.due, r.timezone, r.messageId);
    },
    closed: (limit = 5) => sql.exec<Loop>("SELECT * FROM loops WHERE status != 'open' ORDER BY closed_at DESC LIMIT ?", limit).toArray(),
    proactivity(): Proactivity {
      const row = sql.exec<{ settings: string }>('SELECT settings FROM proactivity WHERE id = 1').toArray()[0];
      return row ? { ...DEFAULT_PROACTIVITY, ...(JSON.parse(row.settings) as Partial<Proactivity>) } : DEFAULT_PROACTIVITY;
    },
    setProactivity(settings: SetProactivityArgs): Proactivity {
      const next: Proactivity = settings.quiet_start && settings.quiet_end ? settings : { ...settings, quiet_start: null, quiet_end: null };
      sql.exec('INSERT INTO proactivity (id, settings) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET settings = excluded.settings', JSON.stringify(next));
      return next;
    },
  };
};
export type LoopBook = ReturnType<typeof loopBook>;

export const isQuiet = (settings: Proactivity, now: number, timezone: string): boolean => {
  if (!settings.quiet_start || !settings.quiet_end || settings.quiet_start === settings.quiet_end) return false;
  const clock = localIso(now, timezone).slice(11, 16);
  return settings.quiet_start < settings.quiet_end
    ? clock >= settings.quiet_start && clock < settings.quiet_end
    : clock >= settings.quiet_start || clock < settings.quiet_end;
};

export const proactivityLine = (settings: Proactivity): string =>
  `Proactivity: volume ${settings.volume}; ${settings.quiet_start ? `quiet hours ${settings.quiet_start}-${settings.quiet_end}` : 'no quiet hours'}`;

export const loopsSection = (book: LoopBook, timezone: string): string => {
  const open = book.list();
  return [
    'Waldo is on',
    ...(open.length ? open.map((loop) => `- ${loop.title}${loop.due ? ` (due ${loop.due.replace('T', ' ')})` : ''}${loop.source_ref ? ` [source ${loop.source_ref}; completion unknown]` : ''} [${loop.id}]`) : ['- nothing open']),
    ...book.closed().map((loop) => `- ${loop.status}: ${loop.title} (${localIso(loop.closed_at ?? loop.created_at, timezone).slice(0, 10)})`),
  ].join('\n');
};

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

export const loopHandlers = (book: LoopBook) => [
  {
    name: 'open_loop',
    description: 'Record something you took on for the owner (a check-back, a thing to find out, a follow-up) so it shows in their ledger until you close it. For a mail follow-up hypothesis, supply the observed source_ref and explicit due time; completion stays unknown. Do not turn an email request into an owner commitment or permission. Use it whenever you say you will do something later. Never for remembering information - memory handles that on its own, no loop needed.',
    schema: openLoopArgsSchema,
    trigger_allowlist: allowlist('open_loop'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args) {
      return { ok: true, data: book.open(args), source_taint: null };
    },
  } satisfies ToolHandler<OpenLoopArgs, Loop, ToolDispatcherContext>,
  {
    name: 'close_loop',
    description: 'Close an open loop when it is done, or when the owner no longer wants it.',
    schema: closeLoopArgsSchema,
    trigger_allowlist: allowlist('close_loop'),
    autonomy_gated: false,
    mutates_state: true,
    async handle({ id, outcome }) {
      return { ok: true, data: { id, closed: book.close(id, outcome) }, source_taint: null };
    },
  } satisfies ToolHandler<CloseLoopArgs, { id: string; closed: boolean }, ToolDispatcherContext>,
  {
    name: 'set_proactivity',
    description: "Change how much Waldo reaches out on its own: quiet hours and volume. Only when the owner asks. Send all three fields; keep the current value for anything they did not mention (it is in the ledger).",
    schema: setProactivityArgsSchema,
    trigger_allowlist: allowlist('set_proactivity'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args) {
      return { ok: true, data: book.setProactivity(args), source_taint: null };
    },
  } satisfies ToolHandler<SetProactivityArgs, Proactivity, ToolDispatcherContext>,
];
