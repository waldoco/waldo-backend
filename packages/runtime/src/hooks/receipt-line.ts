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
  const receipts = receiptsFromLoopEvents(events).filter(r => !NOT_SHOWN.has(r.effect));
  if (receipts.length === 0) return null;
  const stateOf = (r: (typeof receipts)[number]) => STATE_WORD[r.state ?? (r.ok ? 'accepted' : 'failed')];
  // A turn where every effect was accepted reads as plain words; any other state keeps every entry's state explicit.
  const plain = receipts.every(r => stateOf(r) === 'accepted');
  const named = receipts.slice(0, MAX_NAMED).map(r => {
    const label = `${r.effect.split('_').join(' ')}${r.ref ? ` ${r.ref}` : ''}`;
    if (plain) return r.delegated ? `${label} (via task)` : label;
    return `${label} (${stateOf(r)}${r.delegated ? ', via task' : ''})`;
  });
  const more = receipts.length - named.length;
  return `${plain ? 'Done' : 'Receipts'}: ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
};
