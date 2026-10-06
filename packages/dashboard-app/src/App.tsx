import {greeting} from './greeting';
import {Icon,WaldoMark} from './icons';
import {clockLabel,DayRail,localMinutes,sameLocalDay,stagger,type RailMark} from './Infographics';
import {Drawer,Riffle} from '@lucasmarkes/hairline/react';
import {activityLabel,missingOutcome} from './activity-labels';
import {SettingsHead,SettingsPanel,type SettingsSection} from './Settings';
import {parseMemoryDestination} from './destinations';
import {WorkspacePanel} from './Workspace';
import {OwnerControlsPanel} from './OwnerControls';
import {ControlsPanel} from './Controls';
import { MemoryPanel } from './Memory';
import { AdminPanel, type AdminState } from './Admin';
import { fetchAdmin } from './admin-model';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { exactTime, relativeTime } from './time';
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
const dayLabel = (zone: string, now: Date) => {
  try { return new Intl.DateTimeFormat('en', { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric' }).format(now); }
  catch { return null; }
};
const waitingSummary = (data: OverviewV1) => data.waiting.first?.summary ?? 'He couldn’t summarise it. Open the proposals to read it in full.';
const ownerActivity = (data: OverviewV1) => data.latest_activity?.kind === 'heartbeat' && data.latest_activity.status === 'completed' ? null : data.latest_activity;
// The time-of-day word carries the one serif accent on the page.
const Greeting = ({ text }: { text: string }) => { const match = /^(Good )(\w+)(\.)$/.exec(text); return match ? <>{match[1]}<em>{match[2]}</em>{match[3]}</> : <>{text}</>; };

export const isSettingsRoute = (route: Route) => route === 'admin' || ['connections', 'files', 'files/workspace', 'invites', 'day', 'usage', 'account', 'setup', 'settings'].includes(route) || route.startsWith('settings/');

const shortcut: Record<string, string> = { today: 'T', waiting: 'W', memory: 'M', patrol: 'P' };
export function DashboardNavigation({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  const selected = route.startsWith('memory') ? 'memory' : route === 'overview' ? 'today' : route;
  const nav = useRef<HTMLElement>(null);
  // One white pill slides to the chosen page; it follows the link as its icon opens.
  useLayoutEffect(() => {
    const el = nav.current; if (!el) return;
    const place = () => { const on = el.querySelector<HTMLElement>('a[aria-current="page"]'); if (!on) { el.removeAttribute('data-indicator'); return; } el.style.setProperty('--x', `${on.offsetLeft}px`); el.style.setProperty('--w', `${on.offsetWidth}px`); el.setAttribute('data-indicator', ''); };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(place); el.querySelectorAll('a').forEach(a => watch.observe(a));
    return () => watch.disconnect();
  }, [selected]);
  return <nav ref={nav} className="primary-nav" aria-label="Dashboard pages">{routes.map((item) => (
    <a aria-current={selected === item.key ? 'page' : undefined} onClick={onNavigate} key={item.key} href={`#/${item.key}`} title={`${item.label} · G then ${shortcut[item.key]}`}>
      <Icon name={item.key} className="nav-icon"/>
      <span>{item.label}</span>
    </a>
  ))}</nav>;
}

export function Dashboard({ data, route, now = new Date(), isAdmin = false }: { data: OverviewV1; route: Route; now?: Date; isAdmin?: boolean }) {
  const activity = ownerActivity(data);
  const waiting = data.waiting.count;
  if(route==='not-found')return <section className="tile notice" role="status"><h1>Page not found</h1><p>This console page doesn’t exist.</p><a className="button-link" href="#/today">Back to Today</a></section>;
  if(route==='settings/not-found')return <><SettingsHead selected="day" isAdmin={isAdmin}/><section className="tile notice" role="status"><h2>Settings page not found</h2><p>This settings page doesn’t exist.</p><a className="button-link" href="#/settings">Open Settings</a></section></>;
  if(route==='connections')return <><SettingsHead selected="connections" isAdmin={isAdmin}/><ControlsPanel key={route} view="connections" section="connections" embedded/></>;
  if(route==='files'||route==='files/workspace')return <><SettingsHead selected="files" isAdmin={isAdmin}/><nav className="segmented small" aria-label="File storage views"><a href="#/files" aria-current={route==='files'?'page':undefined}>Telegram references</a><a href="#/files/workspace" aria-current={route==='files/workspace'?'page':undefined}>Private workspace</a></nav>{route==='files/workspace'?<WorkspacePanel/>:<ControlsPanel key="files" view="files" embedded/>}</>;
  if(route==='waiting'||route==='patrol')return <ControlsPanel key={route} view={route==='patrol'?'activity':'waiting'}/>;
  if(route==='invites')return <><SettingsHead selected="invites" isAdmin={isAdmin}/><OwnerControlsPanel view={route} embedded/></>;
  if(route==='settings'||route.startsWith('settings/')||['day','usage','account','setup'].includes(route)){const section=(route==='settings'?'day':route.startsWith('settings/')?route.slice(9):route) as SettingsSection;return <SettingsPanel section={section} isAdmin={isAdmin}/>;}
  if (route === 'memory' || route.startsWith('memory/')) return <MemoryPanel subview={route === 'memory/constellation' ? 'constellation' : route === 'memory/profile' ? 'profile' : 'spots'}/>;

  const brief = data.brief.status === 'sent_recorded'
    ? { title: 'Sent, as recorded.', body: 'Waldo logged a send. That doesn’t confirm delivery or show the message; check your chat.' }
    : data.brief.status === 'not_scheduled' ? { title: 'No Brief scheduled.', body: 'There’s nothing to send yet.' }
      : { title: 'Not sent yet.', body: 'No Brief content is shown here.' };
  const zone = data.timezone, next = data.next_card;
  const nextDue = !!next && Date.parse(next.scheduled_at) <= now.getTime();
  const marks: RailMark[] = [];
  if (data.brief.status === 'sent_recorded' && data.brief.at && sameLocalDay(data.brief.at, now, zone)) { const at = localMinutes(data.brief.at, zone); if (at !== null) marks.push({ key: 'brief', at, label: 'Brief', time: clockLabel(data.brief.at, zone), kind: 'done' }); }
  if (next && sameLocalDay(next.scheduled_at, now, zone)) { const at = localMinutes(next.scheduled_at, zone); if (at !== null) marks.push({ key: 'next', at, label: next.label, time: clockLabel(next.scheduled_at, zone), kind: nextDue ? 'plain' : 'next' }); }
  const nowAt = localMinutes(now, zone) ?? 0;
  const railSummary = [`Now ${clockLabel(now, zone)}.`, ...marks.map(mark => `${mark.label} ${mark.kind === 'done' ? 'sent, as recorded,' : mark.kind === 'next' ? 'next,' : 'on your plan,'} at ${mark.time}.`)].join(' ');
  return <div className="flow" key="today">
    <div className="page-heading reveal" style={stagger(0)}>{dayLabel(zone, now) && <span className="label">{dayLabel(zone, now)}</span>}<h1><Greeting text={greeting(zone, now)}/></h1></div>
    <section className="tile rail-tile reveal" style={stagger(1)} aria-label="Your day"><DayRail marks={marks} now={nowAt} summary={railSummary}/></section>
    <section className={`tile focus reveal${waiting > 0 ? ' today-action' : ''}`} style={stagger(2)}>
      <div className="focus-copy">
        <span className="label">{waiting > 0 ? 'Waiting on you' : 'Waiting'}</span>
        <h2>{waiting === 0 ? 'Nothing needs you.' : waiting === 1 ? 'One decision needs you.' : `${waiting} decisions need you.`}</h2>
        {waiting > 0 && <p>{waitingSummary(data)}</p>}
        {waiting > 0 && <a className="button-link" href="#/waiting">{waiting === 1 ? 'Review it' : 'Review them'} <span aria-hidden="true">→</span></a>}
      </div>
      {waiting > 0 ? <Riffle className="figure" label="A tray of cards, an interactive illustration. Decorative."/> : <Drawer className="figure" label="An empty cabinet drawer, an interactive illustration. Decorative."/>}
    </section>
    <div className="tile disclosures reveal" style={stagger(3)}>
      <details name="today" className="disclosure"><summary><Icon name="calendarClock"/><span className="label key">{nextDue ? 'On your plan' : 'Next'}</span><span className="value">{next ? `${next.label} · ${clockLabel(next.scheduled_at, zone)}` : 'Nothing scheduled ahead.'}</span></summary>
        <div className="disclosure-body"><p>{next ? date(next.scheduled_at, zone) : 'No later card is recorded in your plan.'}</p><a className="quiet-link" href="#/settings/day">Adjust timing</a></div></details>
      <details name="today" className="disclosure"><summary><Icon name="brief"/><span className="label key">The Brief</span><span className="value">{brief.title}</span></summary>
        <div className="disclosure-body"><p>{brief.body}</p>{data.brief.at && <p className="meta">Recorded {date(data.brief.at, zone)}</p>}</div></details>
      <details name="today" className="disclosure"><summary><Icon name="entry"/><span className="label key">Latest</span><span className="value">{activity ? activityLabel(activity.kind) : 'Nothing to report.'}</span></summary>
        <div className="disclosure-body"><p>{activity ? (activity.summary?.trim() ? activity.summary : missingOutcome) : 'No owner-facing activity in the latest record.'}</p>
          {activity && <p className="meta">Recorded status: {activity.status} · {date(activity.at, zone)}</p>}<a className="quiet-link" href="#/patrol">Open Patrol</a></div></details>
    </div>
    <p className="caption reveal" style={stagger(4)}>The Brief, Check-in and evening Close run in chat. Their content and results aren’t shown here.</p>
  </div>;
}

type FeedbackState = { kind: 'loading' } | { kind: 'error'; message: string; signedOut: boolean };
export function DashboardFeedback({ state, onRetry }: { state: FeedbackState; onRetry: () => void }) {
  if (state.kind === 'loading') return <div role="status" className="skeleton-page"><span className="visually-hidden">Checking what has been recorded…</span><i className="sk sk-title"/><i className="sk sk-rail"/><i className="sk sk-card"/><i className="sk sk-rows"/></div>;
  return <div role="alert" className="feedback tile"><h1>{state.signedOut ? 'Sign in to your Waldo.' : 'Couldn’t load your dashboard.'}</h1>
    <p>{state.message}</p>{state.signedOut ? <a className="button-link" href="/console/signin">Sign in</a> : <button className="primary" onClick={onRetry}>Try again</button>}</div>;
}


export function App() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const [now,setNow]=useState(()=>new Date());
  useEffect(()=>{const tick=()=>setNow(new Date());const timer=window.setInterval(tick,60000);window.addEventListener('focus',tick);document.addEventListener('visibilitychange',tick);return()=>{window.clearInterval(timer);window.removeEventListener('focus',tick);document.removeEventListener('visibilitychange',tick);};},[]);
  const [state, setState] = useState<FeedbackState | { kind: 'ready'; data: OverviewV1 }>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [adminState, setAdminState] = useState<AdminState>({kind:'loading'});
  const adminAbort = useRef<AbortController | null>(null);
  const refreshAdmin = async () => {
    adminAbort.current?.abort();
    const controller = new AbortController(); adminAbort.current = controller;
    try { const data = await fetchAdmin(controller.signal); if (!controller.signal.aborted) setAdminState(data ? {kind:'ready',data} : {kind:'absent'}); }
    catch { if (!controller.signal.aborted) setAdminState({kind:'error'}); }
  };
  useEffect(() => { void refreshAdmin(); return () => adminAbort.current?.abort(); }, []);
  useEffect(() => {
    const onHash = () => { setRoute(currentRoute()); window.scrollTo?.(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // A refresh keeps the page on screen and swaps the records in when they arrive.
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => previous.kind === 'ready' ? previous : { kind: 'loading' });
    if (retry > 0) setRefreshing(true);
    fetchOverview(controller.signal).then((data) => {
      if (!controller.signal.aborted) setState({ kind: 'ready', data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ kind: 'error', message: error instanceof Error ? error.message : 'The dashboard could not load right now.', signedOut: error instanceof SignInRequired });
    }).finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [retry]);
  // Linear-style jumps: G, then T, W, M or P. Ignored while typing.
  useEffect(() => {
    let armed = 0;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest('input,textarea,select,[contenteditable="true"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'g') { armed = Date.now(); return; }
      const page = ({ t: 'today', w: 'waiting', m: 'memory', p: 'patrol', s: 'settings' } as Record<string, string>)[key];
      if (page && Date.now() - armed < 1200) { armed = 0; window.location.hash = `#/${page}`; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const isAdmin = adminState.kind === 'ready';
  const ready = state.kind === 'ready' ? state.data : null;
  return <div className="console-shell">
    <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
    <header className="topbar"><div className="topbar-inner">
      <a className="brand" href="#/today" aria-label="Waldo dashboard home"><WaldoMark/><span aria-hidden="true">Waldo</span></a>
      <DashboardNavigation route={route}/>
      <a className="settings-link" href="#/settings" aria-label="Settings" aria-current={isSettingsRoute(route) ? 'page' : undefined}><Icon name="settings"/></a>
    </div></header>
    <main id="main" tabIndex={-1}>{route === 'admin' ? <><SettingsHead selected="admin" isAdmin={isAdmin}/><AdminPanel state={adminState} onRefresh={refreshAdmin}/></>
      : state.kind !== 'ready' ? <DashboardFeedback state={state} onRetry={() => setRetry((n) => n + 1)}/>
      : <div className="route" key={route.split('/')[0]}><Dashboard data={state.data} route={route} now={now} isAdmin={isAdmin}/></div>}</main>
    <footer>
      {ready && <p><span title={`${exactTime(ready.as_of, ready.timezone)} · ${ready.timezone}`}>Updated {relativeTime(ready.as_of, now)}</span><button type="button" className="refresh" aria-busy={refreshing} disabled={refreshing} onClick={() => setRetry((n) => n + 1)}><Icon name="retry"/>Refresh records</button></p>}
      <p>Recorded activity can include attempts and failures. Check the result before treating work as done.</p>
    </footer>
  </div>;
}
