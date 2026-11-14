import { describe, expect, it } from 'vitest';
import { appCalendarProposalRoutesV1, calendarProposalApiErrorV1Schema, calendarProposalRequestV1Schema, calendarProposalResponseV1Schema } from './calendar-proposal';

const REQUEST_ID = 'req_0123456789';
const create = { action: 'create', title: 'Design review', start: '2026-10-27T10:00:00+05:30', end: '2026-10-27T11:00:00+05:30' };
const move = { action: 'move', event_id: 'evt_0123456789abcdef', day: '2026-10-27', start: '2026-10-27T15:00:00+05:30', end: '2026-10-27T16:00:00+05:30' };
const cancel = { action: 'cancel', event_id: 'evt_0123456789abcdef', day: '2026-10-27' };
const request = (change: unknown, request_id: unknown = REQUEST_ID) => ({ request_id, change });
const accepted = (input: unknown) => calendarProposalRequestV1Schema.safeParse(input).success;

describe('calendar proposal', () => {
  it('takes a create with and without a place and guests, a move and a cancel, unchanged', () => {
    const invite = { ...create, location: 'Room 4', guests: ['asha@example.test', 'ravi@example.test'] };
    for (const change of [create, invite, move, cancel, { ...create, start: '2026-10-27T04:30:00Z', end: '2026-10-27T05:30:00Z' }])
      expect(calendarProposalRequestV1Schema.parse(request(change))).toEqual(request(change));
  });

  it('bounds the request id', () => {
    for (const id of ['a'.repeat(8), 'A-b_9'.repeat(16)]) expect(accepted(request(create, id)), id).toBe(true);
    for (const id of ['a'.repeat(7), 'a'.repeat(81), 'has space1', 'dots.are.out', '', 12345678, null]) expect(accepted(request(create, id)), String(id)).toBe(false);
  });

  it('refuses a change that is not exactly one of the three', () => {
    const refused: unknown[] = [
      { ...create, title: '' }, { ...create, title: 'x'.repeat(201) }, { ...create, start: '2026-10-27T10:00:00' }, { ...create, end: '2026-10-27' },
      { ...create, end: create.start }, { ...create, end: '2026-10-27T09:00:00+05:30' },
      { ...create, location: '' }, { ...create, location: 'x'.repeat(301) }, { ...create, guests: [] }, { ...create, guests: ['not-an-address'] },
      { ...create, guests: Array.from({ length: 51 }, (_, i) => `guest${i}@example.test`) },
      { ...create, event_id: 'evt_1' }, { ...create, notes: 'extra' }, { ...create, action: 'update' }, { title: 'No action', start: create.start, end: create.end },
      { ...move, event_id: '' }, { ...move, event_id: 'x'.repeat(129) }, { ...move, day: '27-10-2026' }, { ...move, day: undefined }, { ...move, end: move.start },
      { ...move, title: 'Renamed' }, { ...move, guests: ['asha@example.test'] }, { action: 'move', event_id: 'evt_1', day: '2026-10-27' },
      { ...cancel, start: move.start, end: move.end }, { action: 'cancel', event_id: 'evt_1' }, { action: 'cancel', day: '2026-10-27' },
    ];
    for (const change of refused) expect(accepted(request(change)), JSON.stringify(change)).toBe(false);
    for (const body of [{ change: create }, { request_id: REQUEST_ID }, { ...request(create), owner: 'someone' }, null, []]) expect(accepted(body), JSON.stringify(body)).toBe(false);
  });

  it('takes the limits of a create: a 200-character title, a 300-character place and 50 guests', () => {
    expect(accepted(request({ ...create, title: 'x'.repeat(200), location: 'y'.repeat(300), guests: Array.from({ length: 50 }, (_, i) => `guest${i}@example.test`) }))).toBe(true);
  });

  it('answers the approval id alone', () => {
    for (const id of ['p1', 'A-b_9', 'a'.repeat(80)]) expect(calendarProposalResponseV1Schema.parse({ approval_id: id })).toEqual({ approval_id: id });
    for (const body of [{ approval_id: '' }, { approval_id: 'a'.repeat(81) }, { approval_id: 'p 1' }, { approval_id: 'p1', state: 'open' }, {}])
      expect(calendarProposalResponseV1Schema.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });

  it('names each refusal, and the route', () => {
    for (const error of ['invalid_request', 'event_not_found', 'not_connected', 'needs_reconnect', 'request_reused', 'too_late', 'unavailable'])
      expect(calendarProposalApiErrorV1Schema.safeParse({ error }).success, error).toBe(true);
    expect(calendarProposalApiErrorV1Schema.safeParse({ error: 'unavailable', message: 'x'.repeat(1000) }).success).toBe(true);
    for (const body of [{ error: 'forbidden' }, { error: 'unavailable', message: 'x'.repeat(1001) }, { error: 'unavailable', detail: 'x' }])
      expect(calendarProposalApiErrorV1Schema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    expect(appCalendarProposalRoutesV1.map(route => `${route.method} ${route.path} ${route.success_status} ${route.authenticated}`)).toEqual(['POST /app/v1/calendar/proposals 201 true']);
  });
});
