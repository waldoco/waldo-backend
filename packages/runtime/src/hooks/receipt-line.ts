import { receiptsFromLoopEvents, type LoopEventLike } from './claim-hook';

// Receipt-first status line: what this turn's effect tools actually did, from typed receipts only.
// No reply wording is read and the model produces no claim. 'accepted' means the tool accepted the
// effect; it is not proof the source system holds it. Null when the turn made no effect call.
const MAX_NAMED = 5;
const STATE_WORD = { accepted: 'accepted', failed: 'failed', unresolved: 'unconfirmed' } as const;

export const receiptLine = (events: readonly LoopEventLike[]): string | null => {
  const receipts = receiptsFromLoopEvents(events);
  if (receipts.length === 0) return null;
  const named = receipts.slice(0, MAX_NAMED).map(r => `${r.effect.split('_').join(' ')}${r.ref ? ` ${r.ref}` : ''} (${STATE_WORD[r.state ?? (r.ok ? 'accepted' : 'failed')]})`);
  const more = receipts.length - named.length;
  return `Receipts: ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
};
