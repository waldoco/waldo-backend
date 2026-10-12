import { describe, expect, it } from 'vitest';
import { calendarPageSchema } from '@waldo/contracts';
import { calendarPromptProjection, googleClient, type CalendarItem } from '../src/connectors/google';
import { calendarPrepDigest, calendarPrepPrompt } from '../src/channels/event-briefs';

// Synthetic events only. The attendee-email cases follow draft #1042's calendar field tests.
const base = { id: 'e1', etag: '"3301"', status: 'confirmed', summary: 'Weekly sync', updated: '2026-10-01T09:00:00.000Z', description: 'Agenda in the doc.', start: { dateTime: '2026-10-03T10:30:00+05:30' }, end: { dateTime: '2026-10-03T11:00:00+05:30' }, attendees: [{ displayName: 'Asha Rao', email: 'asha@example.test', responseStatus: 'accepted' }] };
const page = (items: unknown[]) => googleClient({ clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://fixture.invalid' }, { refresh_token: 'fixture' },
  (async (input: RequestInfo | URL) => Response.json(String(input).startsWith('https://oauth2') ? { access_token: 'fixture' } : { kind: 'calendar#events', items })) as typeof fetch, undefined, { connection_id: 'c', email: 'o@example.test' })
  .calendarPage!('primary', '2026-10-03T04:00:00Z', '2026-10-03T06:00:00Z', 10, false);
const mapped = async (event: Record<string, unknown>) => (await page([{ ...base, ...event }])).events[0]!;
const meet = 'https://meet.example.test/abc-defg-hij';
const attached = [{ fileId: 'drive-file-1', title: 'Q4 plan', fileUrl: 'https://drive.example.test/file/d/drive-file-1' }];

describe('calendar event fields', () => {
  it('carries the join link from hangoutLink, or else the video entry point', async () => {
    expect((await mapped({ hangoutLink: meet })).conference_url).toBe(meet);
    expect((await mapped({ conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1-555-0100' }, { entryPointType: 'video', uri: 'https://zoom.example.test/j/123?pwd=synthetic' }] } })).conference_url).toBe('https://zoom.example.test/j/123?pwd=synthetic');
  });

  it('carries no join link from a phone-only, non-https or malformed entry', async () => {
    for (const event of [{ conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1-555-0100' }] } }, { hangoutLink: 'http://meet.example.test/x' }, { hangoutLink: 'not a url' }, { conferenceData: { entryPoints: [{ entryPointType: 'video', uri: `https://zoom.example.test/${'x'.repeat(2100)}` }] } }]) {
      expect(await mapped(event)).not.toHaveProperty('conference_url');
    }
  });

  it('lists attachment titles with their Drive ids, at most 20, and keeps a title without an id', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ fileId: `drive-${i}`, title: `Doc ${i}` }));
    expect((await mapped({ attachments: attached })).attachments).toEqual([{ title: 'Q4 plan', file_id: 'drive-file-1' }]);
    expect((await mapped({ attachments: many })).attachments).toHaveLength(20);
    expect((await mapped({ attachments: [{ title: 'Shared link', fileUrl: 'https://docs.example.test/x' }, { fileId: 'no-title' }] })).attachments).toEqual([{ title: 'Shared link' }]);
    expect(await mapped({})).not.toHaveProperty('attachments');
  });

  it('lists non-declined attendee emails, at most 20', async () => {
    // The declined attendee comes first, so the 20-item cap cannot hide a missing filter.
    const attendees = [{ email: 'no@example.test', responseStatus: 'declined' }, ...Array.from({ length: 25 }, (_, i) => ({ email: `p${i}@example.test`, responseStatus: 'accepted' }))];
    const event = await mapped({ attendees });
    expect(event.attendee_emails).toHaveLength(20);
    expect(event.attendee_emails).not.toContain('no@example.test');
    expect(await mapped({ attendees: [{ responseStatus: 'accepted' }] })).not.toHaveProperty('attendee_emails');
  });

  it('never lists the owner, whom Google marks as self, whatever address the connection recorded', async () => {
    const event = await mapped({ attendees: [{ email: 'owner.alias@example.test', self: true, responseStatus: 'accepted' }, { email: 'asha@example.test', responseStatus: 'accepted' }] });
    expect(event.attendee_emails).toEqual(['asha@example.test']);
  });

  it('admits the new fields in the query_calendar page and rejects bad ones', () => {
    const event = { id: 'e1', title: 'Sync', start: '2026-10-03T10:30:00Z', end: '2026-10-03T11:00:00Z', all_day: false, conference_url: meet, attachments: [{ title: 'Q4 plan', file_id: 'drive-file-1' }], attendee_emails: ['a@example.test'] };
    const receipt = { events: [event], next_page_token: null, fetched_count: 1, account: { connection_id: 'c', email: 'o@example.test' }, observed_at: '2026-10-03T04:00:00.000Z' };
    expect(calendarPageSchema.parse(receipt)).toEqual(receipt);
    for (const bad of [{ conference_url: 7 }, { attachments: [{ file_id: 'x' }] }, { attachments: Array(21).fill({ title: 'x' }) }, { attendee_emails: Array(21).fill('a@example.test') }]) {
      expect(calendarPageSchema.safeParse({ ...receipt, events: [{ ...event, ...bad }] }).success).toBe(false);
    }
  });
});

describe('where the new fields reach the model', () => {
  const event: CalendarItem = { id: 'e1', title: 'Weekly sync', start: '2026-10-03T05:00:00.000Z', end: '2026-10-03T05:30:00.000Z', all_day: false, conference_url: meet, attachments: [{ title: 'Q4 plan', file_id: 'drive-file-1' }], attendee_emails: ['asha@example.test'] };

  it('leaves them out of the shared projection, so day and update cards are unchanged', () => {
    expect(calendarPromptProjection(event)).toEqual({ id: 'e1', title: 'Weekly sync', start: '2026-10-03T05:00:00.000Z', end: '2026-10-03T05:30:00.000Z', all_day: false });
  });

  it('gives meeting prep the join link and attachment titles, never the Drive ids or attendee emails', () => {
    const prompt = calendarPrepPrompt(event, Date.parse('2026-10-03T04:30:00Z'), 'UTC');
    expect(prompt).toContain(meet);
    expect(prompt).toContain('"attachment_titles":["Q4 plan"]');
    expect(prompt).not.toContain('drive-file-1');
    expect(prompt).not.toContain('asha@example.test');
  });
});

describe('calendar prep digest', () => {
  const event: CalendarItem = { id: 'e1', title: 'Weekly sync', start: '2026-10-03T05:00:00.000Z', end: '2026-10-03T05:30:00.000Z', all_day: false, updated: '2026-10-01T09:00:00.000Z', conference_url: meet, attachments: [{ title: 'Q4 plan', file_id: 'drive-file-1' }], attendee_emails: ['asha@example.test'] };
  it('stays byte-identical for an event as mapped before this change, so a deploy re-preps nothing', async () => {
    expect(await calendarPrepDigest(await mapped({ hangoutLink: meet, attachments: attached }))).toBe('95196f390feea45decd5d59de134f3f213875f1adcdbf3fdfbe809501facf6da');
  });

  it('ignores the new fields, which Google changes only alongside updated', async () => {
    const { conference_url: _c, attachments: _a, attendee_emails: _e, ...without } = event;
    expect(await calendarPrepDigest(event)).toBe(await calendarPrepDigest(without));
  });

  it('still changes when the event is edited', async () => {
    expect(await calendarPrepDigest({ ...event, updated: '2026-10-02T09:00:00.000Z' })).not.toBe(await calendarPrepDigest(event));
  });
});

describe('calendar details are safe in either deploy order', () => {
  const detailed = { ...base, hangoutLink: meet, attachments: attached, attendees: [{ email: 'asha@example.test', responseStatus: 'accepted' }] };
  const client = (options?: { calendarDetails: boolean }) => googleClient({ clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://fixture.invalid' }, { refresh_token: 'fixture' },
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://oauth2')) return Response.json({ access_token: 'fixture' });
      if (init?.method === 'POST' || init?.method === 'PATCH' || /\/events\/[^/?]+$/.test(url)) return Response.json(detailed);
      return Response.json({ kind: 'calendar#events', items: [detailed], nextSyncToken: 'sync' });
    }) as typeof fetch, undefined, { connection_id: 'c', email: 'o@example.test' }, options);
  const everyPath = async (google: ReturnType<typeof client>) => [
    (await google.calendarPage!('primary', '2026-10-03T04:00:00Z', '2026-10-03T06:00:00Z', 10, false)).events[0],
    (await google.events('2026-10-03T04:00:00Z', '2026-10-03T06:00:00Z', 10, false))[0],
    await google.event('e1'),
    await google.createEvent({ title: 'Weekly sync', start: '2026-10-03T05:00:00Z', end: '2026-10-03T05:30:00Z' }),
    (await google.changedEvents(Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-10-03T00:00:00Z'), Date.parse('2026-10-04T00:00:00Z')))[0],
  ];

  it('leaves the three fields out of every mapped event when calendar details are off', async () => {
    for (const event of await everyPath(client({ calendarDetails: false }))) {
      expect(event).toMatchObject({ id: 'e1' });
      for (const field of ['conference_url', 'attachments', 'attendee_emails']) expect(event).not.toHaveProperty(field);
    }
  });

  it('carries them on every mapped event by default', async () => {
    for (const event of await everyPath(client())) expect(event).toMatchObject({ conference_url: meet, attachments: [{ title: 'Q4 plan', file_id: 'drive-file-1' }], attendee_emails: ['asha@example.test'] });
  });
});
