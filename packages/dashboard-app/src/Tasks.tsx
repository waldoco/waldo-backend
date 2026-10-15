import { useEffect, useState } from 'react';
import { SignInRequired } from './model';
import { exactTime } from './time';
import { Icon } from './icons';

// Mirrors the runtime projection in packages/runtime/src/channels/dashboard-tasks.ts field for field.
export type TasksV1 = Readonly<{
  version: 1; as_of: string; withheld: boolean;
  open: readonly Readonly<{ id: string; title: string; due_local: string | null; source: 'mail' | 'agent'; created_at: string }>[];
  recently_closed: readonly Readonly<{ id: string; title: string; outcome: 'done' | 'dropped'; closed_at: string }>[];
}>;
export const TASKS_URL = '/console/dashboard/api/v1/tasks';
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const time = (v: unknown): v is string => text(v) && !Number.isNaN(Date.parse(v));
const unsupported = () => new Error('Tasks could not be read. The record has an unsupported shape.');
export function readTasks(raw: unknown): TasksV1 {
  if (!object(raw) || raw.version !== 1 || !time(raw.as_of) || typeof raw.withheld !== 'boolean' || !Array.isArray(raw.open) || !Array.isArray(raw.recently_closed)) throw unsupported();
  const open = raw.open.map((row: unknown) => {
    if (!object(row) || !text(row.id) || !text(row.title) || !(row.due_local === null || text(row.due_local)) || (row.source !== 'mail' && row.source !== 'agent') || !time(row.created_at)) throw unsupported();
    return { id: row.id, title: row.title, due_local: row.due_local, source: row.source, created_at: row.created_at } as const;
  });
  const closed = raw.recently_closed.map((row: unknown) => {
    if (!object(row) || !text(row.id) || !text(row.title) || (row.outcome !== 'done' && row.outcome !== 'dropped') || !time(row.closed_at)) throw unsupported();
    return { id: row.id, title: row.title, outcome: row.outcome, closed_at: row.closed_at } as const;
  });
  return { version: 1, as_of: raw.as_of, withheld: raw.withheld, open, recently_closed: closed };
}
export async function fetchTasks(signal?: AbortSignal): Promise<TasksV1> {
  let response: Response;
  try { response = await fetch(TASKS_URL, { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store', redirect: 'error', signal }); }
  catch (error) { if (signal?.aborted) throw error; throw new Error('Tasks could not load right now.'); }
  if (response.status === 401) throw new SignInRequired();
  if (!response.ok) throw new Error('Tasks could not load right now.');
  let value: unknown;
  try { value = await response.json(); } catch { throw unsupported(); }
  return readTasks(value);
}

// Due is stored as owner-local wall time (YYYY-MM-DD or YYYY-MM-DDTHH:MM), so it is shown as written, never shifted.
const due = (local: string | null) => local === null ? 'No due date' : `Due ${local.replace('T', ' ')}`;

export function TasksView({ data, zone }: { data: TasksV1; zone?: string }) {
  return <div className="flow">
    <div className="page-heading"><h1>Tasks.</h1><p>What Waldo is keeping track of for you. This page only shows records; ask Waldo in chat to change one.</p></div>
    {data.withheld && <p className="tile" role="note">Some items are hidden while a forget request finishes.</p>}
    <section className="tile" aria-labelledby="tasks-open">
      <h2 id="tasks-open">Open</h2>
      {data.open.length === 0 ? <p className="muted">Nothing open is recorded.</p>
        : <div className="activity-record-list">{data.open.map(item => <article key={item.id} className="activity-record">
          <p className="strong">{item.title}</p>
          <p className="meta">{due(item.due_local)} · {item.source === 'mail' ? 'From mail, completion unknown' : 'Taken on by Waldo'} · Recorded {exactTime(item.created_at, zone)}</p>
        </article>)}</div>}
    </section>
    <section className="tile" aria-labelledby="tasks-closed">
      <h2 id="tasks-closed">Recently closed</h2>
      {data.recently_closed.length === 0 ? <p className="muted">Nothing closed recently.</p>
        : <div className="activity-record-list">{data.recently_closed.map(item => <article key={item.id} className="activity-record">
          <div className="connection-heading"><p className="strong">{item.title}</p><span className="access-label">{item.outcome === 'done' ? 'Done' : 'Dropped'}</span></div>
          <p className="meta">Closed {exactTime(item.closed_at, zone)}</p>
        </article>)}</div>}
    </section>
    <p className="caption">As of {exactTime(data.as_of, zone)}. Closed means Waldo recorded it as done or dropped; it is not a check of the result.</p>
  </div>;
}

type TasksState = { kind: 'loading' } | { kind: 'error'; message: string; signedOut: boolean } | { kind: 'ready'; data: TasksV1 };
export function TasksFeedback({ state, onRetry }: { state: Exclude<TasksState, { kind: 'ready' }>; onRetry: () => void }) {
  if (state.kind === 'loading') return <p role="status" className="tile">Loading tasks…</p>;
  return <div role="alert" className="feedback tile"><h1>{state.signedOut ? 'Sign in to your Waldo.' : 'Couldn’t load tasks.'}</h1><p>{state.message}</p>
    {state.signedOut ? <a className="button-link" href="/console/signin">Sign in</a> : <button type="button" className="primary" onClick={onRetry}><Icon name="retry"/>Try again</button>}</div>;
}

export function TasksPanel({ zone }: { zone?: string }) {
  const [state, setState] = useState<TasksState>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setState({ kind: 'loading' });
    fetchTasks(abort.signal).then(data => { if (!abort.signal.aborted) setState({ kind: 'ready', data }); })
      .catch((e: unknown) => { if (!abort.signal.aborted) setState({ kind: 'error', message: e instanceof Error ? e.message : 'Tasks could not load right now.', signedOut: e instanceof SignInRequired }); });
    return () => abort.abort();
  }, [retry]);
  return state.kind === 'ready' ? <TasksView data={state.data} zone={zone}/> : <TasksFeedback state={state} onRetry={() => setRetry(n => n + 1)}/>;
}
