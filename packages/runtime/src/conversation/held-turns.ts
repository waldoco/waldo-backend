import type { LLMToolTurn } from '@waldo/contracts';

export const HELD_TURN_OUTPUT = '[waldo: this tool returned data that mentions a topic the owner asked to forget, so it is withheld. The tool DID return data - do not report it as empty or failed; say that part is withheld.]';

// A withheld result keeps its call and gets a receipt in place of the output. Dropping the turn left the
// model's own function_call without a result: it never saw the read, repeated it, or the provider rejected the request.
export const withholdHeldTurns = (turns: readonly LLMToolTurn[], holds: (output: string) => boolean): LLMToolTurn[] =>
  turns.map((turn) => turn.call.name === 'forget_memory' || !holds(turn.output) ? turn : { ...turn, output: HELD_TURN_OUTPUT });
