import { z } from 'zod';
import { calendarEventCategoryV1Schema } from './calendar-day';
import { APP_CARD_EXCERPT_MAX_V1 } from './controls';
import { healthDayV1Schema, healthInstantV1Schema, healthTimezoneV1Schema } from './health-ingest';

// The owner's day at a glance, for the surfaces that cannot open a screen: the widget, Siri and Shortcuts intents, and Android
// AppFunctions. Read-only. It is put together from the owner's own calendar day, approvals and day view, read as this app build
// reads them, so it never shows what those screens do not. Each part stands alone: one that cannot be read says unavailable and
// the others still answer. Where any of it may be shown (on a locked screen, say) is the app's call, not this contract's.

const event = z.strictObject({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(300),
  start: healthInstantV1Schema,
  end: healthInstantV1Schema,
  category: calendarEventCategoryV1Schema,
}).refine(item => Date.parse(item.end) > Date.parse(item.start), 'event ends before it starts');

export const appTodayV1Schema = z.strictObject({
  compiled_at: healthInstantV1Schema,
  // The owner's local day and zone, as the calendar day names them; null when the calendar day could not be read.
  day: healthDayV1Schema.nullable(),
  timezone: healthTimezoneV1Schema.nullable(),
  // now is the timed event under way at compiled_at (the latest to start, if several), next the first to start after it, and
  // left how many of today's timed events have not ended.
  calendar: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('unavailable') }),
    z.strictObject({ state: z.literal('not_connected') }),
    z.strictObject({ state: z.literal('needs_reconnect') }),
    z.strictObject({ state: z.literal('available'), now: event.nullable(), next: event.nullable(), left: z.int().min(0).max(200) }),
  ]),
  // waiting counts the open approval cards the approvals list shows this build, which holds at most 100.
  approvals: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('unavailable') }),
    z.strictObject({ state: z.literal('available'), waiting: z.int().min(0).max(100) }),
  ]),
  // Today's Brief in Main chat: the opening of the message as the chat shows it, and when it was delivered (epoch ms).
  brief: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('unavailable') }),
    z.strictObject({ state: z.literal('not_delivered') }),
    z.strictObject({ state: z.literal('delivered'), excerpt: z.string().min(1).max(APP_CARD_EXCERPT_MAX_V1), delivered_at: z.int().positive() }),
  ]),
}).refine(today => (today.day === null) === (today.timezone === null), { error: 'day and timezone come together', path: ['day'] });

// The runtime may attach a short message; a client acts on `error` only.
export const appTodayApiErrorV1Schema = z.strictObject({
  error: z.enum(['invalid_request', 'unavailable']),
  message: z.string().max(1000).optional(),
});

export const appTodayRoutesV1 = [
  { method: 'GET', path: '/app/v1/today', response: appTodayV1Schema, authenticated: true, success_status: 200 },
] as const;

export type AppTodayV1 = z.infer<typeof appTodayV1Schema>;
