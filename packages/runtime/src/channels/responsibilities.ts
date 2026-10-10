import {
  closeResponsibilityArgsSchema, listResponsibilitiesArgsSchema, trackResponsibilityArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, updateTodoArgsSchema,
  type CloseResponsibilityArgs, type ListResponsibilitiesArgs, type ToolHandler, type ToolName, type TrackResponsibilityArgs, type UpdateTodoArgs,
} from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';

type Sql = Pick<SqlStorage, 'exec'>;
export type ResponsibilityStatus = 'open' | 'waiting' | 'done' | 'dropped' | 'uncertain';
export type TodoStatus = 'pending' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';
export type Responsibility = Readonly<{
  id: string; title: string; intent: string; status: ResponsibilityStatus; created_from: string;
  account: string | null; grant_ref: string | null; next_check_at: string | null; closed_by_evidence: string | null;
  revision: number; created_at: number; closed_at: number | null;
}>;
export type TodoItem = Readonly<{
  id: string; responsibility_id: string; title: string; owner: string; status: TodoStatus;
  depends_on: readonly string[]; result_ref: string | null; superseded_result: string | null; updated_at: number; revision: number;
}>;
export type ItemWrite = 'applied' | 'superseded' | 'missing' | 'blocked';

type ItemRow = Omit<TodoItem, 'depends_on'> & { depends_on: string };
const toItem = (row: ItemRow): TodoItem => ({ ...row, depends_on: JSON.parse(row.depends_on) as string[] });
const TERMINAL: readonly TodoStatus[] = ['done', 'failed', 'cancelled'];

export const responsibilityBook = (sql: Sql, deps: Readonly<{ newId(): string; now(): number }>) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS responsibilities (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, intent TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_from TEXT NOT NULL,
    account TEXT, grant_ref TEXT, next_check_at TEXT, closed_by_evidence TEXT, revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, closed_at INTEGER)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS responsibility_items (
    id TEXT PRIMARY KEY, responsibility_id TEXT NOT NULL, title TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    depends_on TEXT NOT NULL DEFAULT '[]', result_ref TEXT, superseded_result TEXT, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1)`);
  sql.exec('CREATE INDEX IF NOT EXISTS responsibilities_status_idx ON responsibilities (status, next_check_at)');
  sql.exec('CREATE INDEX IF NOT EXISTS responsibility_items_parent_idx ON responsibility_items (responsibility_id)');

  const items = (responsibilityId: string): readonly TodoItem[] =>
    sql.exec<ItemRow>('SELECT * FROM responsibility_items WHERE responsibility_id = ? ORDER BY rowid', responsibilityId).toArray().map(toItem);
  const item = (id: string): TodoItem | null => {
    const row = sql.exec<ItemRow>('SELECT * FROM responsibility_items WHERE id = ?', id).toArray()[0];
    return row ? toItem(row) : null;
  };

  return {
    track(args: TrackResponsibilityArgs, createdFrom: string): Readonly<{ responsibility: Responsibility; items: readonly TodoItem[] }> {
      const now = deps.now();
      const id = `r${deps.newId()}`;
      sql.exec('INSERT INTO responsibilities (id, title, intent, status, created_from, next_check_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, args.title, args.intent, 'open', createdFrom, args.next_check_at, now);
      const ids = args.items.map(() => `i${deps.newId()}`);
      args.items.forEach((entry, index) => {
        const deps_ = entry.depends_on.filter((position) => position < args.items.length && position !== index).map((position) => ids[position]!);
        sql.exec('INSERT INTO responsibility_items (id, responsibility_id, title, owner, status, depends_on, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ids[index], id, entry.title, entry.owner, 'pending', JSON.stringify(deps_), now);
      });
      return { responsibility: this.get(id)!, items: items(id) };
    },
    get: (id: string): Responsibility | null => sql.exec<Responsibility>('SELECT * FROM responsibilities WHERE id = ?', id).toArray()[0] ?? null,
    item,
    items,
    list(status: ListResponsibilitiesArgs['status'] = 'open'): readonly Responsibility[] {
      return status === 'all'
        ? sql.exec<Responsibility>('SELECT * FROM responsibilities ORDER BY created_at DESC LIMIT 50').toArray()
        : sql.exec<Responsibility>('SELECT * FROM responsibilities WHERE status = ? ORDER BY next_check_at IS NULL, next_check_at, created_at', status).toArray();
    },
    all: (): readonly Responsibility[] => sql.exec<Responsibility>('SELECT * FROM responsibilities ORDER BY created_at DESC, id').toArray(),
    // A worker starts from a revision it read; a write from an older revision never lands.
    start(itemId: string, owner: string): Readonly<{ item: TodoItem; revision: number }> | null {
      const current = item(itemId);
      if (!current || TERMINAL.includes(current.status)) return null;
      const unfinished = current.depends_on.some((dep) => item(dep)?.status !== 'done');
      if (unfinished) return null;
      sql.exec("UPDATE responsibility_items SET owner = ?, status = 'running', updated_at = ?, revision = revision + 1 WHERE id = ?", owner, deps.now(), itemId);
      return { item: item(itemId)!, revision: current.revision + 1 };
    },
    // The owner or Waldo changing an item bumps its revision, so any worker holding the old one is fenced out.
    update(args: UpdateTodoArgs): TodoItem | null {
      const current = item(args.item_id);
      if (!current) return null;
      sql.exec('UPDATE responsibility_items SET status = ?, result_ref = COALESCE(?, result_ref), updated_at = ?, revision = revision + 1 WHERE id = ?', args.status, args.result ?? null, deps.now(), args.item_id);
      return item(args.item_id);
    },
    finishWorker(itemId: string, startedRevision: number, outcome: Readonly<{ status: 'done' | 'failed'; result: string }>): ItemWrite {
      const current = item(itemId);
      if (!current) return 'missing';
      if (current.revision !== startedRevision) {
        sql.exec('UPDATE responsibility_items SET superseded_result = ?, updated_at = ? WHERE id = ?', outcome.result, deps.now(), itemId);
        return 'superseded';
      }
      sql.exec('UPDATE responsibility_items SET status = ?, result_ref = ?, updated_at = ?, revision = revision + 1 WHERE id = ?', outcome.status, outcome.result, deps.now(), itemId);
      return 'applied';
    },
    cancel(itemId: string): TodoItem | null {
      return this.update({ item_id: itemId, status: 'cancelled' });
    },
    running: (): readonly TodoItem[] => sql.exec<ItemRow>("SELECT * FROM responsibility_items WHERE status = 'running' ORDER BY updated_at").toArray().map(toItem),
    close(args: CloseResponsibilityArgs): boolean {
      const evidence = args.evidence_ref.trim();
      if (!evidence) return false;
      return sql.exec("UPDATE responsibilities SET status = ?, closed_by_evidence = ?, closed_at = ?, revision = revision + 1 WHERE id = ? AND status IN ('open', 'waiting', 'uncertain') RETURNING id", args.outcome, evidence, deps.now(), args.id).toArray().length > 0;
    },
    // Carries open loops across under their own ids; a loop already carried is left as it is.
    adoptLoops(intentForLoop?: (id: string) => string | null): number {
      const exists = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'loops'").toArray().length > 0;
      if (!exists) return 0;
      const count = () => sql.exec<{ n: number }>('SELECT count(*) AS n FROM responsibilities').one().n;
      const before = count();
      const previousRow = intentForLoop ? sql.exec<{ n: number }>('SELECT COALESCE(max(rowid), 0) AS n FROM responsibilities').one().n : 0;
      sql.exec(`INSERT OR IGNORE INTO responsibilities (id, title, intent, status, created_from, next_check_at, closed_by_evidence, created_at, closed_at)
        SELECT id, title, title, CASE status WHEN 'open' THEN 'open' WHEN 'done' THEN 'done' ELSE 'dropped' END, 'loop', due, NULL, created_at, closed_at FROM loops`);
      // Only newly adopted rows receive their source-backed hypothesis. A later discovery
      // cannot overwrite owner corrections or change an existing responsibility revision.
      if (intentForLoop) for (const row of sql.exec<{ id: string }>("SELECT id FROM responsibilities WHERE rowid > ? AND created_from = 'loop'", previousRow).toArray()) {
        const intent = intentForLoop(row.id);
        if (intent !== null && (typeof intent !== 'string' || !intent.trim() || intent.length > 1000)) throw new Error('responsibility intent unavailable');
        if (intent) sql.exec('UPDATE responsibilities SET intent = ? WHERE id = ? AND intent = title AND revision = 1', intent, row.id);
      }
      return count() - before;
    },
  };
};
export type ResponsibilityBook = ReturnType<typeof responsibilityBook>;

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

export const responsibilityHandlers = (book: ResponsibilityBook) => [
  {
    name: 'track_responsibility',
    description: 'Record work you took on that is consequential or has several steps, with the owner\'s intent and the steps, so it stays on the owner\'s list until it is finished on evidence. Not for questions or one-step answers.',
    schema: trackResponsibilityArgsSchema,
    trigger_allowlist: allowlist('track_responsibility'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args, ctx) {
      return { ok: true, data: book.track(args, ctx.trigger), source_taint: null };
    },
  } satisfies ToolHandler<TrackResponsibilityArgs, unknown, ToolDispatcherContext>,
  {
    name: 'update_todo',
    description: 'Change the status of one step of a tracked responsibility, with its result when it finished or failed.',
    schema: updateTodoArgsSchema,
    trigger_allowlist: allowlist('update_todo'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args) {
      const updated = book.update(args);
      return updated
        ? { ok: true, data: updated, source_taint: null }
        : { ok: false, error: 'No such item.', code: 'rejected', source_taint: null };
    },
  } satisfies ToolHandler<UpdateTodoArgs, unknown, ToolDispatcherContext>,
  {
    name: 'list_responsibilities',
    description: 'What Waldo is on: tracked responsibilities with their steps and which are running.',
    schema: listResponsibilitiesArgsSchema,
    trigger_allowlist: allowlist('list_responsibilities'),
    autonomy_gated: false,
    async handle({ status }) {
      return { ok: true, data: book.list(status).map((responsibility) => ({ ...responsibility, items: book.items(responsibility.id) })), source_taint: null };
    },
  } satisfies ToolHandler<ListResponsibilitiesArgs, unknown, ToolDispatcherContext>,
  {
    name: 'close_responsibility',
    description: 'Close a tracked responsibility as done or dropped. Needs the evidence: a receipt or provider id, or the owner\'s own words.',
    schema: closeResponsibilityArgsSchema,
    trigger_allowlist: allowlist('close_responsibility'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args) {
      return book.close(args)
        ? { ok: true, data: { id: args.id, closed: true }, source_taint: null }
        : { ok: false, error: 'Not closed: unknown or already closed, or no evidence given.', code: 'rejected', source_taint: null };
    },
  } satisfies ToolHandler<CloseResponsibilityArgs, unknown, ToolDispatcherContext>,
];
