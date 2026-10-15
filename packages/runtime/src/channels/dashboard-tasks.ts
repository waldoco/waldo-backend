// Read-only projection of the owner's open loops for the console Tasks page. Pure over LoopBook rows.
// A mail-linked title is derived from outside text: it is shown to the owner here as plain data, but
// its source reference never leaves the DO. Rows that carry or may hide a forget-pending topic are
// withheld with the same predicate the forget coverage uses; `withheld` says so without the topic.
import type { Loop } from './loops';
import { carriesTopic, hidesTopic } from '../memory/forget-guard';

export const DASHBOARD_TASKS_PATH = '/console/dashboard/api/v1/tasks';
export const TASKS_CLOSED_LIMIT = 5;

const iso = (epoch: number) => new Date(epoch).toISOString();
const byDueThenCreated = (a: Loop, b: Loop) =>
  a.due === b.due ? a.created_at - b.created_at : a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1;

export const dashboardTasks = (input: Readonly<{ now: number; open: readonly Loop[]; closed: readonly Loop[]; held: readonly string[] }>) => {
  const holds = (loop: Loop) => [loop.title, loop.source_ref].some((value) =>
    typeof value === 'string' && input.held.some((topic) => carriesTopic(value, topic) || hidesTopic(value, topic)));
  const open = input.open.filter((loop) => !holds(loop));
  const closed = input.closed.filter((loop) => !holds(loop));
  return {
    version: 1 as const,
    as_of: iso(input.now),
    withheld: open.length < input.open.length || closed.length < input.closed.length,
    open: [...open].sort(byDueThenCreated).map((loop) => ({
      id: loop.id, title: loop.title, due_local: loop.due, source: loop.source_ref ? 'mail' as const : 'agent' as const, created_at: iso(loop.created_at),
    })),
    recently_closed: [...closed].sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0)).slice(0, TASKS_CLOSED_LIMIT).map((loop) => ({
      id: loop.id, title: loop.title, outcome: loop.status, closed_at: iso(loop.closed_at ?? loop.created_at),
    })),
  };
};
export type DashboardTasks = ReturnType<typeof dashboardTasks>;
