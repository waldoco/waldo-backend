import { useEffect, useState } from 'react';
import { activityLabel } from './activity-labels';
import { chatStore } from './chat-store';
import { excerptText, paragraphs } from './day-cards-model';
import { chatSeed, dayLabel, fetchDayDetail, fetchDaysList, type DayDetail, type DaysList, type HistoryCard } from './day-history-model';
import { clockLabel } from './Infographics';

const STATE_WORDS: Readonly<Record<HistoryCard['state'], string>> = {
  sent: 'Went out', skipped: 'Skipped', pending: 'Still to come', not_sent: 'Didn’t go out', unknown: 'Finished',
};

/** "Chat about this": Main chat opens with the card and day already named in the composer. Nothing is sent until the owner sends it. */
export const chatAbout = (card: HistoryCard, date: string) => {
  chatStore().setDraft(chatSeed(card, date));
  window.location.hash = '#/chat';
};

/**
 * One day as the app's Home showed it: each card with the words it delivered to Main chat, the update cards, and the night before it from
 * the Close to the Brief. A day or night that began before Waldo kept history says so instead of looking empty.
 */
export function DayView({ detail, since, onChat }: { detail: DayDetail; since: string | null; onChat: (card: HistoryCard) => void }) {
  const zone = detail.timezone, { night, updates } = detail;
  const elsewhere = updates.total - updates.items.length;
  return <>
    {!detail.complete && <p className="meta">{since ? `Waldo began keeping day history on ${dayLabel(since)}, so this day shows only what was kept.` : 'Waldo hadn’t begun keeping day history, so this day shows only what was kept.'}</p>}
    {detail.cards.length ? <ol className="day-cards">{detail.cards.map(card => <li key={card.id} className="day-card">
      <div className="day-card-head"><span className="strong">{card.name}</span><span className="meta">{STATE_WORDS[card.state]}</span></div>
      {card.latest ? <>
        <div className="card-letter" role="group" aria-label={paragraphs(excerptText(card.latest.excerpt)).join(' ')}>{paragraphs(excerptText(card.latest.excerpt)).map((line, p) => <p key={p} aria-hidden="true">{line}</p>)}</div>
        <p className="meta">Arrived {clockLabel(new Date(card.latest.delivered_at), zone)} · <button className="quiet-link" type="button" onClick={() => onChat(card)}>Chat about this</button></p>
      </> : card.state === 'sent' && <p className="meta">{card.latest === null ? 'It went out somewhere other than Chat, or its message is gone.' : 'Its words couldn’t be read just now.'}</p>}
    </li>)}</ol> : <p>No cards were planned or sent this day.</p>}
    {updates.total > 0 && <div className="day-history-updates">
      <span className="label">{updates.total === 1 ? '1 update' : `${updates.total} updates`}</span>
      {updates.items.map(item => <p key={item.message_id}><span className="meta">{clockLabel(new Date(item.delivered_at), zone)}</span> {excerptText(item.excerpt)}</p>)}
      {elsewhere > 0 && <p className="meta">{elsewhere === 1 ? '1 more went' : `${elsewhere} more went`} somewhere other than Chat.</p>}
    </div>}
    <details className="disclosure">
      <summary><span className="label key">Overnight</span><span className="value">{night.total === 1 ? '1 run' : `${night.total} runs`}</span></summary>
      <div className="disclosure-body">
        <p className="meta">From {clockLabel(new Date(night.from), zone)} to {clockLabel(new Date(night.to), zone)}.{!night.complete && ' Part of this night wasn’t kept, so some runs may be missing.'}</p>
        {night.runs.length ? <ul className="night-runs">{night.runs.map(run => <li key={run.id}>
          <span className="meta">{clockLabel(new Date(run.started_at), zone)}</span> {activityLabel(run.kind)}: {run.summary?.trim() ? run.summary : run.status}
        </li>)}</ul> : <p>Nothing ran that night.</p>}
        {night.total > night.runs.length && <p className="meta">Showing the first {night.runs.length}.</p>}
      </div>
    </details>
  </>;
}

type Read<T> = { kind: 'reading' } | { kind: 'failed' } | { kind: 'ready'; value: T };

/** Day by day on Today: the last fourteen days, stepped through from today back, each read when it is opened. */
export function DayHistory() {
  const [list, setList] = useState<Read<DaysList>>({ kind: 'reading' });
  const [at, setAt] = useState(0);
  const [detail, setDetail] = useState<Read<DayDetail>>({ kind: 'reading' });
  useEffect(() => { fetchDaysList().then(value => setList({ kind: 'ready', value }), () => setList({ kind: 'failed' })); }, []);
  const date = list.kind === 'ready' ? list.value.days[at]?.date : undefined;
  useEffect(() => {
    if (!date) return;
    const abort = new AbortController();
    setDetail({ kind: 'reading' });
    fetchDayDetail(date, abort.signal).then(value => setDetail({ kind: 'ready', value }), () => { if (!abort.signal.aborted) setDetail({ kind: 'failed' }); });
    return () => abort.abort();
  }, [date]);
  if (list.kind === 'failed') return <section className="tile day-history-tile"><span className="label">Day by day</span><p>Couldn’t read your earlier days.</p></section>;
  if (list.kind === 'reading' || !date) return <section className="tile day-history-tile" aria-busy="true"><span className="label">Day by day</span><p className="meta">Reading your earlier days…</p></section>;
  const days = list.value.days;
  return <section className="tile day-history-tile" aria-label="Day by day">
    <div className="day-pager">
      <button className="quiet" type="button" disabled={at >= days.length - 1} onClick={() => setAt(at + 1)} aria-label="Earlier day">‹ Earlier</button>
      <span className="strong" aria-live="polite">{at === 0 ? `Today, ${dayLabel(date)}` : dayLabel(date)}</span>
      <button className="quiet" type="button" disabled={at === 0} onClick={() => setAt(at - 1)} aria-label="Later day">Later ›</button>
    </div>
    {detail.kind === 'ready' && detail.value.date === date ? <DayView detail={detail.value} since={list.value.history_since} onChat={card => chatAbout(card, date)}/>
      : detail.kind === 'failed' ? <p>Couldn’t read {dayLabel(date)}.</p> : <p className="meta">Reading {dayLabel(date)}…</p>}
  </section>;
}
