// A reply's words arriving as the model writes them, in the app's setup-chat motion: each word that just arrived fades and rises in over
// 220 ms on cubic-bezier(.23,1,.32,1), a short beat after the one before. Words already on screen are never drawn in again, and nothing
// waits to be typed: every word that has arrived is in the page at once, its fade delayed at most REVEAL_SPREAD_MS.
//
// Words are counted in drawing order. A word that is still fading is its own span, keyed by that count, so React keeps the same node while
// later words arrive and its CSS animation (which runs once, on mount) is never restarted. Once its fade is over it is plain text again.

export const REVEAL_MS = 220;
const REVEAL_STEP_MS = 45;
export const REVEAL_SPREAD_MS = 200;

/** `live`: the reply being written. `shown`: the settled reply, drawn after these words were already on screen. `key` names the message. */
export type RevealMode = ({ live: true } | { shown: string }) & { key: string };
/** The fade delay, in ms, for the word at this count while it is still fading, else null. */
export type Reveal = (word: number) => number | null;

type Chunk = { from: number; to: number; at: number; step: number };
const chunk = (from: number, to: number, at: number): Chunk => ({ from, to, at, step: to - from > 1 ? Math.min(REVEAL_STEP_MS, REVEAL_SPREAD_MS / (to - from - 1)) : 0 });
const doneAt = (c: Chunk) => c.at + Math.max(0, c.to - c.from - 1) * c.step + REVEAL_MS;
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
  return word => {
    const c = live.find(candidate => word >= candidate.from && word < candidate.to);
    return c ? Math.round((word - c.from) * c.step) : null;
  };
}
