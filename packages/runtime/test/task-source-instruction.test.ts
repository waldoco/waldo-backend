import { expect, it } from 'vitest';
import { TASK_SOURCE_INSTRUCTION } from '../src/channels/task-source-scope';

// SOURCE layer only: pins the prompt contract. Model behaviour is graded on staging traces, not here.
it('names a specific website or URL as an explicit web family and keeps vague lookups uncertain', () => {
  expect(TASK_SOURCE_INSTRUCTION).toContain('names a specific website or URL to open, read or fill in explicitly identifies the web family');
  expect(TASK_SOURCE_INSTRUCTION).toContain('look something up names no family and stays uncertain');
});

it('does not claim web additions need the owner card, matching the code that exempts web', () => {
  expect(TASK_SOURCE_INSTRUCTION).toContain('added directly'); expect(TASK_SOURCE_INSTRUCTION).not.toContain('other than web requires');
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

// Recall after a named-URL task (staging trace tg-904958308): the classifier returned [web] for a named page, which narrowed the owner's memory away. The model decides; the instruction must tell it local is a default source unless excluded.
it('the classifier is told the owner\'s own memory stays in a new task unless excluded', () => {
  expect(TASK_SOURCE_INSTRUCTION).toContain('include local in sources unless the owner excluded it');
});
it('a new task that lists local with web keeps memory readable; an exclusive list does not', () => custody('url-memory', async (sql, scope) => {
  const text = 'Use browse_page to read https://example.com and tell me its title.';
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {}, { inputRef: 'in-5', text }, defaultsFor([{ id: 'g' }] as never));
  const opened = await cap.classify(JSON.stringify({ decision: 'new', sources: ['local', 'web'], evidence: text }), 'in-5', text);
  expect(taskSourceAllowed(opened.snapshot, { name: 'read_owner_context' })).toBe(true);
}));
it('an explicit exclusive new task keeps memory out', () => custody('url-excl', async (sql, scope) => {
  const text = 'Begin a new workspace task using workspace only.';
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {}, { inputRef: 'in-7', text }, defaultsFor([{ id: 'g' }] as never));
  await cap.classify(JSON.stringify({ decision: 'restrict', sources: [] }), 'prev');
  const opened = await cap.classify(JSON.stringify({ decision: 'new', sources: ['workspace'], evidence: text }), 'in-7', text);
  expect(taskSourceAllowed(opened.snapshot, { name: 'read_owner_context' })).toBe(false);
}));
