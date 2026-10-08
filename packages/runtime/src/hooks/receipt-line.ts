import { receiptsFromLoopEvents, type LoopEventLike } from './claim-hook';

// Receipt-first status line: what this turn's effect tools actually did, from typed receipts only.
// No reply wording is read and the model produces no claim. 'accepted' means the tool accepted the
// effect; it is not proof the source system holds it. Null when the turn made no effect call.
const MAX_NAMED = 5;
// Working steps, not outcomes the owner asked for: picking a skill or driving a page while researching. A failed page step
// after a good answer would read as a failed turn. Their receipts still back claim checks; they are only left off this line.
const NOT_SHOWN = new Set(['skill_selected', 'browser_acted']);
const STATE_WORD = { accepted: 'accepted', failed: 'failed', unresolved: 'unconfirmed' } as const;

export const receiptLine = (events: readonly LoopEventLike[]): string | null => {
  const shown = receiptsFromLoopEvents(events).filter(r => !NOT_SHOWN.has(r.effect));
  // A failed attempt that a later attempt of the same effect and ref redid successfully is a retry, not an outcome.
  const redone = (r: (typeof shown)[number], index: number): boolean =>
    (r.state ?? (r.ok ? 'accepted' : 'failed')) === 'failed' &&
    shown.slice(index + 1).some(later => later.effect === r.effect && later.ref === r.ref && (later.state ?? (later.ok ? 'accepted' : 'failed')) === 'accepted');
  const receipts = shown.filter((r, index) => !redone(r, index));
  if (receipts.length === 0) return null;
  const named = receipts.slice(0, MAX_NAMED).map(r => `${r.effect.split('_').join(' ')}${r.ref ? ` ${r.ref}` : ''} (${STATE_WORD[r.state ?? (r.ok ? 'accepted' : 'failed')]}${r.delegated ? ', via task' : ''})`);
  const more = receipts.length - named.length;
  return `Receipts: ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
};
