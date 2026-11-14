import { describe, expect, it } from 'vitest';
import { APP_TODAY_DEADLINE_MS_V1, appTodayApiErrorV1Schema, appTodayRoutesV1, appTodayV1Schema } from './today';

// Synthetic values: a made-up day and event.
const event = { id: 'evt-1', title: 'Design review', start: '2026-11-06T10:00:00+05:30', end: '2026-11-06T11:00:00+05:30', category: 'meeting' };
const today = {
  compiled_at: '2026-11-06T04:00:00.000Z', day: '2026-11-06', timezone: 'Asia/Kolkata',
  calendar: { state: 'available', now: null, next: event, left: 3 },
  approvals: { state: 'available', waiting: 2 },
  brief: { state: 'delivered', excerpt: 'A light morning, then the review at ten.', delivered_at: 1_762_400_000_000 },
};

describe('today', () => {
  it('carries each part, or says it is unavailable on its own', () => {
    expect(appTodayV1Schema.safeParse(today).success).toBe(true);
    expect(appTodayV1Schema.safeParse({ ...today, day: null, timezone: null, calendar: { state: 'unavailable' }, approvals: { state: 'unavailable' }, brief: { state: 'unavailable' } }).success).toBe(true);
    expect(appTodayV1Schema.safeParse({ ...today, calendar: { state: 'needs_reconnect' }, brief: { state: 'not_delivered' } }).success).toBe(true);
  });

  it('refuses a part with fields its state does not carry, or anything beyond a glance', () => {
    for (const bad of [
      { ...today, calendar: { state: 'not_connected', next: event } },
      { ...today, calendar: { ...today.calendar, next: { ...event, attendees: { names: ['Someone'], more: 0 } } } },
      { ...today, calendar: { ...today.calendar, next: { ...event, end: event.start } } },
      { ...today, approvals: { state: 'available', waiting: 101 } },
      { ...today, brief: { state: 'delivered', excerpt: 'x'.repeat(281), delivered_at: 1 } },
      { ...today, brief: { state: 'not_delivered', excerpt: 'x' } },
      { ...today, day: null },
      { ...today, events: [event] },
    ]) expect(appTodayV1Schema.safeParse(bad).success).toBe(false);
  });

  it('refuses with a closed error code, and answers within a few seconds', () => {
    expect(appTodayApiErrorV1Schema.safeParse({ error: 'unavailable' }).success).toBe(true);
    expect(appTodayApiErrorV1Schema.safeParse({ error: 'invalid_request', message: 'no query' }).success).toBe(true);
    for (const bad of [{ error: 'not_found' }, { error: 'unavailable', detail: 'x' }, { error: 'unavailable', message: 'x'.repeat(1001) }, {}])
      expect(appTodayApiErrorV1Schema.safeParse(bad).success).toBe(false);
    expect(APP_TODAY_DEADLINE_MS_V1).toBeLessThanOrEqual(10_000);
  });

  it('declares its route', () => {
    expect(appTodayRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual(['GET /app/v1/today']);
  });
});
