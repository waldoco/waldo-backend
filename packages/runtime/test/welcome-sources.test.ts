import { describe, expect, it } from 'vitest';
import { GoogleError, type CalendarItem, type GoogleClient, type MailItem } from '../src/connectors/google';
import type { HealthReadBook } from '../src/tools/live/health';
import type { GoogleAccess } from '../src/tools/live/google';
import { calendarStage, healthStage, mailStage, webStage } from '../src/onboarding/welcome-sources';

const NOW = Date.parse('2026-10-25T13:00:00Z');
const series = (sources: readonly { source: string; readings: readonly object[] }[]) => ({ access: 'granted', read_at: '2026-10-25T13:00:00.000Z', sources: sources.map(({ source, readings }) => ({ source, consent_epoch: 1, samples: readings })) });
const reading = (signal: string, day: string, value: number, method: string | null = null) => ({ signal, day, value, method, start_at: null, end_at: `${day}T07:00:00.000Z`, timezone: 'Europe/London' });
const book = (consent: Awaited<ReturnType<HealthReadBook['consent']>>, raw: unknown = series([])): HealthReadBook & { asked: unknown[] } => {
  const asked: unknown[] = [];
  return { asked, consent: async () => consent, series: async (range) => { asked.push(range); return raw; } };
};
const granted = (...sources: string[]) => ({ kind: 'granted' as const, sources: new Set(sources) });
const health = (b: HealthReadBook) => healthStage(b, () => 'Europe/London', () => NOW)();

describe('welcome health stage', () => {
  // The welcome read is get_health's read: time asleep only, a stage from its own share of the night, one method per signal.
  it('reads a sleep stage from its share of the night and never time in bed or blended methods', async () => {
    const night = { start_at: '2026-10-23T22:00:00.000Z', end_at: '2026-10-24T06:00:00.000Z' };
    const result = await health(book(granted('apple'), series([{ source: 'apple', readings: [
      { ...reading('sleep_duration', '2026-10-24', 420, 'asleep_duration'), ...night, stages: { light: 200, deep: 70, rem: 90, unspecified: 60, awake: 22 } },
      { ...reading('sleep_duration', '2026-10-24', 480, 'time_in_bed'), ...night },
      reading('overnight_hrv', '2026-10-24', 40, 'rmssd'), reading('overnight_hrv', '2026-10-24', 90, 'sdnn'), reading('overnight_hrv', '2026-10-23', 42, 'rmssd'),
    ] }])));
    expect(result.kind).toBe('input');
    if (result.kind !== 'input') return;
    const line = (signal: string) => result.text.split('\n').find((row) => row.startsWith(`${signal} (`));
    expect(line('sleep')).toBe('sleep (apple_health, minutes): 2026-10-24 420');
    expect(line('sleep_light')).toBe('sleep_light (apple_health, minutes): 2026-10-24 200');
    expect(line('sleep_awake')).toBe('sleep_awake (apple_health, minutes): 2026-10-24 22');
    expect(line('hrv')).toBe('hrv (apple_health, ms, rmssd): 2026-10-23 42; 2026-10-24 40');
  });

  it('skips without consent, says revoked after a withdrawal, unavailable on a failed read, and asks the plane nothing then', async () => {
    for (const [consent, state] of [[{ kind: 'consent_required' }, 'skipped'], [{ kind: 'not_linked' }, 'skipped'], [{ kind: 'consent_withdrawn' }, 'revoked'], [{ kind: 'read_failed' }, 'unavailable']] as const) {
      const b = book(consent);
      expect(await health(b)).toEqual({ kind: 'settled', state });
      expect(b.asked).toEqual([]);
    }
    expect(await health(book(granted('apple'), { error: 'boom' }))).toEqual({ kind: 'settled', state: 'unavailable' });
  });

  it('reads ninety local days, and settles empty when there is nothing', async () => {
    const b = book(granted('apple'));
    expect(await health(b)).toEqual({ kind: 'settled', state: 'empty' });
    expect(b.asked[0]).toMatchObject({ from: '2026-07-28', to: '2026-10-25' });
  });

  it('gives the model the owner\'s readings per signal and source, only from sources with live consent, and never WHOOP', async () => {
    const result = await health(book(granted('apple', 'whoop'), series([
      { source: 'apple', readings: [reading('sleep_midpoint', '2026-10-24', 240), reading('resting_heart_rate', '2026-10-24', 52)] },
      { source: 'whoop', readings: [reading('resting_heart_rate', '2026-10-24', 50)] },
      { source: 'health_connect', readings: [reading('resting_heart_rate', '2026-10-24', 49)] },
    ])));
    expect(result.kind).toBe('input');
    if (result.kind !== 'input') return;
    expect(result.sources).toEqual(['apple_health']);
    expect([...result.pointers].sort()).toEqual(['resting_hr', 'sleep_midpoint']);
    expect(result.text).toContain('resting_hr (apple_health, bpm): 2026-10-24 52');
    expect(result.text).not.toContain('50');
    expect(result.text).not.toContain('49');
  });
});

const event = (id: string, extra: Partial<CalendarItem> = {}): CalendarItem => ({ id, title: `Planning ${id}`, start: '2026-10-20T09:00:00Z', end: '2026-10-20T10:00:00Z', all_day: false, attendees: 3, description: 'SECRET agenda body', attendee_emails: ['someone@example.com'], ...extra });
const mail = (thread: string, extra: Partial<MailItem> = {}): MailItem => ({ id: `m-${thread}`, thread_id: thread, from: '"Ana Diaz" <ana@design.example>', subject: `Review ${thread}`, snippet: 'SECRET snippet text', at: '2026-10-21T10:00:00Z', ...extra });
type Account = Readonly<{ id: string; email: string; error: string | null; calendar: boolean; mail: boolean; tasks: boolean }>;
const account = (email: string, extra: Partial<Account> = {}): Account => ({ id: email, email, error: null, calendar: true, mail: true, tasks: false, ...extra });
const google = (accounts: readonly Account[], clients: Record<string, Partial<GoogleClient> | Error>): GoogleAccess & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    state: async () => accounts,
    client: async (feature, _intent, _current, email) => {
      asked.push(`${feature}:${email}`);
      const client = clients[email ?? ''];
      if (client instanceof Error) throw client;
      return (client ?? null) as GoogleClient | null;
    },
  };
};

describe('welcome calendar stage', () => {
  it('skips with no Google account, and says revoked when every account needs reconnecting', async () => {
    expect(await calendarStage(google([], {}), () => NOW)()).toEqual({ kind: 'settled', state: 'skipped' });
    expect(await calendarStage(google([account('a@x.com', { error: 'invalid_grant' })], {}), () => NOW)()).toEqual({ kind: 'settled', state: 'revoked' });
    expect(await calendarStage(google([account('a@x.com')], { 'a@x.com': new GoogleError(401, 'expired') }), () => NOW)()).toEqual({ kind: 'settled', state: 'revoked' });
  });

  it('reads every connected account by name, sends titles and times but no descriptions or addresses, and cites event ids', async () => {
    const g = google([account('a@x.com'), account('b@y.com')], {
      'a@x.com': { calendarPage: async () => ({ events: [event('evt_a', { recurring_event_id: 'r1' })], next_page_token: null, fetched_count: 1, account: { connection_id: null, email: 'a@x.com' }, observed_at: '' }) },
      'b@y.com': { calendarPage: async () => ({ events: [event('evt_b'), event('evt_gone', { status: 'cancelled' })], next_page_token: null, fetched_count: 2, account: { connection_id: null, email: 'b@y.com' }, observed_at: '' }) },
    });
    const result = await calendarStage(g, () => NOW)();
    expect(g.asked).toEqual(['calendar:a@x.com', 'calendar:b@y.com']);
    expect(result.kind).toBe('input');
    if (result.kind !== 'input') return;
    expect([...result.pointers]).toEqual(['evt_a', 'evt_b']);
    expect(result.text).toContain('[evt_a] Planning evt_a');
    expect(result.text).toContain('repeats');
    expect(result.text).not.toMatch(/SECRET|someone@example\.com|evt_gone/);
  });

  it('is empty when the connected calendars and task lists hold nothing', async () => {
    const g = google([account('a@x.com', { tasks: true })], { 'a@x.com': {
      calendarPage: async () => ({ events: [], next_page_token: null, fetched_count: 0, account: { connection_id: null, email: 'a@x.com' }, observed_at: '' }),
      allTasksPage: async () => ({ tasks: [], next_page_token: null }) as never,
    } });
    expect(await calendarStage(g, () => NOW)()).toEqual({ kind: 'settled', state: 'empty' });
  });

  it('a failing read that is not revoked access fails the stage', async () => {
    await expect(calendarStage(google([account('a@x.com')], { 'a@x.com': new GoogleError(500, 'down') }), () => NOW)()).rejects.toThrow('down');
  });
});

describe('welcome mail stage', () => {
  it('sends who and what about, never a snippet or a full address, and cites each thread once', async () => {
    const g = google([account('a@x.com', { calendar: false })], { 'a@x.com': { mailPage: async () => ({ messages: [mail('thr_1'), mail('thr_1'), mail('thr_2')], next_page_token: null, result_size_estimate: 3 }) } });
    const result = await mailStage(g)();
    expect(result.kind).toBe('input');
    if (result.kind !== 'input') return;
    expect(result.sources).toEqual(['gmail']);
    expect([...result.pointers]).toEqual(['thr_1', 'thr_2']);
    expect(result.text).toContain('[thr_1] Ana Diaz (design.example) · Review thr_1');
    expect(result.text).not.toMatch(/SECRET|ana@/);
  });

  it('says revoked when the mail grant is dead or its scope was taken back, and reads nothing then', async () => {
    expect(await mailStage(google([account('a@x.com', { error: 'invalid_grant' })], {}))()).toEqual({ kind: 'settled', state: 'revoked' });
    expect(await mailStage(google([account('a@x.com')], { 'a@x.com': new GoogleError(403, 'scope', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') }))()).toEqual({ kind: 'settled', state: 'revoked' });
  });

  it('skips with no mail account, and is empty when nothing came back', async () => {
    expect(await mailStage(google([account('a@x.com', { mail: false })], {}))()).toEqual({ kind: 'settled', state: 'skipped' });
    expect(await mailStage(google([account('a@x.com')], { 'a@x.com': { mailPage: async () => ({ messages: [], next_page_token: null, result_size_estimate: 0 }) } }))()).toEqual({ kind: 'settled', state: 'empty' });
  });
});

describe('welcome web stage', () => {
  const findings = (offered: boolean, lookup: 'granted' | 'not_granted' | 'withdrawn', total: number) => ({ offered: () => offered, lookup: () => lookup, page: () => ({ items: [], total, next_cursor: null }) });
  it('is skipped until the look-up is offered and agreed to, and never writes a node', async () => {
    expect(await webStage(findings(false, 'granted', 3))()).toEqual({ kind: 'settled', state: 'skipped' });
    expect(await webStage(findings(true, 'not_granted', 3))()).toEqual({ kind: 'settled', state: 'skipped' });
    expect(await webStage(findings(true, 'withdrawn', 0))()).toEqual({ kind: 'settled', state: 'skipped' });
    expect(await webStage(findings(true, 'granted', 2))()).toEqual({ kind: 'settled', state: 'done' });
    expect(await webStage(findings(true, 'granted', 0))()).toEqual({ kind: 'settled', state: 'empty' });
  });
});
