import { describe, expect, it } from 'vitest';
import { calendarPromptProjection, googleClient } from '../src/connectors/google';

const event = { id: 'instance-1', status: 'confirmed', summary: 'Design review', etag: 'revision-1', updated: '2026-10-03T07:00:00Z', recurringEventId: 'series-1', originalStartTime: { dateTime: '2026-10-03T10:00:00+05:30' }, start: { dateTime: '2026-10-03T10:30:00+05:30' }, end: { dateTime: '2026-10-03T11:00:00+05:30' }, htmlLink: 'https://calendar.google.com/calendar/event?eid=fixture', attendees: [{ displayName: 'Pat', responseStatus: 'accepted' }, { email: 'hidden@example.test', responseStatus: 'accepted' }, { displayName: 'Declined Person', responseStatus: 'declined' }] };
const client = (value: unknown) => googleClient({ clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://fixture.invalid' }, { refresh_token: 'fixture' }, (async (input: string) => Response.json(input.startsWith('https://oauth2') ? { access_token: 'fixture' } : value)) as typeof fetch, undefined, { connection_id: 'owner-connection', email: 'owner@example.test' });

describe('meeting-prep calendar source', () => {
  it('preserves fetched revision, recurring occurrence, status and known participant names', async () => {
    const page = await client({ kind: 'calendar#events', items: [event] }).calendarPage('primary', '2026-10-03T04:00:00Z', '2026-10-03T06:00:00Z', 10, false);
    expect(page.account.connection_id).toBe('owner-connection');
    expect(page.events[0]).toMatchObject({ status: 'confirmed', updated: event.updated, recurring_event_id: 'series-1', original_start: event.originalStartTime.dateTime, source_url: event.htmlLink, attendee_names: ['Pat'], etag: 'revision-1' });
    expect(calendarPromptProjection(page.events[0]!)).not.toHaveProperty('etag');
    expect(JSON.stringify(calendarPromptProjection(page.events[0]!))).not.toContain('hidden@example.test');
  });

  it('represents a fetched cancellation without invented details or throwing', async () => {
    expect(await client({ id: 'instance-1', status: 'cancelled', recurringEventId: 'series-1', originalStartTime: event.originalStartTime }).event('instance-1')).toMatchObject({ id: 'instance-1', status: 'cancelled', start: '', end: '', original_start: event.originalStartTime.dateTime });
  });

  it('does not expose unsafe calendar URLs or invent missing participants', async () => {
    for (const htmlLink of ['javascript:alert(1)', 'https://calendar.google.com.attacker.invalid/calendar/event', 'https://user:password@calendar.google.com/calendar/event', `https://calendar.google.com/calendar/event?eid=${' x'.repeat(900)}`]) {
      const value = await client({ ...event, htmlLink, attendees: undefined }).event('instance-1');
      expect(value).not.toHaveProperty('source_url');
      expect(value).not.toHaveProperty('attendee_names');
    }
  });
});
