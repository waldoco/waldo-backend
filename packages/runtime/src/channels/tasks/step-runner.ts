import type { ScheduleEntry, ToolName } from '@waldo/contracts';
import { numericHealthIn } from '../../scribe/sanitiser';
import { CHILD_READ_TOOLS, type BackgroundStart } from '../../conversation/subagent';
import type { Scheduler } from '../../scheduler/multiplexer';
import { ClosedRunError } from '../run-effect-scope';
import { OwnerAdmissionError } from '../../identity/owner-message-admission';
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
// report is the owner-facing line an attempt owes: 'sending' is committed before the send and 'sent' after it.
type Attempt = Readonly<{ item_id: string; attempt: number; revision: number; status: AttemptStatus; report: 'sending' | 'sent' | null }>;

export type StepRunnerDeps = Readonly<{
  sql: Sql;
  // The owner object's synchronous transaction; no I/O runs inside it.
  transact: <T>(work: () => T) => T;
  book: ResponsibilityBook;
  scheduler: Pick<Scheduler, 'schedule'>;
  now: () => number;
  newId: () => string;
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
  const set = (row: Pick<Attempt, 'item_id' | 'attempt'>, status: AttemptStatus, revision?: number) =>
    sql.exec('UPDATE task_step_attempts SET status = ?, revision = COALESCE(?, revision), ended_at = ? WHERE item_id = ? AND attempt = ?',
      status, revision ?? null, status === 'armed' || status === 'running' ? null : deps.now(), row.item_id, row.attempt);
  const report = (row: Attempt, state: 'sending' | 'sent') =>
    sql.exec('UPDATE task_step_attempts SET report = ? WHERE item_id = ? AND attempt = ?', state, row.item_id, row.attempt);
  const insert = (itemId: string, attempt: number, revision: number, status: 'armed' | 'running') =>
    sql.exec('INSERT INTO task_step_attempts (item_id, attempt, revision, status, report, created_at) VALUES (?, ?, ?, ?, NULL, ?)', itemId, attempt, revision, status, deps.now());

  // An attempt's intent is its journal row and its schedule entry. Every entry has its own id, so arming never rewrites the
  // entry being dispatched; the entry names the attempt it runs, and an entry for an older attempt runs nothing.
  const arm = async (item: Pick<TodoItem, 'id' | 'revision'>, attempt: number, dueAt: number, again = false): Promise<void> => {
    deps.transact(() => again ? set({ item_id: item.id, attempt }, 'armed', item.revision) : insert(item.id, attempt, item.revision, 'armed'));
    await deps.scheduler.schedule({ id: `task:${item.id}:${deps.newId()}`, kind: 'task_step', occurrenceAt: dueAt, dueAt, payloadRefs: { item_id: item.id, attempt_id: String(attempt) } });
  };

  // Intent before I/O: the line is marked before it is sent. A progress line is never sent again, so a crash mid-send can lose
  // one but never repeat it; a failed send of a result or notice is the caller's to handle.
  const tell = async (row: Attempt, text: string): Promise<unknown> => {
    deps.transact(() => report(row, 'sending'));
    try {
      await deps.send(text);
      deps.transact(() => report(row, 'sent'));
      return null;
    } catch (error) {
      return error;
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

  // Every pending Waldo step whose dependencies are done and that was never attempted is armed now.
  const armRunnable = async (responsibilityId: string): Promise<void> => {
    if (!OPEN.includes(book.get(responsibilityId)?.status ?? '')) return;
    const all = book.items(responsibilityId);
    for (const entry of all) {
      if (entry.owner === 'owner' || entry.status !== 'pending' || latest(entry.id)) continue;
      if (entry.depends_on.every(dep => all.find(other => other.id === dep)?.status === 'done')) await arm(entry, 1, deps.now());
    }
  };

  const giveUp = async (item: TodoItem, row: Attempt, trace: string): Promise<void> => {
    if (row.report === 'sent') return;
    const responsibility = book.get(item.responsibility_id);
    const unsent = await tell(row, `I couldn't finish "${responsibility?.title ?? item.title}": the step "${item.title}" failed ${TASK_STEP_MAX_ATTEMPTS} times, so I stopped.`);
    if (unsent) deps.log({ trace, hop: 'task_step_report', ms: 0, ok: false, code: 'notice_unsent', error: String(unsent) });
  };

  const execute = async (entry: ScheduleEntry): Promise<void> => {
    const itemId = entry.payload_refs.item_id ?? '';
    const trace = `${entry.id}:${entry.occurrence_at}`;
    const started = deps.now();
    const hop = (ok: boolean, code: string, attempt = 0, error?: unknown) =>
      deps.log({ trace, hop: 'task_step', ms: deps.now() - started, ok, code, detail: `attempt=${attempt}`, ...(error === undefined ? {} : { error: String(error) }) });
    const row = latest(itemId), item = book.item(itemId), responsibility = item && book.get(item.responsibility_id);
    if (!row || !item || !responsibility) { hop(false, 'missing'); return; }
    // A repeat delivery of a settled attempt, or an entry for an attempt already replaced, runs nothing.
    if (row.status !== 'armed' && row.status !== 'running') { hop(true, 'settled', row.attempt); return; }
    if (row.status === 'armed' && entry.payload_refs.attempt_id !== String(row.attempt)) { hop(true, 'superseded', row.attempt); return; }
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
    const position = work.findIndex(other => other.id === item.id) + 1, total = work.length;
    const last = work.every(other => other.id === item.id || other.status === 'done');
    const begun = deps.transact(() => {
      if (row.status === 'running') set(row, 'interrupted');
      if (attempt > TASK_STEP_MAX_ATTEMPTS) {
        book.update({ item_id: item.id, status: 'failed', result: 'Could not finish.' });
        return 'gave_up' as const;
      }
      const start = book.start(item.id, WORKER);
      if (!start) return null;
      if (row.status === 'running') insert(item.id, attempt, start.revision, 'running');
      else set(row, 'running', start.revision);
      return start;
    });
    if (begun === 'gave_up') { await giveUp(item, row, trace); hop(false, 'gave_up', row.attempt); return; }
    if (!begun) { hop(false, 'not_started', attempt); return; }
    const current: Attempt = { ...row, attempt, revision: begun.revision, status: 'running', report: null };

    // A closed authority (a revoke, a rebind, a directory outage) is not the step failing: the same attempt waits and runs
    // again. Anything else spends an attempt; the last one fails the step and the owner hears it once.
    const failed = async (error: unknown): Promise<void> => {
      if (error instanceof ClosedRunError || error instanceof OwnerAdmissionError) {
        await arm({ id: item.id, revision: begun.revision }, attempt, deps.now() + TASK_STEP_RETRY_MS, true);
        hop(false, 'authority_closed', attempt);
        return;
      }
      hop(false, 'step_failed', attempt, error);
      if (attempt < TASK_STEP_MAX_ATTEMPTS) {
        deps.transact(() => set(current, 'failed'));
        await arm({ id: item.id, revision: begun.revision }, attempt + 1, deps.now() + TASK_STEP_RETRY_MS * attempt);
        return;
      }
      const written = deps.transact(() => { set(current, 'failed'); return book.finishWorker(item.id, begun.revision, { status: 'failed', result: 'Could not finish.' }); });
      if (written === 'applied') await giveUp(item, latest(item.id) ?? current, trace);
    };

    let text: string;
    try {
      // A step that reads an earlier step's result reads text that came from sources, so its turn is tainted like one.
      text = (await deps.runStep(`${trace}:${attempt}`, stepPrompt(item, position, total, last), TASK_STEP_TOOLS, item.depends_on.length > 0 ? 'external' : undefined)).trim();
      if (!text) throw new Error('empty step result');
      if (!last && numericHealthIn(text)) throw new Error('health reading in a step result');
    } catch (error) {
      await failed(error);
      return;
    }
    if (last) {
      // The result is kept nowhere but the owner's channel, so the last step is done only once it is sent. A send that fails
      // runs the step again; a crash mid-send can send the result twice, never lose it.
      const unsent = await tell(current, text);
      if (unsent) { await failed(unsent); return; }
    }
    const written = deps.transact(() => {
      const outcome = book.finishWorker(item.id, begun.revision, { status: 'done', result: last ? 'Reported to the owner.' : text });
      set(current, outcome === 'applied' ? 'done' : 'cancelled');
      return outcome;
    });
    if (written !== 'applied') { hop(true, 'superseded', attempt); return; }
    hop(true, 'done', attempt);
    if (last) {
      const evidence = work.map(other => `task_step:${other.id}:${latest(other.id)?.attempt ?? 0}`).join(' ');
      if (book.items(item.responsibility_id).every(other => other.status === 'done')) book.close({ id: item.responsibility_id, outcome: 'done', evidence_ref: evidence });
      return;
    }
    await armRunnable(item.responsibility_id);
    const unsent = await tell(current, `Step ${position} of ${total} done for "${responsibility.title}": ${item.title}.`);
    if (unsent) deps.log({ trace, hop: 'task_step_report', ms: 0, ok: false, code: 'progress_unsent', error: String(unsent) });
  };

  // delegate_task's background start: the item was started by the turn; this arms its first attempt at that revision.
  const startBackground: BackgroundStart = async ({ itemId, revision }) => {
    if (latest(itemId)) return false;
    await arm({ id: itemId, revision }, 1, deps.now());
    return true;
  };

  return { execute, startBackground, armRunnable };
};
export type StepRunner = ReturnType<typeof stepRunner>;
