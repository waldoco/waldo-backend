import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectChanges, updateBook } from '../src/channels/update-cards';
import { parseProactiveDecision } from '../src/proactivity/judgment';
import type { CalendarChange, GoogleClient, MailItem } from '../src/connectors/google';
const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const at = Date.parse('2026-10-10T10:00:00Z');
function database() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const sql = { exec(query: string, ...args: (string | number | null)[]) {
    const rows = db.prepare(query).all(...args);
    return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('Expected one row'); return rows[0]; } };
  } } as unknown as SqlStorage;
  const transaction = <T>(work: () => T): T => { db.exec('BEGIN'); try { const value = work(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  return { sql, transaction, book: updateBook(sql, transaction) };
}
const mail = (id: number): MailItem => ({ id: `m${id}`, thread_id: `t${id}`, from: 'sender@example.test', subject: `Current item ${id}`, snippet: 'Read the full thread to judge it.', at: new Date(at + 1000).toISOString() });
const event = (id: number): CalendarChange => ({ id: `e${id}`, title: `Meeting ${id}`, start: new Date(at + 86_400_000).toISOString(), end: new Date(at + 86_400_000 + 3600_000).toISOString(), all_day: false, status: 'confirmed', created: new Date(at + 1000).toISOString() });
function pagedClient(countMail = 25, countCalendar = 51): GoogleClient {
  return {
    account: { connection_id: 'google:personal', email: 'owner@example.test' },
    changedEventsPage: async (calendarId, _since, _from, _to, _limit, token) => {
      const offset = Number(token ?? 0), end = Math.min(offset + 25, countCalendar);
      return { events: Array.from({ length: end - offset }, (_, i) => event(i + offset)), next_page_token: end === countCalendar ? null : String(end), fetched_count: end - offset, calendar_id: calendarId, account: { connection_id: 'google:personal', email: 'owner@example.test' }, observed_at: new Date(at + 5000).toISOString() };
    },
    mailPage: async (_query, _limit, token) => {
      const offset = Number(token ?? 0), end = Math.min(offset + 10, countMail);
      return { messages: Array.from({ length: end - offset }, (_, i) => mail(i + offset)), next_page_token: end === countMail ? null : String(end), result_size_estimate: countMail };
    },
  } satisfies Pick<GoogleClient, 'account' | 'changedEventsPage' | 'mailPage'> as unknown as GoogleClient;
}
describe('existing periodic collector with durable complete source coverage', () => {
  it('ingests all 25 arrivals and 51 calendar changes and returns a single durable card after restart', async () => {
    const f = database(), client = pagedClient();
    await collectChanges(f.book, client, at, true);
    const changes = await collectChanges(f.book, client, at + 10_000, true);
    expect(changes.filter(value => value.source === 'mail')).toHaveLength(25);
    expect(changes.filter(value => value.source === 'calendar')).toHaveLength(51);
    expect(changes.find(value => value.source === 'mail')).toMatchObject({ account_id: 'google:personal', source_ref: 'mail:google%3Apersonal:t0' });
    const restarted = updateBook(f.sql, f.transaction), noReads = { account: client.account, changedEventsPage: vi.fn(), mailPage: vi.fn() } as unknown as GoogleClient;
    expect(await collectChanges(restarted, noReads, at + 20_000, true)).toEqual(changes);
    const id = restarted.record('2026-10-10', at + 20_000, changes, null);
    expect(f.sql.exec('SELECT id FROM update_cards').toArray()).toEqual([{ id }]);
    expect(restarted.since('mail_since', 'google:personal')).toBe(at + 10_000);
    expect(restarted.since('calendar_since', JSON.stringify(['google:personal', 'primary']))).toBe(at + 10_000);
  });
  it('resumes each frozen page query after interruption and advances no watermark while incomplete', async () => {
    const f = database(), client = pagedClient(); await collectChanges(f.book, client, at);
    expect(await collectChanges(f.book, client, at + 10_000, false, { maxPages: 1 })).toEqual([]);
    expect(f.book.since('mail_since', 'google:personal')).toBe(at);
    const calls: unknown[][] = [], resumed = { ...client,
      mailPage: async (...args: Parameters<GoogleClient['mailPage']>) => { calls.push(['mail', ...args]); return client.mailPage(...args); },
      changedEventsPage: async (...args: Parameters<NonNullable<GoogleClient['changedEventsPage']>>) => { calls.push(['calendar', ...args]); return client.changedEventsPage!(...args); },
    };
    const changes = await collectChanges(updateBook(f.sql, f.transaction), resumed, at + 99_000, false);
    expect(changes).toHaveLength(76);
    expect(calls[0]).toEqual(['calendar', 'primary', at, at + 10_000, at + 10_000 + 2 * 86_400_000, 50, '25']);
    const mailCall = calls.find(value => value[0] === 'mail')!;
    expect(mailCall[1]).toContain(`before:${Math.ceil((at + 10_000) / 1000) + 1}`); expect(mailCall[3]).toBe('10');
  });
  it('keeps accepted page state when the next page fails and replays only the failed page', async () => {
    const f = database(), client = pagedClient(25, 0); await collectChanges(f.book, client, at, false, { calendar: false });
    let fail = true;
    const modified = { ...client, mailPage: async (...args: Parameters<GoogleClient['mailPage']>) => { if (args[2] === '10' && fail) throw new Error('provider unavailable'); return client.mailPage(...args); } };
    await expect(collectChanges(f.book, modified, at + 10_000, false, { calendar: false })).rejects.toThrow('provider unavailable');
    expect(f.book.since('mail_since', 'google:personal')).toBe(at); fail = false;
    const changes = await collectChanges(updateBook(f.sql, f.transaction), modified, at + 20_000, false, { calendar: false });
    expect(changes).toHaveLength(25); expect(new Set(changes.map(value => value.detail)).size).toBe(25);
  });
  it('does not silently advance a capped legacy ten-message collector', async () => {
    const f = database(), client = { newMail: async () => Array.from({ length: 10 }, (_, i) => mail(i)) } as unknown as GoogleClient;
    await collectChanges(f.book, client, at, false, { calendar: false });
    await expect(collectChanges(f.book, client, at + 10_000, false, { calendar: false })).rejects.toThrow('resumable page adapter');
    expect(f.book.since('mail_since')).toBe(at);
  });
  it('isolates Gmail-only second-account progress from calendar/account watermarks', async () => {
    const f = database(), one = pagedClient(1, 1), two = { ...pagedClient(2, 0), account: { connection_id: 'google:second', email: 'second@example.test' } };
    await collectChanges(f.book, one, at); await collectChanges(f.book, two, at, false, { calendar: false });
    const changes = await collectChanges(f.book, two, at + 10_000, false, { calendar: false });
    expect(changes).toHaveLength(2); expect(changes.every(value => value.account_id === 'google:second')).toBe(true);
    expect(f.book.since('mail_since', 'google:personal')).toBe(at);
    expect(f.book.since('calendar_since', JSON.stringify(['google:second', 'primary']))).toBeNull();
  });
});
describe('typed model interruption decisions', () => {
  it('decodes notify, batch, and silent without allowing model-supplied authority fields', () => {
    expect(parseProactiveDecision('{"disposition":"notify","rationale":"Useful fresh evidence","text":"The deadline changed.","batch_at":null}')).toMatchObject({ disposition: 'notify' });
    expect(parseProactiveDecision(`{"disposition":"batch","rationale":"Useful in the brief","text":"One update","batch_at":${at}}`)).toMatchObject({ disposition: 'batch', batchAt: at });
    expect(parseProactiveDecision('{"disposition":"silent","rationale":"Already handled","text":"Unused text","batch_at":null}').text).toBe('');
    expect(() => parseProactiveDecision('{"disposition":"notify","rationale":"Useful","text":"Update","batch_at":null,"grant":true}')).toThrow();
    expect(() => parseProactiveDecision('{"disposition":"batch","rationale":"Useful","text":"Update","batch_at":null}')).toThrow();
  });
});
