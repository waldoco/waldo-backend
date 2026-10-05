import { expect, it } from 'vitest';
import { TASK_SOURCE_INSTRUCTION } from '../src/channels/task-source-scope';

// SOURCE layer only: pins the prompt contract. Model behaviour is graded on staging traces, not here.
it('names a specific website or URL as an explicit web family and keeps vague lookups uncertain', () => {
  expect(TASK_SOURCE_INSTRUCTION).toContain('names a specific website or URL to open, read or fill in explicitly identifies the web family');
  expect(TASK_SOURCE_INSTRUCTION).toContain('look something up names no family and stays uncertain');
});

it('does not claim web additions need the owner card, matching the code that exempts web', () => {
  expect(TASK_SOURCE_INSTRUCTION).toContain('connected source families other than web requires');
  expect(TASK_SOURCE_INSTRUCTION).not.toContain('web and browser');
});

// CUSTODY layer: the output the prompt now asks for (web only, evidence = owner text) must yield a ready web scope.
import { env, runInDurableObject } from 'cloudflare:test';
import { createTaskSourceScope, taskSourceAllowed } from '../src/channels/task-source-scope';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
const custody = (name: string, work: (sql: SqlStorage, scope: RunEffectScope) => Promise<void>) => runInDurableObject(
  env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    await work(state.storage.sql, { runId: name, attempt: 'test', deadline: Date.now() + 30_000, signal: new AbortController().signal, admit() {}, commit: fn => fn() });
  });
it.each([['web only', ['web'], 'owner_transition', true], ['web and browser', ['web', 'browser'], 'owner_confirmation', false]] as const)('a named-URL new decision with %s -> %s', (_label, sources, outcome, ready) => custody(`url-${outcome}`, async (sql, scope) => {
  const text = 'Go to https://httpbin.org/forms/post and fill in the form with fictional values.';
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {}, { inputRef: 'in-1', text });
  await cap.classify(JSON.stringify({ decision: 'restrict', sources: [] }), 'prev');
  const result = await cap.classify(JSON.stringify({ decision: 'new', sources, evidence: text }), 'in-1', text);
  expect(result.outcome).toBe(outcome);
  expect(result.snapshot.ready).toBe(ready);
  if (ready) expect(taskSourceAllowed(result.snapshot, { name: 'browse_act' })).toBe(true);
}));

it('never treats naming a source as a limit, allows several sources per query, and keeps explicit owner limits', () => {
  expect(TASK_SOURCE_INSTRUCTION).toContain('Naming a source the owner wants read is never a limit');
  expect(TASK_SOURCE_INSTRUCTION).toContain('one or several in the same query');
  expect(TASK_SOURCE_INSTRUCTION).toContain('Use restrict only for that explicit owner limit');
  expect(TASK_SOURCE_INSTRUCTION).toContain('such a limit stays in force until the owner lifts it');
});
import { ownerReadSources as defaultsFor } from '../src/channels/task-source-scope';
it('a mail and calendar query becomes one ready task over both sources with no card', () => custody('mail-and-calendar', async (sql, scope) => {
  const text = 'Check my GitHub mail, then find a free slot tomorrow morning';
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {}, { inputRef: 'in-3', text }, defaultsFor([{ id: 'g' }] as never));
  await cap.classify(JSON.stringify({ decision: 'restrict', sources: ['web'] }), 'prev');
  const result = await cap.classify(JSON.stringify({ decision: 'new', sources: ['mail', 'calendar'], evidence: text }), 'in-3', text);
  expect(result.outcome).toBe('owner_transition');
  expect(result.proposal).toBeUndefined();
  for (const name of ['search_communication', 'query_availability'] as const) expect(taskSourceAllowed(result.snapshot, { name })).toBe(true);
}));
it('an explicit owner exclusion still holds: a retained mail-only limit refuses calendar reads', () => custody('explicit-exclusion', async (sql, scope) => {
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {}, { inputRef: 'in-4', text: 'only mail, do not touch my calendar' }, defaultsFor([{ id: 'g' }] as never));
  await cap.classify(JSON.stringify({ decision: 'restrict', sources: ['mail'] }), 'in-4');
  const kept = await cap.classify(JSON.stringify({ decision: 'retain', sources: [], evidence: null }), 'in-5');
  expect(taskSourceAllowed(kept.snapshot, { name: 'query_calendar' })).toBe(false);
  expect(taskSourceAllowed(kept.snapshot, { name: 'search_communication' })).toBe(true);
}));
