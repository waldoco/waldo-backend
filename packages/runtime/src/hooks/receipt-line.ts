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

// The arguments that pick an effect's target, so a retry that only rewords its note names the same target. A tool not listed
// is named by all of its arguments.
const TARGET_ARGS: Partial<Record<ToolName, readonly string[]>> = { forget_memory: ['claim_ids', 'topic', 'source'] };
const targetOf = (tool: string, args: unknown): string => {
  const keys = TARGET_ARGS[tool as ToolName];
  if (!keys || !args || typeof args !== 'object') return stableJson(args ?? null);
  return stableJson(Object.fromEntries(keys.flatMap(key => (args as Record<string, unknown>)[key] === undefined ? [] : [[key, (args as Record<string, unknown>)[key]]])));
};
// A refused attempt that a later call in the same turn made good (the same tool, the same target, accepted) is superseded,
// not a failure of the turn. A transient failure (a handler that threw, a timeout) may have crossed its effect, and an
// unconfirmed receipt may have landed, so a retry can be a second copy: those stay shown, as does any failure never made good.
const shownReceipts = (events: readonly LoopEventLike[]) => {
  const receipts = receiptsFromLoopEvents(events).filter(r => !NOT_SHOWN.has(r.effect));
  const eventOf = new Map(events.map(event => [event.seq, event]));
  const target = (r: (typeof receipts)[number]) => targetOf(r.tool, eventOf.get(r.seq)?.call.args);
  const superseded = (r: (typeof receipts)[number]) => {
    const code = eventOf.get(r.seq)?.code;
    return r.state === 'failed' && code !== undefined && code !== 'transient'
      && receipts.some(later => later.seq > r.seq && later.tool === r.tool && later.state === 'accepted' && target(later) === target(r));
  };
  return receipts.filter(r => !superseded(r));
};
const TARGET_MAX = 200;

// A proposal's effect only asks the owner for an approval: accepted, it is waiting on their yes, never done.
const PROPOSED = '_proposed';

export const receiptLine = (events: readonly LoopEventLike[]): string | null => {
  const receipts = shownReceipts(events);
  if (receipts.length === 0) return null;
  const stateOf = (r: (typeof receipts)[number]) => STATE_WORD[r.state ?? (r.ok ? 'accepted' : 'failed')];
  const label = (r: (typeof receipts)[number], effect = r.effect) => `${effect.split('_').join(' ')}${r.ref ? ` ${r.ref}` : ''}`;
  const named = receipts.slice(0, MAX_NAMED);
  const more = receipts.length - named.length > 0 ? `; and ${receipts.length - named.length} more` : '';
  // A turn where every effect was accepted reads as plain words; any other state keeps every entry's state explicit.
  if (!receipts.every(r => stateOf(r) === 'accepted')) {
    return `Receipts: ${named.map(r => `${label(r)} (${stateOf(r)}${r.delegated ? ', via task' : ''})`).join('; ')}${more}`;
  }
  const plain = (r: (typeof receipts)[number], effect: string) => `${label(r, effect)}${r.delegated ? ' (via task)' : ''}`;
  const done = named.filter(r => !r.effect.endsWith(PROPOSED)).map(r => plain(r, r.effect));
  const asked = named.filter(r => r.effect.endsWith(PROPOSED)).map(r => plain(r, r.effect.slice(0, -PROPOSED.length)));
  return [done.length ? `Done: ${done.join('; ')}` : '', asked.length ? `Needs your yes: ${asked.join('; ')}` : ''].filter(Boolean).join('. ') + more;
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
