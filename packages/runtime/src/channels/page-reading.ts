// How a read page reaches the model: in reading order, the sections that share rare words with the read's instruction
// first, then the whole page in its own order. Ordering only: nothing is dropped or judged, and every moved section is
// marked where it stood. The model sees one window; the rest is paged by offset.

// The window shown inline. With its JSON wrapping it stays under the dispatcher's 16,384-character offload threshold.
export const PAGE_WINDOW_CHARS = 8_000;
// A blank-line block longer than this is split at line breaks, so a page rendered without paragraph gaps still orders.
const SECTION_CHARS = 1_000;
export const MOVED_MARK = '[moved to the top]';
const LEAD_NOTE = `[Read for the instruction: the sections that share its words come first; the whole page then follows in its own order, each moved section marked ${MOVED_MARK}.]`;
const PAGE_NOTE = '[The page in its own order:]';

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

const sections = (text: string): string[] => text.split(/\n[^\S\n]*\n/).flatMap((block) => {
  if (block.length <= SECTION_CHARS) return block.trim() ? [block] : [];
  const out: string[] = [];
  let current = '';
  for (const line of block.split('\n')) {
    if (current && current.length + line.length + 1 > SECTION_CHARS) { out.push(current); current = line; }
    else current = current ? `${current}\n${line}` : line;
  }
  if (current.trim()) out.push(current);
  return out;
});

export function readingOrder(text: string, instruction: string): string {
  const parts = sections(text);
  const asked = words(instruction);
  const present = parts.map(words);
  // Inverse document frequency over the page's sections: a word in more than half of them singles nothing out.
  const weight = new Map<string, number>();
  for (const word of asked) {
    const df = present.filter((set) => set.has(word)).length;
    if (df > 0 && df <= parts.length / 2) weight.set(word, Math.log(parts.length / df));
  }
  if (weight.size === 0) return text;
  const scored = parts.map((part, index) => ({ index, score: [...weight].reduce((sum, [word, w]) => sum + (present[index]!.has(word) ? w : 0), 0) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const lead = new Set<number>();
  let room = PAGE_WINDOW_CHARS - LEAD_NOTE.length;
  for (const { index } of scored) {
    if (lead.size > 0 && parts[index]!.length + 2 > room) break;
    lead.add(index);
    room -= parts[index]!.length + 2;
  }
  return [LEAD_NOTE, ...[...lead].map((index) => parts[index]!), PAGE_NOTE, ...parts.map((part, index) => lead.has(index) ? MOVED_MARK : part)].join('\n\n');
}

// The first window of a text, cut at a line break when one falls in its second half, and the offset the rest starts at.
export function pageWindow(text: string, limit = PAGE_WINDOW_CHARS): Readonly<{ text: string; next_offset: number | null }> {
  if (text.length <= limit) return { text, next_offset: null };
  const lineEnd = text.lastIndexOf('\n', limit - 1) + 1;
  const cut = lineEnd > limit / 2 ? lineEnd : limit;
  return { text: text.slice(0, cut), next_offset: cut };
}
