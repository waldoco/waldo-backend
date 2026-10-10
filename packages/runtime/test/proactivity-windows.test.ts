import { describe, expect, it } from 'vitest';
import { notificationAllowed, processingAllowed } from '../src/proactivity/windows';
import type { ProactivityPolicy } from '../src/proactivity/types';

const policy: ProactivityPolicy = { revision: 1, enabled: true, timezone: 'America/New_York', processingWindows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }], notificationWindows: [], quietHours: { start: '22:00', end: '08:00' } };
describe('separate source processing and notification windows', () => {
  it('lets permitted notifications through outside the work-account processing window', () => {
    const at = Date.parse('2026-10-10T16:00:00Z');
    expect(processingAllowed(policy, at)).toBe(false);
    expect(notificationAllowed(policy, at)).toBe(true);
  });
  it('uses current local time on both sides of the DST fallback', () => {
    const daily = { ...policy, processingWindows: [], quietHours: { start: '01:00', end: '02:00' } };
    expect(notificationAllowed(daily, Date.parse('2026-11-01T05:30:00Z'))).toBe(false);
    expect(notificationAllowed(daily, Date.parse('2026-11-01T06:30:00Z'))).toBe(false);
    expect(notificationAllowed(daily, Date.parse('2026-11-01T07:00:00Z'))).toBe(true);
  });
  it('keeps an overnight processing window attached to its starting weekday', () => {
    const night = { ...policy, timezone: 'UTC', processingWindows: [{ days: [5], start: '22:00', end: '06:00' }] };
    expect(processingAllowed(night, Date.parse('2026-10-10T05:00:00Z'))).toBe(true);
    expect(processingAllowed(night, Date.parse('2026-10-11T05:00:00Z'))).toBe(false);
  });
});
