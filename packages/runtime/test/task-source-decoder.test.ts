import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createTaskSourceScope, TASK_SOURCE_SCHEMA, taskSourceAllowed } from '../src/channels/task-source-scope';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
const run = (name: string, work: (sql: SqlStorage, scope: RunEffectScope) => Promise<void>) => runInDurableObject(
  env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const scope: RunEffectScope = { runId: name, attempt: 'test', deadline: Date.now() + 30_000, signal: new AbortController().signal, admit() {}, commit: fn => fn() };
    await work(state.storage.sql, scope);
  });

it('schema-valid repeated known families decode to a set on an ordinary continuation', () => run('decoder-duplicate', async (sql, scope) => {
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {});
  await cap.classify(JSON.stringify({ decision: 'restrict', sources: ['workspace'], evidence: null }), 'start');
  const sources = ['workspace', 'workspace'];
  expect(sources.length).toBeLessThanOrEqual(TASK_SOURCE_SCHEMA.properties.sources.maxItems);
  expect(sources.every(source => TASK_SOURCE_SCHEMA.properties.sources.items.enum.includes(source as 'workspace'))).toBe(true);
  const result = await cap.classify(JSON.stringify({ decision: 'retain', sources, evidence: null }), 'followup');
  expect(result.outcome).toBe('retained'); expect(result.snapshot.sources).toEqual(['workspace']);
  expect(taskSourceAllowed(result.snapshot, { name: 'workspace_read' })).toBe(true);
}));

it.each(['invalid', 'uncertain'] as const)('%s output cannot preserve external access on a fresh owner narrowing instruction', kind => run(`decoder-narrow-${kind}`, async (sql, scope) => {
  const text = 'Use only this pasted material for this instruction. Do not read mail or Drive.';
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {}, { inputRef: 'narrow', text });
  await cap.classify(JSON.stringify({ decision: 'restrict', sources: ['mail', 'drive'], evidence: null }), 'mail-start');
  const raw = kind === 'invalid' ? 'not json' : JSON.stringify({ decision: 'uncertain', sources: ['mail'], evidence: null });
  const result = await cap.classify(raw, 'narrow', text);
  expect(result.snapshot.sources).toEqual(['mail', 'drive']); expect(result.snapshot.ready).toBe(false);
  expect(taskSourceAllowed(result.snapshot, { name: 'search_communication' })).toBe(false);
  expect(taskSourceAllowed(result.snapshot, { name: 'read_drive' })).toBe(false);
}));


it.each([
  ['not json', 'json_syntax'], ['{}', 'invalid_shape'],
  ['{"decision":"invented","sources":[],"evidence":null}', 'unknown_decision'],
  ['{"decision":"retain","sources":["invented"],"evidence":null}', 'invalid_sources'],
  ['{"decision":"retain","sources":[],"evidence":42}', 'invalid_evidence'],
] as const)('decoder reports only finite metadata category %s', (raw, category) => run(`decoder-${category}`, async (sql, scope) => {
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {});
  await cap.classify(JSON.stringify({ decision: 'restrict', sources: ['workspace'], evidence: null }), 'start');
  const result = await cap.classify(raw, 'current');
  expect(result.decodeReason).toBe(category); expect(result.outcome).toBe('invalid_decision');
  expect(result.snapshot.ready).toBe(false); expect(result.snapshot.sources).toEqual(['workspace']);
}));
