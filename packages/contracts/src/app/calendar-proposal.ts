import { z } from 'zod';

// The owner asks, from the app's calendar, for an event to be added, moved or cancelled. Nothing is written to the
// calendar: the server raises the same calendar_change approval Waldo's own proposals raise (./approvals), and the change
// happens only when the owner approves that card. The owner comes from the authenticated session.
const instant = z.iso.datetime({ offset: true });
// The server's own id for an event, as GET /app/v1/calendar/day gave it, with the local day it was read for.
const eventId = z.string().min(1).max(128);
const endsAfterStart = (change: Readonly<{ start: string; end: string }>) => Date.parse(change.end) > Date.parse(change.start);

export const calendarProposalChangeV1Schema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'), title: z.string().min(1).max(200), start: instant, end: instant,
    location: z.string().min(1).max(300).optional(), guests: z.array(z.email()).min(1).max(50).optional(),
  }).refine(endsAfterStart, { error: 'the event ends after it starts', path: ['end'] }),
  z.strictObject({ action: z.literal('move'), event_id: eventId, day: z.iso.date(), start: instant, end: instant })
    .refine(endsAfterStart, { error: 'the event ends after it starts', path: ['end'] }),
  z.strictObject({ action: z.literal('cancel'), event_id: eventId, day: z.iso.date() }),
]);

// Repeating a request_id with the same change answers the approval it raised the first time, never a second card.
export const calendarProposalRequestV1Schema = z.strictObject({
  request_id: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  change: calendarProposalChangeV1Schema,
});
export const calendarProposalResponseV1Schema = z.strictObject({ approval_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) });

// invalid_request (400): the body is not this contract. event_not_found (404): the event is no longer on that day of the
// owner's calendar. not_connected, needs_reconnect (409): there is no calendar to change, or it must be reconnected.
// request_reused (409): the request_id was already used for a different change. too_late (409): the new time, or the event
// being moved, has already started, so a card for it could no longer be approved. unavailable: anything else; nothing was raised.
// The runtime may attach a short message; a client acts on `error` only.
export const calendarProposalApiErrorV1Schema = z.strictObject({
  error: z.enum(['invalid_request', 'event_not_found', 'not_connected', 'needs_reconnect', 'request_reused', 'too_late', 'unavailable']),
  message: z.string().max(1000).optional(),
});

export const appCalendarProposalRoutesV1 = [
  { method: 'POST', path: '/app/v1/calendar/proposals', request: calendarProposalRequestV1Schema, response: calendarProposalResponseV1Schema, authenticated: true, success_status: 201 },
] as const;

export type CalendarProposalChangeV1 = z.infer<typeof calendarProposalChangeV1Schema>;
export type CalendarProposalRequestV1 = z.infer<typeof calendarProposalRequestV1Schema>;
export type CalendarProposalResponseV1 = z.infer<typeof calendarProposalResponseV1Schema>;
