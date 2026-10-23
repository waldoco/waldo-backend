import { useCallback, useEffect, useState } from 'react';
import { exactTime, relativeTime } from './time';
import { SignInRequired } from './model';
import {
  fetchAdminHealth, fetchHealth, PURPOSE_LABEL, reasonText, SOURCE_LABEL,
  type AdminHealthRecord, type Consent, type HealthRecord, type Pillar, type Scores, type SleepDebt, type Source, type Uploads,
} from './health-model';

export type HealthState = { kind: 'loading' } | { kind: 'error'; message: string; signedOut: boolean } | { kind: 'ready'; data: HealthRecord };
export type AdminHealthState = { kind: 'loading' } | { kind: 'absent' } | { kind: 'error'; message: string } | { kind: 'ready'; data: AdminHealthRecord };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tally = (rows: { name: string; count: number }[]) => rows.length ? rows.map(r => `${r.name} ×${r.count}`).join(', ') : 'None';
const refusals = (uploads: Uploads) => uploads.refusals_7d.map(r => ({ name: r.code, count: r.count }));
const rejections = (uploads: Uploads) => {
  const byReason = new Map<string, number>();
  for (const s of uploads.sources) for (const r of s.rejected_readings_7d) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + r.count);
  return [...byReason].map(([name, count]) => ({ name, count }));
};
const At = ({ iso, now, lead = '' }: { iso: string; now: Date; lead?: string }) => <time dateTime={iso} title={exactTime(iso)}>{lead}{relativeTime(iso, now)}</time>;
const FRESHNESS = {
  fresh: 'Fresh',
  stale: 'Stale: derived more than six hours ago, or for an earlier day.',
  expired: 'Expired: derived more than three days ago. Waldo treats these as out of date.',
} as const;

function PillarCard({ title, pillar }: { title: string; pillar: Pillar }) {
  return <div className="tile"><h3>{title}</h3>{pillar.state === 'available'
    ? <><p className="value">{Math.round(pillar.score)}</p><p>{pillar.zone ?? 'No zone word yet'}</p></>
    : <><p className="value">Unavailable</p><p>{reasonText(pillar.reason)}</p></>}</div>;
}
const sleepDebtLine = (debt: SleepDebt) => debt.state === 'partial' ? 'Sleep debt: not enough nights yet'
  : debt.state === 'unavailable' ? `Sleep debt: unavailable. ${reasonText(debt.reason)}`
  : debt.debt_minutes < 1 ? 'Sleep debt: none' : `Sleep debt: ${Math.floor(debt.debt_minutes / 60)} h ${Math.round(debt.debt_minutes % 60)} min`;

function ScoresSection({ scores, now }: { scores: Scores | null; now: Date }) {
  if (!scores) return <section className="panel" role="status"><h2>Today’s scores</h2><p>Couldn’t read your scores. Try again.</p></section>;
  if (scores.state === 'unavailable') return <section className="panel"><h2>Today’s scores</h2><p>{reasonText(scores.reason)}</p></section>;
  return <section className="panel"><h2>Scores for {scores.day}</h2>
    <p><span className={`access-label ${scores.freshness === 'fresh' ? 'done' : 'needs'}`}>{FRESHNESS[scores.freshness]}</span> <At iso={scores.compiled_at} now={now} lead="Derived "/></p>
    <div className="controls-stack"><PillarCard title="Recovery" pillar={scores.recovery}/><PillarCard title="Form" pillar={scores.form}/><PillarCard title="Weight" pillar={scores.weight}/></div>
    {scores.sleep_debt && <p>{sleepDebtLine(scores.sleep_debt)}</p>}
  </section>;
}

function UploadsSection({ uploads, now }: { uploads: Uploads | null; now: Date }) {
  if (!uploads) return <section className="panel" role="status"><h2>Sources</h2><p>Couldn’t read your uploads. Try again.</p></section>;
  const refused = uploads.refusals_7d.reduce((n, r) => n + r.count, 0);
  return <section className="panel"><h2>Sources</h2>
    {uploads.sources.length === 0 ? <p>No uploads yet.</p> : uploads.sources.map(s => {
      const rejected = s.rejected_readings_7d.reduce((n, r) => n + r.count, 0);
      return <div key={s.source} className="tile"><h3>{SOURCE_LABEL[s.source]}</h3>
        <p><At iso={s.newest_upload_at} now={now} lead="Last upload "/></p>
        <p>{plural(s.uploads_7d, 'upload')} in the last 7 days{rejected > 0 && `, ${plural(rejected, 'reading')} rejected`}</p></div>;
    })}
    {refused > 0 && <p>{plural(refused, 'upload')} refused in the last 7 days ({tally(refusals(uploads))}). Only uploads refused after sign-in are counted.</p>}
    {uploads.newest_derived && <p>Newest derived day: {uploads.newest_derived.day}, <At iso={uploads.newest_derived.compiled_at} now={now}/>.</p>}
  </section>;
}

const consentLine = (row: Consent | undefined) => !row || row.status === 'not_granted' ? 'Not shared'
  : row.status === 'granted' ? `Shared since ${row.granted_at ? exactTime(row.granted_at) : 'an unrecorded time'}`
  : `Withdrawn ${row.withdrawn_at ? exactTime(row.withdrawn_at) : ''}`.trim();
function ConsentSection({ consents }: { consents: Consent[] | null }) {
  if (!consents) return <section className="panel" role="status"><h2>Consent</h2><p>Couldn’t read your consent. Try again.</p></section>;
  const sources = [...new Set(consents.map(c => c.source))];
  const purposes = (source: Source | null) => (['storage_compute', 'model_processing'] as const).map(purpose =>
    <p key={purpose}><strong>{PURPOSE_LABEL[purpose]}</strong>: {consentLine(source ? consents.find(c => c.source === source && c.purpose === purpose) : undefined)}</p>);
  return <section className="panel"><h2>Consent</h2>
    {sources.length === 0 ? purposes(null) : sources.map(source => <div key={source}><h3>{SOURCE_LABEL[source]}</h3>{purposes(source)}</div>)}
    <p>Change what you share in the Waldo app.</p>
  </section>;
}

export function HealthView({ state, now, onRetry }: { state: HealthState; now: Date; onRetry?: () => void }) {
  if (state.kind === 'loading') return <p role="status">Reading your health…</p>;
  if (state.kind === 'error') return <section className="panel" role="alert"><h2>{state.signedOut ? 'Sign in to your Waldo.' : 'Couldn’t load your health.'}</h2><p>{state.message}</p>
    {state.signedOut ? <a className="button-link" href="/console/signin">Sign in</a> : onRetry && <button onClick={onRetry}>Try again</button>}</section>;
  const { data } = state;
  return <>
    <div className="section-head"><h2>Health.</h2><p>What Waldo sees from your health data: the scores it derived, where they came from, and what you agreed to.</p></div>
    <ScoresSection scores={data.scores} now={now}/>
    <UploadsSection uploads={data.freshness} now={now}/>
    <ConsentSection consents={data.consents}/>
  </>;
}

export function HealthPanel() {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });
  const load = useCallback((signal?: AbortSignal) => {
    fetchHealth(signal).then(data => setState({ kind: 'ready', data }), (error: unknown) => {
      if (signal?.aborted) return;
      setState({ kind: 'error', signedOut: error instanceof SignInRequired, message: error instanceof Error ? error.message : 'Your health view is unavailable right now.' });
    });
  }, []);
  useEffect(() => { const abort = new AbortController(); load(abort.signal); return () => abort.abort(); }, [load]);
  return <HealthView state={state} now={new Date()} onRetry={() => { setState({ kind: 'loading' }); load(); }}/>;
}

export function AdminHealthView({ state, now, onRefresh }: { state: AdminHealthState; now: Date; onRefresh?: () => void }) {
  if (state.kind === 'loading') return <p role="status">Checking access…</p>;
  if (state.kind === 'absent') return <section className="panel"><h2>Page not found.</h2><a href="#/today">Return to Today</a></section>;
  if (state.kind === 'error') return <section className="panel" role="alert"><h2>This page is unavailable.</h2><p>{state.message}</p>{onRefresh && <button onClick={onRefresh}>Retry</button>}</section>;
  const { owners } = state.data;
  return <>
    <div className="section-head"><h2>Tester health.</h2><p>When each tester’s uploads arrived, what was refused and why, and what they agreed to. Counts, times and codes only: no readings or scores. Refusals count uploads refused after sign-in; a signed-out or rate-limited upload is not counted.</p>{onRefresh && <button className="quiet" onClick={onRefresh}>Refresh</button>}</div>
    <section className="panel"><div className="table-scroll" tabIndex={0} role="region" aria-label="Tester health records"><table>
      <thead><tr>{['Tester', 'Consent', 'Newest upload', 'Uploads, 7 days', 'Refused, 7 days', 'Rejected readings, 7 days', 'Newest derived day'].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{owners.map(o => <tr key={o.id}>
        <td>{o.email ?? 'No email recorded'}{o.state !== 'active' && <small> · {o.state}</small>}</td>
        <td>{o.consents.length ? o.consents.map(c => <div key={`${c.source}:${c.purpose}`}>{SOURCE_LABEL[c.source]} {c.purpose === 'storage_compute' ? 'storage' : 'model'}: {consentLine(c)}</div>) : 'Not shared'}</td>
        <td>{o.freshness.sources.length ? o.freshness.sources.map(s => <div key={s.source} title={exactTime(s.newest_upload_at)}>{SOURCE_LABEL[s.source]}: {relativeTime(s.newest_upload_at, now)}</div>) : 'No uploads'}</td>
        <td>{o.freshness.sources.reduce((n, s) => n + s.uploads_7d, 0)}</td>
        <td>{tally(refusals(o.freshness))}</td>
        <td>{tally(rejections(o.freshness))}</td>
        <td>{o.freshness.newest_derived?.day ?? 'None'}</td>
      </tr>)}</tbody>
    </table></div>{!owners.length && <p>No owner records were returned.</p>}</section>
  </>;
}

export function AdminHealthPanel() {
  const [state, setState] = useState<AdminHealthState>({ kind: 'loading' });
  const load = useCallback((signal?: AbortSignal) => {
    fetchAdminHealth(signal).then(data => setState(data ? { kind: 'ready', data } : { kind: 'absent' }), (error: unknown) => {
      if (!signal?.aborted) setState({ kind: 'error', message: error instanceof Error ? error.message : 'Tester health is unavailable right now.' });
    });
  }, []);
  useEffect(() => { const abort = new AbortController(); load(abort.signal); return () => abort.abort(); }, [load]);
  return <AdminHealthView state={state} now={new Date()} onRefresh={() => { setState({ kind: 'loading' }); load(); }}/>;
}
