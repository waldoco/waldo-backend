import { clockLabel } from './Infographics';
import type { HeldChange } from './held-changes-model';

const when = (at: Readonly<{ start: string | null; all_day: boolean }>, zone: string) => {
  if (!at.start) return null;
  if (at.all_day) return at.start.slice(0, 10);
  try { return new Intl.DateTimeFormat('en', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(at.start)); } catch { return null; }
};

export const heldLine = (change: HeldChange, zone: string): string => {
  if (change.source === 'mail') return `Mail from ${change.from ?? 'someone'}: ${change.subject ?? '(subject withheld)'}`;
  const title = change.title ?? 'An event', now = when(change, zone), was = change.before ? when(change.before, zone) : null;
  if (change.kind === 'cancelled') return `${title}: cancelled${was ? ` (was ${was})` : ''}`;
  if (change.kind === 'added') return `${title}: added${now ? ` for ${now}` : ''}`;
  return was && now && was !== now ? `${title}: moved from ${was} to ${now}` : `${title}: changed${now ? `, now ${now}` : ''}`;
};

/** What Waldo saw change today and did not bring to you, newest first: a held change waits in the record, not in a message. */
export function HeldChangesView({ changes, zone }: { changes: readonly HeldChange[]; zone: string }) {
  if (!changes.length) return null;
  return <div className="held-changes">
    <p className="meta">Seen today, not brought to you</p>
    <ul>{changes.map((change, index) => <li key={index}><span className="meta">{clockLabel(change.at, zone)}</span> {heldLine(change, zone)}</li>)}</ul>
  </div>;
}
