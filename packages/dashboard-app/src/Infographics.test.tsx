import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DayRail, localMinutes, pulseHeight, railLayout, sameLocalDay, SourceBar } from './Infographics';

it('drops a crowded mark to the second lane and pins edge labels inside the rail', () => {
  const laid = railLayout([{ key: 'b', at: 9 * 60 + 30, label: 'Check-in', time: '9:30 AM', kind: 'next' }, { key: 'a', at: 9 * 60, label: 'Brief', time: '9:00 AM', kind: 'done' }, { key: 'c', at: 23 * 60 + 50, label: 'Close', time: '11:50 PM', kind: 'plain' }]);
  expect(laid.map(mark => [mark.key, mark.lane, mark.edge])).toEqual([['a', 0, null], ['b', 1, null], ['c', 0, 'r']]);
});
it('reads minutes and calendar days in the owner timezone, not the device zone', () => {
  expect(localMinutes('2026-10-03T03:30:00Z', 'Asia/Kolkata')).toBe(9 * 60);
  expect(sameLocalDay('2026-10-03T18:40:00Z', '2026-10-03T17:00:00Z', 'Asia/Kolkata')).toBe(false);
  expect(localMinutes('2026-10-03T03:30:00Z', 'invalid')).toBeNull();
});
it('scales recorded duration into a bounded bar height', () => {
  expect(pulseHeight(0)).toBe(10);
  expect(pulseHeight(4000)).toBe(48);
  expect(pulseHeight(90000)).toBe(48);
  expect(pulseHeight(-5)).toBe(10);
});
it('describes the rail in text and escapes labels', () => {
  const html = renderToStaticMarkup(<DayRail marks={[{ key: 'x', at: 60, label: '<script>', time: '1:00 AM', kind: 'next' }]} now={30} summary="Now 12:30 AM."/>);
  expect(html).toContain('role="img"'); expect(html).toContain('aria-label="Now 12:30 AM."'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
});
it('labels the mix with its scope and draws nothing for an empty page', () => {
  expect(renderToStaticMarkup(<SourceBar segments={[{ key: 'inferred', label: 'inferred', count: 3 }]} scope="This page"/>)).toContain('aria-label="This page: 3 inferred"');
  expect(renderToStaticMarkup(<SourceBar segments={[]} scope="This page"/>)).toBe('');
});
