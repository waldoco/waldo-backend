import type { CSSProperties } from 'react';

export const stagger = (index: number) => ({ '--i': index }) as CSSProperties;

const parts = (value: Date | string, zone: string) => {
  try {
    const found = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
    const get = (type: string) => found.find(part => part.type === type)?.value ?? '';
    const minutes = Number(get('hour')) * 60 + Number(get('minute'));
    return Number.isFinite(minutes) ? { day: `${get('year')}-${get('month')}-${get('day')}`, minutes } : null;
  } catch { return null; }
};
export const localMinutes = (value: Date | string, zone: string) => parts(value, zone)?.minutes ?? null;
export const sameLocalDay = (a: Date | string, b: Date | string, zone: string) => { const left = parts(a, zone), right = parts(b, zone); return !!left && !!right && left.day === right.day; };
export const clockLabel = (value: Date | string, zone: string) => {
  try { return new Intl.DateTimeFormat('en', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(value)); } catch { return ''; }
};
export const minutesLabel = (minutes: number) => { const h = Math.floor(minutes / 60) % 24, m = minutes % 60; return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

export type RailMark = { key: string; at: number; label: string; time: string; kind: 'done' | 'next' | 'plain' };
export type RailLane = RailMark & { pct: number; lane: 0 | 1; edge: 'l' | 'r' | null };
// Labels sit under their marks; a mark too close to the previous one drops to a second lane.
export const railLayout = (marks: RailMark[]): RailLane[] => {
  const laid: RailLane[] = [];
  for (const mark of [...marks].sort((a, b) => a.at - b.at)) {
    const pct = Math.min(100, Math.max(0, (mark.at / 1440) * 100));
    const previous = laid.at(-1);
    const lane: 0 | 1 = previous && pct - previous.pct < 18 && previous.lane === 0 ? 1 : 0;
    laid.push({ ...mark, pct, lane, edge: pct < 9 ? 'l' : pct > 91 ? 'r' : null });
  }
  return laid;
};

const axis = ['12 am', '6', '12 pm', '6', '12 am'];

export function DayRail({ marks, now, quiet, summary }: { marks: RailMark[]; now: number; quiet?: { start: number; end: number } | null; summary: string }) {
  const laid = railLayout(marks);
  const nowPct = Math.min(100, Math.max(0, (now / 1440) * 100));
  const quietSegments = quiet ? (quiet.start <= quiet.end ? [[quiet.start, quiet.end]] : [[0, quiet.end], [quiet.start, 1440]]) : [];
  return <div className="rail" role="img" aria-label={summary}>
    <div className="rail-track" aria-hidden="true">
      {quietSegments.map(([from, to], index) => <i key={index} className="rail-quiet" style={{ left: `${(from! / 1440) * 100}%`, width: `${((to! - from!) / 1440) * 100}%` }}/>)}
      <i className="rail-elapsed" style={{ width: `${nowPct}%` }}/>
      {laid.map(mark => <span key={mark.key} className={`rail-mark ${mark.kind}${mark.lane ? ' lane' : ''}${mark.edge ? ` edge-${mark.edge}` : ''}`} style={{ left: `${mark.pct}%` }}><b/><em><strong>{mark.label}</strong>{mark.time}</em></span>)}
      <span className="rail-now" style={{ left: `${nowPct}%` }}><b/><em>Now</em></span>
    </div>
    <div className="rail-axis" aria-hidden="true">{axis.map((tick, index) => <span key={index}>{tick}</span>)}</div>
  </div>;
}

export type PulseItem = { label: string; time: string; ms: number; ok: boolean };
export const pulseHeight = (ms: number) => Math.round(10 + Math.sqrt(Math.min(Math.max(ms, 0), 4000) / 4000) * 38);
export function PulseStrip({ items, selected, onSelect }: { items: PulseItem[]; selected: number | null; onSelect: (index: number) => void }) {
  return <div className="pulse" role="group" aria-label="Recent attempts, oldest to newest. Bar height is recorded duration.">
    {[...items].reverse().map((item, index) => {
      const source = items.length - 1 - index;
      return <button key={source} type="button" className={`pulse-bar${item.ok ? '' : ' failed'}`} aria-pressed={selected === source} aria-label={`${item.label}, ${item.ok ? 'attempt recorded' : 'failure recorded'}, ${item.ms} ms, ${item.time}`} style={{ '--h': `${pulseHeight(item.ms)}px`, '--i': index } as CSSProperties} onClick={() => onSelect(source)}><i/></button>;
    })}
  </div>;
}

export type PipelineStep = { step: string; state: 'ok' | 'failed' | 'unseen' };
export function Pipeline({ steps }: { steps: PipelineStep[] }) {
  return <ol className="pipeline" aria-label="Recorded steps">{steps.map((item, index) => <li key={index} className={item.state} style={{ '--i': index } as CSSProperties}>
    <span className="node" aria-hidden="true">{item.state === 'ok' ? <svg viewBox="0 0 16 16"><path d="m4 8.5 2.8 2.7L12 5.5"/></svg> : item.state === 'failed' ? <svg viewBox="0 0 16 16"><path d="m5 5 6 6m0-6-6 6"/></svg> : null}</span>
    <span className="step-name">{item.step}</span><span className="visually-hidden">{item.state === 'ok' ? 'Successful step recorded' : item.state === 'failed' ? 'Failure recorded' : 'Not seen yet'}</span>
  </li>)}</ol>;
}

export type Segment = { key: string; label: string; count: number };
export function SourceBar({ segments, scope }: { segments: Segment[]; scope: string }) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  if (!total) return null;
  return <div className="mix" role="group" aria-label={`${scope}: ${segments.filter(s => s.count).map(s => `${s.count} ${s.label}`).join(', ')}`}>
    <div className="mix-bar" aria-hidden="true">{segments.filter(s => s.count).map((segment, index) => <i key={segment.key} className={`seg seg-${index % 4}`} style={{ flexGrow: segment.count, '--i': index } as CSSProperties}/>)}</div>
    <ul className="mix-legend">{segments.filter(s => s.count).map((segment, index) => <li key={segment.key}><i className={`seg seg-${index % 4}`} aria-hidden="true"/>{segment.count} {segment.label}</li>)}<li className="label">{scope}</li></ul>
  </div>;
}
