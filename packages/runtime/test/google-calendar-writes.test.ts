import { describe, expect, it } from 'vitest';
import { googleClient } from '../src/connectors/google';

const app = { clientId: 'c', clientSecret: 's', redirectUri: 'https://w.test/oauth/google/callback' };
const start = '2026-10-14T10:00:00+05:30', end = '2026-10-14T10:30:00+05:30';
const TEAM = 'team@group.calendar.google.com';
const recorder = () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic' });
    calls.push({ url, init: init ?? {} });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ id: 'evt-1', summary: 'Design review', start: { dateTime: start }, end: { dateTime: end }, etag: '"v2"' });
  }) as typeof fetch;
  return { calls, client: googleClient(app, { refresh_token: 'synthetic' }, fetcher) };
};

describe('calendar writes carry the calendar, guests, place, notes, Meet link and the emailing choice', () => {
  it('a create on another calendar invites the guests, asks for a Meet link keyed to the event, and emails as told', async () => {
    const { calls, client } = recorder();
    await client.createEvent({ id: 'evt-1', title: 'Design review', start, end, operationMarker: 'm1', calendarId: TEAM, attendees: ['sam@example.com', 'pat@example.org'], description: 'Agenda', location: 'Room 4', meet: true, sendUpdates: 'all' });
    const { url, init } = calls[0]!;
    expect(url.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(TEAM)}/events`);
    expect(url.searchParams.get('sendUpdates')).toBe('all');
    expect(url.searchParams.get('conferenceDataVersion')).toBe('1');
    expect(JSON.parse(String(init.body))).toMatchObject({
      id: 'evt-1', summary: 'Design review', description: 'Agenda', location: 'Room 4',
      attendees: [{ email: 'sam@example.com' }, { email: 'pat@example.org' }],
      conferenceData: { createRequest: { requestId: 'evt-1', conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      extendedProperties: { private: { waldoOperation: 'm1' } },
    });
  });

  it('a plain create is unchanged: primary calendar, no emailing parameter, no conference request', async () => {
    const { calls, client } = recorder();
    await client.createEvent({ id: 'evt-1', title: 'Design review', start, end });
    const { url, init } = calls[0]!;
    expect(url.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect([...url.searchParams.keys()]).toEqual([]);
    expect(JSON.parse(String(init.body))).not.toHaveProperty('conferenceData');
  });

  it('move, cancel and the readback stay on the event\'s calendar, and move and cancel email as told', async () => {
    const { calls, client } = recorder();
    await client.event('evt-1', TEAM);
    await client.moveEvent('evt-1', start, end, '"v1"', 'm2', { calendarId: TEAM, sendUpdates: 'none' });
    await client.cancelEvent('evt-1', '"v2"', 'm3', { calendarId: TEAM, sendUpdates: 'all' });
    for (const { url } of calls) expect(url.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(TEAM)}/events/evt-1`);
    expect(calls.map(({ url }) => url.searchParams.get('sendUpdates'))).toEqual([null, 'none', 'all']);
  });

  it.each([{ calendarId: '' }, { calendarId: 'x'.repeat(255) }])('an invalid calendar id %j is refused before any call', async (options) => {
    const { calls, client } = recorder();
    await expect(client.moveEvent('evt-1', start, end, '"v1"', 'm', options)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
