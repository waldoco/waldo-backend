import { describe, expect, it } from 'vitest';
import { OUTLINE_ENTRIES, OUTLINE_LINE_CHARS, PAGE_WINDOW_CHARS, outlineText, pageOutline, pageWindow } from '../src/channels/page-reading';

const filler = (label: string, n: number) => Array.from({ length: n }, (_, index) => `${label} paragraph ${index}\nabout the usual site navigation and other material on the page.`).join('\n\n');
const page = [filler('Intro', 60), 'Opening hours\nMonday to Friday 9:00 to 17:00. Saturdays 10:00 to 14:00.', filler('Footer', 60)].join('\n\n');

describe('pageWindow', () => {
  it('returns a short text whole', () => {
    expect(pageWindow('abc')).toEqual({ text: 'abc', next_offset: null });
  });

  it('cuts a long text at a line break within the window, with the offset the rest starts at', () => {
    const { text, next_offset } = pageWindow(page);
    expect(text.length).toBeLessThanOrEqual(PAGE_WINDOW_CHARS);
    expect(text.length).toBeGreaterThan(PAGE_WINDOW_CHARS / 2);
    expect(next_offset).toBe(text.length);
    expect(page.slice(0, next_offset!)).toBe(text);
    expect(page[next_offset! - 1]).toBe('\n');
  });

  it('cuts a text with no line breaks at the window', () => {
    const { text, next_offset } = pageWindow('x'.repeat(PAGE_WINDOW_CHARS * 2));
    expect(text).toHaveLength(PAGE_WINDOW_CHARS);
    expect(next_offset).toBe(PAGE_WINDOW_CHARS);
  });

  it('never splits a surrogate pair at the cut', () => {
    const text = `${'x'.repeat(PAGE_WINDOW_CHARS - 1)}😀${'y'.repeat(100)}`;
    const { text: shown, next_offset } = pageWindow(text);
    expect(next_offset).toBe(PAGE_WINDOW_CHARS - 1);
    expect(shown.charCodeAt(shown.length - 1)).toBe('x'.charCodeAt(0));
    expect(text.slice(next_offset!).startsWith('😀')).toBe(true);
  });
});

describe('pageOutline', () => {
  it('lists section starts in page order, each with its first line and the exact offset it starts at', () => {
    const outline = pageOutline(page);
    expect(outline.length).toBeGreaterThan(1);
    expect(outline.length).toBeLessThanOrEqual(OUTLINE_ENTRIES);
    expect(outline[0]).toEqual({ offset: 0, line: 'Intro paragraph 0' });
    for (const entry of outline) expect(page.startsWith(entry.line, entry.offset)).toBe(true);
    expect(outline.map((entry) => entry.offset)).toEqual([...outline.map((entry) => entry.offset)].sort((a, b) => a - b));
  });

  it('spreads its entries over the whole page when it has more sections than entries', () => {
    const outline = pageOutline(page);
    expect(outline.at(-1)!.offset).toBeGreaterThan(page.length * 0.9);
    // No entry is chosen for what it says: the outline does not depend on any section's words.
    const renamed = page.replace('Opening hours', 'Closing times');
    expect(pageOutline(renamed).map((entry) => entry.offset)).toEqual(outline.map((entry) => entry.offset));
  });

  it('uses line starts for a page with no blank lines, and shortens long first lines', () => {
    const flat = Array.from({ length: 300 }, (_, index) => `Row ${index} ${'z'.repeat(200)}`).join('\n');
    const outline = pageOutline(flat);
    expect(outline.length).toBe(OUTLINE_ENTRIES);
    for (const entry of outline) {
      expect(entry.line.length).toBeLessThanOrEqual(OUTLINE_LINE_CHARS);
      expect(flat.startsWith(entry.line, entry.offset)).toBe(true);
    }
  });

  it('keeps a windowed result with its outline under the 16,384-character offload threshold, even with a 2,000-character URL', () => {
    const lines = Array.from({ length: 4_000 }, (_, index) => `Line ${index}: "quoted" text with a tab\tand ${'w'.repeat(OUTLINE_LINE_CHARS)}`).join('\n\n');
    const { text, next_offset } = pageWindow(lines);
    const result = { ok: true, data: { url: `https://example.com/${'p'.repeat(1_980)}`, provider: 'cloudflare_playwright', data: { title: 'T'.repeat(200), text, total_chars: lines.length, next_offset, stored_output: 'to-12', read_with: 'read_tool_output', outline: outlineText(pageOutline(lines)) } }, source_taint: 'external' };
    expect(JSON.stringify(result).length).toBeLessThan(16_384);
  });

  it('reads as one "at <offset>: <first line>" line per entry', () => {
    expect(outlineText([{ offset: 0, line: 'Intro' }, { offset: 412, line: 'Opening hours' }])).toBe('at 0: Intro\nat 412: Opening hours');
  });
});
