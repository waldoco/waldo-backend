import { describe, expect, it } from 'vitest';
import { PAGE_WINDOW_CHARS, pageWindow, readingOrder } from '../src/channels/page-reading';

const filler = (label: string, n: number) => Array.from({ length: n }, (_, index) => `${label} paragraph ${index} about the usual site navigation and other unrelated material.`).join('\n\n');
const page = [filler('Intro', 60), 'Opening hours\nMonday to Friday 9:00 to 17:00. Saturdays 10:00 to 14:00.', filler('Footer', 60)].join('\n\n');

describe('readingOrder', () => {
  it('leaves a page in its own order when no instruction words single out a section', () => {
    expect(readingOrder(page, 'zzzz qqqq')).toBe(page);
    expect(readingOrder('Short page.', 'opening hours')).toBe('Short page.');
  });

  it('leads with the sections that match the instruction, says so, and keeps every character of the page', () => {
    const ordered = readingOrder(page, 'What are the opening hours on Saturday?');
    const firstSection = ordered.split('\n\n')[1]!;
    expect(ordered.startsWith('[')).toBe(true);
    expect(firstSection).toContain('Saturdays 10:00 to 14:00');
    // Nothing is dropped: every section of the page is still there, the moved one marked where it stood.
    for (const section of page.split('\n\n')) expect(ordered).toContain(section);
    expect(ordered).toContain('[moved to the top]');
    expect(ordered.indexOf('Intro paragraph 0')).toBeGreaterThan(ordered.indexOf('Saturdays'));
  });

  it('weighs words by how rare they are on the page, so a word every section has moves nothing', () => {
    // "paragraph" is in every filler section; only the hours section has "saturdays".
    const ordered = readingOrder(page, 'paragraph saturdays');
    expect(ordered.split('\n\n')[1]).toContain('Saturdays');
    expect(readingOrder(page, 'paragraph')).toBe(page);
  });

  it('splits a page with no blank lines into sections by line, so one long block still orders', () => {
    const flat = [...Array.from({ length: 200 }, (_, index) => `Menu item ${index} with ordinary words`), 'Gluten free pasta is available on request'].join('\n');
    const ordered = readingOrder(flat, 'is there gluten free pasta');
    expect(ordered.split('\n\n')[1]).toContain('Gluten free pasta');
  });

  it('is deterministic', () => {
    expect(readingOrder(page, 'opening hours saturday')).toBe(readingOrder(page, 'opening hours saturday'));
  });
});

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
});
