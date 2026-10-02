import { AdminPanel, type AdminState } from './Admin';
import { fetchAdmin } from './admin-model';
import { useEffect, useRef, useState } from 'react';
import type { OverviewV1 } from './model';
import { fetchOverview, SignInRequired } from './model';
import './style.css';

export type Route = 'today' | 'overview' | 'waiting' | 'patrol' | 'memory' | 'memory/spots' | 'memory/constellation' | 'memory/profile' | 'connections' | 'day' | 'admin';
const routes = [
  { key: 'today', label: 'Today' }, { key: 'waiting', label: 'Waiting' },
  { key: 'patrol', label: 'Patrol' }, { key: 'memory', label: 'Memory' },
  { key: 'connections', label: 'Connections' }, { key: 'day', label: 'Your day' },
] as const;
export const resolveRoute = (value: string): Route => {
  if (value === 'admin') return 'admin';
  if (value === 'memory/spots' || value === 'memory/constellation' || value === 'memory/profile') return value;
  return routes.find((r) => r.key === value)?.key ?? 'today';
};
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

const navigationIcons = {
  today: <><rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3h6v2M9 10h6M9 14h6"/></>,
  waiting: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  patrol: <><path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z"/><path d="m8 12 3 3 5-6"/></>,
  memory: <><circle cx="7" cy="6" r="3"/><circle cx="17" cy="10" r="3"/><circle cx="8" cy="18" r="3"/><path d="m10 7 4 2M8 9v6m3 1 4-4"/></>,
  connections: <><path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-6 6v4M9 22h6"/></>,
  day: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
};

export function DashboardNavigation({ route, waitingCount, onNavigate, isAdmin = false }: { isAdmin?: boolean; route: Route; waitingCount?: number; onNavigate?: () => void }) {
  const selected = route.startsWith('memory/') ? 'memory' : route === 'overview' ? 'today' : route;
  return <div className="navigation">
    <nav aria-label="Dashboard pages">{routes.map((item) => (
      <a aria-current={selected === item.key ? 'page' : undefined} onClick={onNavigate}
        key={item.key} href={`#/${item.key}`}><span className="nav-label"><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{navigationIcons[item.key]}</svg>{item.label}</span>
        {item.key === 'waiting' && waitingCount !== undefined && waitingCount > 0 && <span className="nav-count" aria-label={`${waitingCount} waiting ${waitingCount === 1 ? 'decision' : 'decisions'}`}>{waitingCount}</span>}
      </a>
    ))}</nav>
    <nav className="secondary-nav" aria-label="More console controls">
      <a href="/console/files" onClick={onNavigate}>Files <small>Telegram references</small></a>
      <a href="/console/workspace" onClick={onNavigate}>Private workspace <small>Retained files &amp; downloads</small></a>
      <a href="/console/usage" onClick={onNavigate}>Usage &amp; estimated cost</a>
      <a href="/console/setup" onClick={onNavigate}>Setup checklist</a>
      <a href="/console/invites" onClick={onNavigate}>Invite someone</a>
    </nav>
    {isAdmin && <nav className="secondary-nav" aria-label="Restricted administration"><a href="#/admin" aria-current={route === 'admin' ? 'page' : undefined} onClick={onNavigate}><span className="nav-label"><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h5M8 17h3"/></svg>Invite management</span><small>Restricted administration</small></a></nav>}
    <nav className="account-nav" aria-label="Account and sessions">
      <a href="/console/account" onClick={onNavigate}>Account</a>
      <a href="/console/connections" onClick={onNavigate}>Sessions &amp; sign out</a>
      <a href="/console" onClick={onNavigate}>Original console <span aria-hidden="true">↗</span></a>
    </nav>
    <p className="sidebar-note">Invites let someone join Waldo. They do not share your data.</p>
  </div>;
}

export function Dashboard({ data, route }: { data: OverviewV1; route: Route }) {
  const activity = ownerActivity(data);
  if (route === 'waiting') return <>
    <Heading eyebrow="Your decision comes first" title="Waiting."><p>A proposal is pending work. Read the full details before deciding.</p></Heading>
    <div className="waiting-review">
      <section className={`proposal-preview${data.waiting.count ? ' pending' : ''}`}>
        <div className="section-label"><span className="eyebrow">Recorded pending count</span><span className="count">{data.waiting.count}</span></div>
        <h2>{data.waiting.count} {data.waiting.count === 1 ? 'decision' : 'decisions'}</h2><p className="proposal-summary">{waitingSummary(data)}</p>
        {data.waiting.first && <p className="muted">First pending summary only. This is not the complete review.</p>}
        <a className="button-link" href="/console/waiting">Open full proposals <span aria-hidden="true">↗</span></a>
        <p className="muted">This summary cannot approve a change.</p>
      </section>
      <aside className="review-guide" aria-label="Supported review paths"><span className="brief-mark" aria-hidden="true"/><h2>Before you decide</h2>
        <ol><li><strong>Calendar changes</strong><p>Full details, eligible approve/skip and supported undo stay in the existing console.</p></li>
          <li><strong>Email &amp; message sends</strong><p>Approval stays on the exact chat review card. The console can dismiss supported send proposals; it cannot approve a send.</p></li>
          <li><strong>Missing or unconfirmed review</strong><p>Check chat for the full proposal before deciding. A summary is not enough to authorise an effect.</p></li></ol>
      </aside>
    </div>
  </>;
  if (route === 'patrol') return <>
    <Heading eyebrow="Recorded work" title="Patrol."><p>See what was recorded, then inspect the details.</p></Heading>
    <Section eyebrow="Latest recorded activity" title={activity?.kind ?? 'No owner-facing activity in the latest record.'}>
      <p>{activity ? (activity.summary ?? 'No summary is recorded for this activity. Older records are not shown here.') : 'No owner-facing work appears in this latest record. Older records are not shown here.'}</p>
      {activity && <p className="muted">Recorded status: {activity.status} · {date(activity.at, data.timezone)}. A completed attempt does not by itself verify its result.</p>}
      <a href="/console/activity">Open activity &amp; background runs <span aria-hidden="true">↗</span></a>
    </Section>
  </>;
  if (route === 'memory' || route.startsWith('memory/')) {
    const subview = route === 'memory/constellation' ? 'constellation' : route === 'memory/profile' ? 'profile' : 'spots';
    const views = [
      { key: 'spots', name: 'Spots', description: 'Individual claims & evidence notes', path: '/console/spots' },
      { key: 'constellation', name: 'Constellation', description: 'Tentative patterns & supporting links', path: '/console/constellation' },
      { key: 'profile', name: 'Profile', description: 'Context kept in profile sections', path: '/console/memory' },
    ] as const;
    const selected = views.find((item) => item.key === subview)!;
    return <>
      <Heading eyebrow="Correctable context" title="Memory."><p>A place to inspect what Waldo holds—and decide what should stay.</p></Heading>
      <div className="memory-layout">
        <nav className="memory-index" aria-label="Memory subviews">{views.map((item) => <a key={item.key} href={`#/memory/${item.key}`} aria-current={item.key === subview ? 'page' : undefined}>
          <span>{item.name}</span><small>{item.description}</small></a>)}
          <div className="memory-original-links"><span className="eyebrow">Existing lists &amp; details</span>{views.map((item) => <a key={item.key} href={item.path}>{item.name} <span aria-hidden="true">↗</span></a>)}</div>
        </nav>
        <section className={`memory-detail memory-${subview}`} aria-label={`${selected.name} details`}>
          <div className="detail-kicker"><span className="eyebrow">Memory details unavailable</span>{subview === 'constellation' && <span className="constellation-mark" aria-hidden="true"/>}</div>
          <h2>{selected.name}</h2><p className="memory-unavailable">No memory details here yet. This view has not loaded your {subview === 'spots' ? 'Spots' : subview === 'constellation' ? 'patterns or links' : 'profile sections'}. Open the existing console to inspect them.</p>
          <a className="button-link" href={selected.path}>Open {selected.name} <span aria-hidden="true">↗</span></a>
          <div className="memory-guidance">
            {subview === 'spots' ? <>
              <details open><summary>Claims need context</summary><p>Source IDs are audit hints, not original-message links or proof of truth. Evidence notes describe support. Shared or untrusted origin and tentative claims remain visible in the existing list.</p></details>
              <details><summary>Confirm, dismiss or forget</summary><p>Confirm is offered for inferred Spots where supported. Dismiss and Forget remain on the existing item controls. Correct a claim by telling Waldo in chat.</p></details>
              <details><summary>When removal is incomplete</summary><p>Retry forget stays available when part of memory storage still holds the text. Incomplete removal is not a finished forget.</p></details>
            </> : subview === 'constellation' ? <>
              <details open><summary>Patterns are tentative</summary><p>Inspect the supporting Spots and recorded links in the existing list. Strength is an uncalibrated estimate, not a probability of truth; stale patterns stay distinguishable.</p></details>
              <details><summary>Forgetting a pattern</summary><p>Supporting Spots stay when a pattern and its links are forgotten. Review and forget those separately if needed; correction stays in chat.</p></details>
            </> : <details open><summary>Keep your context correctable</summary><p>Profile sections and do-not-relearn notes are in the existing read-only view. Ask Waldo for corrections in chat. This page does not offer a profile editor or infer what has been saved.</p></details>}
          </div>
        </section>
      </div>
    </>;
  }
  if (route === 'day') return <>
    <Heading eyebrow="Your rhythm" title="Your day."><p>Keep the day’s cards and when Waldo reaches you together.</p></Heading>
    <div className="day-summary">
      <Section eyebrow="Next scheduled card" title={data.next_card?.label ?? 'No card scheduled ahead.'}>
        <p>{data.next_card ? date(data.next_card.scheduled_at, data.timezone) : 'No future card is recorded in this plan. This does not mean all day cards are disabled.'}</p>
      </Section>
      <Section eyebrow="Current time zone" title={data.timezone}><p>Times shown here follow this recorded time zone.</p></Section>
    </div>
    <section className="control-list" aria-label="Your day controls">
      <div className="control-row"><div><h2>The Brief, Check-in &amp; Close</h2><p>Timing and pin details are unavailable in this view. Open the existing controls to set a time for today, pin an unsent card or clear an existing pin.</p><p className="muted">These cards run in chat. A recorded send does not confirm delivery; full content and Close results are unavailable here.</p></div><a href="/console/day">Timing &amp; pins <span aria-hidden="true">↗</span></a></div>
      <div className="control-row"><div><h2>Time zone</h2><p>Change it when you travel, or use your device’s time zone before saving.</p></div><a href="/console/day">Change time zone <span aria-hidden="true">↗</span></a></div>
      <div className="control-row"><div><h2>Quiet hours &amp; volume</h2><p>Quiet hours and volume values are unavailable in this view. The existing controls set when Waldo holds cards, updates and event briefs. Reminders you set still fire.</p></div><a href="/console/day">Quiet hours &amp; volume <span aria-hidden="true">↗</span></a></div>
    </section>
    <a className="button-link" href="/console/day">Open day controls <span aria-hidden="true">↗</span></a>
  </>;
  if (route === 'connections') return <>
    <Heading eyebrow="Permission, with control" title="Connections."><p>See saved account access and manage what Waldo can reach.</p></Heading>
    <div className="connection-heading"><h2>Google accounts</h2><a className="button-link" href="/console/connections">Manage Google &amp; Telegram <span aria-hidden="true">↗</span></a></div>
    <div className="account-list">{data.services.length ? data.services.map((service) => (
      <section key={service.account_id} className="account-row" aria-label={service.email}>
        <div className="account-monogram" aria-hidden="true">G</div>
        <div className="account-details"><h3>{service.email}</h3>
          <span className={`access-label${service.health === 'needs_reconnect' ? ' reconnect' : ''}`}>{service.health === 'needs_reconnect' ? 'Reconnect needed' : 'Access granted · read unverified'}</span>
          <ul className="grant-list" aria-label="Recorded permissions">{service.grants.length ? service.grants.map((grant) => <li key={grant}>{({ calendar: 'Calendar', gmail: 'Gmail', tasks: 'Tasks' })[grant]}</li>) : <li>No active grants</li>}</ul>
          <p className="muted">Saved access does not prove a successful live read. Check a real request in chat and its recorded result.</p>
        </div><a href="/console/connections">Account controls <span aria-hidden="true">↗</span></a>
      </section>
    )) : <Section eyebrow="No Google rows recorded" title="No Google account rows recorded."><p>No Google account rows are present in this overview. Open the existing controls to see available account setup; this says nothing about Telegram.</p></Section>}</div>
    <section className="control-list" aria-label="Connection and session controls">
      <div className="control-row"><div><h2>Telegram</h2><p>Telegram and session details are unavailable in this view. Link or unlink where supported in the existing owner console.</p></div><a href="/console/connections">Telegram controls <span aria-hidden="true">↗</span></a></div>
      <div className="control-row"><div><h2>Sessions &amp; sign out</h2><p>Sign out of this browser under Connections. Sign out everywhere is available there when more than one session is recorded.</p></div><a href="/console/connections">Sessions &amp; sign out <span aria-hidden="true">↗</span></a></div>
    </section>
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
  const [adminState, setAdminState] = useState<AdminState>({kind:'loading'});
  const adminAbort = useRef<AbortController | null>(null);
  const refreshAdmin = async () => {
    adminAbort.current?.abort();
    const controller = new AbortController(); adminAbort.current = controller;
    try { const data = await fetchAdmin(controller.signal); if (!controller.signal.aborted) setAdminState(data ? {kind:'ready',data} : {kind:'absent'}); }
    catch { if (!controller.signal.aborted) setAdminState({kind:'error'}); }
  };
  useEffect(() => { void refreshAdmin(); return () => adminAbort.current?.abort(); }, []);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDialogElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = () => drawer.current?.close();
  const openDrawer = () => { if (!drawer.current?.open) { drawer.current?.showModal(); setDrawerOpen(true); drawer.current?.querySelector<HTMLElement>('button')?.focus(); } };
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 861px)');
    const onChange = () => { if (desktop.matches) drawer.current?.close(); };
    desktop.addEventListener('change', onChange);
    return () => desktop.removeEventListener('change', onChange);
  }, []);
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
  return <div className="console-shell">
    <a className="skip-link" href="#main" onClick={(event) => {
      event.preventDefault(); closeDrawer(); document.getElementById('main')?.focus();
    }}>Skip to content</a>
    <aside className="desktop-sidebar" aria-label="Console sidebar">
      <a className="brand" href="#/today" aria-label="Waldo dashboard home"><span className="brand-mark" aria-hidden="true"/></a>
      <span className="sidebar-caption">Your console</span>
      <DashboardNavigation route={route} isAdmin={adminState.kind === 'ready'} waitingCount={state.kind === 'ready' ? state.data.waiting.count : undefined}/>
    </aside>
    <div className="console-content"><div className="frame">
    <header className="mobile-header"><a className="brand" href="#/today" aria-label="Waldo dashboard home"><span className="brand-mark" aria-hidden="true"/></a>
      <button ref={menuButton} type="button" aria-expanded={drawerOpen} aria-controls="navigation-drawer" aria-haspopup="dialog" onClick={openDrawer} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDrawer(); } }}>Menu</button>
    </header>
    <dialog ref={drawer} id="navigation-drawer" className="navigation-drawer" aria-labelledby="drawer-title" onClose={() => { setDrawerOpen(false); if (window.matchMedia('(max-width: 860px)').matches) menuButton.current?.focus(); }} onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const controls = event.currentTarget.querySelectorAll<HTMLElement>('a[href],button:not([disabled])');
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="drawer-heading"><h2 id="drawer-title">Your console</h2><button onClick={closeDrawer}>Close menu</button></div>
      <DashboardNavigation route={route} isAdmin={adminState.kind === 'ready'} waitingCount={state.kind === 'ready' ? state.data.waiting.count : undefined} onNavigate={closeDrawer}/>
    </dialog>
    <main id="main" tabIndex={-1}>{route === 'admin' ? <AdminPanel state={adminState} onRefresh={refreshAdmin}/> : state.kind !== 'ready' ? <DashboardFeedback state={state} onRetry={() => setRetry((n) => n + 1)}/>
      : <><div className="record-status"><span>Records as of {date(state.data.as_of, state.data.timezone)} · {state.data.timezone}</span><button onClick={() => setRetry((n) => n + 1)}>Refresh records</button></div><Dashboard data={state.data} route={route}/></>}</main>
    <footer>Recorded activity can include attempts and failures. Check the result before treating work as done.</footer>
  </div></div></div>;
}
