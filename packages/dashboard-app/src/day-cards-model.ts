// Today's cards on the console's Today, as the app's Home shows them: what each of the Brief, Check-in and the Close delivered to
// Main chat, read from the app's day view, cut and cleaned the same way, and played in word by word at the setup notice's pace the
// first time this browser sees each one.

// revised_at: Waldo revised the card after it first went out, and this is its newest revision (controls revision 9).
export type CardLatest = { message_id: string; delivered_at: number; excerpt: string; revised_at?: number };
/** What the app's day view adds for Today: each card's latest delivery by id (absent: the Worker could not tell), and whether the daily brief is on. */
export type AppDay = { latest: ReadonlyMap<string, CardLatest | null>; dailyBrief: boolean | null };

// The contract's longest excerpt (APP_CARD_EXCERPT_MAX_V1). One this long is cut from a longer message.
const EXCERPT_MAX = 280;
const unreadable = () => new Error('The day view could not be read.');
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const latestOf = (value: unknown): CardLatest | null => {
  if (value === null) return null;
  if (!object(value) || typeof value.message_id !== 'string' || !value.message_id || !Number.isSafeInteger(value.delivered_at) || Number(value.delivered_at) <= 0
    || typeof value.excerpt !== 'string' || !value.excerpt || value.excerpt.length > EXCERPT_MAX) throw unreadable();
  return { message_id: value.message_id, delivered_at: Number(value.delivered_at), excerpt: value.excerpt };
};

/**
 * The parts of the app's day view Today uses. A card whose `latest` is left out is one the Worker could not tell about (it could not read
 * the chat), so it has no entry; null means it delivered nothing to Main chat. Only these fields are read.
 */
export function readAppDay(value: unknown): AppDay {
  if (!object(value) || value.version !== 1 || value.view !== 'day' || !object(value.data) || !Array.isArray(value.data.cards)) throw unreadable();
  const latest = new Map<string, CardLatest | null>();
  for (const card of value.data.cards) {
    if (!object(card) || typeof card.id !== 'string') throw unreadable();
    if ((card.revision === undefined) !== (card.revised_at === undefined) || (card.revision !== undefined && !(Number.isSafeInteger(card.revision) && Number(card.revision) >= 1
      && Number.isSafeInteger(card.revised_at) && Number(card.revised_at) > 0))) throw unreadable();
    if (card.latest === undefined) continue;
    const delivery = latestOf(card.latest);
    latest.set(card.id, delivery && card.revised_at !== undefined ? { ...delivery, revised_at: Number(card.revised_at) } : delivery);
  }
  const schedules = value.data.schedules;
  return { latest, dailyBrief: object(schedules) && typeof schedules.daily_brief === 'boolean' ? schedules.daily_brief : null };
}

/** A card's name inside a sentence: "The Brief" reads "the Brief" after "making". Every other name is kept as the server wrote it. */
export const cardName = (name: string) => name.replace(/^The /, 'the ');

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

/** The app's pace (its setup notice and Home's letter): one word after another, a breath after a sentence, a longer one between paragraphs. */
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
const KEY = 'waldo.console.cardsRevealed';
// A day has three cards; a few days' worth is kept, so yesterday's never pushes out one of today's.
const KEPT = 12;
const browserStore = (): Store | null => { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } };

/**
 * Whether this browser sees this card's message for the first time, and so plays it in. Only message ids are kept, never words, and the id is
 * kept before the answer is given, so each plays once. A browser that keeps nothing shows them still: better than playing on every visit.
 */
export function firstReveal(id: string, store: Store | null = browserStore()): boolean {
  if (!store) return false;
  try {
    const raw = store.getItem(KEY);
    const seen: unknown = raw ? JSON.parse(raw) : [];
    const ids = Array.isArray(seen) ? seen.filter((item): item is string => typeof item === 'string') : [];
    if (ids.includes(id)) return false;
    store.setItem(KEY, JSON.stringify([...ids, id].slice(-KEPT)));
    return true;
  } catch { return false; }
}

/** The session ended: the marker goes with it. */
export function forgetCardsRevealed(store: Store | null = browserStore()): void {
  try { store?.removeItem(KEY); } catch { /* nothing kept */ }
}
