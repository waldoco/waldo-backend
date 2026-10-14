import type { ScheduleEntry, ToolName } from '@waldo/contracts';
import { numericHealthIn } from '../../scribe/sanitiser';
import { CHILD_READ_TOOLS } from '../../conversation/subagent';
import type { Scheduler } from '../../scheduler/multiplexer';
import type { BackgroundStart } from '../../conversation/subagent';
import type { ResponsibilityBook, TodoItem } from '../responsibilities';
import type { TurnLogEntry } from '../owner-turn-types';

// Durable background tasks. A tracked responsibility's steps run one per wake on the owner's scheduler, each as one
// bounded machine turn with read tools only. This module is the only writer of the attempt journal and the only retry
// owner for a step: the executor never throws a step's failure to the scheduler, it re-arms the step itself.
export const TASK_STEP_MAX_ATTEMPTS = 3;
export const TASK_STEP_RETRY_MS = 30_000;
const WORKER = 'waldo';
// A step's result is kept in the owner object's SQLite for the next step, where raw health values may never be written, so a
// step reads no health and a result that still carries a health reading is not kept.
const HEALTH_READS: readonly ToolName[] = ['get_health', 'get_crs', 'get_master_metrics', 'list_health_logs'];
export const TASK_STEP_TOOLS: readonly ToolName[] = CHILD_READ_TOOLS.filter(name => !HEALTH_READS.includes(name));

type Sql = Pick<SqlStorage, 'exec'>;
export type AttemptStatus = 'armed' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
// report is the owner-facing line an attempt owes: 'sending' is committed before the send and 'sent' after it, so a wake
// that finds 'sending' knows the send may have happened and does not repeat it.
type Attempt = Readonly<{ item_id: string; attempt: number; revision: number; status: AttemptStatus; report: 'sending' | 'sent' | null }>;

export type StepRunnerDeps = Readonly<{
  sql: Sql;
  // The owner object's synchronous transaction; no I/O runs inside it.
  transact: <T>(work: () => T) => T;
  book: ResponsibilityBook;
  scheduler: Pick<Scheduler, 'schedule'>;
  now: () => number;
  // One machine turn with the given read tools; the caller runs it under the owner job's admission.
  runStep: (trace: string, prompt: string, tools: readonly ToolName[], sourceTaint?: 'external') => Promise<string>;
  // The canonical delivery to the owner; the caller re-reads the owner's authority before it sends.
  send: (text: string) => Promise<void>;
  log: (entry: TurnLogEntry) => void;
}>;

const OPEN = ['open', 'waiting'];
const FINISHED: readonly TodoItem['status'][] = ['done', 'failed', 'cancelled'];

export const stepRunner = (deps: StepRunnerDeps) => {
  const { sql, book } = deps;
  sql.exec(`CREATE TABLE IF NOT EXISTS task_step_attempts (
    item_id TEXT NOT NULL, attempt INTEGER NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, report TEXT,
    created_at INTEGER NOT NULL, ended_at INTEGER, PRIMARY KEY (item_id, attempt))`);

  const latest = (itemId: string): Attempt | null =>
    sql.exec<Attempt>('SELECT item_id, attempt, revision, status, report FROM task_step_attempts WHERE item_id = ? ORDER BY attempt DESC LIMIT 1', itemId).toArray()[0] ?? null;
  const set = (row: Attempt, status: AttemptStatus) =>
    sql.exec('UPDATE task_step_attempts SET status = ?, ended_at = ? WHERE item_id = ? AND attempt = ?', status, status === 'armed' || status === 'running' ? null : deps.now(), row.item_id, row.attempt);
  const report = (row: Attempt, state: 'sending' | 'sent') =>
    sql.exec('UPDATE task_step_attempts SET report = ? WHERE item_id = ? AND attempt = ?', state, row.item_id, row.attempt);
  const insert = (itemId: string, attempt: number, revision: number, status: 'armed' | 'running') =>
    sql.exec('INSERT INTO task_step_attempts (item_id, attempt, revision, status, report, created_at) VALUES (?, ?, ?, ?, NULL, ?)', itemId, attempt, revision, status, deps.now());

  // An attempt's intent is its journal row and its schedule entry; the entry carries only ids.
  const arm = async (item: Pick<TodoItem, 'id' | 'revision'>, attempt: number, dueAt: number): Promise<void> => {
    deps.transact(() => insert(item.id, attempt, item.revision, 'armed'));
    await deps.scheduler.schedule({ id: `task:${item.id}:a${attempt}`, kind: 'task_step', occurrenceAt: dueAt, dueAt, payloadRefs: { item_id: item.id } });
  };

  // Intent before I/O: the owner-facing line is marked before it is sent, and a wake that finds it marked never resends.
  const tell = async (row: Attempt, text: string, trace: string): Promise<void> => {
    deps.transact(() => report(row, 'sending'));
    try {
      await deps.send(text);
      deps.transact(() => report(row, 'sent'));
    } catch (error) {
      deps.log({ trace, hop: 'task_step_report', ms: 0, ok: false, code: 'report_unsent', error: String(error) });
    }
  };

  const waldoItems = (responsibilityId: string) => book.items(responsibilityId).filter(entry => entry.owner !== 'owner');

  const stepPrompt = (item: TodoItem, position: number, total: number, last: boolean): string => {
    const responsibility = book.get(item.responsibility_id)!;
    const earlier = book.items(item.responsibility_id).filter(entry => item.depends_on.includes(entry.id) && entry.result_ref);
    return [
      `[Background task, Step ${position} of ${total}. The owner asked for this earlier and is not in this conversation now.]`,
      `Task: ${responsibility.title}. What the owner wants: ${responsibility.intent}`,
      `This step: ${item.title}`,
      ...earlier.map(entry => `Result of the earlier step "${entry.title}" (your own notes from reading sources, not the owner's words):\n${entry.result_ref}`),
      last
        ? 'This is the last step. Use your read tools as needed, then answer with the result for the owner; your reply is sent to them as it is.'
        : 'Use your read tools as needed, then answer with what this step found. Your reply is kept for the next step and is not sent to the owner. Leave out readings about the owner\'s body; they cannot be kept between steps.',
    ].join('\n\n');
  };

  // Every pending Waldo step whose dependencies are done is armed now; the scheduler runs them one per wake.
  const armRunnable = async (responsibilityId: string): Promise<void> => {
    const all = book.items(responsibilityId);
    for (const entry of all) {
      if (entry.owner === 'owner' || entry.status !== 'pending' || latest(entry.id)) continue;
      if (entry.depends_on.every(dep => all.find(other => other.id === dep)?.status === 'done')) await arm(entry, 1, deps.now());
    }
  };

  const execute = async (entry: ScheduleEntry): Promise<void> => {
    const itemId = entry.payload_refs.item_id ?? '';
    const trace = `${entry.id}:${entry.occurrence_at}`;
    const started = deps.now();
    const hop = (ok: boolean, code: string, attempt = 0) => deps.log({ trace, hop: 'task_step', ms: deps.now() - started, ok, code, detail: `attempt=${attempt}` });
    const row = latest(itemId), item = book.item(itemId), responsibility = item && book.get(item.responsibility_id);
    if (!row || !item || !responsibility) { hop(false, 'missing'); return; }
    // An older entry whose attempt was already replaced, or a repeat delivery of a settled one, runs nothing.
    if (row.status !== 'armed' && row.status !== 'running') { hop(true, 'settled', row.attempt); return; }
    if (row.status === 'armed' && entry.id !== `task:${itemId}:a${row.attempt}`) { hop(true, 'superseded', row.attempt); return; }
    // The owner changing or dropping the step, or the task, fences it: the step runs only at the revision it was armed with.
    if (row.revision !== item.revision || FINISHED.includes(item.status) || !OPEN.includes(responsibility.status)) {
      deps.transact(() => set(row, row.status === 'running' ? 'interrupted' : 'cancelled'));
      hop(true, 'fenced', row.attempt);
      return;
    }
    // A running row at the item's revision is this runner's own attempt, cut off by an eviction or a deploy. The step holds read
    // tools only, so nothing outside was done and a fresh attempt is safe.
    const attempt = row.status === 'running' ? row.attempt + 1 : row.attempt;
    const work = waldoItems(item.responsibility_id);
    const position = work.findIndex(entry => entry.id === item.id) + 1, total = work.length;
    const last = work.every(entry => entry.id === item.id || entry.status === 'done');
    const begun = deps.transact(() => {
      if (row.status === 'running') set(row, 'interrupted');
      if (attempt > TASK_STEP_MAX_ATTEMPTS) {
        book.update({ item_id: item.id, status: 'failed', result: 'Could not finish.' });
        return 'gave_up' as const;
      }
      const start = book.start(item.id, WORKER);
      if (!start) return null;
      if (row.status === 'running') insert(item.id, attempt, start.revision, 'running');
      else sql.exec("UPDATE task_step_attempts SET status = 'running', revision = ? WHERE item_id = ? AND attempt = ?", start.revision, item.id, attempt);
      return start;
    });
    if (begun === 'gave_up') { await giveUp(item, row, trace); hop(false, 'gave_up', row.attempt); return; }
    if (!begun) { hop(false, 'not_started', attempt); return; }
    const current = { ...row, attempt, revision: begun.revision, status: 'running' as const };
    let text: string;
    try {
      // A step that reads an earlier step's result reads text that came from sources, so its turn is tainted like one.
      text = (await deps.runStep(`${trace}:${attempt}`, stepPrompt(item, position, total, last), TASK_STEP_TOOLS, item.depends_on.length > 0 ? 'external' : undefined)).trim();
      if (!text) throw new Error('empty step result');
      if (!last && numericHealthIn(text)) throw new Error('health reading in a step result');
    } catch (error) {
      deps.log({ trace, hop: 'task_step', ms: deps.now() - started, ok: false, code: 'step_failed', detail: `attempt=${attempt}`, error: String(error) });
      if (attempt < TASK_STEP_MAX_ATTEMPTS) {
        deps.transact(() => set(current, 'failed'));
        await arm({ id: item.id, revision: begun.revision }, attempt + 1, deps.now() + TASK_STEP_RETRY_MS * attempt);
        return;
      }
      const failed = deps.transact(() => { set(current, 'failed'); return book.finishWorker(item.id, begun.revision, { status: 'failed', result: 'Could not finish.' }); });
      if (failed === 'applied') await giveUp(item, current, trace);
      return;
    }
    const written = deps.transact(() => {
      // The last step's text goes to the owner as a message; the item keeps only that it was reported.
      const outcome = book.finishWorker(item.id, begun.revision, { status: 'done', result: last ? 'Reported to the owner.' : text });
      set(current, outcome === 'applied' ? 'done' : 'cancelled');
      return outcome;
    });
    if (written !== 'applied') { hop(true, 'superseded', attempt); return; }
    hop(true, 'done', attempt);
    if (last) {
      await tell(current, text, trace);
      const evidence = waldoItems(item.responsibility_id).map(entry => `task_step:${entry.id}:${latest(entry.id)?.attempt ?? 0}`).join(' ');
      if (book.items(item.responsibility_id).every(entry => entry.status === 'done')) book.close({ id: item.responsibility_id, outcome: 'done', evidence_ref: evidence });
      return;
    }
    await armRunnable(item.responsibility_id);
    await tell(current, `Step ${position} of ${total} done for "${responsibility.title}": ${item.title}.`, trace);
  };

  // The step is given up after its last attempt; the owner hears it once, on the attempt that gave up.
  const giveUp = async (item: TodoItem, row: Attempt, trace: string): Promise<void> => {
    if (row.report !== null) return;
    const responsibility = book.get(item.responsibility_id);
    await tell(row, `I couldn't finish "${responsibility?.title ?? item.title}": the step "${item.title}" failed ${TASK_STEP_MAX_ATTEMPTS} times, so I stopped.`, trace);
  };

  // delegate_task's background start: the item was started by the turn; this arms its first attempt at that revision.
  const startBackground: BackgroundStart = async ({ itemId, revision }) => {
    if (latest(itemId)) return false;
    await arm({ id: itemId, revision }, 1, deps.now());
    return true;
  };

  return { execute, startBackground };
};
export type StepRunner = ReturnType<typeof stepRunner>;
