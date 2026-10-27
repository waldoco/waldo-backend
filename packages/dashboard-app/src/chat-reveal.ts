// A reply's text arriving as the model writes it, as streaming chat apps show it: each chunk that arrives fades in as one over REVEAL_MS,
// with no word-by-word stagger (which tires on a long reply) and nothing waiting to be typed. Text already on screen is never drawn in again.
//
// Words are counted in drawing order. A word that is still fading is its own span, keyed by that count, so React keeps the same node while
// later words arrive and its CSS animation (which runs once, on mount) is never restarted. Once its fade is over it is plain text again.

export const REVEAL_MS = 180;

/** `live`: the reply being written. `shown`: the settled reply, drawn after these words were already on screen. `key` names the message. */
export type RevealMode = ({ live: true } | { shown: string }) & { key: string };
/** Whether the word at this count is still fading in. */
export type Reveal = (word: number) => boolean;

type Chunk = { from: number; to: number; at: number };
const chunk = (from: number, to: number, at: number): Chunk => ({ from, to, at });
const doneAt = (c: Chunk) => c.at + REVEAL_MS;
const reduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// What each message has shown, by its key, so a row drawn again (the chat opened again) carries on where it was rather than fading in
// again. It holds no words: the text's length and a hash of it, enough to tell growth from a new draft, plus the fades still running.
type Seen = { length: number; sig: number; words: number; chunks: Chunk[] };
const SEEN_KEPT = 64;
const seenByMessage = new Map<string, Seen>();
const hash = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
};
const remember = (key: string, seen: Seen) => {
  seenByMessage.delete(key);
  seenByMessage.set(key, seen);
  if (seenByMessage.size > SEEN_KEPT) seenByMessage.delete(seenByMessage.keys().next().value!);
};

/**
 * The fade for a reply drawn from `text` (`words` words long), or undefined when nothing is fading. Growth is read from the text: text that
 * extends the last adds only its new words; text that doesn't (the draft was withdrawn and another began) starts over. `count` gives the
 * word count of other text, for the words a settled reply had already shown.
 */
export function wordReveal(text: string, words: number, mode: RevealMode | undefined, count: (text: string) => number): Reveal | undefined {
  const now = Date.now();
  if (!mode || reduced()) return undefined;
  const last = seenByMessage.get(mode.key);
  const sig = hash(text);
  let seen = last;
  if (!last) {
    // A settled reply fades in only what came after the words already shown; one the delivery path rewrote appears as it is.
    const from = 'shown' in mode ? (text.startsWith(mode.shown) ? count(mode.shown) : words) : 0;
    seen = { length: text.length, sig, words, chunks: from < words ? [chunk(from, words, now)] : [] };
    remember(mode.key, seen);
  } else if (sig !== last.sig || text.length !== last.length) {
    const grew = text.length >= last.length && hash(text.slice(0, last.length)) === last.sig;
    const from = grew ? last.words : 0;
    const chunks = grew ? last.chunks.filter(c => doneAt(c) > now) : [];
    if (words > from) chunks.push(chunk(from, words, now));
    seen = { length: text.length, sig, words, chunks };
    remember(mode.key, seen);
  }
  const live = seen!.chunks.filter(c => doneAt(c) > now);
  if (!live.length) return undefined;
  return word => live.some(c => word >= c.from && word < c.to);
}
