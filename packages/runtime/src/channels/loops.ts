import {
  closeLoopArgsSchema, openLoopArgsSchema, setProactivityArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type CloseLoopArgs, type OpenLoopArgs, type SetProactivityArgs, type ToolHandler, type ToolName,
} from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import { localIso } from './reminders';

type Sql = Pick<SqlStorage, 'exec'>;
export type Loop = Readonly<{ id: string; title: string; due: string | null; status: string; created_at: number; closed_at: number | null }>;
export type Proactivity = Readonly<{ quiet_start: string | null; quiet_end: string | null; volume: 'low' | 'normal' | 'high' }>;

const DEFAULT_PROACTIVITY: Proactivity = { quiet_start: null, quiet_end: null, volume: 'normal' };

export const loopBook = (sql: Sql, deps: Readonly<{ newId(): string; now(): number }>) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS loops (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, due TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, closed_at INTEGER)`);
  sql.exec('CREATE TABLE IF NOT EXISTS proactivity (id INTEGER PRIMARY KEY CHECK (id = 1), settings TEXT NOT NULL)');
  return {
    open(args: OpenLoopArgs): Loop {
      const loop: Loop = { id: `o${deps.newId()}`, title: args.title, due: args.due, status: 'open', created_at: deps.now(), closed_at: null };
      sql.exec('INSERT INTO loops (id, title, due, status, created_at) VALUES (?, ?, ?, ?, ?)', loop.id, loop.title, loop.due, loop.status, loop.created_at);
      return loop;
    },
    close(id: string, outcome: CloseLoopArgs['outcome']): boolean {
      return sql.exec("UPDATE loops SET status = ?, closed_at = ? WHERE id = ? AND status = 'open' RETURNING id", outcome, deps.now(), id).toArray().length > 0;
    },
    list: (status = 'open') => sql.exec<Loop>('SELECT * FROM loops WHERE status = ? ORDER BY due IS NULL, due, created_at', status).toArray(),
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
    ...(open.length ? open.map((loop) => `- ${loop.title}${loop.due ? ` (due ${loop.due.replace('T', ' ')})` : ''} [${loop.id}]`) : ['- nothing open']),
    ...book.closed().map((loop) => `- ${loop.status}: ${loop.title} (${localIso(loop.closed_at ?? loop.created_at, timezone).slice(0, 10)})`),
  ].join('\n');
};

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

export const loopHandlers = (book: LoopBook) => [
  {
    name: 'open_loop',
    description: 'Record something you took on for the owner (a check-back, a thing to find out, a follow-up) so it shows in their ledger until you close it. Use it whenever you say you will do something later.',
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
