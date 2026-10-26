import { useEffect, useState } from 'react';
import { SignInRequired, signInHref } from './model';
import { exactTime } from './time';
import { fetchAccessLog, type AccessLogCursors, type AccessLogRecord } from './access-log-model';

type LogState = { kind: 'loading' } | { kind: 'error'; message: string; signedOut: boolean } | { kind: 'ready'; data: AccessLogRecord };

const CATEGORY_LABEL: Record<string, string> = { core: 'Everyday', calendar: 'Calendar', mail: 'Mail', web: 'Web and connected tools', memory: 'Memory', health: 'Health', reminders: 'Follow-ups', settings: 'Settings', skills: 'Skills', workspace: 'Workspace', artifacts: 'Documents', actions: 'Actions beyond chat', catalog: 'Tool catalog', other: 'Unrecognised tool' };
const DECISION_LABEL: Record<string, string> = { open: 'Waiting for you', review_only: 'Waiting for review', unconfirmed: 'Card not yet shown', edit_requested: 'You asked for changes', skipped: 'You said no', expired: 'Expired', outcome_unknown: 'Outcome unknown', done: 'Approved and done', not_done: 'Not done', undone: 'Undone', other: 'Unrecognised state' };
const APPROVAL_LABEL: Record<string, string> = { calendar_change: 'Calendar change', email_send: 'Email', message_send: 'Message', mcp_call: 'Connected tool call', tainted_action: 'Action after outside content', browser_submit: 'Web form submit', google_task_change: 'Google Tasks change' };

export function AccessLogView({ log, onPage, onNewest }: { log: AccessLogRecord; onPage: (cursors: AccessLogCursors) => void; onNewest?: () => void }) {
  return <section className="panel access-log" aria-labelledby="access-log-title">
    <h2 id="access-log-title">Access log</h2>
    <p>From Waldo’s own records: the tools it used and the actions that needed your approval, over the last {log.window_days} days. Waldo keeps its newest {log.kept_steps} steps, so the tool list can start later{log.tools.oldest_at ? `; it starts ${exactTime(log.tools.oldest_at)}` : ''}. Only tool names and categories are shown, never what was read or sent.</p>
    <h3>Tools Waldo used</h3>
    {log.tools.rows.length === 0 ? <p>No tool use recorded.</p> : <table className="access-log-table"><thead><tr><th scope="col">When</th><th scope="col">Tool</th><th scope="col">Category</th><th scope="col">Result</th></tr></thead>
      <tbody>{log.tools.rows.map((row, n) => <tr key={`${row.at}:${n}`}><td>{exactTime(row.at)}</td><td>{row.tool === 'other' ? 'Unrecognised tool' : row.tool}</td><td>{CATEGORY_LABEL[row.category] ?? row.category} · {row.kind === 'acted' ? 'acts' : row.kind === 'read' ? 'reads' : 'unknown'}</td><td>{row.ok ? 'Ran' : 'Failed'}</td></tr>)}</tbody></table>}
    {log.tools.next_before !== null && <button onClick={() => onPage({ tools_before: log.tools.next_before! })}>Older tool use</button>}
    <h3>Actions that needed your approval</h3>
    {log.approvals.rows.length === 0 ? <p>No approvals recorded.</p> : <table className="access-log-table"><thead><tr><th scope="col">Asked</th><th scope="col">Action</th><th scope="col">How it was decided</th><th scope="col">Decided</th></tr></thead>
      <tbody>{log.approvals.rows.map((row, n) => <tr key={`${row.at}:${n}`}><td>{exactTime(row.at)}</td><td>{APPROVAL_LABEL[row.kind] ?? row.kind}</td><td>{DECISION_LABEL[row.decision] ?? row.decision}</td><td>{row.decided_at ? exactTime(row.decided_at) : '—'}</td></tr>)}</tbody></table>}
    {log.approvals.next_before !== null && <button onClick={() => onPage({ approvals_before: log.approvals.next_before! })}>Older approvals</button>}
    {onNewest && <button onClick={onNewest}>Back to the newest</button>}
  </section>;
}

export function AccessLogPanel() {
  const [state, setState] = useState<LogState>({ kind: 'loading' });
  const [cursors, setCursors] = useState<AccessLogCursors>({});
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    fetchAccessLog(abort.signal, cursors).then(data => { if (!abort.signal.aborted) setState({ kind: 'ready', data }); }).catch((error: unknown) => {
      if (!abort.signal.aborted) setState({ kind: 'error', message: error instanceof Error ? error.message : 'Couldn’t read the access log. Try again.', signedOut: error instanceof SignInRequired });
    });
    return () => abort.abort();
  }, [cursors, retry]);
  if (state.kind === 'loading') return <p role="status">Reading the access log…</p>;
  if (state.kind === 'error') return <section className="panel" role="alert"><h2>{state.signedOut ? 'Sign in to your Waldo.' : 'Couldn’t read the access log.'}</h2>
    {state.signedOut ? <a className="button-link" href={signInHref()}>Sign in</a> : <button onClick={() => setRetry(n => n + 1)}>Try again</button>}</section>;
  return <AccessLogView log={state.data} onPage={next => setCursors(previous => ({ ...previous, ...next }))} {...(Object.keys(cursors).length ? { onNewest: () => setCursors({}) } : {})}/>;
}
