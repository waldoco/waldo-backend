import { describe, expect, it } from 'vitest';
import { calendarPromptProjection, mailPromptProjection, type CalendarChange, type CalendarItem, type GoogleClient, type MailItem } from '../src/connectors/google';
import { briefPrompt } from '../src/channels/event-briefs';
import { readCalendar } from '../src/channels/day-cards';
import { collectChanges, type UpdateBook } from '../src/channels/update-cards';
import { sanitise } from '../src/scribe/sanitiser';

// Model-facing projections omit provider-internal identifiers; ordinary 16-hex mail
// content survives the exact-session canary guard.

const CANARIES = ['1111111111111111', '2222222222222222', '3333333333333333'] as const;

const sanitisesClean = (text: string): boolean =>
  sanitise({
    payload: [{ role: 'user', content: text }],
    destination: 'internal_context',
    canary_tokens: [...CANARIES],
    source_taint: null,
  }).ok;

const ETAG = '3496332447879000'; // current-era Google Calendar etag: 16 digits
const etagged: CalendarItem = {
  id: 'evt1', title: 'Design review', start: '2026-09-28T18:00:00+05:30', end: '2026-09-28T18:30:00+05:30',
  all_day: false, location: 'Office', description: 'Bring the mocks', attendees: 4, etag: ETAG,
};
const GMAIL_ID = '19a2b4c6d8e0f1a2'; // Gmail message ids are exactly 16 hex chars
const mail: MailItem = { id: GMAIL_ID, thread_id: '18b3c5d7e9f0a1b2', from: 'sam@example.com', subject: 'Friday plan', snippet: 'are we still on', at: '2026-09-28T10:00:00+05:30' };

describe('prompt projections drop provider-internal fields', () => {
  it('calendar projection drops only the etag', () => {
    const projection = calendarPromptProjection(etagged);
    expect(projection).not.toHaveProperty('etag');
    expect(projection).toMatchObject({ id: 'evt1', title: 'Design review', location: 'Office', description: 'Bring the mocks', attendees: 4 });
  });

  it('mail projection drops only provider ids', () => {
    const projection = mailPromptProjection(mail);
    expect(projection).not.toHaveProperty('id');
    expect(projection).not.toHaveProperty('thread_id');
    expect(projection).toMatchObject({ from: 'sam@example.com', subject: 'Friday plan', snippet: 'are we still on' });
  });
});

describe('trusted card and brief context survives real Google field shapes', () => {
  it('pre-event brief prompt carries no etag and sanitises clean', () => {
    const prompt = briefPrompt(etagged, Date.parse('2026-09-28T12:30:00Z'), 'Asia/Kolkata');
    expect(prompt).not.toContain(ETAG);
    expect(prompt).toContain('"title":"Design review"');
    expect(sanitisesClean(prompt)).toBe(true);
  });

  it('day-card calendar lines carry no etag and sanitise clean', async () => {
    const google = { events: async () => [etagged] } as unknown as GoogleClient;
    const calendar = await readCalendar({ from: Date.parse('2026-09-28T00:00:00+05:30'), to: Date.parse('2026-09-29T00:00:00+05:30') }, 'Asia/Kolkata', google, false);
    expect(calendar).not.toContain(ETAG);
    expect(calendar).toContain('"title":"Design review"');
    expect(sanitisesClean(calendar)).toBe(true);
  });

  it('update changes carry no etag or provider message ids and sanitise clean', async () => {
    const change: CalendarChange = { ...etagged, status: 'confirmed', created: '2026-09-27T09:00:00+05:30' };
    const google = {
      changedEvents: async () => [change],
      newMail: async () => [mail],
    } as unknown as GoogleClient;
    const book = { since: () => 0, mark: () => undefined } as unknown as UpdateBook;
    const changes = await collectChanges(book, google, Date.parse('2026-09-28T12:00:00Z'));
    expect(changes).toHaveLength(2);
    for (const item of changes) {
      expect(item.detail).not.toContain(ETAG);
      expect(item.detail).not.toContain(GMAIL_ID);
      expect(item.detail).not.toContain('18b3c5d7e9f0a1b2');
      expect(sanitisesClean(item.detail)).toBe(true);
    }
    expect(changes.find((item) => item.source === 'mail')?.detail).toContain('Friday plan');
    expect(changes.find((item) => item.source === 'calendar')?.detail).toContain('Design review');
  });

  it('preserves non-canary 16-hex mail free text and sanitises clean', async () => {
    // Tracking/reference-shaped text is owner-readable content, not a session canary.
    const hexRun = 'a1b2c3d4e5f60718';
    const codedMail: MailItem = {
      ...mail,
      subject: `Your sign-in code ${hexRun}`,
      snippet: `confirm with ${hexRun} or tap the link, expires in 10 minutes`,
    };
    const google = {
      changedEvents: async () => [],
      newMail: async () => [codedMail],
    } as unknown as GoogleClient;
    const book = { since: () => 0, mark: () => undefined } as unknown as UpdateBook;
    const changes = await collectChanges(book, google, Date.parse('2026-09-28T12:00:00Z'));
    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    expect(change.detail).toContain(hexRun);
    expect(change.detail).toContain('expires in 10 minutes');
    expect(sanitisesClean(change.detail)).toBe(true);
  });

  it('scrub stays narrow: ordinary snippet text and non-16 hex runs survive untouched', () => {
    const projection = mailPromptProjection({
      ...mail,
      subject: 'Friday plan',
      snippet: 'deadbeef is 8 hex and cafebabe12345 is 12 - both stay, are we still on',
    });
    expect(projection.subject).toBe('Friday plan');
    expect(projection.snippet).toBe('deadbeef is 8 hex and cafebabe12345 is 12 - both stay, are we still on');
  });

  it('allows ordinary unprojected provider identifiers under exact-session canary matching', () => {
    // Provider identifiers alone are not session canaries; the projection still omits
    // unnecessary IDs from the prompt, but the scribe must not reject normal mail.
    expect(sanitisesClean(JSON.stringify(etagged))).toBe(true);
    expect(sanitisesClean(JSON.stringify(mail))).toBe(true);
  });
});
