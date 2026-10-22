import { literalTextRedactor, type LLMToolTurn } from '@waldo/contracts';
import { carriesTopic, holdsIn } from '../memory/forget-guard';

// The one place the model's view is cut for topics the owner asked to forget whose purge has not finished. A forget is a
// privacy boundary, so the cut is deterministic; its cost lands on the forgotten words, not on the reads around them.
//   items: owner memory drops the matching item; other text has the words replaced and keeps the rest. Nothing is withheld whole.
//   reads: the earlier rule, kept as the flag-off path: a held string or key outside a list withholds the whole read.
export type ForgetBarrierMode = 'items' | 'reads';
// owner_store: memory Waldo keeps about the owner, where an item is a unit of meaning that is dropped whole.
// external: everything else a tool returns, where the surrounding text stays useful once the words are gone.
export type ResultOrigin = 'owner_store' | 'external';
export type BarrierTally = { dropped: number; redacted: number };

export const FORGET_MARKER = '[forgotten]';
export const WITHHELD_OUTPUT = '[waldo: this tool returned data that mentions a topic the owner asked to forget, so it is withheld. The tool DID return data - do not report it as empty or failed; say that part is withheld.]';
const OWNER_STORE_TOOLS: ReadonlySet<string> = new Set(['read_owner_context', 'read_memory', 'search_episodes']);
export const resultOrigin = (tool: string): ResultOrigin => (OWNER_STORE_TOOLS.has(tool) ? 'owner_store' : 'external');

// Every string in a structured value (keys and values), unserialised: JSON.stringify would double a stored backslash and
// hide an escaped topic from hidesTopic.
export const structuredStrings = (value: unknown, depth = 0): string[] => {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || depth > 64) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...structuredStrings(child, depth + 1)]);
};

const removalNote = ({ dropped, redacted }: BarrierTally): string => {
  const parts = [dropped ? `${dropped} item${dropped === 1 ? '' : 's'}` : '', redacted ? `${redacted} passage${redacted === 1 ? '' : 's'}` : ''].filter(Boolean);
  return `[waldo: ${parts.join(' and ')} mentioning a topic the owner asked to forget ${dropped + redacted === 1 ? 'was' : 'were'} removed; the rest is shown. Do not report the result as empty.]`;
};

// Escapes a reader can still decode into letters. Unlike stored JSON, the model's view is read as text, so an unknown
// escape such as \d spells nothing and must not cost the owner the whole page.
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '/': '/' };
const decodeOnce = (value: string): string =>
  value.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[bfnrt"\\/])/g, (_match, escape: string) =>
    escape.length > 1 ? String.fromCharCode(parseInt(escape.slice(1), 16)) : SIMPLE_ESCAPES[escape]!);
// Every pass that decodes something shortens the text, so this ends; nesting cannot hide the topic.
const decodeEscapes = (value: string): string => {
  for (let next = decodeOnce(value); next !== value; next = decodeOnce(value)) value = next;
  return value;
};

export const forgetBarrier = (held: readonly string[], mode: ForgetBarrierMode = 'items') => {
  const topics = [...new Set(held.map((topic) => topic.trim()).filter(Boolean))];
  const redactWords = literalTextRedactor(topics, FORGET_MARKER);
  // The storage-grade test, the one the purge reads back by: an escape it cannot rule out counts as the topic. Owner memory
  // items are judged by it, so a doubtful item is dropped rather than shown.
  const holds = holdsIn(topics);
  // What a reader of the text would see: the topic as written, or spelled by escapes that decode.
  const shows = (value: string): boolean =>
    topics.some((topic) => carriesTopic(value, topic) || (value.includes('\\') && carriesTopic(decodeEscapes(value), topic)));

  // Text from outside the owner's memory: the words go, the rest stays. Text keeps its own spelling unless the topic hides
  // behind escapes, which are then decoded so the words can be removed. undefined is the flag-off rule's whole-read hold.
  const text = (value: string, tally: BarrierTally): string | undefined => {
    if (mode === 'reads') return holds(value) ? undefined : value;
    if (!shows(value)) return value;
    tally.redacted += 1;
    const redacted = redactWords(value);
    return shows(redacted) ? redactWords(decodeEscapes(value)) : redacted;
  };

  // A structured result. Owner memory drops list items that carry a topic; any other list keeps its items with the words
  // replaced. undefined means the whole value is withheld, which items mode never returns.
  const structured = <T,>(value: T, origin: ResultOrigin, tally: BarrierTally, depth = 0): T | undefined => {
    if (typeof value === 'string') return text(value, tally) as T | undefined;
    if (value === null || typeof value !== 'object') return value;
    if (depth > 64) return mode === 'reads' ? undefined : value;
    if (Array.isArray(value)) {
      const dropItems = mode === 'reads' || origin === 'owner_store';
      const kept = dropItems ? value.filter((item) => !holds(...structuredStrings(item))) : value;
      tally.dropped += value.length - kept.length;
      const out = [];
      for (const item of kept) {
        const child = structured(item, origin, tally, depth + 1);
        if (child === undefined) return undefined;
        out.push(child);
      }
      return out as T;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const keptKey = text(key, tally);
      if (keptKey === undefined) return undefined;
      const kept = structured(child, origin, tally, depth + 1);
      if (kept === undefined && child !== undefined) return undefined;
      out[keptKey] = kept;
    }
    return out as T;
  };

  // A tool output as the model reads it: its JSON line is cut like any structured result and the loop's own notes after it
  // ride along; text that is not JSON is cut as text.
  const output = (raw: string, origin: ResultOrigin): string => {
    if (!holds(raw)) return raw;
    const clean = (value: string) => (mode === 'items' ? !shows(value) : !holds(value));
    const cut = raw.indexOf('\n');
    const head = cut === -1 ? raw : raw.slice(0, cut);
    const rest = cut === -1 ? '' : raw.slice(cut);
    const tally: BarrierTally = { dropped: 0, redacted: 0 };
    let parsed: unknown;
    try { parsed = JSON.parse(head); } catch {
      const kept = text(raw, tally);
      if (kept === undefined) return WITHHELD_OUTPUT;
      return tally.redacted ? `${kept}\n${removalNote(tally)}` : kept;
    }
    const kept = structured(parsed, origin, tally);
    if (kept === undefined) return WITHHELD_OUTPUT;
    if (!tally.dropped && !tally.redacted) return clean(raw) ? raw : WITHHELD_OUTPUT;
    const narrowed = `${JSON.stringify(kept)}\n${removalNote(tally)}${rest}`;
    return clean(narrowed) ? narrowed : WITHHELD_OUTPUT;
  };

  // The model's own calls keep their results in place: dropping a turn would leave its function call unanswered.
  const turns = (list: readonly LLMToolTurn[]): LLMToolTurn[] =>
    list.map((turn) => (turn.call.name === 'forget_memory' ? turn : { ...turn, output: output(turn.output, resultOrigin(turn.call.name)) }));

  // A list of outside texts (earlier tool results): the words go from each. The flag-off rule dropped any that held.
  const texts = <T,>(list: readonly T[], textOf: (item: T) => string, withText: (item: T, text: string) => T): T[] =>
    list.flatMap((item) => {
      const kept = text(textOf(item), { dropped: 0, redacted: 0 });
      return kept === undefined ? [] : [kept === textOf(item) ? item : withText(item, kept)];
    });

  // Text this repository wrote is never cut; the flag-off rule dropped it whole.
  const code = (value: string): string => (mode === 'reads' && holds(value) ? '' : value);

  return { mode, active: topics.length > 0, holds, shows, text, structured, output, turns, texts, code };
};

export type ForgetBarrier = ReturnType<typeof forgetBarrier>;
