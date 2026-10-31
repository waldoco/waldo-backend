import { RECEIPT_MAX_ITEMS, type ConversationReceipt, type ToolName } from '@waldo/contracts';
import { sha256Hex, stableJson } from '../context-composer/canonical';
import { receiptsFromLoopEvents, type LoopEventLike } from './claim-hook';

// Receipt-first status line: what this turn's effect tools actually did, from typed receipts only.
// No reply wording is read and the model produces no claim. 'accepted' means the tool accepted the
// effect; it is not proof the source system holds it. Null when the turn made no effect call.
const MAX_NAMED = 5;
// Working steps, not outcomes the owner asked for: picking a skill or driving a page while researching. A failed page step
// after a good answer would read as a failed turn. Their receipts still back claim checks; they are only left off this line.
const NOT_SHOWN = new Set(['skill_selected', 'browser_acted']);
const STATE_WORD = { accepted: 'accepted', failed: 'failed', unresolved: 'unconfirmed' } as const;

// The tools whose repeat is harmless (forgetting twice forgets once), each with the arguments that pick its target, so a
// retry that only rewords its note names the same target. Any other effect can land before a later step refuses it (an
// oversize result, a post-call halt), so its retry may be a second copy and its refusal stays shown.
const REPEATABLE_TARGET_ARGS: Partial<Record<ToolName, readonly string[]>> = { forget_memory: ['claim_ids', 'topic', 'source'] };
const targetOf = (keys: readonly string[], args: unknown): string =>
  !args || typeof args !== 'object' ? stableJson(args ?? null)
    : stableJson(Object.fromEntries(keys.flatMap(key => (args as Record<string, unknown>)[key] === undefined ? [] : [[key, (args as Record<string, unknown>)[key]]])));
// A refused attempt of a repeatable tool that a later call in the same turn made good (the same target, accepted) is
// superseded, not a failure of the turn. A transient failure (a handler that threw, a timeout) may have crossed its effect,
// and an unconfirmed receipt may have landed: those stay shown, as does any failure never made good.
const shownReceipts = (events: readonly LoopEventLike[]) => {
  const receipts = receiptsFromLoopEvents(events).filter(r => !NOT_SHOWN.has(r.effect));
  const eventOf = new Map(events.map(event => [event.seq, event]));
  const superseded = (r: (typeof receipts)[number]) => {
    const keys = REPEATABLE_TARGET_ARGS[r.tool as ToolName], code = eventOf.get(r.seq)?.code;
    if (!keys || r.state !== 'failed' || code === undefined || code === 'transient') return false;
    const target = (seq: number) => targetOf(keys, eventOf.get(seq)?.call.args);
    return receipts.some(later => later.seq > r.seq && later.tool === r.tool && later.state === 'accepted' && target(later.seq) === target(r.seq));
  };
  return receipts.filter(r => !superseded(r));
};
const TARGET_MAX = 200;

// A proposal's effect only asks the owner for an approval: accepted, it is waiting on their yes, never done.
const PROPOSED = '_proposed';

// One thing done more than once in a turn (three memories saved) is one entry with its count: a text-only channel shows this
// line as the reply's last line, where the same words three times read as a glitch. The typed items stay one per receipt.
type Entry = { part: 'receipts' | 'done' | 'asked'; label: string; note: string; count: number };

export const receiptLine = (events: readonly LoopEventLike[]): string | null => {
  const receipts = shownReceipts(events);
  if (receipts.length === 0) return null;
  const stateOf = (r: (typeof receipts)[number]) => STATE_WORD[r.state ?? (r.ok ? 'accepted' : 'failed')];
  const label = (r: (typeof receipts)[number], effect = r.effect) => `${effect.split('_').join(' ')}${r.ref ? ` ${r.ref}` : ''}`;
  // A turn where every effect was accepted reads as plain words; any other state keeps every entry's state explicit.
  const explicit = !receipts.every(r => stateOf(r) === 'accepted');
  const entries = new Map<string, Entry>();
  for (const r of receipts) {
    const entry: Entry = explicit ? { part: 'receipts', label: label(r), note: ` (${stateOf(r)}${r.delegated ? ', via task' : ''})`, count: 1 }
      : r.effect.endsWith(PROPOSED) ? { part: 'asked', label: label(r, r.effect.slice(0, -PROPOSED.length)), note: r.delegated ? ' (via task)' : '', count: 1 }
      : { part: 'done', label: label(r), note: r.delegated ? ' (via task)' : '', count: 1 };
    const key = stableJson([entry.part, entry.label, entry.note]);
    const seen = entries.get(key);
    if (seen) seen.count += 1; else entries.set(key, entry);
  }
  const named = [...entries.values()].slice(0, MAX_NAMED);
  const unnamed = receipts.length - named.reduce((sum, entry) => sum + entry.count, 0);
  const more = unnamed > 0 ? `; and ${unnamed} more` : '';
  const list = (part: Entry['part']) => named.filter(entry => entry.part === part).map(entry => `${entry.label}${entry.count > 1 ? ` ×${entry.count}` : ''}${entry.note}`).join('; ');
  if (explicit) return `Receipts: ${list('receipts')}${more}`;
  const done = list('done'), asked = list('asked');
  return [done ? `Done: ${done}` : '', asked ? `Needs your yes: ${asked}` : ''].filter(Boolean).join('. ') + more;
};

// The same receipts in typed form, with the line as their text. A target too long for the part is left out, not cut.
export const turnReceipt = async (events: readonly LoopEventLike[]): Promise<ConversationReceipt | null> => {
  const line = receiptLine(events);
  if (line === null) return null;
  const receipts = shownReceipts(events);
  const items = await Promise.all(receipts.slice(0, RECEIPT_MAX_ITEMS).map(async receipt => {
    const event = events.find(candidate => candidate.seq === receipt.seq)!;
    return {
      kind: receipt.effect, target: receipt.ref !== undefined && receipt.ref.length <= TARGET_MAX ? receipt.ref : null,
      outcome: STATE_WORD[receipt.state ?? (receipt.ok ? 'accepted' : 'failed')], via_task: receipt.delegated === true,
      at: event.at ?? Date.now(), digest: event.call.args === undefined ? null : `sha256:${await sha256Hex(stableJson(event.call.args))}`,
    };
  }));
  return { line, items, more: receipts.length - items.length };
};
