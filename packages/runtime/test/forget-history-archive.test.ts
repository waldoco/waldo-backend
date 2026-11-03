// A forget reaches history_archive the way it reaches the hot rows the archive took them from: a run's summary goes whole,
// a task loses the words from its title and brief, and an unrelated row is untouched. Until the store runs, the archived
// copy holds the forget (a projection store). Every row is synthetic.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { runBook } from '../src/channels/background-runs';
import { historyArchive, historyArchiveForgetStore } from '../src/history/archive';
import { claimStore } from '../src/memory/claims';
import { jobBook } from '../src/tasks/jobs';
import type { TestStorageDO } from './support/worker-entry';

const topic = 'ZEPHYR4471';
const stub = (name: string) => env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(name)) as DurableObjectStub<TestStorageDO>;

it('redacts archived runs and tasks the way their hot tables are redacted, and the archive holds the forget until then', async () => {
  const result = await runInDurableObject(stub('forget-history-archive'), (_instance, state) => {
    const sql = state.storage.sql, transaction = <T>(work: () => T) => state.storage.transactionSync(work);
    const archive = historyArchive({ sql, transaction, mode: 'on', now: () => 5_000, log: () => undefined });
    const runs = runBook(sql, { timezone: 'UTC', now: () => new Date(1_000) }, () => 'r1');
    const run = runs.start('reminder', null); runs.finish(run.id, 'completed', `reminded about ${topic} renewal`);
    const other = runBook(sql, { timezone: 'UTC', now: () => new Date(2_000) }, () => 'r2').start('loop', null);
    runs.finish(other.id, 'completed', 'loop checked');
    const jobs = jobBook(sql, { now: () => 3_000, newId: () => 'a1b2c3d4e5f6', newToken: () => 'tok' });
    const { job } = jobs.create({ kind: 'task', profile: null, idempotencyKey: 'k1', origin: 'turn-1', surface: 'app', brief: { title: `Compare ${topic} quotes`, goal: 'g', context: 'c', done_when: 'd', effort: 'standard', started_at: 3_000 }, dueAt: 3_000, deadlineAt: 9_000 });
    jobs.cancel(job.id, 'owner');
    archive.retire('background_runs', [run.id, other.id]);
    archive.retire('task_jobs', [job.id]);
    const held = claimStore(sql).forgetSources(topic).heldBy;
    const remaining = historyArchiveForgetStore({ sql, transaction }).run([topic]);
    const rows = sql.exec<{ id: string; summary: string | null; row_json: string }>('SELECT id, summary, row_json FROM history_archive ORDER BY id').toArray();
    return { held, remaining, again: claimStore(sql).forgetSources(topic).heldBy ?? [], rows, jobId: job.id };
  });
  expect(result.held).toContainEqual({ table: 'history_archive', rule: 'projection', rows: 2 });
  expect(result.remaining).toBe(0);
  expect(result.again.filter(hold => hold.table === 'history_archive')).toEqual([]);
  expect(JSON.stringify(result.rows)).not.toContain(topic);
  const [run, other, task] = result.rows;
  expect(run).toMatchObject({ id: 'background_runs:bg:r1', summary: null });
  expect(JSON.parse(run!.row_json)).toMatchObject({ summary: null, status: 'completed' });
  expect(other).toMatchObject({ id: 'background_runs:bg:r2', summary: 'loop checked' });
  expect(task).toMatchObject({ id: `task_jobs:${result.jobId}`, summary: 'Compare [forgotten] quotes' });
  expect(JSON.parse(task!.row_json)).toMatchObject({ brief_json: { title: 'Compare [forgotten] quotes' } });
});

it('drops a copy the literal redaction cannot rewrite, so nothing is left holding the forget', async () => {
  const result = await runInDurableObject(stub('forget-history-archive-escape'), (_instance, state) => {
    const sql = state.storage.sql, transaction = <T>(work: () => T) => state.storage.transactionSync(work);
    const archive = historyArchive({ sql, transaction, mode: 'on', now: () => 5_000, log: () => undefined });
    const jobs = jobBook(sql, { now: () => 3_000, newId: () => 'b1b2c3d4e5f6', newToken: () => 'tok' });
    // The topic as a JSON key: no literal replace of a value reaches it.
    const { job } = jobs.create({ kind: 'task', profile: null, idempotencyKey: 'k2', origin: 'turn-1', surface: 'app', brief: { title: 'Quotes', goal: 'g', context: 'c', done_when: 'd', effort: 'standard', started_at: 3_000, [topic]: 'x' } as never, dueAt: 3_000, deadlineAt: 9_000 });
    jobs.cancel(job.id, 'forgotten');
    archive.retire('task_jobs', [job.id]);
    const remaining = historyArchiveForgetStore({ sql, transaction }).run([topic]);
    return { remaining, row: sql.exec<{ row_json: string }>('SELECT row_json FROM history_archive').one().row_json };
  });
  expect(result.remaining).toBe(0);
  expect(result.row).not.toContain(topic);
  expect(JSON.parse(result.row)).toMatchObject({ brief_json: {} });
});
