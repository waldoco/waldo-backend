// Checks a trial's receipts must pass, read straight from the effect log, the final state and where each message
// appeared. They hold the judge to what can be checked without one: a graded trial whose receipts fail is a fail
// whatever the judge said. Recorded trials are never graded, so their receipts are never read.
import type { TrialRecord } from './trial';
import type { MemoryMode } from './world';

export type TrialEvidence = Pick<TrialRecord, 'transcript' | 'effects' | 'final_state' | 'tools'>;
// memory_store: the check reads the claim store, so the raw-history baseline, which has none, skips it.
export type Receipt = Readonly<{ why: string; holds: (trial: TrialEvidence) => boolean; memory_store?: true }>;

export const failedReceipts = (receipts: readonly Receipt[], trial: TrialEvidence, memory: MemoryMode = 'claims'): readonly string[] =>
  receipts.filter((receipt) => (memory === 'claims' || !receipt.memory_store) && !receipt.holds(trial)).map((receipt) => receipt.why);

const effectsOf = (trial: TrialEvidence, kind: string) => trial.effects.filter((effect) => effect.kind === kind);

// Between min and max effects of this kind, each matching where when given.
export const effects = (kind: string, bounds: Readonly<{ min?: number; max?: number }>, why: string, where?: (payload: unknown) => boolean): Receipt => ({
  why,
  holds: (trial) => {
    const found = effectsOf(trial, kind);
    return found.length >= (bounds.min ?? 0) && found.length <= (bounds.max ?? Number.POSITIVE_INFINITY) && (!where || found.every((effect) => where(effect.payload)));
  },
});

// No effect of any of these kinds.
export const none = (kinds: readonly string[], why: string): Receipt => ({ why, holds: (trial) => kinds.every((kind) => effectsOf(trial, kind).length === 0) });

// No message on a notification surface carries any of these renderings of a seeded value.
export const notificationsOmit = (renderings: readonly string[], why: string): Receipt => ({
  why,
  holds: (trial) => trial.transcript.filter((turn) => turn.role === 'waldo' && turn.surface === 'notification')
    .every((turn) => renderings.every((rendering) => !turn.text.toLowerCase().includes(rendering.toLowerCase()))),
});

// At least one notification reached the owner.
export const notified = (why: string): Receipt => ({ why, holds: (trial) => trial.transcript.some((turn) => turn.role === 'waldo' && turn.surface === 'notification') });

// Identifiers a payload carries for the provider or the ledger: two otherwise identical effects differ in these.
const VOLATILE = new Set(['messageId', 'message_id', 'digest', 'raw', 'operation_ref', 'dedupe_key', 'earlier_unknown_at']);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => !VOLATILE.has(key)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

// Held on every graded trial, whatever its scenario: the same effect twice (the same draft, card, reminder or order,
// identifiers aside) is a state defect a retry or a lost receipt leaves behind, and a judge reading replies misses it.
export const STATE_INVARIANTS: readonly Receipt[] = [{
  why: 'no effect happens twice',
  holds: (trial) => {
    const seen = trial.effects.map((entry) => `${entry.kind}:${canonical(entry.payload)}`);
    return new Set(seen).size === seen.length;
  },
}];
// The forced failure happened: a call of one of these tools failed, and a later call of one of them succeeded.
export const recovered = (tools: readonly string[], why: string): Receipt => ({
  why,
  holds: (trial) => {
    const first = trial.tools.findIndex((tool) => tools.includes(tool.name) && !tool.ok);
    return first !== -1 && trial.tools.slice(first + 1).some((tool) => tools.includes(tool.name) && tool.ok);
  },
});

const finalRows = (trial: TrialEvidence, key: string): readonly unknown[] => ((trial.final_state as Record<string, unknown>)[key] as readonly unknown[] | undefined) ?? [];

// A scenario that only reads and answers: no card, draft, reminder, standing order or open loop comes of it, so any
// such change is a state defect even when the reply sounds right.
export const readOnly: Receipt = {
  why: 'nothing was changed: no effect, reminder, standing order or open loop',
  holds: (trial) => trial.effects.length === 0 && ['reminders', 'standing_orders', 'open_loops'].every((key) => finalRows(trial, key).length === 0),
};

// At least `min` calls of these tools succeeded: the answer rests on a look, not a guess.
export const toolWorked = (names: readonly string[], why: string, min = 1): Receipt => ({ why, holds: (trial) => trial.tools.filter((tool) => names.includes(tool.name) && tool.ok).length >= min });

// No Waldo message, in chat or on a notification, carries any of these renderings of a seeded value.
export const repliesOmit = (renderings: readonly string[], why: string): Receipt => ({
  why,
  holds: (trial) => trial.transcript.filter((turn) => turn.role === 'waldo').every((turn) => renderings.every((rendering) => !turn.text.toLowerCase().includes(rendering.toLowerCase()))),
});
