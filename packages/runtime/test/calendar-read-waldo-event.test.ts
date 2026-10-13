import { describe, expect, it } from 'vitest';
import { queryCalendarArgsSchema } from '@waldo/contracts';
import { googleClient } from '../src/connectors/google';
import { googleHandlers } from '../src/tools/live/google';

// Synthetic events only. An event Waldo created, moved or cancelled through the approval desk carries its operation
// marker; reading the calendar afterwards must still work, and the marker never reaches the model.
const app = { clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://example.test/callback' };
const clock = { timezone: 'UTC', now: () => new Date('2026-10-13T09:00:00Z') };
const desk = { propose: async () => '', proposeSendEmail: async () => '', record: () => {} };
const marker = 'a'.repeat(64);
const created = { id: 'qa1', etag: '"1"', status: 'confirmed', summary: 'QA', start: { dateTime: '2026-10-13T16:00:00+05:30' }, end: { dateTime: '2026-10-13T17:00:00+05:30' },
  extendedProperties: { private: { waldoOperation: marker } } };
const other = { id: 'e2', etag: '"2"', status: 'confirmed', summary: 'Standup', start: { dateTime: '2026-10-13T10:00:00Z' }, end: { dateTime: '2026-10-13T10:15:00Z' } };

const read = async (args: Record<string, unknown>, items: unknown[]) => {
  const fetcher = (async (input: RequestInfo | URL) => Response.json(new URL(String(input)).hostname === 'oauth2.googleapis.com' ? { access_token: 'fixture' } : { kind: 'calendar#events', items })) as typeof fetch;
  const client = googleClient(app, { refresh_token: 'grant' }, fetcher, undefined, { connection_id: 'c1', email: 'owner@example.test' });
  const handler = googleHandlers({ client: async () => client } as never, desk, clock).find(h => h.name === 'query_calendar')!;
  return await handler.handle(queryCalendarArgsSchema.parse(args)) as { ok: boolean; data?: { events: readonly Record<string, unknown>[] } };
};

describe('reading a calendar that holds an event Waldo created', () => {
  it.each([['the default window', {}], ['an explicit window', { date_range: { from: '2026-10-13T00:00:00Z', to: '2026-10-14T00:00:00Z' } }]])('returns the event in %s', async (_window, args) => {
    const result = await read(args, [created, other]);
    expect(result.ok).toBe(true);
    expect(result.data!.events.map(event => event.id)).toEqual(['qa1', 'e2']);
  });

  it('keeps the operation marker out of what the model reads', async () => {
    const result = await read({}, [created]);
    expect(result.data!.events[0]).not.toHaveProperty('operation_marker');
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('keeps it out on an adapter without pages too', async () => {
    const legacy = { account: { connection_id: 'c1', email: 'owner@example.test' },
      events: async () => [{ id: 'qa1', title: 'QA', start: '2026-10-13T16:00:00+05:30', end: '2026-10-13T17:00:00+05:30', all_day: false, operation_marker: marker }] };
    const handler = googleHandlers({ client: async () => legacy } as never, desk, clock).find(h => h.name === 'query_calendar')!;
    const result = await handler.handle(queryCalendarArgsSchema.parse({})) as { ok: boolean; data?: { events: readonly Record<string, unknown>[] } };
    expect(result.ok).toBe(true);
    expect(result.data!.events.map(event => event.id)).toEqual(['qa1']);
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});

// The page the Worker accepts must name every field the connector reports, or one event rejects the whole read.
describe('reading an event with every field the connector reads', () => {
  it('returns it', async () => {
    const everything = { ...created, location: 'Room 4', description: 'Agenda in the doc.', created: '2026-10-12T08:00:00Z', updated: '2026-10-12T08:00:00.000Z',
      recurringEventId: 'series1', originalStartTime: { dateTime: '2026-10-13T16:00:00+05:30' }, htmlLink: 'https://www.google.com/calendar/event?eid=abc',
      organizer: { self: true }, attendees: [{ self: true, email: 'owner@example.test', responseStatus: 'accepted' }, { displayName: 'Asha Rao', email: 'asha@example.test', responseStatus: 'accepted' }],
      hangoutLink: 'https://meet.example.test/abc-defg-hij', attachments: [{ fileId: 'f1', title: 'Plan' }] };
    const result = await read({}, [everything]);
    expect(result.ok).toBe(true);
    expect(result.data!.events[0]).toMatchObject({ id: 'qa1', location: 'Room 4', attendees: 2, recurring_event_id: 'series1', conference_url: 'https://meet.example.test/abc-defg-hij', attachments: [{ title: 'Plan', file_id: 'f1' }] });
  });
});
