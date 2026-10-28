// The Brief's text on Today, as the app's Home shows it: the latest delivery of each of today's cards from the app's day view,
// cut and cleaned the same way, and played in word by word at the setup notice's pace the first time this browser sees it.

export type BriefLatest = { message_id: string; delivered_at: number; excerpt: string };

// The contract's longest excerpt (APP_CARD_EXCERPT_MAX_V1). One this long is cut from a longer message.
const EXCERPT_MAX = 280;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const latestOf = (value: unknown): BriefLatest | null => {
  if (value === null) return null;
  if (!object(value) || typeof value.message_id !== 'string' || !value.message_id || !Number.isSafeInteger(value.delivered_at) || Number(value.delivered_at) <= 0
    || typeof value.excerpt !== 'string' || !value.excerpt || value.excerpt.length > EXCERPT_MAX) throw new Error('The day view could not be read.');
  return { message_id: value.message_id, delivered_at: Number(value.delivered_at), excerpt: value.excerpt };
};

/**
 * Each card's latest delivery to Main chat, by card id: the delivery, or null when it delivered nothing there. A card whose `latest` is left
 * out is one the Worker could not tell about (it could not read the chat), so it has no entry. Only the fields Today uses are read.
 */
export function readDayLatest(value: unknown): ReadonlyMap<string, BriefLatest | null> {
  if (!object(value) || value.version !== 1 || value.view !== 'day' || !object(value.data) || !Array.isArray(value.data.cards)) throw new Error('The day view could not be read.');
  const latest = new Map<string, BriefLatest | null>();
  for (const card of value.data.cards) {
    if (!object(card) || typeof card.id !== 'string') throw new Error('The day view could not be read.');
    if (card.latest !== undefined) latest.set(card.id, latestOf(card.latest));
  }
  return latest;
}

// The excerpt is a prefix of the text Main chat shows, which may carry Markdown; Today shows it as plain lines.
const plainExcerpt = (text: string) => text.replace(/\*\*|__|`/g, '').replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*]\s+/gm, '• ').trim();

/** The excerpt as plain lines. One cut from a longer message ends at its last whole word with an ellipsis, never half a character. */
export function excerptText(excerpt: string): string {
  const plain = plainExcerpt(excerpt);
  if (excerpt.length < EXCERPT_MAX) return plain;
  const points = Array.from(plain);
  while (points.length && /^[\uD800-\uDBFF]$/.test(points[points.length - 1]!)) points.pop();
  const kept = points.join('');
  const lastSpace = kept.search(/\s\S*$/);
  return `${(lastSpace > 0 ? kept.slice(0, lastSpace) : kept).replace(/[\s,;:.\-–—]+$/, '')}…`;
}
export const excerptCut = (excerpt: string) => excerpt.length >= EXCERPT_MAX;
export const paragraphs = (text: string) => text.split(/\n+/).map(line => line.trim()).filter(Boolean);

/** The app's pace (its setup notice and Home's Brief): one word after another, a breath after a sentence, a longer one between paragraphs. */
export const REVEAL = { WORD_MS: 70, SENTENCE_GAP_MS: 260, PARAGRAPH_GAP_MS: 380, WORD_FADE_MS: 420, SETTLE_AFTER_MS: 900, SETTLE_MS: 600 } as const;
export type RevealWord = { text: string; at: number };

/** The text's paragraphs, each as its words with the moment (ms) each starts to appear. */
export function revealWords(text: string): RevealWord[][] {
  let clock = 0;
  return paragraphs(text).map((line, p) => {
    if (p > 0) clock += REVEAL.PARAGRAPH_GAP_MS;
    return line.split(/\s+/).filter(Boolean).map(word => {
      const at = clock;
      clock += REVEAL.WORD_MS + (/[.?!]$/.test(word) ? REVEAL.SENTENCE_GAP_MS : 0);
      return { text: word, at };
    });
  });
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const KEY = 'waldo.console.briefRevealed';
const browserStore = (): Store | null => { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } };

/**
 * Whether this browser sees this Brief for the first time, and so plays it in. Only the Brief's message id is kept, never its words, and it is
 * kept before the answer is given, so a Brief plays once. A browser that keeps nothing shows it still: better than playing on every visit.
 */
export function firstReveal(id: string, store: Store | null = browserStore()): boolean {
  if (!store) return false;
  try {
    if (store.getItem(KEY) === id) return false;
    store.setItem(KEY, id);
    return true;
  } catch { return false; }
}

/** The session ended: the marker goes with it. */
export function forgetBriefRevealed(store: Store | null = browserStore()): void {
  try { store?.removeItem(KEY); } catch { /* nothing kept */ }
}
