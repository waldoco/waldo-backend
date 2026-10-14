import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { calendarPushBook } from '../src/channels/calendar-push';
import { gmailPushBook } from '../src/channels/gmail-push';
import { WATCH_UPKEEP_ID, watchStatusLine } from '../src/channels/watch-upkeep';
import { dueFailureNotices } from '../src/scheduler/failure-notice';
import { ensureSchema } from '../src/tracer/schema';

const AT = Date.parse('2030-11-04T09:00:00Z');
const BOTH = { mail: true, calendar: true } as const;
const memoryKv = () => {
  const map = new Map<string, unknown>();
  return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); }, delete: (key: string) => map.delete(key) };
};

describe('the watch status host fact', () => {
  it('says nothing while every granted watch runs or has not been tried', () => {
    expect(watchStatusLine({ grants: BOTH, gmail: null, calendar: null, timezone: 'UTC' })).toBe('');
  });

  it('names an older mail connection and the console fix, with no account detail', () => {
    const kv = memoryKv();
    gmailPushBook(kv).fail(AT, 'local_rail');
    const line = watchStatusLine({ grants: BOTH, gmail: gmailPushBook(kv).miss(), calendar: null, timezone: 'UTC' });
    expect(line).toContain('older Google connection');
    expect(line).toContain('console');
    expect(line).toContain('send_console_link');
    expect(line).not.toMatch(/@|conn-|local:/);
  });

  it('names a failed start, when it failed and when Waldo tries again, in the owner\'s zone', () => {
    const kv = memoryKv();
    calendarPushBook(kv).fail(AT);
    const line = watchStatusLine({ grants: BOTH, gmail: null, calendar: calendarPushBook(kv).miss(), timezone: 'Asia/Tokyo' });
    expect(line).toContain('Calendar changes are not pushed');
    expect(line).toContain('2030-11-04 18:00');
    expect(line).toContain('2030-11-05 00:00');
  });

  it('reads a miss stored before reasons were kept as a failed start', () => {
    const kv = memoryKv();
    kv.put('gmail_push', { failedAt: AT });
    expect(gmailPushBook(kv).miss()).toEqual({ at: AT, reason: 'failed' });
    expect(watchStatusLine({ grants: BOTH, gmail: gmailPushBook(kv).miss(), calendar: null, timezone: 'UTC' })).toContain('New emails are not pushed');
  });

  it('says nothing for a watch without its grant, or a Calendar start this server could not route', () => {
    const kv = memoryKv();
    gmailPushBook(kv).fail(AT, 'local_rail');
    calendarPushBook(kv).fail(AT, 'skipped');
    expect(watchStatusLine({ grants: { mail: false, calendar: true }, gmail: gmailPushBook(kv).miss(), calendar: calendarPushBook(kv).miss(), timezone: 'UTC' })).toBe('');
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
