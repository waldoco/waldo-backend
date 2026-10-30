import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { updateBook, type Change } from '../src/channels/update-cards';

// Whether the owner's day moved since a meeting was judged to need no note: a calendar change that touches the day, or new
// mail from someone at that meeting. Other mail does not reopen it, so a busy inbox does not re-ask about every meeting.
const AT = Date.parse('2026-10-03T04:30:00Z');
const calendar = (start: string, end: string): Change => ({ source: 'calendar', kind: 'changed', detail: JSON.stringify({ id: 'e9', title: 'Moved', start, end, all_day: false }), ref: 'event:e9' });
const mail = (from: string): Change => ({ source: 'mail', kind: 'new', detail: JSON.stringify({ from, subject: 'Agenda', snippet: 'Budget first', at: '2026-10-03T04:40:00Z' }), ref: 'message:m1' });
let seq = 0;
const withBook = (work: (book: ReturnType<typeof updateBook>) => void) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`changed-since-${seq += 1}`)), async (_instance, state) => work(updateBook(state.storage.sql)));
const PEOPLE = ['asha@example.test'];

it.each([
  { name: 'nothing recorded after the judgment', rows: [[AT - 1, [mail('Asha <asha@example.test>')]]], day: '2026-10-03', zone: 'Asia/Kolkata', expected: false },
  { name: 'mail from an attendee', rows: [[AT + 1, [mail('Asha <ASHA@example.test>')]]], day: '2026-10-03', zone: 'Asia/Kolkata', expected: true },
  { name: 'mail from someone else', rows: [[AT + 1, [mail('News <news@example.test>')]]], day: '2026-10-03', zone: 'Asia/Kolkata', expected: false },
  { name: 'a calendar change on another day', rows: [[AT + 1, [calendar('2026-10-05T04:30:00Z', '2026-10-05T05:00:00Z')]]], day: '2026-10-03', zone: 'Asia/Kolkata', expected: false },
  { name: 'a calendar change touching today', rows: [[AT + 1, [calendar('2026-10-03T08:00:00Z', '2026-10-03T08:30:00Z')]]], day: '2026-10-03', zone: 'Asia/Kolkata', expected: true },
  // The 25-hour fall-back day in New York: 23:30 local is 04:30Z the next UTC day, and still that local day.
  { name: 'a change late on a DST fall-back day', rows: [[AT + 1, [calendar('2026-11-02T04:30:00Z', '2026-11-02T04:45:00Z')]]], day: '2026-11-01', zone: 'America/New_York', expected: true },
  // After a move from Kolkata to Los Angeles, the same change sits on the owner's new local day.
  { name: 'a timezone change moves the day the change is read against', rows: [[AT + 1, [calendar('2026-10-03T20:00:00Z', '2026-10-03T20:30:00Z')]]], day: '2026-10-03', zone: 'America/Los_Angeles', expected: true },
  { name: 'the same change against the old zone\'s day', rows: [[AT + 1, [calendar('2026-10-03T20:00:00Z', '2026-10-03T20:30:00Z')]]], day: '2026-10-03', zone: 'Asia/Kolkata', expected: false },
] as const)('changedSince: $name', async ({ rows, day, zone, expected }) => {
  await withBook(book => {
    for (const [at, changes] of rows) book.record(day, at, changes, null);
    expect(book.changedSince(AT, day, zone, PEOPLE)).toBe(expected);
  });
});

it('changedSince: mail never reopens a meeting with no attendee address to match', async () => {
  await withBook(book => {
    book.record('2026-10-03', AT + 1, [mail('Asha <asha@example.test>')], null);
    expect(book.changedSince(AT, '2026-10-03', 'Asia/Kolkata', [])).toBe(false);
  });
});
