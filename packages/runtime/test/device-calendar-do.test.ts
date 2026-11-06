import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CalendarChange, GoogleClient, MailItem } from '../src/connectors/google';
import { deviceCalendarBook, deviceCalendarRequest } from '../src/channels/device-calendar';
import { updateBook } from '../src/channels/update-cards';
import { updateSweepCheck } from '../src/channels/update-sweep';
import { jobBook, taskBrief, type JobRow } from '../src/tasks/jobs';
import { phoneCalendarReader, queryPhoneCalendarHandler } from '../src/tools/live/phone-calendar';

// The owner object's side: the routes answer from the book in one transaction, the update sweep takes the phone's changes
// with its own, and the read tool leaves out what Google already shows by iCal UID. Synthetic events, ids and times.
const NOW = Date.parse('2026-11-09T06:00:00Z');
const DEVICE = '0c9d6a7e-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const meeting = { device_event_id: '1042', calendar_id: '7', start: '2026-11-09T09:00:00Z', end: '2026-11-09T10:00:00Z', all_day: false, title: 'Ops review', availability: 'busy', ical_uid: 'shared-uid@example.test' };
const standup = { device_event_id: '1044', calendar_id: '7', start: '2026-11-09T11:00:00Z', end: '2026-11-09T11:15:00Z', all_day: false, title: 'Standup', availability: 'busy' };
let seq = 0;
const snapshot = (events: readonly object[], at = NOW) => ({
  request_id: `dcal-${(seq += 1).toString().padStart(6, '0')}`, expected_epoch: 1, device_id: DEVICE, platform: 'android', timezone: 'UTC', observed_at: new Date(at).toISOString(),
  window: { from: new Date(at - 86_400_000).toISOString(), to: new Date(at + 14 * 86_400_000).toISOString() }, times_only: false, complete: true,
  calendars: [{ calendar_id: '7', name: 'Work', account_type: 'exchange' }], events,
});
const inObject = <T,>(work: (state: DurableObjectState) => Promise<T>) => runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`device-calendar-do-${seq += 1}`)), async (_i, state) => work(state));
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`https://o.test/app/v1/device/calendar${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const grant = { request_id: 'dcal-grant-0001', signal: 'calendar', version: 1, purposes: [{ purpose: 'storage_compute', expected_epoch: 0 }, { purpose: 'model_processing', expected_epoch: 0 }] } as const;
// The tool's answer, whatever its branch.
const answer = async (handler: ReturnType<typeof queryPhoneCalendarHandler>) => ((await handler.handle({}, undefined as never)) as { data?: unknown }).data;

describe('the owner object\'s phone-calendar routes', () => {
  it('answer consent, ingest and the owner\'s read-back, and refuse what the contract does not hold', () => inObject(async (state) => {
    const book = deviceCalendarBook(state.storage.sql, () => NOW), tx = <T,>(work: () => T) => state.storage.transactionSync(work);
    const ask = (request: Request) => deviceCalendarRequest(request, book, tx);
    expect((await ask(post('', snapshot([meeting])))).status).toBe(403);
    expect((await ask(post('/consents/batch', grant))).status).toBe(200);
    expect(await (await ask(new Request('https://o.test/app/v1/device/calendar/consents'))).json()).toMatchObject({ consents: [{ purpose: 'storage_compute', status: 'granted' }, { purpose: 'model_processing', status: 'granted' }] });
    expect(await (await ask(post('', snapshot([meeting])))).json()).toMatchObject({ status: 'accepted', replayed: false });
    expect(await (await ask(new Request('https://o.test/app/v1/device/calendar'))).json()).toMatchObject({ devices: [{ device_id: DEVICE, events: 1, times_only: false }] });
    expect((await ask(post('', { ...snapshot([meeting]), attendees: [] }))).status).toBe(400);
    expect((await ask(post('', snapshot([meeting]), { 'idempotency-key': 'another-key-0001' }))).status).toBe(400);
    expect((await ask(post('/consents/batch', { ...grant, signal: 'place' }))).status).toBe(400);
    expect((await ask(post('/nowhere', {}))).status).toBe(404);
  }));

  it('a phone change waits for the update sweep and becomes part of its one job; a revoked consent leaves nothing to judge', () => inObject(async (state) => {
    const sql = state.storage.sql, phone = deviceCalendarBook(sql, () => NOW), tx = <T,>(work: () => T) => state.storage.transactionSync(work);
    phone.grant(grant, 'g');
    phone.ingest(snapshot([meeting, standup]) as never, 'a');
    phone.ingest(snapshot([standup]) as never, 'b');
    let n = 0;
    const jobs = jobBook(sql, { now: () => NOW, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const updates = updateBook(sql);
    updates.mark('mail_since', NOW - 600_000); updates.mark('calendar_since', NOW - 600_000);
    const google = { changedEvents: async (): Promise<CalendarChange[]> => [], newMail: async (): Promise<MailItem[]> => [] } as unknown as GoogleClient;
    const check = () => updateSweepCheck({ updates, jobs, google, now: NOW, day: '2026-11-09', timezone: 'UTC', surface: 'app', sourceFollowups: false, phone,
      gate: () => null, providerDown: () => false, transaction: tx, enqueued: () => undefined, held: () => [], dayChanged: async () => undefined });
    expect((await check()).code).toBe('enqueued');
    const [job] = sql.exec<JobRow>('SELECT * FROM task_jobs').toArray();
    expect(taskBrief(job!).context).toContain('calendar cancelled');
    expect(taskBrief(job!).context).toContain('Ops review');
    expect(phone.takeChanges()).toEqual([]);
  }));

  it('the read tool leaves out a phone event Google shows under the same iCal UID, and says what it could not compare', () => inObject(async (state) => {
    const book = deviceCalendarBook(state.storage.sql, () => NOW);
    book.grant(grant, 'g');
    book.ingest(snapshot([meeting, standup]) as never, 'a');
    const clock = { now: () => new Date(NOW + 30 * 60_000), timezone: 'UTC' } as never;
    const google = (uids: string[] | null) => ({
      state: async () => [{ id: 'acct-1', email: 'owner@example.test', error: null, calendar: true, mail: true, tasks: false }],
      client: async () => (uids === null ? null : { events: async () => uids.map((uid, index) => ({ id: `g${index}`, title: 'x', start: meeting.start, end: meeting.end, all_day: false, ical_uid: uid })) }),
    }) as never;
    const compared = await answer(queryPhoneCalendarHandler(phoneCalendarReader(book, google(['shared-uid@example.test'])), clock));
    expect(compared).toMatchObject({ state: 'available', on_google: 1, google_compared: true, more: 0, phones: [{ phone: 1, age_minutes: 30, complete: true }] });
    expect((compared as { events: { title: string; may_be_on_google: boolean }[] }).events.map(event => [event.title, event.may_be_on_google])).toEqual([['Standup', true]]);
    const unknown = await answer(queryPhoneCalendarHandler(phoneCalendarReader(book, google(null)), clock));
    expect(unknown).toMatchObject({ on_google: 0, google_compared: false });
    expect((unknown as { events: unknown[] }).events).toHaveLength(2);
    book.withdraw({ request_id: 'dcal-wd-0001', purpose: 'storage_compute', expected_epoch: 1 }, 'w');
    expect(await answer(queryPhoneCalendarHandler(phoneCalendarReader(book, google([])), clock))).toEqual({ state: 'unavailable', reason: 'consent_required' });
  }));
});
