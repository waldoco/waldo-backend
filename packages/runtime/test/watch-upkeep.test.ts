import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { calendarPushBook } from '../src/channels/calendar-push';
import { gmailPushBook } from '../src/channels/gmail-push';
import { WATCH_UPKEEP_ID, watchStatusLine } from '../src/channels/watch-upkeep';
import { dueFailureNotices } from '../src/scheduler/failure-notice';
import { ensureSchema } from '../src/tracer/schema';

const AT = Date.parse('2030-11-04T09:00:00Z');
const MAIL = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'];
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const VAULT = { id: 'conn-1', email: 'owner@example.test', scopes: [...MAIL, CALENDAR] };
const OLDER = { id: 'local:old@example.test', email: 'old@example.test', refresh_token: 'synthetic-offline-only', scopes: MAIL };
const memoryKv = () => {
  const map = new Map<string, unknown>();
  return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); }, delete: (key: string) => map.delete(key) };
};

describe('the watch status host fact', () => {
  it('says nothing while every granted watch runs or has not been tried', () => {
    expect(watchStatusLine({ accounts: [VAULT], gmail: null, calendar: null, timezone: 'UTC' })).toBe('');
  });

  it('names the account connected the older way, not a newer one, so reconnecting it is the true fix', () => {
    const kv = memoryKv();
    gmailPushBook(kv).fail(AT, 'local_rail');
    const line = watchStatusLine({ accounts: [OLDER, VAULT], gmail: gmailPushBook(kv).miss(), calendar: null, timezone: 'UTC' });
    expect(line).toContain('the mail account "old@example.test" is connected the older way');
    expect(line).toContain('Reconnecting that account, or disconnecting it if no longer used, fixes it.');
    expect(line).not.toContain('owner@example.test');
    expect(line).toContain('the app or the console');
    expect(line).toContain('send_console_link');
    expect(line).not.toMatch(/conn-|local:|synthetic/);
  });

  it('names a failed start, when it failed and when Waldo tries again, in the owner\'s zone', () => {
    const kv = memoryKv();
    calendarPushBook(kv).fail(AT);
    const line = watchStatusLine({ accounts: [VAULT], gmail: null, calendar: calendarPushBook(kv).miss(), timezone: 'Asia/Tokyo' });
    expect(line).toContain('Calendar changes are not pushed');
    expect(line).toContain('2030-11-04 18:00');
    expect(line).toContain('2030-11-05 00:00');
  });

  it('reads a miss stored before reasons were kept as a failed start', () => {
    const kv = memoryKv();
    kv.put('gmail_push', { failedAt: AT });
    expect(gmailPushBook(kv).miss()).toEqual({ at: AT, reason: 'failed' });
    expect(watchStatusLine({ accounts: [VAULT], gmail: gmailPushBook(kv).miss(), calendar: null, timezone: 'UTC' })).toContain('New emails are not pushed');
  });

  it('says nothing for a watch without its grant, or a Calendar start this server could not route', () => {
    const kv = memoryKv();
    gmailPushBook(kv).fail(AT, 'local_rail');
    calendarPushBook(kv).fail(AT, 'skipped');
    expect(watchStatusLine({ accounts: [{ email: 'owner@example.test', scopes: [CALENDAR] }], gmail: gmailPushBook(kv).miss(), calendar: calendarPushBook(kv).miss(), timezone: 'UTC' })).toBe('');
  });
});

describe('a stored book the host fact cannot read', () => {
  it('is no miss, whatever its shape, and an unknown reason reads as a failed start', () => {
    for (const stored of ['not a watch', 7, null, [], { failedAt: 'yesterday' }]) {
      const kv = memoryKv();
      kv.put('gmail_push', stored);
      kv.put('calendar_push', stored);
      expect(gmailPushBook(kv).miss()).toBeNull();
      expect(calendarPushBook(kv).miss()).toBeNull();
    }
    const kv = memoryKv();
    kv.put('gmail_push', { failedAt: AT, reason: 'retired_reason' });
    kv.put('calendar_push', { failedAt: AT, reason: 'retired_reason' });
    expect(gmailPushBook(kv).miss()).toEqual({ at: AT, reason: 'failed' });
    expect(calendarPushBook(kv).miss()).toEqual({ at: AT, reason: 'failed' });
  });
});

it('a paused upkeep job tells the owner nothing: it is not one of their jobs', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('watch-upkeep-pause-silent')), async (_instance, state) => {
    ensureSchema(state.storage);
    // The same pause on the owner's heartbeat is the control: it has a notice.
    for (const [id, kind] of [[WATCH_UPKEEP_ID, 'watch_upkeep'], ['heartbeat-tick', 'heartbeat']] as const) {
      state.storage.sql.exec(`INSERT INTO schedule (id, kind, occurrence_at, due_at, recurrence_json, payload_json, status, attempts, last_fired_at, quarantined_until, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, '{}', 'quarantined', 3, ?, ?, ?, ?)`, id, kind, AT, AT, AT, AT + 86_400_000, AT, AT);
      state.storage.sql.exec(`INSERT INTO schedule_runs (id, schedule_id, kind, fired_at, attempt, outcome, error_class, settled_at) VALUES (?, ?, ?, ?, 3, 'quarantined', 'run', ?)`,
        `${id}:${AT}:3`, id, kind, AT, AT);
    }
    expect(dueFailureNotices(state.storage.sql, state.storage.kv, AT + 1_000, 'UTC').map(notice => notice.scheduleId)).toEqual(['heartbeat-tick']);
  });
});
