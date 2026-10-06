import {activityLabel,missingOutcome} from './activity-labels';
import {MemoryActions} from './MemoryActions';
import {useState} from 'react';
import {Icon,Logo,type IconName} from './icons';
import {Pipeline,PulseStrip} from './Infographics';
import {Terminal} from '@lucasmarkes/hairline/react';
import {ProfileCards} from './Profile';
import type { ActivityCursors, ActivityRecord, ControlAction, ControlFields, FilesRecord, ProfileRecord, ProposalReview, SetupRecord, UsageRecord, WaitingRecord } from './controls-model';

type Actions = { busy: boolean; onAction: (action: ControlAction, fields?: ControlFields) => void };
const parseTime = (value: string | null) => { if (!value) return null; const t = Date.parse(value.includes('T') ? value : value.replace(' ', 'T')); return Number.isNaN(t) ? null : new Date(t); };
const clock = (d: Date) => new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(d);
const day = (d: Date) => new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
const hours = (d: Date) => d.getHours() + d.getMinutes() / 60;

// Copies the exact draft words, for reading or pasting elsewhere. It does not send anything.
function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className={`quiet copy${copied ? ' done' : ''}`} onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }); }}>{copied ? 'Copied' : 'Copy text'}</button>;
}

/** The change as one sentence, and the slot drawn on that day's hours. */
function CalendarReview({ review }: { review: Extract<ProposalReview, { kind: 'calendar_change' }> }) {
  const start = parseTime(review.start), end = parseTime(review.end);
  const verb = { create: 'Add', move: 'Move', cancel: 'Cancel' }[review.action];
  const from = start ? Math.max(0, Math.floor(hours(start)) - 2) : 0, to = start ? Math.min(24, Math.ceil(end ? hours(end) : hours(start) + 1) + 2) : 0;
  const pct = (d: Date) => ((hours(d) - from) / (to - from)) * 100;
  return <div className="proposal-full-review review-calendar" title={review.event_id ? `Calendar reference ${review.event_id}` : undefined}>
    <p className="review-sentence"><b>{verb}</b> {review.title ?? 'this event'}{start && <>{review.action === 'move' ? ' to ' : ' on '}<b>{day(start)}, {clock(start)}{end ? `–${clock(end)}` : ''}</b></>}.</p>
    {start && <div className={`slot-day ${review.action}`} aria-hidden="true">
      <div className="slot-hours">{Array.from({ length: to - from + 1 }, (_, i) => <span key={i} style={{ left: `${(i / (to - from)) * 100}%` }}>{i % 2 === 0 ? clock(new Date(2000, 0, 1, from + i)).replace(':00', '') : ''}</span>)}</div>
      <div className="slot-track"><i className="slot" style={{ left: `${pct(start)}%`, width: `${Math.max(3, (end ? pct(end) : pct(start) + 4) - pct(start))}%` }}><b>{review.title ?? verb}</b></i></div>
    </div>}
    <p className="review-why"><Icon name="chat"/><span><b>Why:</b> {review.reason}</span></p>
  </div>;
}

function Review({ review }: { review: ProposalReview }) {
  if (review.kind === 'email_send') {
    const people = (label: string, list: string[]) => list.length > 0 && <div className="letter-row"><span className="label">{label}</span>{list.map(address => <span className="person" key={address}><i aria-hidden="true">{address.charAt(0).toUpperCase()}</i>{address}</span>)}</div>;
    return <div className="proposal-full-review letter">{people('To', review.to)}{people('Cc', review.cc)}{people('Bcc', review.bcc)}<p className="letter-subject">{review.subject}</p><pre className="owner-record-text letter-body">{review.body}</pre><CopyText text={review.body}/></div>;
  }
  if (review.kind === 'message_send') return <div className="proposal-full-review chat-preview"><span className="channel">{review.channel.toLowerCase() === 'telegram' ? <Logo name="telegram"/> : <Icon name="paperplane"/>}To your {review.channel} chat</span><p className="bubble">{review.content}</p><CopyText text={review.content}/></div>;
  return <CalendarReview review={review}/>;
}

const KindMark = ({ item }: { item: WaitingRecord['data']['proposals'][number] }) =>
  item.review?.kind === 'message_send' && item.review.channel.toLowerCase() === 'telegram' ? <Logo name="telegram"/>
    : <Icon name={item.kind === 'calendar_change' ? 'calendar' : item.kind === 'email_send' ? 'envelope' : item.kind === 'message_send' ? 'paperplane' : 'entry'}/>;

export function WaitingControls({ record, busy, onAction }: { record: WaitingRecord } & Actions) {
  const first = Math.max(0, record.data.proposals.findIndex(item => item.state === 'open'));
  return <>
    <div className="proposal-list">{record.data.proposals.map((item, index) => {
      const send = item.kind === 'email_send' || item.kind === 'message_send';
      const calendarApprove = item.kind === 'calendar_change' && item.state === 'open' && item.review?.kind === 'calendar_change' && item.actions.includes('approval.approve');
      const calendarUndo = item.kind === 'calendar_change' && item.state === 'done' && item.actions.includes('approval.undo');
      const note = item.state === 'review_only' ? 'Too long for a chat card, so there’s no Send it button. Ask Waldo for a shorter version or a draft.'
        : item.state === 'unconfirmed' ? 'Waldo couldn’t confirm the review card was delivered, so this can’t be approved. Check chat, then ask again.'
          : send && item.state === 'open' ? 'Approve on its review card in chat, after checking sender, recipient and words. Dismissing here only stops the send.'
            : item.state === 'open' && item.kind === 'calendar_change' ? 'Want it changed? Ask Waldo for a new proposal before approving.' : null;
      return <details name="proposals" open={index === first} className="tile disclosure proposal-detail reveal" style={{ '--i': index } as React.CSSProperties} key={item.id}>
        <summary><span className="kind"><KindMark item={item}/></span><span className="value proposal-summary">{item.summary}</span><span className={`access-label${item.state === 'open' ? ' needs' : ''}`}>{item.state === 'open' ? 'Needs you' : item.state === 'review_only' ? 'Too long to approve' : item.state === 'unconfirmed' ? 'Card unconfirmed' : 'Decision recorded'}</span></summary>
        <div className="disclosure-body">
          {item.review ? <Review review={item.review}/> : <p>Full details aren’t available for this one. Ask Waldo to show them before you decide.</p>}
          {note && <p className="meta">{note}</p>}
          <div className="control-actions">
            {calendarApprove && <button className="primary" disabled={busy} onClick={() => onAction('approval.approve', { id: item.id })}>Approve this calendar change</button>}
            {item.actions.includes('approval.skip') && <button disabled={busy} onClick={() => onAction('approval.skip', { id: item.id })}>{send ? 'Dismiss proposal' : 'Not now'}</button>}
            {calendarUndo && <button disabled={busy} onClick={() => { if (window.confirm('Undo this calendar change?')) onAction('approval.undo', { id: item.id }); }}>Undo calendar change</button>}
          </div>
        </div>
      </details>;
    })}</div>
    {!record.data.proposals.length && <section className="tile empty"><h2>Nothing waiting.</h2><p>This read returned no proposals. It isn’t a full history of decisions.</p></section>}
    {record.data.proposals.length > 0 && <p className="caption">Showing what this read returned. A recorded decision doesn’t verify its outcome.</p>}
  </>;
}

export function activityPageCursors(page: ActivityRecord['data']['page'], list: 'trace' | 'runs', older: boolean): ActivityCursors {
  return list === 'trace' ? { trace_before: older ? page.trace_before : null, runs_before: page.runs_applied }
    : { runs_before: older ? page.runs_before : null, trace_before: page.trace_applied };
}
const stamp = (value: string) => { const t = Date.parse(value.includes('T') ? value : value.replace(' ', 'T')); return Number.isNaN(t) ? value : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(t)); };
const took = (ms: number) => ms < 1000 ? 'under a second' : `${(ms / 1000).toFixed(1)} seconds`;
const kindIcon = (kind: string): IconName => ({ update_card: 'brief', reminder: 'bell', llm_reply: 'chat', joined_path: 'chat', heartbeat: 'patrol', patrol_skip: 'patrol' } as Record<string, IconName>)[kind] ?? 'entry';
export function ActivityControls({ record, busy, onPage }: { record: ActivityRecord; busy: boolean; onPage: (page: ActivityCursors) => void }) {
  const { trace, runs, steps, page, ledger } = record.data;
  const firstFailure = trace.findIndex(row => !row.ok);
  const [selected, setSelected] = useState<number | null>(trace.length ? (firstFailure >= 0 ? firstFailure : 0) : null);
  return <>
    {trace.length > 0 && <section className="tile chart reveal" style={{ '--i': 0 } as React.CSSProperties} aria-labelledby="pulse-title">
      <div className="with-figure"><div>
      <div className="chart-head"><h2 id="pulse-title">Recent attempts</h2><span className="legend"><i className="dot"/>Recorded<i className="dot failed"/>Failed</span></div>
      <PulseStrip items={trace.map(row => ({ label: activityLabel(row.hop), time: stamp(row.time), ms: row.ms, ok: row.ok }))} selected={selected} onSelect={setSelected}/>
      <div className="chart-axis" aria-hidden="true"><span>Older</span><span>Latest</span></div>
      </div><Terminal className="figure" label="A terminal window, an interactive illustration. Decorative."/></div>
    </section>}
    {steps.length > 0 && <section className="tile chart reveal" style={{ '--i': 1 } as React.CSSProperties} aria-labelledby="steps-title">
      <div className="chart-head"><h2 id="steps-title">The last request, step by step</h2></div>
      <Pipeline steps={steps}/>
      <p className="meta">Observed pipeline steps. Saved permission alone isn’t a successful live tool test.</p>
    </section>}
    <div className="tile disclosures reveal" style={{ '--i': 2 } as React.CSSProperties}>
      <h2 className="visually-hidden">Recent recorded activity</h2>
      {trace.map((row, index) => <details key={index} className="disclosure activity-record" open={selected === index} onToggle={event => { const open = event.currentTarget.open; setSelected(current => open ? index : current === index ? null : current); }}>
        <summary title={`Recorded type: ${row.hop}`}><Icon name={kindIcon(row.hop)}/><span className="value">{activityLabel(row.hop)}</span><span className={`access-label${row.ok ? '' : ' failed'}`}>{row.ok ? 'Attempt recorded' : 'Failure recorded'}</span><span className="label time">{stamp(row.time)}</span></summary>
        <div className="disclosure-body"><p>{row.summary?.trim()?row.summary:missingOutcome}</p><p className="meta">Took {took(row.ms)}</p></div>
      </details>)}
      {!trace.length && <p className="empty-line">No activity records on this page.</p>}
      <nav className="table-pager" aria-label="Activity pages"><button disabled={busy || page.trace_applied === null} onClick={() => onPage(activityPageCursors(page, 'trace', false))}>Latest activity</button><button disabled={busy || page.trace_before === null} onClick={() => onPage(activityPageCursors(page, 'trace', true))}>Older activity</button></nav>
    </div>
    <details className="tile fold reveal" style={{ '--i': 3 } as React.CSSProperties}><summary><Icon name="patrol"/>Background checks <span className="count">{runs.length}</span></summary>
      <div className="activity-record-list">{runs.map(run => <article key={run.id} className="activity-record"><div className="connection-heading"><p className="strong">{activityLabel(run.kind)}</p><span className="access-label">Recorded status: {run.status}</span></div><p>{run.summary?.trim()?run.summary:missingOutcome}</p><p className="meta" title={`Recorded type: ${run.kind}`}>Started {stamp(run.started)} · {run.ended === null ? 'no end recorded' : `ended ${stamp(run.ended)}`}</p></article>)}</div>{!runs.length && <p>No background runs on this page.</p>}
      <nav className="table-pager" aria-label="Background run pages"><button disabled={busy || page.runs_applied === null} onClick={() => onPage(activityPageCursors(page, 'runs', false))}>Latest runs</button><button disabled={busy || page.runs_before === null} onClick={() => onPage(activityPageCursors(page, 'runs', true))}>Older runs</button></nav>
    </details>
    <details className="tile fold reveal" style={{ '--i': 4 } as React.CSSProperties}><summary><Icon name="bell"/>Reminders &amp; notes</summary>
      <pre className="owner-record-text">{ledger}</pre><p className="meta">The existing recorded ledger, not a complete commitments product.</p></details>
    <p className="caption">One page of recent records, not a full history. A completed attempt doesn’t by itself verify its result.</p>
  </>;
}

export function ProfileControls({ record }: { record: ProfileRecord }) {
  const { sections, removal, barriers, holds } = record.data;
  return <>
    <p className="meta">From saved context. Corrections go through chat.</p>
    {removal.state === 'incomplete' && <section className="panel" role="alert"><h2>Removal incomplete.</h2><p>{removal.pending_count} removal {removal.pending_count === 1 ? 'item is' : 'items are'} still pending. Profile text is withheld while removal is incomplete; this is not an empty Profile or proof that retained text was purged.</p>{removal.items?.map((item,i)=><details key={item.id}><summary>Removal {i+1} · retry controls</summary><MemoryActions id={item.id}/></details>)}{!removal.items?.length&&<p>No retry target is available in this read. Ask Waldo in chat to inspect the incomplete removal; this dashboard cannot invent a target.</p>}</section>}
    {sections.length > 0 && <ProfileCards sections={sections}/>}
    {!sections.length && removal.state !== 'incomplete' && <section className="panel"><h2>No profile sections returned.</h2><p>This read contains no saved profile sections.</p></section>}
    <p className="caption">{barriers} recorded do-not-relearn {barriers === 1 ? 'note' : 'notes'} from things you asked Waldo to forget. This count does not certify complete removal.</p>
    {holds.length > 0 && <section className="panel"><h2>Held at the memory gate</h2><p>Only recorded kinds, reasons and dates are shown here. These notes do not contain the refused words.</p>{holds.map((hold, index) => <article className="activity-record" key={index}><h3>{hold.kind}</h3><p>{hold.reason}</p><p className="meta">{hold.created_at}</p></article>)}</section>}
  </>;
}

export function SetupControls({ record }: { record: SetupRecord }) {
  const items = [
    { title: 'Link Telegram', recorded: record.data.telegram_linked, href: '#/connections', description: 'Link your owner DM so chat, cards and reminders reach the right account.' },
    { title: 'Connect Google', recorded: record.data.google_access_granted, href: '#/connections', description: 'Saved grants are access permission. Check an actual Calendar or Gmail request in chat to verify a live read.' },
    { title: 'Set quiet hours', recorded: record.data.quiet_hours_set, href: '#/day', description: 'Choose when Waldo holds cards and updates. Reminders you set still fire.' },
  ];
  return <section className="panel"><h2>Setup</h2>{items.map(item => <article className="control-row" key={item.title}><div><h3>{item.title}</h3><p>{item.description}</p><span className="access-label">{item.recorded ? 'Setting recorded' : 'To do'}</span></div><a href={item.href}>Manage {item.title.toLowerCase()}</a></article>)}</section>;
}

export function UsageControls({ record }: { record: UsageRecord }) {
  const total = record.data.rows.reduce((sum, row) => sum + row.usd, 0);
  const top = Math.max(...record.data.rows.map(row => row.usd), 0);
  return <section className="panel chart"><div className="chart-head"><h2>What Waldo’s thinking cost</h2><span className="legend">${total.toFixed(4)} total</span></div>
    <p className="meta">Waldo’s recorded estimates, not verified provider billing.</p>
    <ul className="usage-bars">{record.data.rows.map((row, index) => <li key={index} style={{ '--i': index } as React.CSSProperties}><span className="usage-name">{row.model}</span><span className="usage-track"><i style={{ width: `${top ? Math.max(2, (row.usd / top) * 100) : 0}%` }}/></span><span className="usage-value">${row.usd.toFixed(4)}<small>{row.calls} {row.calls === 1 ? 'call' : 'calls'}</small></span></li>)}</ul>
    {!record.data.rows.length && <p>No model usage rows returned.</p>}
    <details className="fold-inline"><summary>Token breakdown</summary><div className="table-scroll" tabIndex={0} role="region" aria-label="Model usage records"><table><thead><tr>{['Model', 'Calls', 'Input tokens', 'Cached tokens', 'Output tokens', 'Estimated cost'].map(name => <th scope="col" key={name}>{name}</th>)}</tr></thead><tbody>{record.data.rows.map((row, index) => <tr key={index}><td>{row.model}</td><td>{row.calls}</td><td>{row.input}</td><td>{row.cached}</td><td>{row.output}</td><td>${row.usd.toFixed(4)}</td></tr>)}</tbody></table></div></details>
  </section>;
}

export function FilesControls({ record, busy, onAction }: { record: FilesRecord } & Actions) {
  return <><p>These are Telegram-hosted references, not private retained workspace storage. Opening a reference uses the existing authenticated download route.</p><div className="file-reference-list">{record.data.items.map(file => <section className="panel" key={file.id}><h2>{file.name}</h2><p className="meta">{file.kind} · {file.size === null ? 'Size unavailable' : `${file.size} bytes`}</p>{file.caption && <p>{file.caption}</p>}<div className="control-actions"><a className="button-link" href={`/console/file?${new URLSearchParams({ id: String(file.id) })}`}>Open {file.name}</a><button disabled={busy} onClick={() => { if (window.confirm(`Remove ${file.name} from this list? It stays stored with Telegram.`)) onAction('file.remove', { id: String(file.id) }); }}>Remove {file.name} from list</button></div></section>)}</div>{!record.data.items.length && <section className="panel"><h2>No Telegram references returned.</h2><p>This is the returned reference list, not proof that no files exist elsewhere.</p></section>}<p className="meta">Removing a reference does not purge Telegram bytes or other retained workspace copies. Sharing is unavailable here. The private workspace console is a separate surface.</p></>;
}
