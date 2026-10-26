import { useCallback, useEffect, useRef, useState } from 'react';
import { ControlReceipt } from './Controls';
import { MemoryActions } from './MemoryActions';
import { ControlsActionError, type ActionResult } from './controls-model';
import { PURPOSE_LABEL, SOURCE_LABEL } from './health-model';
import { SignInRequired, StepUpRequired, confirmHref, signInHref } from './model';
import { exactTime } from './time';
import { fetchVault, revokeConnection, type RevokeTarget, type VaultCursors, type VaultRecord } from './vault-model';

type VaultState = { kind: 'loading' } | { kind: 'locked' } | { kind: 'error'; message: string; signedOut: boolean } | { kind: 'ready'; data: VaultRecord };

const KIND_LABEL: Record<string, string> = { fact: 'Facts', preference: 'Preferences', routine: 'Routines', goal: 'Goals', followup: 'Follow-ups', health: 'Health notes', event: 'Events', pattern: 'Patterns', observation: 'Observations', interpretation: 'Patterns Waldo noticed', other: 'Other' };
const GRANT_WORDS: Record<string, string> = {
  calendar: 'See, add, move and cancel events on your calendars.',
  gmail: 'Read your mail, write drafts and send email. Waldo shows you each email to approve before it goes.',
  tasks: 'See and change your Google Tasks.',
};
const CHANNEL_WORDS: Record<string, { name: string; grant: string }> = {
  telegram: { name: 'Telegram', grant: 'Messages from your linked chat reach your Waldo, and Waldo can message it.' },
  imessage: { name: 'iMessage', grant: 'Texts from your linked number reach your Waldo, and Waldo can text it.' },
  whatsapp: { name: 'WhatsApp', grant: 'Messages from your linked number reach your Waldo, and Waldo can message it.' },
};
const CATEGORY_LABEL: Record<string, string> = { core: 'Everyday', calendar: 'Calendar', mail: 'Mail', web: 'Web and connected tools', memory: 'Memory', health: 'Health', reminders: 'Follow-ups', settings: 'Settings', skills: 'Skills', workspace: 'Workspace', artifacts: 'Documents', actions: 'Actions beyond chat', catalog: 'Tool catalog', other: 'Unrecognised tool' };
const DECISION_LABEL: Record<string, string> = { open: 'Waiting for you', review_only: 'Waiting for review', unconfirmed: 'Card not yet shown', edit_requested: 'You asked for changes', skipped: 'You said no', expired: 'Expired', outcome_unknown: 'Outcome unknown', done: 'Approved and done', not_done: 'Not done', undone: 'Undone', other: 'Unrecognised state' };
const APPROVAL_LABEL: Record<string, string> = { calendar_change: 'Calendar change', email_send: 'Email', message_send: 'Message', mcp_call: 'Connected tool call', tainted_action: 'Action after outside content', browser_submit: 'Web form submit', google_task_change: 'Google Tasks change', other: 'Other' };
const notRecorded = 'Not recorded';
const when = (iso: string | null) => iso ? exactTime(iso) : notRecorded;

function Locked() {
  return <section className="panel vault-locked" role="status" aria-labelledby="vault-locked-title">
    <h2 id="vault-locked-title">Your Vault is locked.</h2>
    <p>Opening it needs an email code from the last 2 hours. Until then nothing in it is sent to this browser.</p>
    <a className="button-link" href={confirmHref()}>Get an email code</a>
  </section>;
}

function Revoke({ label, confirm, target, id, onDone }: { label: string; confirm: string; target: RevokeTarget; id: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false), [result, setResult] = useState<ActionResult | null>(null), [error, setError] = useState<{ message: string; stepUp: boolean } | null>(null);
  const request = useRef<string | null>(null);
  const run = async () => {
    if (busy) return;
    if (!request.current) { if (!window.confirm(confirm)) return; request.current = crypto.randomUUID(); }
    setBusy(true); setError(null);
    try {
      const next = await revokeConnection(target, id, request.current);
      setResult(next);
      if (next.receipt.state !== 'unconfirmed') { request.current = null; if (next.receipt.state === 'recorded') onDone(); }
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : 'Outcome unavailable.', stepUp: e instanceof StepUpRequired });
      if (!(e instanceof ControlsActionError && e.uncertain)) request.current = null;
    } finally { setBusy(false); }
  };
  return <div className="vault-revoke">
    {result && <ControlReceipt result={result} onRefresh={onDone} onCheck={result.receipt.state === 'unconfirmed' ? () => void run() : undefined} busy={busy}/>}
    {error && <div role="alert"><p>{error.message}</p>{error.stepUp && <a className="button" href={confirmHref()}>Get an email code</a>}</div>}
    <button disabled={busy} onClick={() => void run()}>{request.current ? 'Check this request' : label}</button>
  </div>;
}

function Memories({ memory, onChanged }: { memory: VaultRecord['memory']; onChanged: () => void }) {
  // One memory-controls read per opened row, never one per row on screen.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const total = memory.groups.reduce((n, group) => n + group.total, 0);
  return <section className="panel" aria-labelledby="vault-memory-title">
    <h2 id="vault-memory-title">Memories</h2>
    <p>What Waldo keeps about you, grouped, with where each came from and when it was recorded. Open one to pin, correct or forget it.</p>
    {memory.state === 'partial' && <p role="status">Some memories are left out while a forget finishes or because a record is incomplete.</p>}
    {memory.state === 'unavailable' && <p role="status">Waldo’s memory could not be read. Nothing here means it is empty.</p>}
    {memory.state !== 'unavailable' && total === 0 && <p>Waldo keeps no memories about you yet.</p>}
    {memory.groups.map(group => <div key={group.kind} className="vault-group">
      <h3>{KIND_LABEL[group.kind] ?? group.kind} <span className="count">{group.total}</span></h3>
      <ul className="vault-list">{group.items.map(item => <li key={item.id}>
        <details onToggle={event => { const shown = (event.currentTarget as HTMLDetailsElement).open; setOpen(previous => { const next = new Set(previous); if (shown) next.add(item.id); else next.delete(item.id); return next; }); }}>
          <summary><span className="value">{item.text}</span><span className="meta">{item.source_label} · {item.recorded_at ?? 'date not recorded'}</span></summary>
          {open.has(item.id) && <MemoryActions id={item.id} onChanged={onChanged}/>}
        </details></li>)}</ul>
      {group.total > group.items.length && <p className="meta">{group.total - group.items.length} more in <a href="#/memory">Memory</a>.</p>}
    </div>)}
  </section>;
}

function Logins({ connections, onChanged }: { connections: VaultRecord['connections']; onChanged: () => void }) {
  const anyLocal = connections.google.some(row => row.token_storage === 'waldo_server');
  return <section className="panel" aria-labelledby="vault-logins-title">
    <h2 id="vault-logins-title">Logins and connections</h2>
    <p className="vault-note">{connections.token_note}</p>
    {anyLocal && <p className="vault-note warning">One Google account below keeps its token on Waldo’s server instead. Waldo’s model still never sees it. Reconnect it to move it to Supabase Vault.</p>}
    <h3>Google</h3>
    {connections.google.length === 0 && <p>No Google account is connected.</p>}
    <ul className="vault-list">{connections.google.map(row => <li key={row.account_id} className="vault-row">
      <div><strong>{row.email}</strong>{row.status === 'needs_reconnect' && <span className="access-label reconnect">Reconnect needed</span>}</div>
      <ul className="grant-list">{row.grants.map(grant => <li key={grant}>{GRANT_WORDS[grant]}</li>)}</ul>
      {row.grants.length === 0 && <p>No service grants recorded for this account.</p>}
      <p className="meta">Token: {row.token_storage === 'supabase_vault' ? 'Supabase Vault, encrypted' : 'on Waldo’s server'} · Connected: {when(row.connected_at)} · Last used: {when(row.last_used_at)}</p>
      <Revoke label={`Revoke ${row.email}`} confirm={`Revoke ${row.email}? Waldo loses this Google access.`} target={row.revoke} id={row.account_id} onDone={onChanged}/>
    </li>)}</ul>
    <h3>Connected tools</h3>
    {connections.mcp.length === 0 && <p>No tool servers are connected.</p>}
    <ul className="vault-list">{connections.mcp.map(row => <li key={row.id} className="vault-row">
      <div><strong>{row.name}</strong> <span className="meta">{row.host}</span>{row.status !== 'active' && <span className="access-label reconnect">Sign in again</span>}</div>
      <p>{row.tools} {row.tools === 1 ? 'tool' : 'tools'}, {row.runs_without_asking} {row.runs_without_asking === 1 ? 'runs' : 'run'} without asking. {row.scopes.length ? `Scopes the server granted: ${row.scopes.join(', ')}.` : 'The server named no scopes.'}</p>
      <p className="meta">Connected: {when(row.connected_at)} · Last used: {when(row.last_used_at)}</p>
      <Revoke label={`Revoke ${row.name}`} confirm={`Revoke ${row.name}? Waldo asks the server to revoke its access and forgets it.`} target={row.revoke} id={row.id} onDone={onChanged}/>
    </li>)}</ul>
    <h3>Chats</h3>
    <ul className="vault-list">{connections.channels.map(row => <li key={row.channel} className="vault-row">
      <div><strong>{CHANNEL_WORDS[row.channel]!.name}</strong> <span className="access-label">{row.state === 'linked' ? 'Linked' : 'Not linked'}</span></div>
      {row.state === 'linked' && <p>{CHANNEL_WORDS[row.channel]!.grant}</p>}
      <p className="meta">Linked: {notRecorded} · Last used: {notRecorded}</p>
      {row.revoke && <Revoke label={`Unlink ${CHANNEL_WORDS[row.channel]!.name}`} confirm={`Unlink ${CHANNEL_WORDS[row.channel]!.name}? Messages from it stop reaching your Waldo.`} target={row.revoke} id="" onDone={onChanged}/>}
    </li>)}</ul>
    <h3>Health</h3>
    {connections.health.state === 'unavailable' ? <p role="status">Health sharing could not be read. Nothing here means you share nothing.</p> : <>
      {connections.health.rows.length === 0 && <p>You share no health data with Waldo.</p>}
      <ul className="vault-list">{connections.health.rows.map(row => <li key={`${row.source}:${row.purpose}`} className="vault-row">
        <div><strong>{SOURCE_LABEL[row.source as keyof typeof SOURCE_LABEL] ?? row.source}</strong> · {PURPOSE_LABEL[row.purpose as keyof typeof PURPOSE_LABEL] ?? row.purpose}</div>
        <p className="meta">{row.status === 'granted' ? `Shared since ${when(row.granted_at)}` : row.status === 'withdrawn' ? `Withdrawn ${when(row.withdrawn_at)}` : 'Not shared'} · Newest upload: {when(row.newest_upload_at)}</p>
      </li>)}</ul>
      <p>Withdraw health sharing in the Waldo app.</p>
    </>}
  </section>;
}

function AccessLog({ log, onPage, onNewest }: { log: VaultRecord['access_log']; onPage: (cursors: VaultCursors) => void; onNewest?: () => void }) {
  return <section className="panel" aria-labelledby="vault-log-title">
    <h2 id="vault-log-title">Access log</h2>
    <p>From Waldo’s own records: the tools it used and the actions that needed your approval, over the last {log.window_days} days. Waldo keeps its newest {log.kept_steps} steps, so the tool list can start later{log.tools.oldest_at ? `; it starts ${exactTime(log.tools.oldest_at)}` : ''}. Only tool names and categories are shown, never what was read or sent.</p>
    <h3>Tools Waldo used</h3>
    {log.tools.rows.length === 0 ? <p>No tool use recorded.</p> : <table className="vault-table"><thead><tr><th scope="col">When</th><th scope="col">Tool</th><th scope="col">Category</th><th scope="col">Result</th></tr></thead>
      <tbody>{log.tools.rows.map((row, n) => <tr key={`${row.at}:${n}`}><td>{exactTime(row.at)}</td><td>{row.tool === 'other' ? 'Unrecognised tool' : row.tool}</td><td>{CATEGORY_LABEL[row.category] ?? row.category} · {row.kind === 'acted' ? 'acts' : row.kind === 'read' ? 'reads' : 'unknown'}</td><td>{row.ok ? 'Ran' : 'Failed'}</td></tr>)}</tbody></table>}
    {log.tools.next_before !== null && <button onClick={() => onPage({ tools_before: log.tools.next_before! })}>Older tool use</button>}
    <h3>Actions that needed your approval</h3>
    {log.approvals.rows.length === 0 ? <p>No approvals recorded.</p> : <table className="vault-table"><thead><tr><th scope="col">Asked</th><th scope="col">Action</th><th scope="col">How it was decided</th><th scope="col">Decided</th></tr></thead>
      <tbody>{log.approvals.rows.map((row, n) => <tr key={`${row.at}:${n}`}><td>{exactTime(row.at)}</td><td>{APPROVAL_LABEL[row.kind] ?? row.kind}</td><td>{DECISION_LABEL[row.decision] ?? row.decision}</td><td>{row.decided_at ? exactTime(row.decided_at) : '—'}</td></tr>)}</tbody></table>}
    {log.approvals.next_before !== null && <button onClick={() => onPage({ approvals_before: log.approvals.next_before! })}>Older approvals</button>}
    {onNewest && <button onClick={onNewest}>Back to the newest</button>}
  </section>;
}

function ComingLater() {
  return <section className="panel" aria-labelledby="vault-later-title">
    <h2 id="vault-later-title">Coming later</h2>
    <ul className="vault-list">
      <li className="vault-row"><strong>Passwords</strong><p>Coming with 1Password. Waldo will never see or store your passwords.</p></li>
      <li className="vault-row"><strong>Payments</strong><p>Coming later.</p></li>
    </ul>
  </section>;
}

export function VaultView({ state, onRetry, onPage, onNewest }: { state: VaultState; onRetry: () => void; onPage: (cursors: VaultCursors) => void; onNewest?: () => void }) {
  const head = <div className="page-heading"><h1>Vault.</h1><p>Everything Waldo keeps and can reach for you, in one place. It needs a recent email code to open.</p></div>;
  if (state.kind === 'loading') return <>{head}<p role="status">Opening your Vault…</p></>;
  if (state.kind === 'locked') return <>{head}<Locked/></>;
  if (state.kind === 'error') return <>{head}<section className="panel" role="alert"><h2>{state.signedOut ? 'Sign in to your Waldo.' : 'Couldn’t open your Vault.'}</h2><p>{state.message}</p>
    {state.signedOut ? <a className="button-link" href={signInHref()}>Sign in</a> : <button onClick={onRetry}>Try again</button>}</section></>;
  return <div className="vault-page">{head}
    <Memories memory={state.data.memory} onChanged={onRetry}/>
    <Logins connections={state.data.connections} onChanged={onRetry}/>
    <AccessLog log={state.data.access_log} onPage={onPage} {...(onNewest ? { onNewest } : {})}/>
    <ComingLater/>
    <p className="caption">Read {exactTime(state.data.as_of)}.</p>
  </div>;
}

export function VaultPanel() {
  const [state, setState] = useState<VaultState>({ kind: 'loading' });
  const [cursors, setCursors] = useState<VaultCursors>({});
  const [retry, setRetry] = useState(0);
  const load = useCallback((signal: AbortSignal) => {
    fetchVault(signal, cursors).then(data => { if (!signal.aborted) setState({ kind: 'ready', data }); }).catch((error: unknown) => {
      if (signal.aborted) return;
      if (error instanceof StepUpRequired) setState({ kind: 'locked' });
      else setState({ kind: 'error', message: error instanceof Error ? error.message : 'The Vault could not load right now.', signedOut: error instanceof SignInRequired });
    });
  }, [cursors]);
  useEffect(() => { const abort = new AbortController(); load(abort.signal); return () => abort.abort(); }, [load, retry]);
  return <VaultView state={state} onRetry={() => setRetry(n => n + 1)} onPage={next => setCursors(previous => ({ ...previous, ...next }))} {...(Object.keys(cursors).length ? { onNewest: () => setCursors({}) } : {})}/>;
}
