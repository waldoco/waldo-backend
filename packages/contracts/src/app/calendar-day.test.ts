import { describe, expect, it } from 'vitest';
import { appCalendarRoutesV1, calendarDayApiErrorV1Schema, calendarDayQueryV1Schema, calendarDayV1Schema, calendarEventV1Schema } from './calendar-day';

const event = {
  id: 'evt_0123456789abcdef', title: 'Design review', detail: 'Room 4', start: '2026-10-27T10:00:00+05:30', end: '2026-10-27T11:00:00+05:30',
  category: 'meeting', attendees: { names: ['Asha', 'Ravi'], more: 3 }, badges: [],
};
const day = {
  day: '2026-10-27', timezone: 'Asia/Kolkata', compiled_at: '2026-10-27T08:00:00Z', freshness: 'fresh',
  calendar: { state: 'available', read_at: '2026-10-27T08:00:00Z' },
  events: [event, { ...event, id: 'evt_2', start: '2026-10-27T13:00:00+05:30', end: '2026-10-27T13:30:00+05:30', category: 'other', attendees: null, detail: null }],
  form: { state: 'unavailable', reason: 'intraday_inputs_unavailable' },
};
const curve = {
  state: 'available', algorithm_version: 'form.intraday.v1', activation: 'candidate_unaccepted', confidence: 0.6,
  points: [
    { at: '2026-10-27T07:00:00+05:30', score: 61, kind: 'measured' },
    { at: '2026-10-27T08:00:00+05:30', score: 64, kind: 'measured' },
    { at: '2026-10-27T09:00:00+05:30', score: 70, kind: 'projected' },
  ],
};
const rejected = (schema: { safeParse(input: unknown): { success: boolean } }, inputs: unknown[]) => inputs.forEach(input => expect(schema.safeParse(input).success, JSON.stringify(input)).toBe(false));

describe('calendar day', () => {
  it('takes a populated day, an empty day, and every calendar and form state', () => {
    expect(calendarDayV1Schema.parse(day)).toEqual(day);
    expect(calendarDayV1Schema.safeParse({ ...day, events: [] }).success).toBe(true);
    expect(calendarDayV1Schema.safeParse({ ...day, form: curve }).success).toBe(true);
    for (const calendar of [{ state: 'not_connected' }, { state: 'needs_reconnect' }]) expect(calendarDayV1Schema.safeParse({ ...day, calendar, events: [] }).success, calendar.state).toBe(true);
    for (const reason of ['not_linked', 'consent_required', 'consent_withdrawn', 'no_readings', 'intraday_inputs_unavailable']) {
      expect(calendarDayV1Schema.safeParse({ ...day, form: { state: 'unavailable', reason } }).success, reason).toBe(true);
    }
  });

  it('refuses unknown keys, events from a calendar it could not read, and events out of order or repeated', () => {
    rejected(calendarDayV1Schema, [
      { ...day, owner_id: 'someone' },
      { ...day, calendar: { state: 'needs_reconnect' } },
      { ...day, calendar: { state: 'not_connected' } },
      { ...day, calendar: { state: 'available' } },
      { ...day, events: [...day.events].reverse() },
      { ...day, events: [event, event] },
      { ...day, events: Array.from({ length: 201 }, (_, i) => ({ ...event, id: `evt_${i}` })) },
      { ...day, freshness: 'live' },
      { ...day, timezone: 'Not a zone!' },
      { ...day, day: '2026-02-30' },
      { ...day, form: { state: 'unavailable', reason: 'tired' } },
    ]);
  });

  it('keeps every event bounded: ends after it starts, at most three unique server badges, three names', () => {
    expect(calendarEventV1Schema.safeParse({ ...event, badges: ['strong_form', 'priority', 'moved'] }).success).toBe(true);
    rejected(calendarEventV1Schema, [
      { ...event, end: event.start },
      { ...event, end: '2026-10-27T09:00:00+05:30' },
      { ...event, start: '2026-10-27 10:00' },
      { ...event, start: '2026-10-27T10:00:00' },
      { ...event, badges: ['priority', 'priority'] },
      { ...event, badges: ['strong_form', 'priority', 'moved', 'low_form'] },
      { ...event, badges: ['sparkly'] },
      { ...event, category: 'gym' },
      { ...event, title: '' },
      { ...event, title: 'x'.repeat(301) },
      { ...event, detail: '' },
      { ...event, id: '' },
      { ...event, id: 'x'.repeat(129) },
      { ...event, attendees: { names: ['a', 'b', 'c', 'd'], more: 0 } },
      { ...event, attendees: { names: ['a'], more: -1 } },
      { ...event, attendees: { names: [''], more: 0 } },
      { ...event, all_day: true },
    ]);
  });

  it('keeps the Form curve honest: ordered, bounded, never measured after projected', () => {
    const [a, b, c] = curve.points;
    rejected(calendarDayV1Schema, [
      { ...day, form: { ...curve, points: [b, a, c] } },
      { ...day, form: { ...curve, points: [a, a] } },
      { ...day, form: { ...curve, points: [a, c, { ...b, at: '2026-10-27T10:00:00+05:30' }] } },
      { ...day, form: { ...curve, points: [{ ...a, score: 101 }] } },
      { ...day, form: { ...curve, points: [{ ...a, kind: 'guessed' }] } },
      { ...day, form: { ...curve, confidence: 1.5 } },
      { ...day, form: { ...curve, algorithm_version: 'Form v1' } },
      { ...day, form: { ...curve, activation: 'validated' } },
      { ...day, form: { ...curve, points: Array.from({ length: 97 }, (_, i) => ({ ...a, at: new Date(Date.parse(a!.at) + i * 60_000).toISOString() })) } },
    ]);
  });

  it('takes only an optional day on the query, and closed errors', () => {
    expect(calendarDayQueryV1Schema.safeParse({}).success).toBe(true);
    expect(calendarDayQueryV1Schema.safeParse({ day: '2026-10-27' }).success).toBe(true);
    rejected(calendarDayQueryV1Schema, [{ day: 'today' }, { day: '2026-10-27', owner: 'x' }]);
    expect(calendarDayApiErrorV1Schema.safeParse({ error: 'invalid_request' }).success).toBe(true);
    rejected(calendarDayApiErrorV1Schema, [{ error: 'not_found' }]);
    expect(appCalendarRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual(['GET /app/v1/calendar/day']);
  });
});
