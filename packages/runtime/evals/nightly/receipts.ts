// Checks a trial's receipts must pass, read straight from the effect log, the final state and where each message
// appeared. They hold the judge to what can be checked without one: a graded trial whose receipts fail is a fail
// whatever the judge said. Recorded trials are never graded, so their receipts are never read.
import type { TrialRecord } from './trial';

export type TrialEvidence = Pick<TrialRecord, 'transcript' | 'effects' | 'final_state' | 'tools'>;
export type Receipt = Readonly<{ why: string; holds: (trial: TrialEvidence) => boolean }>;

export const failedReceipts = (receipts: readonly Receipt[], trial: TrialEvidence): readonly string[] =>
  receipts.filter((receipt) => !receipt.holds(trial)).map((receipt) => receipt.why);

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
