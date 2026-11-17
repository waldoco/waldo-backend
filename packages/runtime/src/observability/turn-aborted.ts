import type { TurnLogEntry } from '../channels/telegram-listener';
import { ownerTurnTrace } from '../channels/owner-turn-envelope';

// A turn's spans export when the turn ends, so a turn the object lost mid-run (a reset, an eviction, a deploy) leaves none.
// Recovery files one root under the lost turn's trace key that names only the last state the turn persisted.
export type AbortedTurn = Readonly<{ updateId: number; phase: 'claimed' | 'consumed' | 'running' }>;

export const turnAbortedEntry = (surface: string, turn: AbortedTurn): TurnLogEntry =>
  ({ trace: ownerTurnTrace(surface, turn.updateId), hop: 'turn_aborted', ms: 0, ok: false, detail: turn.phase, code: turn.phase });
