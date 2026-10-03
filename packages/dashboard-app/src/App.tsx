import {greeting,homeBrief} from './greeting';
import {activityLabel,missingOutcome} from './activity-labels';
import {SettingsPanel,type SettingsSection} from './Settings';
import {parseMemoryDestination} from './destinations';
import {WorkspacePanel} from './Workspace';
import {OwnerControlsPanel} from './OwnerControls';
import {ControlsPanel} from './Controls';
import { MemoryPanel } from './Memory';
import { AdminPanel, type AdminState } from './Admin';
import { fetchAdmin } from './admin-model';
import { useEffect, useRef, useState } from 'react';
import type { OverviewV1 } from './model';
import { fetchOverview, SignInRequired } from './model';
import './style.css';

export type Route = 'not-found' | 'today' | 'overview' | 'waiting' | 'patrol' | 'memory' | 'memory/spots' | 'memory/constellation' | 'memory/profile' | 'connections' | 'day' | 'admin' | 'files' | 'usage' | 'setup' | 'invites' | 'account' | 'files/workspace' | 'settings' | 'settings/not-found' | `settings/${SettingsSection}`;
const routes = [
  { key: 'today', label: 'Today' }, { key: 'waiting', label: 'Waiting' },
  { key: 'memory', label: 'Memory' }, { key: 'patrol', label: 'Patrol' },
] as const;
export const resolveRoute = (raw: string): Route => {
  const memory = parseMemoryDestination(raw);
  if(memory.kind==='invalid-memory')return 'memory';
  if(memory.kind==='valid-memory'){const d=memory.destination;return d.kind==='profile'?'memory/profile':d.kind==='explore'?'memory/constellation':`memory/${d.view}`;}
  const value = raw.split('?')[0] ?? '';
  if(value.startsWith('settings/')&&!['day','sessions','usage','account','setup'].includes(value.slice(9)))return 'settings/not-found';
  if(['settings','settings/day','settings/sessions','settings/usage','settings/account','settings/setup','day','connections'].includes(value))return value as Route;
  if (value === 'admin' || value==='files'||value==='usage'||value==='setup'||value==='invites'||value==='account'||value==='files/workspace') return value;
  if (value === 'memory/spots' || value === 'memory/constellation' || value === 'memory/profile') return value;
  if(value===''||value==='overview')return 'today';
  return routes.find((r) => r.key === value)?.key ?? 'not-found';
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
  const selected = route.startsWith('memory/') ? 'memory' : route === 'overview' ? 'today' : ['day','usage','account','setup'].includes(route)||route.startsWith('settings')?'settings':route;
  return <div className="navigation">
    <nav aria-label="Dashboard pages">{routes.map((item) => (
      <a aria-current={selected === item.key ? 'page' : undefined} onClick={onNavigate}
        key={item.key} href={`#/${item.key}`}><span className="nav-label"><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{navigationIcons[item.key]}</svg>{item.label}</span>
        {item.key === 'waiting' && waitingCount !== undefined && waitingCount > 0 && <span className="nav-count" aria-label={`${waitingCount} waiting ${waitingCount === 1 ? 'decision' : 'decisions'}`}>{waitingCount}</span>}
      </a>
    ))}</nav>
    <nav className="secondary-nav" aria-label="More console controls">
      <a href="#/files" aria-current={route.startsWith('files')?'page':undefined} onClick={onNavigate}>Files</a>
      <a href="#/connections" aria-current={route==='connections'?'page':undefined} onClick={onNavigate}>Connections</a>
    </nav>
    {isAdmin && <nav className="secondary-nav" aria-label="Restricted administration"><a href="#/admin" aria-current={route === 'admin' ? 'page' : undefined} onClick={onNavigate}><span className="nav-label"><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h5M8 17h3"/></svg>Invite management</span><small>Restricted administration</small></a></nav>}
    <nav className="account-nav" aria-label="Settings and invitations">
      <a href="#/settings" aria-current={selected==='settings'?'page':undefined} onClick={onNavigate}>Settings</a>
      <a href="#/invites" aria-current={route==='invites'?'page':undefined} onClick={onNavigate}>Invite someone</a>
      <a href="/console/legacy" onClick={onNavigate}>Existing controls <span aria-hidden="true">↗</span></a>
    </nav>
  </div>;
}

export function Dashboard({ data, route, now = new Date() }: { data: OverviewV1; route: Route; now?:Date }) {
  const activity = ownerActivity(data);
  if(route==='not-found')return <section className="panel" role="status"><h1>Page not found</h1><p>This console destination is not available.</p><a className="button-link" href="#/today">Open Today</a></section>;
  if(route==='settings/not-found')return <section className="panel" role="status"><h1>Settings page not found</h1><p>This settings destination is not available.</p><a href="#/settings">Open Settings</a></section>;
  if(route==='files'||route==='files/workspace')return <><div className="page-heading"><span className="eyebrow">Files with Waldo</span><h1>Files.</h1><p>Inspect Telegram references or your separate private workspace.</p></div><nav className="memory-tabs" aria-label="File storage views"><a href="#/files" aria-current={route==='files'?'page':undefined}>Telegram references</a><a href="#/files/workspace" aria-current={route==='files/workspace'?'page':undefined}>Private workspace</a></nav>{route==='files/workspace'?<WorkspacePanel/>:<ControlsPanel key="files" view="files" embedded/>}</>;
  if(route==='waiting'||route==='patrol')return <ControlsPanel key={route} view={route==='patrol'?'activity':'waiting'}/>;
  if(route==='invites')return <OwnerControlsPanel view={route}/>;
  if(route==='settings'||route.startsWith('settings/')||['day','usage','account','setup'].includes(route)){const section=(route==='settings'?'day':route.startsWith('settings/')?route.slice(9):route) as SettingsSection;return <SettingsPanel section={section}/>;}
  if (route === 'memory' || route.startsWith('memory/')) return <MemoryPanel subview={route === 'memory/constellation' ? 'constellation' : route === 'memory/profile' ? 'profile' : 'spots'}/>;
  if(route==='connections')return <ControlsPanel key={route} view={route} section="connections"/>;

  const brief = data.brief.status === 'sent_recorded' ? 'The Brief is marked sent.'
    : data.brief.status === 'not_scheduled' ? 'No Brief is scheduled.' : 'The Brief has not been sent.';
  return <>
    <Heading eyebrow="Your Waldo" title={greeting(data.timezone,now)}><p>{homeBrief(data,now)}</p></Heading>
    <div className={`overview-grid${data.waiting.count ? ' has-waiting' : ''}`}>
      <section className={`waiting-panel${data.waiting.count ? ' needs-you' : ''}`}>
        <div className="section-label"><span className="eyebrow">Waiting on you</span><span className="count" aria-label={`${data.waiting.count} waiting ${data.waiting.count === 1 ? 'decision' : 'decisions'}`}>{data.waiting.count}</span></div>
        <h2>{data.waiting.count ? `${data.waiting.count} ${data.waiting.count === 1 ? 'decision' : 'decisions'} waiting.` : 'Nothing waiting.'}</h2>
        <p>{waitingSummary(data)}</p><a className="button-link" href="#/waiting">Review what’s waiting <span aria-hidden="true">→</span></a>
        <p className="muted">A proposal is pending work. Review the full details before deciding.</p>
      </section>
      <section className="next-panel"><span className="eyebrow">{data.next_card && Date.parse(data.next_card.scheduled_at)<=now.getTime()?'On your recorded plan':'Next on your day'}</span><h2>{data.next_card?.label ?? 'No card scheduled ahead.'}</h2>
        <p>{data.next_card ? date(data.next_card.scheduled_at, data.timezone) : 'No future card is recorded in this plan.'}</p>
        <a href="#/settings/day">Adjust timing &amp; pins <span aria-hidden="true">↗</span></a>
      </section>
    </div>
    <div className="record-list">
      <section className="record-row"><span className="eyebrow">The Brief</span><div><h2>{brief}</h2>
        <p>{data.brief.status === 'sent_recorded' ? 'Waldo recorded a send. This does not confirm delivery or show message text; open your chat to check.' : 'No Brief content is available here.'}</p>
        {data.brief.at && <p className="muted">Recorded {date(data.brief.at, data.timezone)}</p>}</div>
      </section>
      <section className="record-row"><span className="eyebrow">Latest activity</span><div><h2>{activity ? activityLabel(activity.kind) : 'No owner-facing activity in the latest record.'}</h2>
        {activity && <><p>{activity.summary?.trim() ? activity.summary : missingOutcome}</p><p className="muted">Recorded status: {activity.status} · {date(activity.at, data.timezone)}</p><details><summary>Technical details</summary><p>Recorded type: {activity.kind}</p></details></>}
        <a href="#/patrol">Inspect the latest record <span aria-hidden="true">→</span></a></div>
      </section>
    </div>
    <p className="day-note">The Brief, Check-in and evening Close run in chat. <a href="#/settings/day">Your day</a> keeps their timing and pins together. Their full content and Close results are not shown here yet.</p>
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
  const [now,setNow]=useState(()=>new Date());
  useEffect(()=>{const tick=()=>setNow(new Date());const timer=window.setInterval(tick,60000);window.addEventListener('focus',tick);document.addEventListener('visibilitychange',tick);return()=>{window.clearInterval(timer);window.removeEventListener('focus',tick);document.removeEventListener('visibilitychange',tick);};},[]);
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
      if(event.key==='Escape'){event.preventDefault();closeDrawer();return;}
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
      : <><div className="record-status"><span>Records as of {date(state.data.as_of, state.data.timezone)} · {state.data.timezone}</span><button onClick={() => setRetry((n) => n + 1)}>Refresh records</button></div><Dashboard data={state.data} route={route} now={now}/></>}</main>
    <footer>Recorded activity can include attempts and failures. Check the result before treating work as done.</footer>
  </div></div></div>;
}
