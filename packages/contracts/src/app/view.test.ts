import { describe, expect, it } from 'vitest';
import { REPLY_FALLBACK_MAX_CHARS } from './parts';
import { appMessagePartV1Schema } from './core';
import { fitView, mapViewText, redactView, replyViewPartV1Schema, VIEW_BOUNDS, viewFallbackText, viewInputSchema, viewPart, viewV1Schema, type ViewInput } from './view';
import { showViewArgsSchema } from '../tools/schemas/view';

const hotels: ViewInput = {
  kind: 'options', title: 'Goa, 12 to 15 Dec',
  items: [
    { title: 'Taj Holiday Village', subtitle: 'Candolim, beachfront', facts: [{ label: 'Per night', value: '₹14,500' }, { label: 'Rating', value: '4.6' }], link: 'https://example.com/taj', pick: true },
    { title: 'Ahilya by the Sea', facts: [{ label: 'Per night', value: '₹11,000' }], note: 'Nine rooms.\nBook early.' },
  ],
};

describe('view', () => {
  it('serves each kind as an app part that a reader can parse', () => {
    const views: ViewInput[] = [
      hotels,
      { kind: 'table', columns: ['Flight', 'Departs', 'Price'], rows: [['6E 5302', '06:10', '₹4,800'], ['AI 863', '09:45', '']] },
      { kind: 'steps', title: 'Passport renewal', items: [{ title: 'Book the appointment', state: 'done' }, { title: 'Gather documents', state: 'current', detail: 'Old passport, address proof' }, { title: 'Visit the PSK' }] },
      { kind: 'timeline', items: [{ when: '09:00', title: 'Standup' }, { when: '14:30', title: 'Design review', detail: 'Room 4' }] },
    ];
    for (const view of views) {
      const part = viewPart(fitView(view).view);
      expect(replyViewPartV1Schema.parse(part)).toEqual(part);
      expect(appMessagePartV1Schema.safeParse(part).success).toBe(true);
    }
  });

  it('fits an oversized view instead of refusing it, and counts what was left out', () => {
    const many: ViewInput = { kind: 'steps', items: Array.from({ length: VIEW_BOUNDS.steps + 5 }, (_, i) => ({ title: `Step ${i + 1}\nwith a break`, detail: 'x'.repeat(2_000) })) };
    expect(showViewArgsSchema.safeParse({ view: many }).success).toBe(true);
    const { view, left_out } = fitView(many);
    expect(left_out).toBe(5);
    if (view.kind !== 'steps') throw new Error('kind changed');
    expect(view.items).toHaveLength(VIEW_BOUNDS.steps);
    expect(view.items[0]!.title).toBe('Step 1 with a break');
    expect(view.items[0]!.detail).toHaveLength(VIEW_BOUNDS.detail);
    expect(view.items[0]!.detail!.endsWith('…')).toBe(true);
  });

  it('squares a ragged table to its columns and drops a link that is not https', () => {
    const table = fitView({ kind: 'table', columns: Array.from({ length: 10 }, (_, i) => `C${i}`), rows: [['a'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']] }).view;
    if (table.kind !== 'table') throw new Error('kind changed');
    expect(table.columns).toHaveLength(VIEW_BOUNDS.columns);
    expect(table.rows.map(row => row.length)).toEqual([VIEW_BOUNDS.columns, VIEW_BOUNDS.columns]);
    const options = fitView({ kind: 'options', items: [{ title: 'A', link: 'javascript:alert(1)' }, { title: 'B', link: 'http://example.com' }, { title: 'C', link: 'https://example.com/c' }] }).view;
    if (options.kind !== 'options') throw new Error('kind changed');
    expect(options.items.map(item => item.link)).toEqual([undefined, undefined, 'https://example.com/c']);
  });

  it('refuses a stored view outside its bounds, a ragged table and an unknown kind', () => {
    expect(viewV1Schema.safeParse({ kind: 'table', columns: ['A', 'B'], rows: [['1']] }).success).toBe(false);
    expect(viewV1Schema.safeParse({ kind: 'steps', items: [{ title: 'two\nlines' }] }).success).toBe(false);
    expect(viewV1Schema.safeParse({ kind: 'options', items: [{ title: 'A', link: 'http://example.com' }] }).success).toBe(false);
    expect(viewV1Schema.safeParse({ kind: 'html', html: '<b>hi</b>' }).success).toBe(false);
    expect(viewInputSchema.safeParse({ kind: 'steps', items: [] }).success).toBe(false);
    expect(viewInputSchema.safeParse({ kind: 'steps', items: [{ title: '   ' }] }).success).toBe(false);
    expect(showViewArgsSchema.safeParse({ view: hotels, extra: 1 }).success).toBe(false);
  });

  it('says the whole view in plain text, and keeps within one message by whole lines', () => {
    expect(viewFallbackText(fitView(hotels).view)).toBe([
      'Goa, 12 to 15 Dec',
      "1. Taj Holiday Village (Waldo's pick) - Candolim, beachfront",
      '   Per night: ₹14,500 · Rating: 4.6',
      '   https://example.com/taj',
      '2. Ahilya by the Sea',
      '   Per night: ₹11,000',
      '   Nine rooms. Book early.',
    ].join('\n'));
    const wide = fitView({ kind: 'table', columns: ['A', 'B'], rows: Array.from({ length: 50 }, () => ['x'.repeat(200), 'y'.repeat(200)]) }).view;
    const text = viewFallbackText(wide);
    expect(text.length).toBeLessThanOrEqual(REPLY_FALLBACK_MAX_CHARS);
    expect(text.endsWith('\n…')).toBe(true);
    expect(text.split('\n').slice(1, -1).every(line => line === `${'x'.repeat(200)} | ${'y'.repeat(200)}`)).toBe(true);
  });

  it('rewrites every piece of text it shows, its links included, and nothing else', () => {
    const seen: string[] = [];
    const out = mapViewText(fitView(hotels).view, value => { seen.push(value); return value; });
    expect(seen).toEqual(['Goa, 12 to 15 Dec', 'Taj Holiday Village', 'Candolim, beachfront', 'https://example.com/taj', 'Per night', '₹14,500', 'Rating', '4.6', 'Ahilya by the Sea', 'Nine rooms.\nBook early.', 'Per night', '₹11,000']);
    if (out.kind !== 'options') throw new Error('kind changed');
    expect(out.items[0]!.link).toBe('https://example.com/taj');
    expect(out.items[0]!.pick).toBe(true);
  });
});

describe('forgetting in a view', () => {
  it('rewrites its text and leaves off a link the rewrite changed', () => {
    const view = fitView({ kind: 'options', items: [{ title: 'Goa villa', link: 'https://example.com/goa' }, { title: 'Pune flat', link: 'https://example.com/pune' }] }).view;
    const out = redactView(view, value => value.replaceAll('Goa', '[forgotten]').replaceAll('goa', '[forgotten]'));
    expect(viewV1Schema.safeParse(out).success).toBe(true);
    if (out.kind !== 'options') throw new Error('kind changed');
    expect(out.items).toEqual([{ title: '[forgotten] villa' }, { title: 'Pune flat', link: 'https://example.com/pune' }]);
  });
});

it('keeps a redacted view within its bounds when the replacement is longer than what it replaced', () => {
  const view = fitView({ kind: 'steps', items: [{ title: `${'a '.repeat(75)}x` }] }).view;
  const out = redactView(view, value => value.replaceAll('x', '[forgotten]'));
  expect(viewV1Schema.safeParse(out).success).toBe(true);
});

describe('what a view keeps', () => {
  it('keeps only links a browser opens as given, and refuses a stored one that does not parse', () => {
    const broken = ['https://[', 'https://a|b', 'https://exa^mple.com', 'https://user@', 'https://:80', 'https://#frag', 'https://xn--a.com'];
    const view = fitView({ kind: 'options', items: [...broken, 'https://example.com/ok'].map((link, i) => ({ title: `T${i}`, link })) }).view;
    if (view.kind !== 'options') throw new Error('kind changed');
    expect(view.items.map(item => item.link).filter(Boolean)).toEqual(['https://example.com/ok']);
    for (const link of broken) expect(viewV1Schema.safeParse({ kind: 'options', items: [{ title: 'T', link }] }).success).toBe(false);
  });

  it('never cuts a character in half', () => {
    const view = fitView({ kind: 'steps', items: [{ title: `ab${'😀'.repeat(100)}` }] }).view;
    if (view.kind !== 'steps') throw new Error('kind changed');
    const title = view.items[0]!.title;
    expect(title.endsWith('…')).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(title)).toBe(false);
    expect(title.length).toBeLessThanOrEqual(VIEW_BOUNDS.title);
  });
});
