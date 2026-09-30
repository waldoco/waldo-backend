import { useEffect, useState } from 'react';
import type { OverviewV1 } from './model';
import { fetchOverview, SignInRequired } from './model';
import './style.css';

export type Route = 'today' | 'overview' | 'waiting' | 'patrol' | 'memory' | 'connections';
const routes = [
  { key: 'today', label: 'Today' }, { key: 'waiting', label: 'Waiting' },
  { key: 'patrol', label: 'Patrol' }, { key: 'memory', label: 'Memory' },
  { key: 'connections', label: 'Connections' },
] as const;
export const resolveRoute = (value: string): Route => routes.find((r) => r.key === value)?.key ?? 'today';
const currentRoute = () => resolveRoute(window.location.hash.replace(/^#\/?/, ''));
const date = (iso: string, zone: string) => {
  try { return new Intl.DateTimeFormat('en', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); }
  catch { return 'Time unavailable'; }
};
const waitingSummary = (data: OverviewV1) => data.waiting.first?.summary ?? (data.waiting.count > 0
  ? 'The decision summary is unavailable. Open the full proposals to review.'
  : 'Nothing is waiting for a decision right now.');
const ownerActivity = (data: OverviewV1) => data.latest_activity?.kind === 'heartbeat' && data.latest_activity.status === 'completed' ? null : data.latest_activity;
const Section = ({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) => (
  <section className="panel"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2>{children}</section>
);
const Heading = ({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) => (
  <div className="page-heading"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{children}</div>
);

export function DashboardNavigation({ route }: { route: Route }) {
  return <div className="navigation">
    <nav aria-label="Dashboard pages">{routes.map((item) => (
      <a aria-current={(route === item.key || route === 'overview' && item.key === 'today') ? 'page' : undefined}
        key={item.key} href={`#/${item.key}`}>{item.label}</a>
    ))}</nav>
    <details className="more-controls"><summary>More controls</summary>
      <nav aria-label="More console controls">
        <a href="/console/setup">Setup checklist</a><a href="/console/day">Your day · timing &amp; pins</a>
        <a href="/console/files">Files · Telegram references</a><a href="/console/usage">Usage &amp; estimated cost</a>
        <a href="/console/invites">Invite someone to Waldo</a><a href="/console/account">Account &amp; sign out</a>
      </nav>
      <p>Invites let someone join Waldo. They do not share your data.</p>
    </details>
  </div>;
}

export function Dashboard({ data, route }: { data: OverviewV1; route: Route }) {
  const activity = ownerActivity(data);
  if (route === 'waiting') return <>
    <Heading eyebrow="Needs your judgment" title="Waiting."><p>Review the proposal before deciding.</p></Heading>
    <Section eyebrow="Pending" title={`${data.waiting.count} ${data.waiting.count === 1 ? 'decision' : 'decisions'}`}>
      <p>{waitingSummary(data)}</p>
      <p className="muted">This summary cannot approve a change. Full calendar proposal review, eligible approve/skip and supported undo are in the console. Email and message sends need the exact review card in chat.</p>
      <a className="button-link" href="/console/waiting">Open full proposals <span aria-hidden="true">↗</span></a>
    </Section>
  </>;
  if (route === 'patrol') return <>
    <Heading eyebrow="Recorded work" title="Patrol."><p>See what was recorded, then inspect the details.</p></Heading>
    <Section eyebrow="Latest recorded activity" title={activity?.kind ?? 'No owner-facing activity in the latest record.'}>
      <p>{activity ? (activity.summary ?? 'No summary is recorded for this activity. Older records are not shown here.') : 'No owner-facing work appears in this latest record. Older records are not shown here.'}</p>
      {activity && <p className="muted">Recorded status: {activity.status} · {date(activity.at, data.timezone)}. A completed attempt does not by itself verify its result.</p>}
      <a href="/console/activity">Open activity &amp; background runs <span aria-hidden="true">↗</span></a>
    </Section>
  </>;
  if (route === 'memory') return <>
    <Heading eyebrow="Your context" title="Memory."><p>Inspect what Waldo remembers, and keep it correctable.</p></Heading>
    <Section eyebrow="Memory details unavailable" title="No memory details here yet.">
      <p>Review saved notes, tentative patterns and profile sections in the console. Confirm, dismiss or forget where supported; correction currently goes through chat.</p>
      <div className="subview-links" aria-label="Memory subviews"><a href="/console/spots">Spots <span aria-hidden="true">↗</span></a>
        <a href="/console/constellation">Constellations <span aria-hidden="true">↗</span></a><a href="/console/memory">Profile <span aria-hidden="true">↗</span></a></div>
      <p className="muted">Evidence notes and source IDs are not original-message links or proof of truth. Shared origins, tentative patterns and incomplete removal need review in the item’s existing controls.</p>
    </Section>
  </>;
  if (route === 'connections') return <>
    <Heading eyebrow="Connected accounts" title="Connections."><p>A saved grant is not a successful live read.</p>
      <a className="button-link" href="/console/connections">Manage Google &amp; Telegram <span aria-hidden="true">↗</span></a>
    </Heading>
    <div className="stack">{data.services.length ? data.services.map((service) => (
      <Section key={service.account_id} eyebrow={service.health === 'needs_reconnect' ? 'Reconnect needed' : 'Access granted · read unverified'} title={service.email}>
        <p>{service.grants.length ? service.grants.join(' · ') : 'No active grants'}</p>
      </Section>
    )) : <Section eyebrow="No active Google connections" title="Nothing connected yet."><p>No active Google grants are recorded here. Google account controls and Telegram link/unlink are in Manage connections.</p></Section>}</div>
  </>;

  const brief = data.brief.status === 'sent_recorded' ? 'The Brief is marked sent.'
    : data.brief.status === 'not_scheduled' ? 'No Brief is scheduled.' : 'The Brief has not been sent.';
  return <>
    <Heading eyebrow="Your Waldo" title="Today."><p>What needs you. What’s next. What has been recorded.</p></Heading>
    <div className={`overview-grid${data.waiting.count ? ' has-waiting' : ''}`}>
      <section className={`waiting-panel${data.waiting.count ? ' needs-you' : ''}`}>
        <div className="section-label"><span className="eyebrow">Waiting on you</span><span className="count" aria-label={`${data.waiting.count} waiting ${data.waiting.count === 1 ? 'decision' : 'decisions'}`}>{data.waiting.count}</span></div>
        <h2>{data.waiting.count ? `${data.waiting.count} ${data.waiting.count === 1 ? 'decision' : 'decisions'} waiting.` : 'Nothing waiting.'}</h2>
        <p>{waitingSummary(data)}</p><a className="button-link" href="#/waiting">Review what’s waiting <span aria-hidden="true">→</span></a>
        <p className="muted">A proposal is pending work. Review the full details before deciding.</p>
      </section>
      <section className="next-panel"><span className="eyebrow">Next on your day</span><h2>{data.next_card?.label ?? 'No card scheduled ahead.'}</h2>
        <p>{data.next_card ? date(data.next_card.scheduled_at, data.timezone) : 'No future card is recorded in this plan.'}</p>
        <a href="/console/day">Adjust timing &amp; pins <span aria-hidden="true">↗</span></a>
      </section>
    </div>
    <div className="record-list">
      <section className="record-row"><span className="eyebrow">The Brief</span><div><h2>{brief}</h2>
        <p>{data.brief.status === 'sent_recorded' ? 'Waldo recorded a send. This does not confirm delivery or show message text; open your chat to check.' : 'No Brief content is available here.'}</p>
        {data.brief.at && <p className="muted">Recorded {date(data.brief.at, data.timezone)}</p>}</div>
      </section>
      <section className="record-row"><span className="eyebrow">Latest activity</span><div><h2>{activity?.kind ?? 'No owner-facing activity in the latest record.'}</h2>
        {activity && <><p>{activity.summary ?? 'No summary is recorded for this activity.'}</p><p className="muted">Recorded status: {activity.status} · {date(activity.at, data.timezone)}</p></>}
        <a href="#/patrol">Inspect the latest record <span aria-hidden="true">→</span></a></div>
      </section>
    </div>
    <p className="day-note">The Brief, Check-in and evening Close run in chat. <a href="/console/day">Your day</a> keeps their timing and pins together. Their full content and Close results are not shown here yet.</p>
  </>;
}

type FeedbackState = { kind: 'loading' } | { kind: 'error'; message: string; signedOut: boolean };
export function DashboardFeedback({ state, onRetry }: { state: FeedbackState; onRetry: () => void }) {
  if (state.kind === 'loading') return <div role="status" className="feedback">Checking what has been recorded…</div>;
  return <div role="alert" className="feedback"><h1>{state.signedOut ? 'Sign in to your Waldo.' : 'Couldn’t load your dashboard.'}</h1>
    <p>{state.message}</p>{state.signedOut ? <a className="button-link" href="/console/signin">Sign in</a> : <button onClick={onRetry}>Try again</button>}</div>;
}

export function App() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const [state, setState] = useState<FeedbackState | { kind: 'ready'; data: OverviewV1 }>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    fetchOverview(controller.signal).then((data) => {
      if (!controller.signal.aborted) setState({ kind: 'ready', data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ kind: 'error', message: error instanceof Error ? error.message : 'The dashboard could not load right now.', signedOut: error instanceof SignInRequired });
    });
    return () => controller.abort();
  }, [retry]);
  return <div className="frame">
    <a className="skip-link" href="#main" onClick={(event) => {
      event.preventDefault();
      document.getElementById('main')?.focus();
    }}>Skip to content</a>
    <header><a className="brand" href="#/today" aria-label="Waldo dashboard home"><span className="brand-mark" aria-hidden="true"/><small>Your console</small></a></header>
    <DashboardNavigation route={route} />
    <main id="main" tabIndex={-1}>{state.kind !== 'ready' ? <DashboardFeedback state={state} onRetry={() => setRetry((n) => n + 1)}/>
      : <><div className="record-status"><span>Records as of {date(state.data.as_of, state.data.timezone)} · {state.data.timezone}</span><button onClick={() => setRetry((n) => n + 1)}>Refresh records</button></div><Dashboard data={state.data} route={route}/></>}</main>
    <footer>Recorded activity can include attempts and failures. Check the result before treating work as done.</footer>
  </div>;
}
