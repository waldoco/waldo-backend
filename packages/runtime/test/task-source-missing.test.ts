import { expect, it } from 'vitest';
import { TASK_SOURCE_FAMILIES, taskSourceAllowed, taskSourceMissing, type TaskSourceSnapshot } from '../src/channels/task-source-scope';

const snap = (sources: TaskSourceSnapshot['sources'], ready = true, defaults?: TaskSourceSnapshot['defaults']): TaskSourceSnapshot => ({ taskId: 't', revision: 1, sources, ready, startRef: null, ...(defaults ? { defaults } : {}) });

it('reports no missing family for a default read while the task is unresolved', () => {
  const snapshot = snap([], false, ['calendar']);
  const handler = { name: 'query_calendar', requires_connector: true } as const;
  expect(taskSourceAllowed(snapshot, handler)).toBe(true);
  expect(taskSourceMissing(snapshot, handler)).toEqual([]);
});

it('calendar proposals need current calendar scope and cannot use unresolved read defaults',()=>{
 const handler={name:'propose_calendar_change',mutates_state:true,requires_connector:true} as const;
 expect(taskSourceAllowed(snap(['calendar']),handler)).toBe(true);
 expect(taskSourceMissing(snap(['mail']),handler)).toEqual(['calendar']);
 expect(taskSourceAllowed(snap([],false,['calendar']),handler)).toBe(false);
});

it('names the family a refused read is missing, and every family a connector-wide tool lacks', () => {
  expect(taskSourceMissing(snap(['local', 'web']), { name: 'send_email', requires_connector: true })).toEqual(TASK_SOURCE_FAMILIES.filter(name => name !== 'local' && name !== 'web'));
  expect(taskSourceMissing(snap(['local', 'web']), { name: 'query_calendar' })).toEqual(['calendar']);
  expect(taskSourceMissing(snap(['local', 'calendar']), { name: 'query_calendar' })).toEqual([]);
  expect(taskSourceMissing(snap([]), { name: 'send_email', requires_connector: true })).toEqual([...TASK_SOURCE_FAMILIES]);
  expect(taskSourceMissing(snap(['local', 'web'], false), { name: 'query_calendar' })).toEqual(['calendar']);
});

it('agrees with taskSourceAllowed: nothing missing exactly when the call is allowed', () => {
  for (const sources of [[], ['local'], ['web'], ['local', 'web'], [...TASK_SOURCE_FAMILIES]] as TaskSourceSnapshot['sources'][]) {
    for (const handler of [{ name: 'query_calendar' }, { name: 'send_email', requires_connector: true }, { name: 'search_communication', requires_connector: true }, { name: 'read_memory' }] as const) {
      const s = snap(sources);
      expect(taskSourceMissing(s, handler).length === 0).toBe(taskSourceAllowed(s, handler));
    }
  }
});

it.each([false, true])('defaults admit only read-only calls without reporting missing sources (ready=%s)', ready => {
  const snapshot = snap(['local'], ready, ['calendar']);
  const read = { name: 'query_calendar', requires_connector: true } as const;
  const mutation = { ...read, mutates_state: true } as const;
  const gated = { ...read, autonomy_gated: true } as const;
  expect(taskSourceAllowed(snapshot, read)).toBe(true);
  expect(taskSourceMissing(snapshot, read)).toEqual([]);
  for (const handler of [mutation, gated]) {
    expect(taskSourceAllowed(snapshot, handler)).toBe(false);
    expect(taskSourceMissing(snapshot, handler)).toEqual(['calendar']);
  }
  expect(taskSourceMissing(snap(['calendar'], ready), read)).toEqual(ready ? [] : ['calendar']);
});

it('uses local defaults for unclassified reads without admitting a different source', () => {
  const handler = { name: 'get_health' } as const;
  const snapshot = snap([], false, ['local']);
  expect(taskSourceAllowed(snapshot, handler)).toBe(true);
  expect(taskSourceMissing(snapshot, handler)).toEqual([]);
  expect(taskSourceAllowed(snap([], false, ['mail']), handler)).toBe(false);
  expect(taskSourceMissing(snap([], false, ['mail']), handler)).toEqual(['local']);
});

it('preserves the connector fallback, including dynamically connector-backed tool metadata', () => {
  for (const handler of [{ name: 'send_email', requires_connector: true, mutates_state: true }, { name: 'skills_load', requires_connector: true }] as const) {
    expect(taskSourceAllowed(snap(['mail']), handler)).toBe(false);
    expect(taskSourceMissing(snap(['mail']), handler)).toEqual(TASK_SOURCE_FAMILIES.filter(family => family !== 'mail'));
    expect(taskSourceAllowed(snap([...TASK_SOURCE_FAMILIES]), handler)).toBe(true);
    expect(taskSourceMissing(snap([...TASK_SOURCE_FAMILIES]), handler)).toEqual([]);
    const unresolved = snap([...TASK_SOURCE_FAMILIES], false, [...TASK_SOURCE_FAMILIES]);
    expect(taskSourceAllowed(unresolved, handler)).toBe(false);
    expect(taskSourceMissing(unresolved, handler)).toEqual([...TASK_SOURCE_FAMILIES]);
  }
});

it('reports no source requirement for exempt tools and source-independent mutations', () => {
  const noSources = snap([], false);
  for (const name of ['delegate_task', 'skills_list', 'skills_load', 'skills_install', 'skills_disable', 'list_reminders', 'list_standing_orders', 'get_context'] as const) {
    expect(taskSourceAllowed(noSources, { name })).toBe(true);
    expect(taskSourceMissing(noSources, { name })).toEqual([]);
  }
  for (const handler of [{ name: 'get_health', mutates_state: true }, { name: 'get_health', autonomy_gated: true }] as const) {
    expect(taskSourceAllowed(noSources, handler)).toBe(true);
    expect(taskSourceMissing(noSources, handler)).toEqual([]);
  }
});

it('distinguishes supplied workspace creation from source-dependent edits and revisions', () => {
  const handler = { name: 'workspace_write', mutates_state: true } as const;
  for (const args of [{ expected_revision: 0 }, {}]) {
    expect(taskSourceAllowed(snap([], false), handler, args)).toBe(true);
    expect(taskSourceMissing(snap([], false), handler, args)).toEqual([]);
  }
  for (const args of [{ expected_revision: 1 }, { edits: [] }]) {
    const unresolved = snap([], false, ['workspace']);
    expect(taskSourceAllowed(unresolved, handler, args)).toBe(false);
    expect(taskSourceMissing(unresolved, handler, args)).toEqual(['workspace']);
    expect(taskSourceAllowed(snap(['workspace']), handler, args)).toBe(true);
    expect(taskSourceMissing(snap(['workspace']), handler, args)).toEqual([]);
  }
});
