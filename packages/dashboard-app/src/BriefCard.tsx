import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { fetchDayLatest } from './chat-model';
import { fetchControls, submitControl, type DayRecord } from './controls-model';
import { clockLabel, minutesLabel } from './Infographics';
import { excerptCut, excerptText, firstReveal, paragraphs, revealWords, type BriefLatest } from './brief-model';

type Card = DayRecord['data']['cards'][number];

/** The Brief's words, still or played in word by word. Screen readers get the whole text from the container, never word by word. */
function Letter({ text, play }: { text: string; play: boolean }) {
  const label = paragraphs(text).join(' ');
  return <div className="brief-letter" role="group" aria-label={label}>
    {play
      ? revealWords(text).map((words, p) => <p key={p}>{words.map((word, k) => <span key={k}><span className="brief-word" aria-hidden="true" style={{ '--at': `${word.at}ms` } as CSSProperties}>{word.text}</span>{k < words.length - 1 ? ' ' : ''}</span>)}</p>)
      : paragraphs(text).map((line, p) => <p key={p} aria-hidden="true">{line}</p>)}
  </div>;
}

const wallTime = (time: string) => { const [h, m] = time.split(':').map(Number); return minutesLabel(h! * 60 + m!); };

/**
 * The Brief on Today, as the app's Home shows it, from the same day view. `latest`: the delivery to Main chat, null when the Brief went
 * nowhere there, undefined when the Worker could not tell. What went out is shown first; otherwise why Waldo couldn't make it (with Try
 * again while today's tries are left), that he is making it, or when it comes.
 */
export function BriefCardView({ card, latest, zone, play = false, busy, onRetry }: { card: Card; latest?: BriefLatest | null; zone: string; play?: boolean; busy: boolean; onRetry: () => void }) {
  if (latest) return <>
    <Letter text={excerptText(latest.excerpt)} play={play}/>
    <p className="meta">Arrived {clockLabel(new Date(latest.delivered_at), zone)}{excerptCut(latest.excerpt) && <> · <a className="quiet-link" href="#/chat">Read it all in Chat</a></>}</p>
  </>;
  const stuck = (card.state === 'failed' || card.state === 'paused' || card.state === 'skipped') && !!card.state_reason;
  if (card.state === 'generating') return <p>Making your Brief now.</p>;
  if (stuck) {
    const left = card.retries_left ?? 0;
    return <div className="brief-trouble">
      <p><strong>Couldn’t make your Brief.</strong> {card.state_reason}.</p>
      {left > 0 && <p><button className="quiet" type="button" disabled={busy} onClick={onRetry}>Try again</button> <span className="meta">{left === 1 ? '1 try left today' : `${left} tries left today`}</span></p>}
    </div>;
  }
  if (card.state === 'skipped') return <p>Waldo skipped today’s Brief.</p>;
  if (card.sent) return latest === null ? <p>Your Brief went out somewhere other than Chat, so it isn’t shown here.</p> : <p>Your Brief went out. <a href="#/chat">Read it in Chat.</a></p>;
  if (card.state === 'held') return <p>Your Brief is held for your quiet hours.</p>;
  return <p>No Brief yet today. It comes at {wallTime(card.time ?? card.defaultTime)}.</p>;
}

type Read = { kind: 'reading' } | { kind: 'failed' } | { kind: 'ready'; day: DayRecord; latest: ReadonlyMap<string, BriefLatest | null> };

// Reads today's day view (its card states, and the action route's revision for Try again) and, beside it, what each card delivered to
// Main chat. The second read failing leaves the text unknown, never the card: the Brief is still said to have gone out.
export function BriefCard() {
  const [read, setRead] = useState<Read>({ kind: 'reading' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [played, setPlayed] = useState<{ id: string; play: boolean } | null>(null);
  const load = useCallback(async () => {
    const latest = fetchDayLatest().catch(() => new Map<string, BriefLatest | null>());
    try { setRead({ kind: 'ready', day: await fetchControls('day'), latest: await latest }); } catch { setRead({ kind: 'failed' }); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const card = read.kind === 'ready' ? read.day.data.cards.find(item => item.id === 'card:brief') : undefined;
  const latest = read.kind === 'ready' && card ? read.latest.get(card.id) : undefined;
  // Decided once per Brief, the first time this mount draws it.
  useEffect(() => { if (latest && played?.id !== latest.message_id) setPlayed({ id: latest.message_id, play: firstReveal(latest.message_id) }); }, [latest, played]);
  if (read.kind === 'reading') return <section className="tile brief-tile" aria-busy="true"><span className="label">The Brief</span><p className="meta">Reading today’s Brief…</p></section>;
  if (read.kind === 'failed') return <section className="tile brief-tile"><span className="label">The Brief</span><p>Couldn’t read today’s Brief.</p><p><button className="quiet" type="button" onClick={() => { setRead({ kind: 'reading' }); void load(); }}>Try again</button></p></section>;
  // A day without the Brief's card: the daily brief is off.
  if (!card) return null;
  const day = read.day;
  const retry = async () => {
    setBusy(true); setNote(null);
    try { setNote((await submitControl(day, 'card.retry', { id: card.id }, crypto.randomUUID())).receipt.message); }
    catch (error) { setNote(error instanceof Error ? error.message : 'That didn’t go through. Try again in a moment.'); }
    finally { setBusy(false); await load(); }
  };
  // Held out of sight until it is known whether this Brief plays, so it never shows still and then plays.
  const waiting = !!latest && played?.id !== latest.message_id;
  return <section className="tile brief-tile" style={waiting ? { visibility: 'hidden' } : undefined}>
    <span className="label">The Brief</span>
    <BriefCardView card={card} latest={latest} zone={day.data.timezone} play={!!latest && played?.play === true} busy={busy} onRetry={() => void retry()}/>
    {note && <p className="meta" role="status">{note}</p>}
  </section>;
}
