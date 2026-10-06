import { useEffect, useRef, useState } from 'react';
import { SignInRequired } from './model';
import { fetchControls, submitControl, ControlsActionError, type ActionResult, type ActivityCursors, type ConnectionsRecord, type ControlAction, type ControlFields, type ControlRecord, type ControlsView, type DayRecord } from './controls-model';
import { Icon, Logo, type IconName } from './icons';
import { Patch } from '@lucasmarkes/hairline/react';
import { DayRail, localMinutes, minutesLabel, type RailMark } from './Infographics';
import { ActivityControls, FilesControls, ProfileControls, SetupControls, UsageControls, WaitingControls } from './Panels';

type ActionProps = { busy: boolean; onAction: (action: ControlAction, fields?: ControlFields) => void };
export type ControlsState = { kind: 'loading' } | { kind: 'ready'; data: ControlRecord } | { kind: 'error'; message: string; signedOut: boolean };

const clockMinutes = (value: string | null) => { if (!value) return null; const [h, m] = value.split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h! * 60 + m! : null; };
const cardIcon = (name: string): IconName => /brief/i.test(name) ? 'brief' : /close/i.test(name) ? 'close' : 'calendarClock';
function CardTiming({ card, busy, onAction }: { card: DayRecord['data']['cards'][number] } & ActionProps) {
  const [time, setTime] = useState(card.time ?? card.defaultTime);
  const at = clockMinutes(card.time);
  return <details name="day-cards" className="disclosure control-card">
    <summary><Icon name={cardIcon(card.name)}/><span className="value">{card.name}</span><span className="label time">{at === null ? 'Not today' : minutesLabel(at)}</span><span className={`access-label${card.sent ? ' done' : ''}`}>{card.sent ? 'Send recorded' : card.time === null ? 'Skipped today' : 'Scheduled'}</span></summary>
    <div className="disclosure-body">
    <p>{card.reason}</p><p className="meta">{card.time === null ? 'Not scheduled today.' : `Today at ${card.time}.`}{card.pin ? ` Pinned at ${card.pin}.` : ' No daily pin recorded.'}</p>
    {!card.sent && <form className="control-form" onSubmit={event => { event.preventDefault(); onAction('card.today', { id: card.id, value: time }); }}>
      <label>Time for {card.name}<input type="time" required value={time} disabled={busy} onChange={event => setTime(event.target.value)}/></label>
      <div className="control-actions"><button className="primary" disabled={busy}>Set for today</button><button disabled={busy || !time} type="button" onClick={() => onAction('card.pin', { id: card.id, value: time })}>Always at this time</button></div>
    </form>}
    {card.pin && <button className="quiet" disabled={busy} onClick={() => onAction('card.unpin', { id: card.id })}>Clear pin for {card.name}</button>}
    {card.sent && <p className="meta">This records a send, not verified delivery. Timing edits are unavailable for an already sent card.</p>}
    </div>
  </details>;
}

export function DayControls({ record, busy, onAction }: { record: DayRecord } & ActionProps) {
  const [timezone, setTimezone] = useState(record.data.timezone);
  const [quietStart, setQuietStart] = useState(record.data.proactivity.quiet_start ?? '');
  const [quietEnd, setQuietEnd] = useState(record.data.proactivity.quiet_end ?? '');
  const [volume, setVolume] = useState(record.data.proactivity.volume);
  const now = localMinutes(new Date(), record.data.timezone) ?? 0;
  const timed = record.data.cards.map(card => ({ card, at: clockMinutes(card.time) })).filter((entry): entry is { card: typeof entry.card; at: number } => entry.at !== null);
  const nextKey = timed.filter(entry => !entry.card.sent && entry.at > now).sort((a, b) => a.at - b.at)[0]?.card.id;
  const marks: RailMark[] = timed.map(({ card, at }) => ({ key: card.id, at, label: card.name, time: minutesLabel(at), kind: card.sent ? 'done' : card.id === nextKey ? 'next' : 'plain' }));
  const quietFrom = clockMinutes(record.data.proactivity.quiet_start), quietTo = clockMinutes(record.data.proactivity.quiet_end);
  const quiet = quietFrom !== null && quietTo !== null ? { start: quietFrom, end: quietTo } : null;
  return <>
    <section className="tile chart reveal" style={{ '--i': 0 } as React.CSSProperties} aria-labelledby="day-title">
      <div className="chart-head"><h2 id="day-title">The Brief, Check-in &amp; Close</h2><span className="legend">{quiet && <><i className="swatch"/>Quiet hours</>}</span></div>
      <DayRail marks={marks} now={now} quiet={quiet} summary={`${record.data.date}, ${record.data.timezone}. ${marks.map(mark => `${mark.label} ${mark.kind === 'done' ? 'sent, as recorded,' : 'scheduled'} at ${mark.time}.`).join(' ')}${quiet ? ` Quiet from ${record.data.proactivity.quiet_start} to ${record.data.proactivity.quiet_end}.` : ''}`}/>
      <p className="meta">{record.data.date} · {record.data.timezone}. Set today’s timing, or pin a time to keep every day.</p>
    </section>
    <div className="tile disclosures reveal" style={{ '--i': 1 } as React.CSSProperties}>{record.data.cards.map(card => <CardTiming key={`${record.revision}:${card.id}`} card={card} busy={busy} onAction={onAction}/>)}</div>
    {!record.data.cards.length && <section className="panel"><h2>No day cards.</h2><p>This read returned nothing to edit. It doesn’t show Brief or Close content.</p></section>}
    <div className="tile disclosures reveal" style={{ '--i': 2 } as React.CSSProperties}>
    <details name="day-settings" className="disclosure"><summary><Icon name="sun"/><span className="label key">Time zone</span><span className="value">{record.data.timezone}</span></summary><div className="disclosure-body"><p>Cards and reminders follow it. Update it when you travel.</p>
      <form className="control-form" onSubmit={event => { event.preventDefault(); onAction('timezone.set', { value: timezone }); }}>
        <label>Time zone<input required autoComplete="off" value={timezone} disabled={busy} onChange={event => setTimezone(event.target.value)}/></label>
        <div className="control-actions"><button disabled={busy} type="button" onClick={() => setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)}>Use this device</button><button className="primary" disabled={busy}>Save time zone</button></div>
      </form>
    </div></details>
    <details name="day-settings" className="disclosure"><summary><Icon name="moon"/><span className="label key">Quiet hours</span><span className="value">{record.data.proactivity.quiet_start && record.data.proactivity.quiet_end ? `${record.data.proactivity.quiet_start}–${record.data.proactivity.quiet_end}` : 'None'} · {record.data.proactivity.volume} volume</span></summary><div className="disclosure-body"><p>Waldo holds cards, updates and event briefs during quiet hours. Reminders you set still fire. Leave both empty for none.</p>
      <form className="control-form" onSubmit={event => { event.preventDefault(); onAction('proactivity.set', { quiet_start: quietStart, quiet_end: quietEnd, volume }); }}>
        <div className="control-fields"><label>Quiet from<input type="time" value={quietStart} disabled={busy} onChange={event => setQuietStart(event.target.value)}/></label><label>Quiet until<input type="time" value={quietEnd} disabled={busy} onChange={event => setQuietEnd(event.target.value)}/></label></div>
        <label>Volume<select value={volume} disabled={busy} onChange={event => setVolume(event.target.value as typeof volume)}><option value="low">Low: only the three day cards</option><option value="normal">Normal: plus updates that change your day</option><option value="high">High: plus smaller useful updates</option></select></label><button className="primary" disabled={busy}>Save quiet hours &amp; volume</button>
      </form>
    </div></details>
    </div>
    <p className="caption">These cards run in chat. Their content and verified Close results aren’t shown here.</p>
  </>;
}

export function ConnectionsControls({ record, busy, onAction, section }: { record: ConnectionsRecord; section?: 'connections'|'sessions' } & ActionProps) {
  const { google, telegram, sessions } = record.data;
  return <>
    {section!=='sessions'&&<section className="tile reveal" style={{ '--i': 0 } as React.CSSProperties} aria-labelledby="tree-title">
      <div className="chart-head"><h2 id="tree-title">Connected to Waldo</h2><span className="legend"><i className="line"/>Access saved<i className="line dashed"/>Needs you</span></div>
      <div className="with-figure"><div className="tree">
        <div className="tree-root"><span className="root-mark" aria-hidden="true"/>Waldo</div>
        <p className="tree-group label">Google accounts</p>
        <ul>{google.accounts.map(account => { const broken = account.health === 'needs_reconnect'; return <li key={account.id} className={`branch${broken ? ' broken' : ''}`}>
          <details name="connections" className="disclosure control-account"><summary>
            <span className="marks">{account.calendar && <Logo name="googleCalendar"/>}{account.mail && <Logo name="gmail"/>}{account.tasks && <Icon name="checklist"/>}</span>
            <span className="value">{account.email}</span><span className={`access-label${broken ? ' reconnect' : ''}`}>{broken ? 'Reconnect needed' : 'Access granted · read unverified'}</span></summary>
            <div className="disclosure-body">
              <ul className="grant-list">{[account.calendar ? 'Calendar' : null, account.mail ? 'Gmail' : null, account.tasks ? 'Tasks' : null].filter(Boolean).map(grant => <li key={grant}>{grant}</li>)}</ul>
              {![account.calendar, account.mail, account.tasks].some(Boolean) && <p>No service grants recorded for this account.</p>}
              <p className="meta">Saved access is permission, not proof that a live Calendar, Gmail or Tasks request worked.</p>
              {broken && <p>Reconnect and choose {account.email} in Google to refresh this account’s access.</p>}
              <div className="control-actions">{broken && google.connectAvailable && <button className="primary" disabled={busy} onClick={() => onAction('google.connect', { value: 'calendar' })}>Reconnect {account.email}</button>}
                <button disabled={busy} onClick={() => { if (window.confirm(`Disconnect ${account.email}? Waldo loses this Google access.`)) onAction('google.disconnect', { id: account.id }); }}>Disconnect {account.email}</button></div>
            </div></details></li>; })}
          {!google.accounts.length && <li className="branch broken"><p className="empty-line">No Google accounts returned.</p></li>}
        </ul>
        <p className="tree-group label">Chat</p>
        <ul><li className={`branch${telegram.linked ? '' : ' broken'}`}><details name="connections" className="disclosure"><summary><span className="marks"><Logo name="telegram"/></span><span className="value">Telegram</span><span className={`access-label${telegram.linked ? '' : ' reconnect'}`}>{telegram.linked ? 'Linked' : 'Unlinked'}</span></summary>
          <div className="disclosure-body"><p>Chat, cards and reminders arrive in your Telegram DM. Instructions appear here once you ask to link.</p>
            <div className="control-actions"><button disabled={busy} onClick={() => onAction('telegram.link')}>Link a Telegram account</button>{telegram.linked && telegram.unlinkAvailable && <button disabled={busy} onClick={() => { if (window.confirm('Unlink Telegram? Waldo stops messaging it. Sign in with your email to link again.')) onAction('telegram.unlink'); }}>Unlink Telegram</button>}</div></div></details></li></ul>
      </div><Patch className="figure" label="A patch panel of ports, an interactive illustration. Decorative."/></div>
      <div className="control-actions">{google.connectAvailable ? <button className="primary" disabled={busy} onClick={() => onAction('google.connect', { value: 'calendar' })}>{google.accounts.length ? 'Add Google account' : 'Connect Google'}</button> : <p className="meta">Google connection is unavailable on this server.</p>}</div>
      <p className="meta">Google asks for its usual scopes together and lets you pick the account. Mail sends still need your exact approval in chat.</p>
    </section>}
    {section!=='connections'&&<section className="tile reveal" style={{ '--i': 1 } as React.CSSProperties}><div className="chart-head"><h2>Console sessions</h2></div><p>{sessions.count} active {sessions.count === 1 ? 'browser session' : 'browser sessions'} recorded. This session is valid until {sessions.until}.</p>
      <ul className="session-list">{sessions.items.map((item, index) => <li key={index}><span className="strong">{item.current ? 'This browser' : 'Another browser'}</span> · Signed in {item.signed_in}, valid until {item.until}</li>)}</ul>
      <p className="meta">Device names are not recorded, only when each browser signed in. Signing out of one browser isn’t offered here.</p>
      <div className="control-actions"><button disabled={busy} onClick={() => onAction('session.signout')}>Sign out of this browser</button>{sessions.count > 1 && <button disabled={busy} onClick={() => { if (window.confirm('Sign out of every browser?')) onAction('session.signout.all'); }}>Sign out everywhere</button>}</div>
    </section>}
  </>;
}

export function ControlsFeedback({ state, onRefresh }: { state: Exclude<ControlsState, { kind: 'ready' }>; onRefresh: () => void }) {
  if (state.kind === 'loading') return <div role="status" className="skeleton-block"><span className="visually-hidden">Loading your controls…</span><i className="sk sk-card"/><i className="sk sk-rows"/></div>;
  return <section className="panel" role="alert"><h2>{state.signedOut ? 'Sign in to your Waldo.' : 'Controls unavailable.'}</h2><p>{state.message}</p>{state.signedOut ? <a href="/console/signin">Sign in</a> : <button onClick={onRefresh}>Retry read</button>}</section>;
}

export function ControlReceipt({ result, onCheck, onRefresh, busy }: { result: ActionResult; onCheck?: () => void; onRefresh: () => void; busy: boolean }) {
  const { receipt } = result;
  return <section className={`panel control-receipt ${receipt.state}`} role={receipt.state === 'recorded' ? 'status' : 'alert'}>
    <span className="receipt-mark" aria-hidden="true">{receipt.state === 'recorded' ? <svg viewBox="0 0 24 24"><path d="m6 12.5 4 4 8-9"/></svg> : <Icon name="warning"/>}</span>
    <h2>{receipt.signed_out ? 'Signed out.' : receipt.state === 'recorded' ? 'Receipt recorded.' : receipt.state === 'incomplete' ? 'Change incomplete.' : receipt.state === 'rejected' ? 'Change not applied.' : 'Outcome unconfirmed.'}</h2>
    <p className="control-receipt-message">{receipt.message}</p>{result.duplicate && <p className="muted">This is the recorded receipt for the same request. It did not run again.</p>}
    {receipt.navigation && <a className="button-link" href={receipt.navigation}>Continue to Google</a>}
    {receipt.signed_out ? <a href="/console/signin">Sign in again</a> : <div className="control-actions">{onCheck && <button disabled={busy} onClick={onCheck}>Check this request</button>}<button disabled={busy} onClick={onRefresh}>Refresh controls</button></div>}
  </section>;
}

type Attempt = { record: ControlRecord; action: ControlAction; fields: ControlFields; id: string };
const headings: Record<ControlsView, { title: string; description: string }> = {
  day: { title: 'Your day.', description: 'When Waldo reaches you, and what he holds back.' },
  connections: { title: 'Connections.', description: 'The accounts and channels Waldo can use.' },
  waiting: { title: 'Waiting.', description: 'Read each one in full before you decide. Sends are approved in chat, on the exact card.' },
  activity: { title: 'Patrol.', description: 'What Waldo has done, as recorded. A recorded attempt isn’t a verified result.' },
  profile: { title: 'Profile.', description: 'The saved context behind your Waldo.' },
  setup: { title: 'Setup.', description: 'What’s saved so far, and what’s left.' },
  usage: { title: 'Usage.', description: 'Model calls and their recorded cost estimates.' },
  files: { title: 'Files.', description: 'What you’ve sent Waldo.' },
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
    {!embedded&&<div className="page-heading"><h1>{heading.title}</h1><p>{heading.description}</p></div>}
    <div className="tools"><button className="quiet" disabled={busy} onClick={refresh}>Refresh</button></div>
    {result && <ControlReceipt result={result} onCheck={result.receipt.state === 'unconfirmed' ? check : undefined} onRefresh={refresh} busy={busy}/>}
    {error && <section className="panel" role="alert"><h2>{error.uncertain ? 'Outcome unavailable.' : 'Review the controls again.'}</h2><p>{error.message}</p>{error.signedOut ? <a href="/console/signin">Sign in</a> : <div className="control-actions">{error.uncertain && <button disabled={busy} onClick={check}>Check this request</button>}<button disabled={busy} onClick={refresh}>Refresh controls</button></div>}</section>}
    {state.kind !== 'ready' ? <ControlsFeedback state={state} onRefresh={refresh}/> : <div className="controls-stack" key={`${state.data.view}:${state.data.revision}`}>{content}</div>}
  </>;
}
