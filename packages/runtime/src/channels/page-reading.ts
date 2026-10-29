// How a read page reaches the model: in its own order, one window at a time, with an outline of where its sections start
// when it is longer than the window. The outline is structural (section starts spread over the page), so the model, not
// a rule, decides which part to read next.

// The window shown inline. With its outline, its JSON wrapping and a URL at its 2,000-character cap, the result stays under
// the dispatcher's 16,384-character offload threshold.
export const PAGE_WINDOW_CHARS = 7_000;
export const OUTLINE_ENTRIES = 24;
export const OUTLINE_LINE_CHARS = 60;

export type OutlineEntry = Readonly<{ offset: number; line: string }>;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

// The first window of a text, cut at a line break when one falls in its second half, and the offset the rest starts at.
// A cut never leaves half a surrogate pair at the window's end.
export function pageWindow(text: string, limit = PAGE_WINDOW_CHARS): Readonly<{ text: string; next_offset: number | null }> {
  if (text.length <= limit) return { text, next_offset: null };
  const lineEnd = text.lastIndexOf('\n', limit - 1) + 1;
  let cut = lineEnd > limit / 2 ? lineEnd : limit;
  if (isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
  return { text: text.slice(0, cut), next_offset: cut };
}

// Where the page's sections start: the first line after each blank line, or every line when the page has no blank lines.
// With more sections than entries, the entries are the first section start at or after each of OUTLINE_ENTRIES evenly
// spaced points, so the outline covers the whole page.
export function pageOutline(text: string): OutlineEntry[] {
  const lineStarts: number[] = [];
  const blockStarts: number[] = [];
  let afterBlank = true;
  for (let at = 0; at < text.length;) {
    const end = text.indexOf('\n', at);
    const lineEnd = end === -1 ? text.length : end;
    const blank = text.slice(at, lineEnd).trim() === '';
    if (!blank) {
      lineStarts.push(at);
      if (afterBlank) blockStarts.push(at);
    }
    afterBlank = blank;
    at = lineEnd + 1;
  }
  const starts = blockStarts.length > 1 ? blockStarts : lineStarts;
  const chosen: number[] = [];
  for (let slot = 0, next = 0; slot < OUTLINE_ENTRIES && next < starts.length; slot += 1) {
    while (next < starts.length && starts[next]! < (slot * text.length) / OUTLINE_ENTRIES) next += 1;
    if (next < starts.length && starts[next] !== chosen.at(-1)) chosen.push(starts[next]!);
  }
  return chosen.map((start) => {
    const end = text.indexOf('\n', start);
    const first = text.slice(start, end === -1 ? text.length : end);
    const lead = first.length - first.trimStart().length;
    const line = first.trim();
    const cut = line.length > OUTLINE_LINE_CHARS && isHighSurrogate(line.charCodeAt(OUTLINE_LINE_CHARS - 1)) ? OUTLINE_LINE_CHARS - 1 : OUTLINE_LINE_CHARS;
    return { offset: start + lead, line: line.slice(0, cut) };
  });
}

// The outline as the model reads it: one "at <offset>: <first line>" line per entry, the offset to page from.
export const outlineText = (entries: readonly OutlineEntry[]): string => entries.map((entry) => `at ${entry.offset}: ${entry.line}`).join('\n');
