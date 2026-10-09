import type { LLMToolTurn } from '@waldo/contracts';

export const HELD_TURN_OUTPUT = '[waldo: this tool returned data that mentions a topic the owner asked to forget, so it is withheld. The tool DID return data - do not report it as empty or failed; say that part is withheld.]';

// A withheld result keeps its call and gets a receipt in place of the output. Dropping the turn left the
// model's own function_call without a result: it never saw the read, repeated it, or the provider rejected the request.
// `narrow` returns the output with only the held items removed (undefined when it cannot be narrowed safely);
// the receipt replaces the whole output only when it cannot.
export const withholdHeldTurns = (turns: readonly LLMToolTurn[], holds: (output: string) => boolean, narrow?: (output: string) => string | undefined): LLMToolTurn[] =>
  turns.map((turn) => {
    if (turn.call.name === 'forget_memory' || !holds(turn.output)) return turn;
    const narrowed = narrow?.(turn.output);
    return { ...turn, output: narrowed !== undefined && !holds(narrowed) ? narrowed : HELD_TURN_OUTPUT };
  });

// The result's own JSON line is narrowed; any notes the loop appended after it ride along unchanged.
export const narrowHeldJson = (output: string, withhold: (value: unknown, tally: { dropped: number }) => unknown): string | undefined => {
  const cut = output.indexOf('\n');
  const json = cut === -1 ? output : output.slice(0, cut);
  const rest = cut === -1 ? '' : output.slice(cut);
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return undefined; }
  const tally = { dropped: 0 };
  const kept = withhold(parsed, tally);
  if (kept === undefined || tally.dropped === 0) return undefined;
  return `${JSON.stringify(kept)}\n[waldo: ${tally.dropped} item${tally.dropped === 1 ? '' : 's'} mentioning a topic the owner asked to forget ${tally.dropped === 1 ? 'was' : 'were'} withheld; the rest is shown. Do not report the result as empty.]${rest}`;
};
