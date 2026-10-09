import { describe, expect, it } from 'vitest';
import { proposeGoogleTaskChangeArgsSchema, updateTaskArgsSchema, writeTaskArgsSchema } from './writes';

const create = { source: 'google_tasks', action: 'create', task_list_id: 'work', changes: { title: 'Send proposal', notes: 'Exact approved notes', due_date: '2026-10-11' }, reason: 'Track the agreed next step' };
describe('explicit Google Tasks proposal contract', () => {
  it('accepts creation, selective edits, completion and reopening', () => {
    expect(proposeGoogleTaskChangeArgsSchema.parse(create)).toEqual(create);
    expect(proposeGoogleTaskChangeArgsSchema.safeParse({ ...create, action: 'update', task_id: 'task', changes: { notes: null, due_date: null } }).success).toBe(true);
    for (const action of ['complete', 'reopen']) expect(proposeGoogleTaskChangeArgsSchema.safeParse({ source: 'google_tasks', action, task_list_id: 'work', task_id: 'task', account: 'owner@example.test', reason: 'Owner request' }).success).toBe(true);
  });
  it.each([
    { ...create, source: 'local' }, { ...create, source: undefined }, { ...create, task_list_id: '' },
    { ...create, owner: 'guessed-owner' }, { ...create, task_id: 'existing' },
    { ...create, changes: { notes: 'No title' } }, { ...create, changes: { title: '' } },
    { ...create, changes: { title: 'Task', due_date: '2026-02-30' } },
    { ...create, changes: { title: 'Task', due_date: '2026-10-11T15:00:00Z' } },
    { ...create, changes: { title: 'Task', notes: 'x'.repeat(8193) } },
    { ...create, action: 'update', changes: { title: 'Task' } },
    { ...create, action: 'update', task_id: 'task', changes: {} },
    { ...create, action: 'complete', task_id: 'task' },
    { ...create, action: 'delete', task_id: 'task' },
  ])('rejects ambiguous, unsafe or unsupported target %j', args => {
    expect(proposeGoogleTaskChangeArgsSchema.safeParse(args).success).toBe(false);
  });
  it('preserves the local task contracts', () => {
    expect(writeTaskArgsSchema.parse({ title: 'Local task', reasoning: 'Local audit' })).toEqual({ title: 'Local task', reasoning: 'Local audit' });
    expect(updateTaskArgsSchema.parse({ task_id: 'local', changes: { status: 'done' }, reasoning: 'Local audit' })).toEqual({ task_id: 'local', changes: { status: 'done' }, reasoning: 'Local audit' });
  });
});
