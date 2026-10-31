import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { fetchAppDay } from './chat-model';
import { fetchControls, submitControl, type DayRecord } from './controls-model';
import { clockLabel, minutesLabel } from './Infographics';
import { cardName, excerptCut, excerptText, firstReveal, paragraphs, revealWords, type AppDay, type CardLatest } from './day-cards-model';

type Card = DayRecord['data']['cards'][number];

/** A card's words, still or played in word by word. Screen readers get the whole text from the container, never word by word. */
function Letter({ text, play }: { text: string; play: boolean }) {
  return <div className="card-letter" role="group" aria-label={paragraphs(text).join(' ')}>
    {play
      ? revealWords(text).map((words, p) => <p key={p}>{words.map((word, k) => <span key={k}><span className="card-word" aria-hidden="true" style={{ '--at': `${word.at}ms` } as CSSProperties}>{word.text}</span>{k < words.length - 1 ? ' ' : ''}</span>)}</p>)
      : paragraphs(text).map((line, p) => <p key={p} aria-hidden="true">{line}</p>)}
  </div>;
}

const timeOf = (card: Card) => card.time ?? card.defaultTime;
const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h! * 60 + m!; };
// Minutes after midnight now in the owner's zone, or null when the zone can't be read.
const zoneMinutes = (zone: string, now: number) => {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
    return Number(parts.find(part => part.type === 'hour')?.value) * 60 + Number(parts.find(part => part.type === 'minute')?.value);
  } catch { return null; }
};

/**
 * One of today's cards, as the app's Home says it, from the same day view. `latest`: its delivery to Main chat, null when it went nowhere
 * there, undefined when the Worker could not tell. What went out is shown first; otherwise why Waldo couldn't make it (with Try again while
 * today's tries are left), that he is making it, or when it comes. `dailyBrief` false: the daily brief is off, so nothing is said to be coming.
 */
export function DayCardView({ card, latest, zone, dailyBrief = null, now = Date.now(), play = false, busy, onRetry }: {
  card: Card; latest?: CardLatest | null; zone: string; dailyBrief?: boolean | null; now?: number; play?: boolean; busy: boolean; onRetry: () => void;
}) {
  const named = cardName(card.name);
  if (latest) return <>
    <Letter text={excerptText(latest.excerpt)} play={play}/>
    <p className="meta">{latest.revised_at === undefined ? 'Arrived' : 'Updated'} {clockLabel(new Date(latest.revised_at ?? latest.delivered_at), zone)}{excerptCut(latest.excerpt) && <> · <a className="quiet-link" href="#/chat">Read it all in Chat</a></>}</p>
  </>;
  if (card.state === 'generating') return <p>Waldo is making {named} now.</p>;
  if ((card.state === 'failed' || card.state === 'paused' || card.state === 'skipped') && card.state_reason) {
    const left = card.retries_left ?? 0;
    return <div className="card-trouble">
      <p><strong>Waldo couldn’t make {named}.</strong> {card.state_reason}.</p>
      {left > 0 && <p><button className="quiet" type="button" disabled={busy} onClick={onRetry}>Try again</button> <span className="meta">{left === 1 ? '1 try left today' : `${left} tries left today`}</span></p>}
    </div>;
  }
  if (card.state === 'skipped') return <p>Waldo skipped {named} today.</p>;
  if (card.sent) return latest === null ? <p>{card.name} went out somewhere other than Chat, so it isn’t shown here.</p> : <p>{card.name} went out. <a href="#/chat">Read it in Chat.</a></p>;
  if (card.state === 'held') return <p>{card.name} is held for your quiet hours.</p>;
  if (dailyBrief === false) return <p>Not today: the daily brief is off.</p>;
  const at = zoneMinutes(zone, now), due = minutesOf(timeOf(card));
  return at !== null && at >= due ? <p>Due at {minutesLabel(due)}, not out yet.</p> : <p>Not yet. It comes at {minutesLabel(due)}.</p>;
}

/**
 * Today's cards stacked in the order of the day, as the app's Home lists them: the Brief, Check-in and the Close, each under its name and
 * time, split by hairlines. `play` says which delivered messages play in.
 */
export function DayCardsView({ cards, app, zone, now = Date.now(), play, busy, onRetry }: {
  cards: readonly Card[]; app: AppDay | null; zone: string; now?: number; play: (id: string) => boolean; busy: boolean; onRetry: (id: string) => void;
}) {
  const ordered = [...cards].sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
  return <ol className="day-cards">{ordered.map(card => {
    const latest = app?.latest.get(card.id);
    return <li key={card.id} className="day-card">
      <div className="day-card-head"><span className="strong">{card.name}</span><span className="meta">{minutesLabel(minutesOf(timeOf(card)))}</span></div>
      <DayCardView card={card} latest={latest} zone={zone} dailyBrief={app?.dailyBrief ?? null} now={now} play={!!latest && play(latest.message_id)} busy={busy} onRetry={() => onRetry(card.id)}/>
    </li>;
  })}</ol>;
}

type Read = { kind: 'reading' } | { kind: 'failed' } | { kind: 'ready'; day: DayRecord; app: AppDay | null };

// Reads today's day view (its card states, and the action route's revision for Try again) and, beside it, the app's day view for what each
// card delivered to Main chat. The second read failing leaves the words unknown, never the cards: each is still said to have gone out.
export function DayCards() {
  const [read, setRead] = useState<Read>({ kind: 'reading' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Whether each delivered message plays in, decided once per message the first time this mount draws it.
  const [played, setPlayed] = useState<ReadonlyMap<string, boolean>>(new Map());
  const load = useCallback(async () => {
    const app = fetchAppDay().catch(() => null);
    try { setRead({ kind: 'ready', day: await fetchControls('day'), app: await app }); } catch { setRead({ kind: 'failed' }); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const delivered = read.kind === 'ready' && read.app ? read.day.data.cards.flatMap(card => { const latest = read.app!.latest.get(card.id); return latest ? [latest.message_id] : []; }) : [];
  const undecided = delivered.filter(id => !played.has(id));
  const pending = undecided.join('\n');
  useEffect(() => {
    if (!pending) return;
    setPlayed(previous => { const next = new Map(previous); for (const id of pending.split('\n')) if (!next.has(id)) next.set(id, firstReveal(id)); return next; });
  }, [pending]);
  if (read.kind === 'reading') return <section className="tile day-cards-tile" aria-busy="true"><span className="label">Today’s messages</span><p className="meta">Reading today’s messages…</p></section>;
  if (read.kind === 'failed') return <section className="tile day-cards-tile"><span className="label">Today’s messages</span><p>Couldn’t read today’s messages.</p><p><button className="quiet" type="button" onClick={() => { setRead({ kind: 'reading' }); void load(); }}>Try again</button></p></section>;
  const day = read.day;
  if (!day.data.cards.length) return null;
  const retry = async (id: string) => {
    setBusy(true); setNote(null);
    try { setNote((await submitControl(day, 'card.retry', { id }, crypto.randomUUID())).receipt.message); }
    catch (error) { setNote(error instanceof Error ? error.message : 'That didn’t go through. Try again in a moment.'); }
    finally { setBusy(false); await load(); }
  };
  // Held out of sight until it is known which messages play, so none shows still and then plays.
  return <section className="tile day-cards-tile" aria-label="Today’s messages" style={undecided.length ? { visibility: 'hidden' } : undefined}>
    <span className="label">Today’s messages</span>
    <DayCardsView cards={day.data.cards} app={read.app} zone={day.data.timezone} play={id => played.get(id) === true} busy={busy} onRetry={id => void retry(id)}/>
    {note && <p className="meta" role="status">{note}</p>}
  </section>;
}
