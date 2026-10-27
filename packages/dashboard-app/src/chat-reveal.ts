import { useRef } from 'react';

// A reply's words arriving as the model writes them, in the app's setup-chat motion: each word that just arrived fades and rises in over
// 220 ms on cubic-bezier(.23,1,.32,1), a short beat after the one before. Words already on screen are never drawn in again, and nothing
// waits to be typed: every word that has arrived is in the page at once, its fade delayed at most REVEAL_SPREAD_MS.
//
// Words are counted in drawing order. A word that is still fading is its own span, keyed by that count, so React keeps the same node while
// later words arrive and its CSS animation (which runs once, on mount) is never restarted. Once its fade is over it is plain text again.

export const REVEAL_MS = 220;
const REVEAL_STEP_MS = 45;
export const REVEAL_SPREAD_MS = 200;

/** `live`: the reply being written. `shown`: the settled reply, drawn after these words were already on screen. */
export type RevealMode = { live: true } | { shown: string };
/** The fade delay, in ms, for the word at this count while it is still fading, else null. */
export type Reveal = (word: number) => number | null;

type Chunk = { from: number; to: number; at: number; step: number };
const chunk = (from: number, to: number, at: number): Chunk => ({ from, to, at, step: to - from > 1 ? Math.min(REVEAL_STEP_MS, REVEAL_SPREAD_MS / (to - from - 1)) : 0 });
const doneAt = (c: Chunk) => c.at + Math.max(0, c.to - c.from - 1) * c.step + REVEAL_MS;
const reduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * The fade for a reply drawn from `text` (`words` words long), or undefined when nothing is fading. Growth is read from the text: text that
 * extends the last adds only its new words; text that doesn't (the draft was withdrawn and another began) starts over. `count` gives the
 * word count of other text, for the words a settled reply had already shown.
 */
export function useWordReveal(text: string, words: number, mode: RevealMode | undefined, count: (text: string) => number): Reveal | undefined {
  const seen = useRef<{ text: string; words: number; chunks: Chunk[] } | null>(null);
  const now = Date.now();
  if (!mode || reduced()) { seen.current = null; return undefined; }
  if (!seen.current) {
    // A settled reply fades in only what came after the words already shown; one the delivery path rewrote appears as it is.
    const from = 'shown' in mode ? (text.startsWith(mode.shown) ? count(mode.shown) : words) : 0;
    seen.current = { text, words, chunks: from < words ? [chunk(from, words, now)] : [] };
  } else if (text !== seen.current.text) {
    const last = seen.current;
    const grew = text.startsWith(last.text);
    const from = grew ? last.words : 0;
    const chunks = grew ? last.chunks.filter(c => doneAt(c) > now) : [];
    if (words > from) chunks.push(chunk(from, words, now));
    seen.current = { text, words, chunks };
  }
  const live = seen.current.chunks.filter(c => doneAt(c) > now);
  if (!live.length) return undefined;
  return word => {
    const c = live.find(candidate => word >= candidate.from && word < candidate.to);
    return c ? Math.round((word - c.from) * c.step) : null;
  };
}
