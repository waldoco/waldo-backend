import {MemoryActions} from './MemoryActions';
import type { ActivityCursors, ActivityRecord, ControlAction, ControlFields, FilesRecord, ProfileRecord, ProposalReview, SetupRecord, UsageRecord, WaitingRecord } from './controls-model';

type Actions = { busy: boolean; onAction: (action: ControlAction, fields?: ControlFields) => void };
function Review({ review }: { review: ProposalReview }) {
  if (review.kind === 'email_send') return <div className="proposal-full-review"><dl><dt>To</dt><dd>{review.to.join(', ')}</dd>{review.cc.length > 0 && <><dt>CC</dt><dd>{review.cc.join(', ')}</dd></>}{review.bcc.length > 0 && <><dt>BCC</dt><dd>{review.bcc.join(', ')}</dd></>}<dt>Subject</dt><dd>{review.subject}</dd></dl><pre className="owner-record-text">{review.body}</pre></div>;
  if (review.kind === 'message_send') return <div className="proposal-full-review"><p>Channel: {review.channel}</p><pre className="owner-record-text">{review.content}</pre></div>;
  return <div className="proposal-full-review"><dl><dt>Action</dt><dd>{review.action}</dd>{review.title && <><dt>Event</dt><dd>{review.title}</dd></>}{review.event_id && <><dt>Event ID</dt><dd>{review.event_id}</dd></>}{review.start && <><dt>Start</dt><dd>{review.start}</dd></>}{review.end && <><dt>End</dt><dd>{review.end}</dd></>}<dt>Reason</dt><dd>{review.reason}</dd></dl></div>;
}

export function WaitingControls({ record, busy, onAction }: { record: WaitingRecord } & Actions) {
  return <>
    <p className="muted">These are the proposals returned by this read. A recorded decision does not verify its external result.</p>
    <div className="proposal-list">{record.data.proposals.map(item => {
      const send = item.kind === 'email_send' || item.kind === 'message_send';
      const calendarApprove = item.kind === 'calendar_change' && item.state === 'open' && item.review?.kind === 'calendar_change' && item.actions.includes('approval.approve');
      const calendarUndo = item.kind === 'calendar_change' && item.state === 'done' && item.actions.includes('approval.undo');
      return <section className="panel proposal-detail" key={item.id}>
        <div className="connection-heading"><h2>{item.kind === 'calendar_change' ? 'Calendar adjustment' : item.kind === 'email_send' ? 'Email proposal' : item.kind === 'message_send' ? 'Message proposal' : 'Proposed action'}</h2><span className="access-label">{item.state === 'open' ? 'Waiting on you' : item.state === 'review_only' ? 'Too long to approve' : item.state === 'unconfirmed' ? 'Card unconfirmed' : 'Decision recorded'}</span></div>
        <p className="proposal-summary">{item.summary}</p>
        {item.review ? <details open className="proposal-review-details"><summary>Full recorded proposal</summary><Review review={item.review}/></details> : <p>Full review details are unavailable for this proposal. Ask Waldo to show them before deciding.</p>}
        {item.state === 'review_only' ? <p>The full email did not fit in the chat card, so no Send it button was offered. Ask for a shorter version or a draft to review.</p>
          : item.state === 'unconfirmed' ? <p>Review card delivery was not confirmed. This proposal cannot be approved here or in chat. Check chat before making a fresh request.</p>
            : send && item.state === 'open' ? <p>Approve a send only on its exact review card in chat, after reviewing the sender, recipient and words. Dismissal here only prevents the proposed send.</p> : null}
        {(item.state === 'open' || item.state === 'review_only') && (send || item.kind === 'calendar_change') && <p className="muted">Want to change it? Ask Waldo to prepare a new proposal before approving.</p>}
        <div className="control-actions">
          {calendarApprove && <button disabled={busy} onClick={() => onAction('approval.approve', { id: item.id })}>Approve this calendar change</button>}
          {item.actions.includes('approval.skip') && <button disabled={busy} onClick={() => onAction('approval.skip', { id: item.id })}>{send ? 'Dismiss proposal' : 'Not now'}</button>}
          {calendarUndo && <button disabled={busy} onClick={() => { if (window.confirm('Undo this calendar change?')) onAction('approval.undo', { id: item.id }); }}>Undo calendar change</button>}
        </div>
      </section>;
    })}</div>
    {!record.data.proposals.length && <section className="panel"><h2>No proposals returned.</h2><p>This read contains no waiting proposals or supported recent undo items. It is not a complete history of decisions.</p></section>}
  </>;
}

export function activityPageCursors(page: ActivityRecord['data']['page'], list: 'trace' | 'runs', older: boolean): ActivityCursors {
  return list === 'trace' ? { trace_before: older ? page.trace_before : null, runs_before: page.runs_applied }
    : { runs_before: older ? page.runs_before : null, trace_before: page.trace_applied };
}
export function ActivityControls({ record, busy, onPage }: { record: ActivityRecord; busy: boolean; onPage: (page: ActivityCursors) => void }) {
  const { trace, runs, steps, page, ledger } = record.data;
  return <>
    <p className="muted">Recorded attempts, reasons and outcomes on this page. A completed attempt does not by itself verify its result. Older records may be on another page; this is not a full activity history.</p>
    <section className="panel"><h2>Recent recorded activity</h2><div className="activity-record-list">{trace.map((row, index) => <article key={index} className="activity-record"><div className="connection-heading"><h3>{row.hop}</h3><span className="access-label">{row.ok ? 'Attempt recorded' : 'Failure recorded'}</span></div><p>{row.summary ?? 'No reason or outcome summary recorded.'}</p><p className="muted">{row.time} · {row.ms} ms</p></article>)}</div>{!trace.length && <p>No activity records returned on this page.</p>}
      <nav className="table-pager" aria-label="Activity pages"><button disabled={busy || page.trace_applied === null} onClick={() => onPage(activityPageCursors(page, 'trace', false))}>Latest activity</button><button disabled={busy || page.trace_before === null} onClick={() => onPage(activityPageCursors(page, 'trace', true))}>Older activity</button></nav>
    </section>
    <section className="panel"><h2>Background runs</h2><div className="activity-record-list">{runs.map(run => <article key={run.id} className="activity-record"><div className="connection-heading"><h3>{run.kind}</h3><span className="access-label">Recorded status: {run.status}</span></div><p>{run.summary ?? 'No result summary recorded.'}</p><p className="muted">Started {run.started} · {run.ended === null ? 'No end recorded' : `Ended ${run.ended}`}</p></article>)}</div>{!runs.length && <p>No background runs returned on this page.</p>}
      <nav className="table-pager" aria-label="Background run pages"><button disabled={busy || page.runs_applied === null} onClick={() => onPage(activityPageCursors(page, 'runs', false))}>Latest runs</button><button disabled={busy || page.runs_before === null} onClick={() => onPage(activityPageCursors(page, 'runs', true))}>Older runs</button></nav>
    </section>
    <section className="panel"><h2>Recorded end-to-end steps</h2><p>These checks show observed pipeline steps. Saved permission alone is not a successful live tool test.</p>{steps.map((step, index) => <article key={index} className="activity-record"><h3>{step.step}</h3><p>{step.state === 'unseen' ? 'Not seen yet' : step.state === 'failed' ? 'Failure recorded' : 'Successful step recorded'}{step.at ? ` · ${step.at}` : ''}</p>{step.note && <p className="muted">{step.note}</p>}</article>)}</section>
    <section className="panel"><h2>Ledger &amp; reminders</h2><pre className="owner-record-text">{ledger}</pre><p className="muted">This is the existing recorded ledger, not a complete commitments product or a target to resume work.</p></section>
  </>;
}

export function ProfileControls({ record }: { record: ProfileRecord }) {
  const { sections, removal, barriers, holds } = record.data;
  return <>
    <p>Profile sections come from saved context. Corrections currently go through chat.</p>
    {removal.state === 'incomplete' && <section className="panel" role="alert"><h2>Removal incomplete.</h2><p>{removal.pending_count} removal {removal.pending_count === 1 ? 'item is' : 'items are'} still pending. Profile text is withheld while removal is incomplete; this is not an empty Profile or proof that retained text was purged.</p>{removal.items?.map((item,i)=><details key={item.id}><summary>Removal {i+1} · retry controls</summary><MemoryActions id={item.id}/></details>)}{!removal.items?.length&&<p>No retry target is available in this read. Ask Waldo in chat to inspect the incomplete removal; this dashboard cannot invent a target.</p>}</section>}
    <div className="controls-card-list">{sections.map((section, index) => <section className="panel" key={index}><h2>{section.title}</h2><pre className="owner-record-text">{section.lines.join('\n')}</pre></section>)}</div>
    {!sections.length && removal.state !== 'incomplete' && <section className="panel"><h2>No profile sections returned.</h2><p>This read contains no saved profile sections.</p></section>}
    <p className="muted">{barriers} recorded do-not-relearn {barriers === 1 ? 'note' : 'notes'} from things you asked Waldo to forget. This count does not certify complete removal.</p>
    {holds.length > 0 && <section className="panel"><h2>Held at the memory gate</h2><p>Only recorded kinds, reasons and dates are shown here. These notes do not contain the refused words.</p>{holds.map((hold, index) => <article className="activity-record" key={index}><h3>{hold.kind}</h3><p>{hold.reason}</p><p className="muted">{hold.created_at}</p></article>)}</section>}
  </>;
}

export function SetupControls({ record }: { record: SetupRecord }) {
  const items = [
    { title: 'Link Telegram', recorded: record.data.telegram_linked, href: '#/connections', description: 'Link your owner DM so chat, cards and reminders reach the right account.' },
    { title: 'Connect Google', recorded: record.data.google_access_granted, href: '#/connections', description: 'Saved grants are access permission. Check an actual Calendar or Gmail request in chat to verify a live read.' },
    { title: 'Set quiet hours', recorded: record.data.quiet_hours_set, href: '#/day', description: 'Choose when Waldo holds cards and updates. Reminders you set still fire.' },
  ];
  return <section className="panel"><h2>Your setup checklist</h2>{items.map(item => <article className="control-row" key={item.title}><div><h3>{item.title}</h3><p>{item.description}</p><span className="access-label">{item.recorded ? 'Setting recorded' : 'To do'}</span></div><a href={item.href}>Manage {item.title.toLowerCase()}</a></article>)}</section>;
}

export function UsageControls({ record }: { record: UsageRecord }) {
  const total = record.data.rows.reduce((sum, row) => sum + row.usd, 0);
  return <section className="panel"><h2>Recorded model usage</h2><p>Costs are Waldo’s recorded estimates, not verified provider billing.</p><div className="table-scroll" tabIndex={0} role="region" aria-label="Model usage records"><table><thead><tr>{['Model', 'Calls', 'Input tokens', 'Cached tokens', 'Output tokens', 'Estimated cost'].map(name => <th scope="col" key={name}>{name}</th>)}</tr></thead><tbody>{record.data.rows.map((row, index) => <tr key={index}><td>{row.model}</td><td>{row.calls}</td><td>{row.input}</td><td>{row.cached}</td><td>{row.output}</td><td>${row.usd.toFixed(4)}</td></tr>)}</tbody></table></div>{!record.data.rows.length && <p>No model usage rows returned.</p>}<p>Total recorded estimate: ${total.toFixed(4)}</p></section>;
}

export function FilesControls({ record, busy, onAction }: { record: FilesRecord } & Actions) {
  return <><p>These are Telegram-hosted references, not private retained workspace storage. Opening a reference uses the existing authenticated download route.</p><div className="file-reference-list">{record.data.items.map(file => <section className="panel" key={file.id}><h2>{file.name}</h2><p className="muted">{file.kind} · {file.size === null ? 'Size unavailable' : `${file.size} bytes`}</p>{file.caption && <p>{file.caption}</p>}<div className="control-actions"><a className="button-link" href={`/console/file?${new URLSearchParams({ id: String(file.id) })}`}>Open {file.name}</a><button disabled={busy} onClick={() => { if (window.confirm(`Remove ${file.name} from this list? It stays stored with Telegram.`)) onAction('file.remove', { id: String(file.id) }); }}>Remove {file.name} from list</button></div></section>)}</div>{!record.data.items.length && <section className="panel"><h2>No Telegram references returned.</h2><p>This is the returned reference list, not proof that no files exist elsewhere.</p></section>}<p className="muted">Removing a reference does not purge Telegram bytes or other retained workspace copies. Sharing is unavailable here. The private workspace console is a separate surface.</p></>;
}
