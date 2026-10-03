import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { approveTaskSourceProposal, createTaskSourceScope, taskSourceAllowed } from '../src/channels/task-source-scope';
import type { RunEffectScope } from '../src/channels/run-effect-scope';

const run = (name: string, work: (sql: SqlStorage, scope: RunEffectScope) => Promise<void>) => runInDurableObject(
  env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const scope: RunEffectScope = { runId: name, attempt: 'test', deadline: Date.now() + 30_000, signal: new AbortController().signal, admit() {}, commit: fn => fn() };
    await work(state.storage.sql, scope);
  });
const decision = (value: string, sources: readonly string[] = []) => JSON.stringify({ decision: value, sources });
const reads = { workspace: ['workspace_list', 'workspace_read'], others: ['search_communication', 'read_drive', 'web_search', 'browse_page'] } as const;
const allowed = (snapshot: Parameters<typeof taskSourceAllowed>[0], name: string) => taskSourceAllowed(snapshot, { name: name as never });

// Positive/negative pair for N01R: after a pasted-only restriction, the owner explicitly allows workspace tools only.
it('POSITIVE: an explicit owner workspace allowance, once the owner confirms it, opens the workspace reads and nothing else', () => run('pair-positive', async (sql, scope) => {
  const cap = createTaskSourceScope(sql, 'owner-one', scope, async () => {});
  await cap.classify(decision('restrict'));
  const { snapshot, proposal } = await cap.classify(decision('change', ['workspace']));
  expect(proposal).toBeDefined();
  expect(approveTaskSourceProposal(sql, 'owner-one', proposal!, Date.now(), scope)).toBe(true);
  const after = await cap.current();
  expect(after.ready).toBe(true);
  expect(after.sources).toEqual(['workspace']);
  for (const name of reads.workspace) expect(allowed(after, name)).toBe(true);
  for (const name of reads.others) expect(allowed(after, name)).toBe(false);
  expect(after.taskId).toBe(snapshot.taskId);
}));

it('NEGATIVE: before the owner confirms, and for ambiguous or restrictive classifications, nothing widens', () => run('pair-negative', async (sql, scope) => {
  const cap = createTaskSourceScope(sql, 'owner-one', scope, async () => {});
  await cap.classify(decision('restrict'));
  // Classifier says "change to workspace" but the owner has not confirmed: workspace reads stay denied.
  const pending = await cap.classify(decision('change', ['workspace']));
  expect(pending.proposal).toBeDefined();
  for (const name of [...reads.workspace, ...reads.others]) expect(allowed(pending.snapshot, name)).toBe(false);
  // Uncertain, retain and a restrict naming workspace cannot grant it.
  for (const raw of [decision('uncertain', ['workspace']), decision('retain', ['workspace']), decision('restrict', ['workspace']), 'not json']) {
    const { snapshot } = await cap.classify(raw);
    expect(snapshot.sources).toEqual([]);
    for (const name of reads.workspace) expect(allowed(snapshot, name)).toBe(false);
  }
}));

it('FINDING: while a proposal is pending, even sources the owner already had are blocked until the owner decides', () => run('pair-pending-blocks-existing', async (sql, scope) => {
  const cap = createTaskSourceScope(sql, 'owner-one', scope, async () => {});
  await cap.classify(decision('restrict', ['workspace', 'local']));
  expect(allowed(await cap.current(), 'workspace_list')).toBe(true);
  // An owner message that the classifier calls "change to add mail" parks the whole scope as unresolved.
  const { snapshot } = await cap.classify(decision('change', ['workspace', 'mail']));
  expect(snapshot.ready).toBe(false);
  expect(allowed(snapshot, 'workspace_list')).toBe(false);
}));
