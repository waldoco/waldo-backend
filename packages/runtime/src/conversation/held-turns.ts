import type { LLMToolTurn, ToolName } from '@waldo/contracts';

export const HELD_TURN_OUTPUT = '[waldo: this tool returned data that mentions a topic the owner asked to forget, so it is withheld. The tool DID return data - do not report it as empty or failed; say that part is withheld.]';

// Public web reads: text someone else published, read without the owner's accounts. A held topic is cut out of these
// and the rest is kept. Every other tool, an unlisted one included, may carry the owner's own data and is withheld
// whole. browse_act stays here only while it browses without the owner's signed-in browser state.
export const PUBLIC_WEB_TOOLS: readonly ToolName[] = ['web_search', 'browse_page', 'browse_act'];
export const HELD_TOPIC_MARKER = '[withheld]';
export const HELD_TOPIC_REDACTED_NOTE = `[waldo: text mentioning a topic the owner asked to forget was cut from this public result and shown as ${HELD_TOPIC_MARKER}; the rest is as returned. Do not guess the cut text or report the result as empty.]`;

// A withheld result keeps its call and gets a receipt in place of the output. Dropping the turn left the
// model's own function_call without a result: it never saw the read, repeated it, or the provider rejected the request.
// `redact` cuts held text out of a public web result, which is kept only when `holds` passes on the result as sent.
// `narrow` returns the output with only the held items removed (undefined when it cannot be narrowed safely);
// the receipt replaces the whole output only when neither works.
export const withholdHeldTurns = (turns: readonly LLMToolTurn[], holds: (output: string) => boolean, narrow?: (output: string) => string | undefined, redact?: (output: string) => string): LLMToolTurn[] =>
  turns.map((turn) => {
    if (turn.call.name === 'forget_memory' || !holds(turn.output)) return turn;
    if (redact && (PUBLIC_WEB_TOOLS as readonly string[]).includes(turn.call.name)) {
      const redacted = `${redact(turn.output)}\n${HELD_TOPIC_REDACTED_NOTE}`;
      if (!holds(redacted)) return { ...turn, output: redacted };
    }
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
