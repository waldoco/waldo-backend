import { type CSSProperties, useMemo, useState } from 'react';
import type { Claim } from './memory-model';

// Saved Spots on a month calendar, one stamp per day (after the stamp-calendar reference). A stamp holds up to three
// marks in the map's shapes (said, confirmed, inferred) and a count. Choosing a day filters the list to it.

export const dayKey = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const monthKey = (day: string) => day.slice(0, 7);
const shapeOf = (source: string) => source === 'stated' ? 'circle' : source === 'confirmed' ? 'square' : 'triangle';
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Mark({ shape }: { shape: string }) {
  return <svg viewBox="0 0 12 12" aria-hidden="true">{shape === 'circle' ? <circle cx="6" cy="6" r="4"/> : shape === 'square' ? <rect x="2" y="2" width="8" height="8"/> : <path d="M6 1.6 10.6 10H1.4Z"/>}</svg>;
}

export function SpotCalendar({ spots, selected, onSelect }: { spots: Claim[]; selected: string | null; onSelect: (day: string | null) => void }) {
  const byDay = useMemo(() => {
    const map = new Map<string, Claim[]>();
    for (const spot of spots) { const key = dayKey(spot.recorded_at); if (key) map.set(key, [...(map.get(key) ?? []), spot]); }
    return map;
  }, [spots]);
  const months = useMemo(() => [...new Set([...byDay.keys()].map(monthKey))].sort(), [byDay]);
  const [month, setMonth] = useState(() => months.at(-1) ?? null);
  if (!month) return <p className="meta">No dated Spots on this page.</p>;
  const [year, mon] = month.split('-').map(Number) as [number, number];
  const first = new Date(year, mon - 1, 1), days = new Date(year, mon, 0).getDate();
  const cells: (number | null)[] = [...Array(first.getDay()).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const at = months.indexOf(month);
  const name = new Intl.DateTimeFormat('en', { month: 'long' }).format(first);
  return <div className="cal">
    <div className="cal-head">
      <span className="cal-num">{String(mon).padStart(2, '0')}</span><span className="cal-year">{year}</span><span className="cal-month">{name}</span>
      <span className="cal-nav"><button type="button" className="quiet" aria-label="Earlier month" disabled={at <= 0} onClick={() => setMonth(months[at - 1]!)}>‹</button><button type="button" className="quiet" aria-label="Later month" disabled={at >= months.length - 1} onClick={() => setMonth(months[at + 1]!)}>›</button></span>
    </div>
    <div className="cal-grid" role="grid" aria-label={`Spots saved in ${name} ${year}`}>
      {WEEK.map(day => <span key={day} className="cal-dow" role="columnheader">{day}</span>)}
      {cells.map((day, index) => {
        if (day === null) return <span key={`pad-${index}`} className="cal-cell pad" aria-hidden="true"/>;
        const key = `${month}-${String(day).padStart(2, '0')}`, list = byDay.get(key) ?? [];
        if (!list.length) return <span key={key} className="cal-cell empty" role="gridcell"><b>{day}</b></span>;
        return <button key={key} type="button" role="gridcell" className="cal-cell has" aria-pressed={selected === key} aria-label={`${name} ${day}: ${list.length} ${list.length === 1 ? 'Spot' : 'Spots'} saved`} style={{ '--i': index } as CSSProperties} onClick={() => onSelect(selected === key ? null : key)}>
          <b>{day}</b><span className="stamp">{list.slice(0, 3).map((spot, i) => <Mark key={i} shape={shapeOf(spot.source)}/>)}{list.length > 3 && <small>+{list.length - 3}</small>}</span>
        </button>;
      })}
    </div>
  </div>;
}
