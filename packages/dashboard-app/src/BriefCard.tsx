import { useCallback, useEffect, useState } from 'react';
import { fetchControls, submitControl, type DayRecord } from './controls-model';

type Card = DayRecord['data']['cards'][number];

// The Brief as the app's Home says it, from the same day view: why Waldo couldn't make it, that he is making it, or nothing extra
// when it went out or is still to come (the disclosure already says those). Try again only while today's tries are left.
export function BriefCardView({ card, busy, onRetry }: { card: Card; busy: boolean; onRetry: () => void }) {
  const stuck = (card.state === 'failed' || card.state === 'paused' || card.state === 'skipped') && !!card.state_reason;
  if (card.state === 'generating') return <p>Making your Brief now.</p>;
  if (!stuck) return null;
  const left = card.retries_left ?? 0;
  return <div className="brief-trouble">
    <p><strong>Couldn’t make your Brief.</strong> {card.state_reason}.</p>
    {left > 0 && <p><button className="quiet" type="button" disabled={busy} onClick={onRetry}>Try again</button> <span className="meta">{left === 1 ? '1 try left today' : `${left} tries left today`}</span></p>}
  </div>;
}

// Reads today's day view and runs Try again through the console's own action route, as the owner. Read-only apart from that.
export function BriefCard() {
  const [day, setDay] = useState<DayRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const read = useCallback(async () => { try { setDay(await fetchControls('day')); } catch { setDay(null); } }, []);
  useEffect(() => { void read(); }, [read]);
  const card = day?.data.cards.find(item => item.id === 'card:brief');
  if (!day || !card) return null;
  const retry = async () => {
    setBusy(true); setNote(null);
    try { setNote((await submitControl(day, 'card.retry', { id: card.id }, crypto.randomUUID())).receipt.message); }
    catch (error) { setNote(error instanceof Error ? error.message : 'That didn’t go through. Try again in a moment.'); }
    finally { setBusy(false); await read(); }
  };
  return <><BriefCardView card={card} busy={busy} onRetry={() => void retry()}/>{note && <p className="meta" role="status">{note}</p>}</>;
}
