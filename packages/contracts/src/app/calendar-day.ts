import { z } from 'zod';
import { healthDayV1Schema, healthInstantV1Schema, healthScoreUnavailableReasonV1Schema, healthTimezoneV1Schema } from './health-ingest';

// The owner's day for the app's calendar: the timed events of their connected Google Calendar on one local day, each with
// the pills the server derived for it, and Form across the day. Read-only; the owner comes from the authenticated session.
// The day is a local day in the owner's own zone; left out, it is the owner's today.
export const calendarDayQueryV1Schema = z.strictObject({ day: healthDayV1Schema.optional() });

// A kind the server can stand behind for the event; 'other' when it cannot.
export const calendarEventCategoryV1Schema = z.enum(['deep_work', 'meeting', 'meal', 'other']);
// Every pill is the server's: derived from Form, the owner's priorities and Waldo's own moves. The app never adds one.
export const calendarEventBadgeV1Schema = z.enum(['strong_form', 'peak_window', 'low_form', 'priority', 'moved', 'rising_stress']);

export const calendarEventV1Schema = z.strictObject({
  // The server's own id for the event, stable within the day; never the provider's id.
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(300),
  detail: z.string().min(1).max(300).nullable(),
  start: healthInstantV1Schema,
  end: healthInstantV1Schema,
  category: calendarEventCategoryV1Schema,
  // The guests other than the owner: up to three names, and how many more there are.
  attendees: z.strictObject({ names: z.array(z.string().min(1).max(80)).max(3), more: z.int().nonnegative() }).nullable(),
  badges: z.array(calendarEventBadgeV1Schema).max(3).refine(list => new Set(list).size === list.length, 'badges repeat'),
}).refine(event => Date.parse(event.end) > Date.parse(event.start), 'event ends before it starts');

export const calendarFormPointV1Schema = z.strictObject({
  at: healthInstantV1Schema,
  score: z.number().finite().min(0).max(100),
  kind: z.enum(['measured', 'projected']),
});

const algorithmVersion = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\.v[0-9]+$/).max(64);

// compiled_at is when the server put this answer together. Calendar events are read live; all-day events are left out.
// A calendar that is not available carries no events. Form is unavailable, with the reason, whenever the owner's health
// is not shared or no curve has been computed for the day: never a made-up line.
export const calendarDayV1Schema = z.strictObject({
  day: healthDayV1Schema,
  timezone: healthTimezoneV1Schema,
  compiled_at: healthInstantV1Schema,
  freshness: z.enum(['fresh', 'stale', 'expired']),
  calendar: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('not_connected') }),
    z.strictObject({ state: z.literal('needs_reconnect') }),
    z.strictObject({ state: z.literal('available'), read_at: healthInstantV1Schema }),
  ]),
  events: z.array(calendarEventV1Schema).max(200)
    .refine(events => events.every((event, i) => i === 0 || Date.parse(event.start) >= Date.parse(events[i - 1]!.start)), 'events out of order')
    .refine(events => new Set(events.map(event => event.id)).size === events.length, 'event ids repeat'),
  form: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('unavailable'), reason: healthScoreUnavailableReasonV1Schema }),
    z.strictObject({
      state: z.literal('available'),
      algorithm_version: algorithmVersion,
      activation: z.enum(['candidate_unaccepted', 'accepted']),
      confidence: z.number().finite().min(0).max(1).nullable(),
      points: z.array(calendarFormPointV1Schema).max(96)
        .refine(points => points.every((p, i) => i === 0 || Date.parse(p.at) > Date.parse(points[i - 1]!.at)), 'points out of order')
        .refine(points => points.every((p, i) => i === 0 || !(p.kind === 'measured' && points[i - 1]!.kind === 'projected')), 'measured after projected'),
    }),
  ]),
}).refine(answer => answer.calendar.state === 'available' || answer.events.length === 0, { error: 'events without a readable calendar', path: ['events'] });

// The runtime may attach a short message; a client acts on `error` only.
export const calendarDayApiErrorV1Schema = z.strictObject({
  error: z.enum(['invalid_request', 'unavailable']),
  message: z.string().max(1000).optional(),
});

export const appCalendarRoutesV1 = [
  { method: 'GET', path: '/app/v1/calendar/day', query: calendarDayQueryV1Schema, response: calendarDayV1Schema, authenticated: true, success_status: 200 },
] as const;

export type CalendarDayV1 = z.infer<typeof calendarDayV1Schema>;
export type CalendarEventV1 = z.infer<typeof calendarEventV1Schema>;
export type CalendarEventBadgeV1 = z.infer<typeof calendarEventBadgeV1Schema>;
export type CalendarEventCategoryV1 = z.infer<typeof calendarEventCategoryV1Schema>;
