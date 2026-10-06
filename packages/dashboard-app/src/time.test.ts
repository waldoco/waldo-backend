import { expect, it } from 'vitest';
import { relativeTime } from './time';
const now = new Date('2026-10-06T12:00:00Z');
it('says recent times in words and older ones as a date', () => {
  expect(relativeTime('2026-10-06T11:59:40Z', now)).toBe('just now');
  expect(relativeTime('2026-10-06T11:00:00Z', now)).toBe('1 hour ago');
  expect(relativeTime('2026-10-04T12:00:00Z', now)).toBe('2 days ago');
  expect(relativeTime('2026-10-06T14:00:00Z', now)).toBe('in 2 hours');
  expect(relativeTime('2026-09-01T12:00:00Z', now)).toBe('Sep 1');
  expect(relativeTime('not a date', now)).toBe('time unavailable');
});
