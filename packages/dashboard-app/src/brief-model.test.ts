import { describe, expect, it } from 'vitest';
import { excerptText, firstReveal, forgetBriefRevealed, readDayLatest, revealWords, REVEAL } from './brief-model';

const day = (cards: unknown[]) => ({ version: 1, view: 'day', state: 'available', revision: 'a'.repeat(64), data: { timezone: 'UTC', date: '2026-10-28', cards } });
const card = (id: string, latest?: unknown) => ({ id, name: 'The Brief', defaultTime: '08:00', time: null, reason: 'planned', sent: true, pin: null, ...(latest === undefined ? {} : { latest }) });
const delivered = { message_id: 'row-1', delivered_at: 1_761_638_400_000, excerpt: 'Morning. Your day opens with the design review at ten.' };

describe('what each of today\'s cards delivered, from the app\'s day view', () => {
  it('keeps a delivery, a card that delivered nothing, and leaves out one the Worker could not tell', () => {
    const latest = readDayLatest(day([card('card:brief', delivered), card('card:checkin', null), card('card:close')]));
    expect(latest.get('card:brief')).toEqual(delivered);
    expect(latest.get('card:checkin')).toBeNull();
    expect(latest.has('card:close')).toBe(false);
  });

  it('refuses an answer that is not the day view or a delivery out of shape', () => {
    expect(() => readDayLatest({ ...day([]), view: 'connections' })).toThrow();
    expect(() => readDayLatest({ version: 1 })).toThrow();
    for (const bad of [{ ...delivered, message_id: '' }, { ...delivered, delivered_at: 0 }, { ...delivered, delivered_at: 1.5 }, { ...delivered, excerpt: '' }, { ...delivered, excerpt: 'x'.repeat(281) }, 'text'])
      expect(() => readDayLatest(day([card('card:brief', bad)]))).toThrow();
  });
});

describe('the Brief\'s text as Home shows it', () => {
  it('drops Markdown marks and keeps a short excerpt whole', () => {
    expect(excerptText('## Today\n**Design review** at `10:00`\n- Lunch with Ana')).toBe('Today\nDesign review at 10:00\n• Lunch with Ana');
  });

  it('ends a cut excerpt at its last whole word with an ellipsis, never half a character', () => {
    const cut = `${'word '.repeat(55)}abcde`.slice(0, 280);
    expect(cut).toHaveLength(280);
    expect(excerptText(cut)).toBe(`${'word '.repeat(55).trim()}…`);
    const split = `${'a'.repeat(279)}😀`.slice(0, 280);
    expect(excerptText(split).endsWith('…')).toBe(true);
    expect(excerptText(split)).not.toMatch(/[\uD800-\uDBFF]…$/);
  });
});

describe('the reveal, at the app\'s pace', () => {
  it('times each word after the one before, with a breath after a sentence and a longer one between paragraphs', () => {
    const [first, second] = revealWords('Morning. Big day\nLunch at one');
    expect(first!.map(w => [w.text, w.at])).toEqual([['Morning.', 0], ['Big', REVEAL.WORD_MS + REVEAL.SENTENCE_GAP_MS], ['day', 2 * REVEAL.WORD_MS + REVEAL.SENTENCE_GAP_MS]]);
    expect(second![0]).toEqual({ text: 'Lunch', at: 3 * REVEAL.WORD_MS + REVEAL.SENTENCE_GAP_MS + REVEAL.PARAGRAPH_GAP_MS });
  });

  it('plays a Brief once in this browser, keeps only its id, and forgets it on sign-out', () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); }, removeItem: (k: string) => { kept.delete(k); } };
    expect(firstReveal('row-1', storage)).toBe(true);
    expect(firstReveal('row-1', storage)).toBe(false);
    expect([...kept.values()]).toEqual(['row-1']);
    expect(firstReveal('row-2', storage)).toBe(true);
    forgetBriefRevealed(storage);
    expect(kept.size).toBe(0);
    expect(firstReveal('row-2', storage)).toBe(true);
  });

  it('shows the Brief still when the browser keeps nothing', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(firstReveal('row-1', broken)).toBe(false);
    expect(() => forgetBriefRevealed(broken)).not.toThrow();
  });
});
