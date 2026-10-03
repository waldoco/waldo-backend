import { useEffect, useRef, useState } from 'react';
import { SignInRequired } from './model';
import { fetchControls, submitControl, ControlsActionError, type ActionResult, type ActivityCursors, type ConnectionsRecord, type ControlAction, type ControlFields, type ControlRecord, type ControlsView, type DayRecord } from './controls-model';
import { ActivityControls, FilesControls, ProfileControls, SetupControls, UsageControls, WaitingControls } from './Panels';

type ActionProps = { busy: boolean; onAction: (action: ControlAction, fields?: ControlFields) => void };
export type ControlsState = { kind: 'loading' } | { kind: 'ready'; data: ControlRecord } | { kind: 'error'; message: string; signedOut: boolean };

function CardTiming({ card, busy, onAction }: { card: DayRecord['data']['cards'][number] } & ActionProps) {
  const [time, setTime] = useState(card.time ?? card.defaultTime);
  return <section className="panel control-card">
    <div className="connection-heading"><h2>{card.name}</h2><span className="access-label">{card.sent ? 'Send recorded' : card.time === null ? 'Skipped today' : 'Scheduled'}</span></div>
    <p>{card.reason}</p><p className="muted">{card.time === null ? 'No time scheduled today.' : `Today at ${card.time}.`}{card.pin ? ` Pinned at ${card.pin}.` : ' No daily pin recorded.'}</p>
    {!card.sent && <form className="control-form" onSubmit={event => { event.preventDefault(); onAction('card.today', { id: card.id, value: time }); }}>
      <label>Time for {card.name}<input type="time" required value={time} disabled={busy} onChange={event => setTime(event.target.value)}/></label>
      <div className="control-actions"><button disabled={busy}>Set for today</button><button disabled={busy || !time} type="button" onClick={() => onAction('card.pin', { id: card.id, value: time })}>Always at this time</button></div>
    </form>}
    {card.pin && <button disabled={busy} onClick={() => onAction('card.unpin', { id: card.id })}>Clear pin for {card.name}</button>}
    {card.sent && <p className="muted">This records a send, not verified delivery. Timing edits are unavailable for an already sent card.</p>}
  </section>;
}

export function DayControls({ record, busy, onAction }: { record: DayRecord } & ActionProps) {
  const [timezone, setTimezone] = useState(record.data.timezone);
  const [quietStart, setQuietStart] = useState(record.data.proactivity.quiet_start ?? '');
  const [quietEnd, setQuietEnd] = useState(record.data.proactivity.quiet_end ?? '');
  const [volume, setVolume] = useState(record.data.proactivity.volume);
  return <>
    <div className="controls-section-heading"><p>{record.data.date} · {record.data.timezone}</p><h2>The Brief, Check-in &amp; Close</h2><p>Set today’s timing, keep a daily pin, or let Waldo plan again.</p></div>
    <div className="controls-card-list">{record.data.cards.map(card => <CardTiming key={`${record.revision}:${card.id}`} card={card} busy={busy} onAction={onAction}/>)}</div>
    {!record.data.cards.length && <section className="panel"><h2>No day cards returned.</h2><p>This read contains no editable cards. It does not show full Brief or Close content.</p></section>}
    <section className="panel"><h2>Time zone</h2><p>Cards and reminders follow this time zone. Save a change when you travel.</p>
      <form className="control-form" onSubmit={event => { event.preventDefault(); onAction('timezone.set', { value: timezone }); }}>
        <label>Time zone<input required autoComplete="off" value={timezone} disabled={busy} onChange={event => setTimezone(event.target.value)}/></label>
        <div className="control-actions"><button disabled={busy} type="button" onClick={() => setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)}>Use this device</button><button disabled={busy}>Save time zone</button></div>
      </form>
    </section>
    <section className="panel"><h2>Quiet hours &amp; volume</h2><p>Waldo holds cards, updates and event briefs during quiet hours. Reminders you set still fire. Leave both times empty for no quiet hours.</p>
      <form className="control-form" onSubmit={event => { event.preventDefault(); onAction('proactivity.set', { quiet_start: quietStart, quiet_end: quietEnd, volume }); }}>
        <div className="control-fields"><label>Quiet from<input type="time" value={quietStart} disabled={busy} onChange={event => setQuietStart(event.target.value)}/></label><label>Quiet until<input type="time" value={quietEnd} disabled={busy} onChange={event => setQuietEnd(event.target.value)}/></label></div>
        <label>Volume<select value={volume} disabled={busy} onChange={event => setVolume(event.target.value as typeof volume)}><option value="low">Low: only the three day cards</option><option value="normal">Normal: plus updates that change your day</option><option value="high">High: plus smaller useful updates</option></select></label><button disabled={busy}>Save quiet hours &amp; volume</button>
      </form>
    </section>
    <p className="muted">These cards run in chat. Full card content and verified Close results are not supplied by these controls.</p>
  </>;
}

export function ConnectionsControls({ record, busy, onAction, section }: { record: ConnectionsRecord; section?: 'connections'|'sessions' } & ActionProps) {
  const { google, telegram, sessions } = record.data;
  return <>
    {section!=='sessions'&&<><section className="panel"><h2>Google accounts</h2><p>Saved access is permission, not proof that a live Calendar, Gmail or Tasks request worked.</p>
      <div className="account-list">{google.accounts.map(account => <section className="control-account" key={account.id}>
        <h3>{account.email}</h3><span className={`access-label${account.health === 'needs_reconnect' ? ' reconnect' : ''}`}>{account.health === 'needs_reconnect' ? 'Reconnect needed' : 'Access granted · read unverified'}</span>
        <ul className="grant-list">{[account.calendar ? 'Calendar' : null, account.mail ? 'Gmail' : null, account.tasks ? 'Tasks' : null].filter(Boolean).map(grant => <li key={grant}>{grant}</li>)}</ul>
        {![account.calendar, account.mail, account.tasks].some(Boolean) && <p>No service grants recorded for this account.</p>}
        {account.health === 'needs_reconnect' && <p>Reconnect and choose {account.email} in Google to refresh this account’s access.</p>}
        <div className="control-actions">{account.health === 'needs_reconnect' && google.connectAvailable && <button disabled={busy} onClick={() => onAction('google.connect', { value: 'calendar' })}>Reconnect {account.email}</button>}
          <button disabled={busy} onClick={() => { if (window.confirm(`Disconnect ${account.email}? Waldo loses this Google access.`)) onAction('google.disconnect', { id: account.id }); }}>Disconnect {account.email}</button></div>
      </section>)}</div>
      {!google.accounts.length && <p>No Google accounts returned.</p>}
      {google.connectAvailable ? <button disabled={busy} onClick={() => onAction('google.connect', { value: 'calendar' })}>{google.accounts.length ? 'Add Google account' : 'Connect Google'}</button> : <p className="muted">Google connection is unavailable on this server.</p>}
      <p className="muted">Google requests its existing access scopes together and asks which account to use. Mail sends still require your exact approval in chat.</p>
    </section>
    <section className="panel"><div className="connection-heading"><h2>Telegram</h2><span className="access-label">{telegram.linked ? 'Linked' : 'Unlinked'}</span></div><p>Your owner DM carries chat, cards and reminders. Linking instructions appear here after you request them.</p>
      <div className="control-actions"><button disabled={busy} onClick={() => onAction('telegram.link')}>Link a Telegram account</button>{telegram.linked && telegram.unlinkAvailable && <button disabled={busy} onClick={() => { if (window.confirm('Unlink Telegram? Waldo stops messaging it. Sign in with your email to link again.')) onAction('telegram.unlink'); }}>Unlink Telegram</button>}</div>
    </section>
    </>}
    {section!=='connections'&&<section className="panel"><h2>Console sessions</h2><p>{sessions.count} active {sessions.count === 1 ? 'browser session' : 'browser sessions'} recorded. This session is valid until {sessions.until}.</p>
      <div className="control-actions"><button disabled={busy} onClick={() => onAction('session.signout')}>Sign out of this browser</button>{sessions.count > 1 && <button disabled={busy} onClick={() => { if (window.confirm('Sign out of every browser?')) onAction('session.signout.all'); }}>Sign out everywhere</button>}</div>
    </section>}
  </>;
}

export function ControlsFeedback({ state, onRefresh }: { state: Exclude<ControlsState, { kind: 'ready' }>; onRefresh: () => void }) {
  if (state.kind === 'loading') return <p role="status">Loading your controls…</p>;
  return <section className="panel" role="alert"><h2>{state.signedOut ? 'Sign in to your Waldo.' : 'Controls unavailable.'}</h2><p>{state.message}</p>{state.signedOut ? <a href="/console/signin">Sign in</a> : <button onClick={onRefresh}>Retry read</button>}</section>;
}

export function ControlReceipt({ result, onCheck, onRefresh, busy }: { result: ActionResult; onCheck?: () => void; onRefresh: () => void; busy: boolean }) {
  const { receipt } = result;
  return <section className="panel control-receipt" role={receipt.state === 'recorded' ? 'status' : 'alert'}>
    <h2>{receipt.signed_out ? 'Signed out.' : receipt.state === 'recorded' ? 'Receipt recorded.' : receipt.state === 'incomplete' ? 'Change incomplete.' : receipt.state === 'rejected' ? 'Change not applied.' : 'Outcome unconfirmed.'}</h2>
    <p className="control-receipt-message">{receipt.message}</p>{result.duplicate && <p className="muted">This is the recorded receipt for the same request. It did not run again.</p>}
    {receipt.navigation && <a className="button-link" href={receipt.navigation}>Continue to Google</a>}
    {receipt.signed_out ? <a href="/console/signin">Sign in again</a> : <div className="control-actions">{onCheck && <button disabled={busy} onClick={onCheck}>Check this request</button>}<button disabled={busy} onClick={onRefresh}>Refresh controls</button></div>}
  </section>;
}

type Attempt = { record: ControlRecord; action: ControlAction; fields: ControlFields; id: string };
const headings: Record<ControlsView, { eyebrow: string; title: string; description: string }> = {
  day: { eyebrow: 'Your rhythm', title: 'Your day.', description: 'Plan when Waldo reaches you, and keep the rhythm yours.' },
  connections: { eyebrow: 'Permission, with control', title: 'Connections.', description: 'Manage the accounts and channels connected to your Waldo.' },
  waiting: { eyebrow: 'Your decision comes first', title: 'Waiting.', description: 'Review the full proposal before deciding. Send approval stays in chat.' },
  activity: { eyebrow: 'Recorded work', title: 'Patrol.', description: 'Inspect recorded attempts, reasons and outcomes without assuming completion.' },
  profile: { eyebrow: 'Correctable context', title: 'Profile.', description: 'Read the saved context behind your Waldo, and correct it in chat.' },
  setup: { eyebrow: 'Make Waldo useful', title: 'Setup.', description: 'Check saved prerequisites and choose your next step.' },
  usage: { eyebrow: 'Recorded estimates', title: 'Usage.', description: 'Inspect model calls and their recorded estimated cost.' },
  files: { eyebrow: 'Telegram references', title: 'Files.', description: 'Open what you sent Waldo, or remove a reference from the list.' },
};
export function ControlsPanel({ view, embedded=false, section }: { view: ControlsView; embedded?:boolean; section?: 'connections'|'sessions' }) {
  const [state, setState] = useState<ControlsState>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [error, setError] = useState<{ message: string; uncertain: boolean; signedOut: boolean } | null>(null);
  const [page, setPage] = useState<ActivityCursors>({});
  const attempt = useRef<Attempt | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    const abort = new AbortController(); setState({ kind: 'loading' });
    fetchControls(view, abort.signal, page).then(data => { if (!abort.signal.aborted) setState({ kind: 'ready', data }); }).catch(e => { if (!abort.signal.aborted) setState({ kind: 'error', message: e instanceof Error ? e.message : 'Controls unavailable.', signedOut: e instanceof SignInRequired }); });
    return () => abort.abort();
  }, [view, retry, page.trace_before, page.runs_before]);
  const refresh = () => { if (inFlight.current) return; setState({ kind: 'loading' }); setRetry(n => n + 1); if (!error?.uncertain && result?.receipt.state !== 'unconfirmed') { attempt.current = null; setError(null); } };
  const perform = async (pending: Attempt) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const receipt = await submitControl(pending.record, pending.action, pending.fields, pending.id);
      setResult(receipt);
      if (receipt.receipt.state !== 'unconfirmed') {
        attempt.current = null;
        if (receipt.receipt.signed_out) setState({ kind: 'error', signedOut: true, message: 'This session was signed out.' });
        else setRetry(n => n + 1);
      }
    } catch (e) {
      const uncertain = e instanceof ControlsActionError && e.uncertain;
      if (!uncertain) attempt.current = null;
      if (e instanceof SignInRequired) {
        setResult(null); setError(null); setState({ kind: 'error', message: e.message, signedOut: true });
      } else setError({ message: e instanceof Error ? e.message : 'The outcome is unavailable.', uncertain, signedOut: false });
    } finally { inFlight.current = false; setBusy(false); }
  };
  const act = (action: ControlAction, fields: ControlFields = {}) => {
    if (state.kind !== 'ready' || inFlight.current || attempt.current || error || result?.receipt.state === 'unconfirmed') return;
    const next = { record: state.data, action, fields: { ...fields }, id: crypto.randomUUID() };
    attempt.current = next; setResult(null); void perform(next);
  };
  const check = () => { if (attempt.current) void perform(attempt.current); };
  const disabled = busy || !!error || result?.receipt.state === 'unconfirmed';
  const onPage = (next: ActivityCursors) => { if (inFlight.current) return; setState({ kind: 'loading' }); setPage(next); setRetry(n => n + 1); };
  const heading = headings[view];
  const content = state.kind === 'ready' ? state.data.view === 'day' ? <DayControls record={state.data} busy={disabled} onAction={act}/>
    : state.data.view === 'connections' ? <ConnectionsControls record={state.data} busy={disabled} onAction={act} section={section}/>
      : state.data.view === 'waiting' ? <WaitingControls record={state.data} busy={disabled} onAction={act}/>
        : state.data.view === 'activity' ? <ActivityControls record={state.data} busy={disabled} onPage={onPage}/>
          : state.data.view === 'profile' ? <ProfileControls record={state.data}/>
            : state.data.view === 'setup' ? <SetupControls record={state.data}/>
              : state.data.view === 'usage' ? <UsageControls record={state.data}/>
                : <FilesControls record={state.data} busy={disabled} onAction={act}/> : null;
  return <>
    {!embedded&&<div className="page-heading"><span className="eyebrow">{heading.eyebrow}</span><h1>{heading.title}</h1><p>{heading.description}</p><button disabled={busy} onClick={refresh}>Refresh controls</button></div>}
    {embedded&&<button disabled={busy} onClick={refresh}>Refresh {section==='sessions'?'sessions':'settings'}</button>}
    {result && <ControlReceipt result={result} onCheck={result.receipt.state === 'unconfirmed' ? check : undefined} onRefresh={refresh} busy={busy}/>}
    {error && <section className="panel" role="alert"><h2>{error.uncertain ? 'Outcome unavailable.' : 'Review the controls again.'}</h2><p>{error.message}</p>{error.signedOut ? <a href="/console/signin">Sign in</a> : <div className="control-actions">{error.uncertain && <button disabled={busy} onClick={check}>Check this request</button>}<button disabled={busy} onClick={refresh}>Refresh controls</button></div>}</section>}
    {state.kind !== 'ready' ? <ControlsFeedback state={state} onRefresh={refresh}/> : <div className="controls-stack" key={`${state.data.view}:${state.data.revision}`}>{content}</div>}
  </>;
}
