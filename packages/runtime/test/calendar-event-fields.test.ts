import { describe, expect, it } from 'vitest';
import { calendarPageSchema } from '@waldo/contracts';
import { calendarPromptProjection, googleClient } from '../src/connectors/google';

const base = { id: 'e1', status: 'confirmed', summary: 'Sync', start: { dateTime: '2026-10-03T10:30:00+05:30' }, end: { dateTime: '2026-10-03T11:00:00+05:30' } };
const client = (items: unknown[]) => googleClient({ clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://fixture.invalid' }, { refresh_token: 'fixture' },
  (async (input: string) => Response.json(input.startsWith('https://oauth2') ? { access_token: 'fixture' } : { kind: 'calendar#events', items })) as typeof fetch, undefined, { connection_id: 'c', email: 'o@example.test' });
const page = (items: unknown[]) => client(items).calendarPage('primary', '2026-10-03T04:00:00Z', '2026-10-03T06:00:00Z', 10, false);

describe('calendar event fields', () => {
  it('marks an event that carries a conference link, without exposing the link', async () => {
    const withMeet = (await page([{ ...base, hangoutLink: 'https://meet.example.test/x' }])).events[0]!;
    const withEntry = (await page([{ ...base, conferenceData: { entryPoints: [{ uri: 'https://zoom.example.test/j/1' }] } }])).events[0]!;
    const without = (await page([base])).events[0]!;
    expect(withMeet.has_conference).toBe(true);
    expect(withEntry.has_conference).toBe(true);
    expect(without).not.toHaveProperty('has_conference');
    expect(JSON.stringify(withMeet)).not.toContain('meet.example.test');
  });
  it('lists non-declined attendee emails, capped at 20', async () => {
    const attendees = [...Array.from({ length: 25 }, (_, i) => ({ email: `p${i}@example.test`, responseStatus: 'accepted' })), { email: 'no@example.test', responseStatus: 'declined' }];
    const event = (await page([{ ...base, attendees }])).events[0]!;
    expect(event.attendee_emails).toHaveLength(20);
    expect(event.attendee_emails).not.toContain('no@example.test');
    expect((await page([{ ...base, attendees: [{ responseStatus: 'accepted' }] }])).events[0]).not.toHaveProperty('attendee_emails');
  });
  it('keeps emails and conference marker out of the meeting-prep projection', async () => {
    const event = (await page([{ ...base, hangoutLink: 'https://meet.example.test/x', attendees: [{ email: 'a@example.test' }] }])).events[0]!;
    const projected = JSON.stringify(calendarPromptProjection(event));
    expect(projected).not.toContain('a@example.test');
    expect(projected).not.toContain('has_conference');
  });
  it('admits the new fields in the page receipt and rejects bad ones', () => {
    const receipt = { events: [{ id: 'e1', title: 'Sync', start: '2026-10-03T10:30:00Z', end: '2026-10-03T11:00:00Z', all_day: false, has_conference: true, attendee_emails: ['a@example.test'] }], next_page_token: null, fetched_count: 1, account: { connection_id: null, email: null }, observed_at: '2026-10-03T00:00:00Z' };
    expect(calendarPageSchema.parse(receipt)).toEqual(receipt);
    expect(calendarPageSchema.safeParse({ ...receipt, events: [{ ...receipt.events[0], has_conference: 'yes' }] }).success).toBe(false);
    expect(calendarPageSchema.safeParse({ ...receipt, events: [{ ...receipt.events[0], attendee_emails: Array(21).fill('a@example.test') }] }).success).toBe(false);
  });
});
