import { describe, expect, it } from 'vitest';
import { googleClient } from '../src/connectors/google';
const app = { clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://example.test/callback' };
const account = { connection_id: 'connection', email: 'owner@example.test' };
const calendar = 'team@example.test';
const start = '2026-10-11T10:00:00Z', end = '2026-10-11T11:00:00Z';
const fixture = () => {
  const state = { writes: 0, wrongAudience: false, event: { id: 'event', summary: 'Review', start: { dateTime: start }, end: { dateTime: end }, attendees: [{ email: 'peer@example.test', responseStatus: 'needsAction' }], etag: 'v1' } as Record<string, any>, requests: [] as { url: URL; method: string; body: any; headers: Headers }[] };
  const client = googleClient(app, { refresh_token: 'fixture' }, (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture' });
    const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : null;
    state.requests.push({ url, method, body: structuredClone(body), headers: new Headers(init?.headers) });
    if (method === 'POST' || method === 'PATCH') {
      state.writes++;
      state.event = { ...state.event, ...body, etag: 'v2' };
      for (const endpoint of ['start', 'end']) if (state.event[endpoint]) for (const key of ['date', 'dateTime']) if (state.event[endpoint][key] === null) delete state.event[endpoint][key];
      return Response.json(state.event);
    }
    return Response.json(state.wrongAudience ? { ...state.event, attendees: [{ email: 'other@example.test' }] } : state.event);
  }) as typeof fetch, undefined, account);
  return { state, client };
};

describe('explicit Calendar effects and invitation audience', () => {
  it('creates in the selected calendar with exact invitees/content and chosen notification audience, then reopens there', async () => {
    const f = fixture();
    const result = await f.client.createEvent({ id: 'event', title: 'Review', start, end, operationMarker: 'marker', calendar_id: calendar, attendees: ['peer@example.test'], send_updates: 'all', description: 'Exact agenda', location: 'Room 1' });
    expect(result).toMatchObject({ calendar_id: calendar, attendee_emails: ['peer@example.test'], attendees_complete: true, notification_delivery: 'unverified' });
    const write = f.state.requests.find(r => r.method === 'POST')!;
    expect(write.url.pathname).toBe('/calendar/v3/calendars/team%40example.test/events');
    expect(write.url.searchParams.get('sendUpdates')).toBe('all');
    expect(write.body).toMatchObject({ attendees: [{ email: 'peer@example.test' }], description: 'Exact agenda', location: 'Room 1' });
    expect(f.state.requests.at(-1)!.url.pathname).toBe('/calendar/v3/calendars/team%40example.test/events/event');
    expect(f.state.writes).toBe(1);
  });
  it('moves an existing selected-calendar event without replacing its guest list', async () => {
    const f = fixture();
    await f.client.moveEvent('event', '2026-10-11T12:00:00Z', '2026-10-11T13:00:00Z', 'v1', 'marker', { calendar_id: calendar, send_updates: 'externalOnly', expected_attendees: ['peer@example.test'] });
    const write = f.state.requests.find(r => r.method === 'PATCH')!;
    expect(write.url.pathname).toBe('/calendar/v3/calendars/team%40example.test/events/event');
    expect(write.url.searchParams.get('sendUpdates')).toBe('externalOnly');
    expect(write.body.attendees).toBeUndefined();
    expect(write.headers.get('if-match')).toBe('v1');
    expect(f.state.writes).toBe(1);
  });
  it('rejects an audience change before an external notification effect', async () => {
    const f = fixture(); f.state.wrongAudience = true;
    await expect(f.client.moveEvent('event', start, end, 'v1', 'marker', { calendar_id: calendar, send_updates: 'all', expected_attendees: ['peer@example.test'] })).rejects.toThrow();
    expect(f.state.writes).toBe(0);
  });
  it('does not accept a final readback with different invitees', async () => {
    const f = fixture(); f.state.wrongAudience = true;
    await expect(f.client.createEvent({ id: 'event', title: 'Review', start, end, calendar_id: calendar, attendees: ['peer@example.test'], send_updates: 'all' })).rejects.toThrow('readback');
    expect(f.state.writes).toBe(1);
  });
  it('preserves the previous provider notification parameters when options are omitted', async () => {
    const f = fixture(); await f.client.createEvent({ title: 'Review', start, end });
    const write = f.state.requests.find(r => r.method === 'POST')!;
    expect(write.url.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(write.url.searchParams.has('sendUpdates')).toBe(false);
    expect(write.body.attendees).toBeUndefined();
  });
  it('cancels on the selected calendar with the frozen audience and operation marker', async () => {
    const f = fixture();
    await f.client.cancelEvent('event', 'v1', 'cancel-marker', { calendar_id: calendar, send_updates: 'all', expected_attendees: ['peer@example.test'] });
    const write = f.state.requests.find(r => r.method === 'PATCH')!;
    expect(write.url.pathname).toBe('/calendar/v3/calendars/team%40example.test/events/event');
    expect(write.url.searchParams.get('sendUpdates')).toBe('all');
    expect(write.body).toEqual({ status: 'cancelled', extendedProperties: { private: { waldoOperation: 'cancel-marker' } } });
    expect(f.state.requests.at(-1)!.url.pathname).toBe(write.url.pathname);
    expect(f.state.writes).toBe(1);
  });
  it('creates an all-day date interval on the selected calendar without inventing a time', async () => {
    const f = fixture(); f.state.event.attendees = [];
    expect(await f.client.createEvent({ title: 'All day', start: '2026-10-11', end: '2026-10-12', calendar_id: calendar })).toMatchObject({ all_day: true, start: '2026-10-11', end: '2026-10-12', calendar_id: calendar });
    expect(f.state.requests.find(r => r.method === 'POST')!.body).toMatchObject({ start: { date: '2026-10-11', dateTime: null }, end: { date: '2026-10-12', dateTime: null } });
  });
  it('rejects notification effects lacking a reviewed complete audience before any mutation', async () => {
    const f = fixture();
    await expect(f.client.moveEvent('event', start, end, 'v1', 'marker', { calendar_id: calendar, send_updates: 'all' })).rejects.toThrow('reviewed attendee');
    f.state.event.attendeesOmitted = true;
    await expect(f.client.cancelEvent('event', 'v1', 'marker', { calendar_id: calendar, send_updates: 'all', expected_attendees: ['peer@example.test'] })).rejects.toThrow('audience changed');
    expect(f.state.writes).toBe(0);
  });
  it('does not report a selected-calendar create complete with unrequested guests', async () => {
    const f = fixture();
    await expect(f.client.createEvent({ title: 'Solo', start, end, calendar_id: calendar })).rejects.toThrow('readback');
    expect(f.state.writes).toBe(1);
  });
  it('keeps complete audience evidence out of ordinary model prompt projections', async () => {
    const { calendarPromptProjection } = await import('../src/connectors/google');
    const f = fixture(); const event = await f.client.eventInCalendar!(calendar, 'event');
    expect(event).toMatchObject({ attendee_emails: ['peer@example.test'], attendees_complete: true });
    expect(calendarPromptProjection(event)).not.toHaveProperty('attendee_emails');
    expect(calendarPromptProjection(event)).not.toHaveProperty('attendees_complete');
  });
});
