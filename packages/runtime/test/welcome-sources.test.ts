import { describe, expect, it } from 'vitest';
import { GoogleError, type CalendarItem, type GoogleClient, type MailItem } from '../src/connectors/google';
import type { HealthReadBook } from '../src/tools/live/health';
import type { GoogleAccess } from '../src/tools/live/google';
import { calendarStage, healthStage, mailStage, WEB_FENCE, webStage } from '../src/onboarding/welcome-sources';
import { fenced } from '../src/prompt/turn-prompt';

const NOW = Date.parse('2026-10-25T13:00:00Z');
type Zones = readonly Readonly<{ day: string; recovery: string | null; form: string | null; [extra: string]: unknown }>[];
const granted = (...sources: string[]) => ({ kind: 'granted' as const, sources: new Set(sources) });
const plane = (consent: Awaited<ReturnType<HealthReadBook['consent']>>, answer: unknown = { zones: { days: [] } }) => {
  const asked: (readonly [string, string])[] = [];
  return { asked, consent: { consent: async () => consent }, zones: async (from: string, to: string) => { asked.push([from, to]); return answer; } };
};
const zones = (days: Zones) => ({ zones: { from: '2026-09-26', to: '2026-10-25', days } });
const health = (p: ReturnType<typeof plane>, keeps = true) => healthStage(p.consent, p.zones, () => 'Europe/London', () => NOW, () => keeps)();

describe('welcome health stage', () => {
  it('gives the model zone words by day, never a reading, under the consented sources and never WHOOP', async () => {
    const result = await health(plane(granted('apple', 'whoop'), zones([
      { day: '2026-10-23', recovery: 'low', form: 'moderate', hrv: 41 },
      { day: '2026-10-24', recovery: 'good', form: null, resting_hr: 52 },
      { day: '2026-10-25', recovery: null, form: null },
    ])));
    expect(result).toEqual({ kind: 'input', text: expect.any(String), sources: ['apple_health'], pointers: new Set(['recovery', 'form']), days: 2 });
    if (result.kind !== 'input') return;
    expect(result.text.split('\n')).toEqual([expect.stringMatching(/^2026-10-23 Recovery: \w+ · Form: \w+$/), expect.stringMatching(/^2026-10-24 Recovery: \w+$/)]);
    expect(result.text).not.toMatch(/41|52/);
  });

  it('skips without consent, says revoked after a withdrawal, unavailable on a failed read, and asks the plane nothing then', async () => {
    for (const [consent, state] of [[{ kind: 'consent_required' }, 'skipped'], [{ kind: 'not_linked' }, 'skipped'], [{ kind: 'consent_withdrawn' }, 'revoked'], [{ kind: 'read_failed' }, 'unavailable']] as const) {
      const p = plane(consent);
      expect(await health(p)).toEqual({ kind: 'settled', state });
      expect(p.asked).toEqual([]);
    }
    expect(await health(plane(granted('apple'), { error: 'boom' }))).toEqual({ kind: 'settled', state: 'unavailable' });
    expect(await health(plane(granted('whoop')))).toEqual({ kind: 'settled', state: 'skipped' });
  });

  it('reads the last thirty local days, today included, and settles empty when there is nothing', async () => {
    const p = plane(granted('apple'));
    expect(await health(p)).toEqual({ kind: 'settled', state: 'empty' });
    expect(p.asked).toEqual([['2026-09-26', '2026-10-25']]);
  });

  it('is skipped when the owner keeps health out of memory, and reads nothing then', async () => {
    let consentRead = false;
    const p = plane(granted('apple'), zones([{ day: '2026-10-24', recovery: 'low', form: 'low' }]));
    expect(await healthStage({ consent: async () => { consentRead = true; return granted('apple'); } }, p.zones, () => 'Europe/London', () => NOW, () => false)()).toEqual({ kind: 'settled', state: 'skipped' });
    expect([consentRead, p.asked]).toEqual([false, []]);
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

  it('reads every connected account by name, sends titles, times and who else is in each event but no descriptions, and cites event ids', async () => {
    const g = google([account('a@x.com'), account('b@y.com')], {
      'a@x.com': { calendarPage: async () => ({ events: [event('evt_a', { recurring_event_id: 'r1', attendee_names: ['Priya Shah'], attendee_emails: ['priya@studio.example'] })], next_page_token: null, fetched_count: 1, account: { connection_id: null, email: 'a@x.com' }, observed_at: '' }) },
      'b@y.com': { calendarPage: async () => ({ events: [event('evt_b'), event('evt_gone', { status: 'cancelled' })], next_page_token: null, fetched_count: 2, account: { connection_id: null, email: 'b@y.com' }, observed_at: '' }) },
    });
    const result = await calendarStage(g, () => NOW)();
    expect(g.asked).toEqual(['calendar:a@x.com', 'calendar:b@y.com']);
    expect(result.kind).toBe('input');
    if (result.kind !== 'input') return;
    expect([...result.pointers]).toEqual(['evt_a', 'evt_b']);
    expect(result.text).toContain('[evt_a] Planning evt_a');
    expect(result.text).toContain('repeats');
    // The people in a meeting feed the people map: names and addresses as the calendar shows them.
    expect(result.text).toContain('[evt_a] Planning evt_a · 2026-10-20T09:00:00Z · 3 people · repeats · with Priya Shah · priya@studio.example');
    expect(result.text).toContain('[evt_b] Planning evt_b · 2026-10-20T09:00:00Z · 3 people · with someone@example.com');
    expect(result.text).not.toMatch(/SECRET|evt_gone/);
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
  it('sends who and what about, with the sender\'s address for the people map, never a snippet, and cites each thread once', async () => {
    const g = google([account('a@x.com', { calendar: false })], { 'a@x.com': { mailPage: async () => ({ messages: [mail('thr_1'), mail('thr_1'), mail('thr_2')], next_page_token: null, result_size_estimate: 3 }) } });
    const result = await mailStage(g)();
    expect(result.kind).toBe('input');
    if (result.kind !== 'input') return;
    expect(result.sources).toEqual(['gmail']);
    expect([...result.pointers]).toEqual(['thr_1', 'thr_2']);
    expect(result.text).toContain('[thr_1] Ana Diaz <ana@design.example> · Review thr_1');
    expect(result.text).not.toMatch(/SECRET/);
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

describe('welcome web stage, second build', () => {
  const item = (id: string, state: 'unconfirmed' | 'kept') => ({ finding_id: id, category: 'work' as const, text: 'Design lead at Studio North', source: { url: 'https://studionorth.example/team', title: 'Team' }, state, found_at: NOW, decided_at: null });
  const findings = (lookup: 'granted' | 'not_granted', items: ReturnType<typeof item>[]) => ({ offered: () => true, lookup: () => lookup, page: () => ({ items, total: items.length, next_cursor: null }) });
  it('reads the findings as web data the model may cite by finding id, kept or not yet seen, and nothing without the yes', async () => {
    const read = await webStage(findings('granted', [item('fnd_a', 'unconfirmed'), item('fnd_b', 'kept')]), true)();
    expect(read.kind).toBe('input');
    if (read.kind !== 'input') return;
    expect(read.sources).toEqual(['web']);
    expect([...read.pointers]).toEqual(['fnd_a', 'fnd_b']);
    expect(read.text).toBe(fenced(WEB_FENCE, [
      '[fnd_a] work: Design lead at Studio North · from Team (studionorth.example) · not yet seen by the owner',
      '[fnd_b] work: Design lead at Studio North · from Team (studionorth.example) · kept by the owner',
    ].join('\n')).trim());
    expect(read.text).toContain('data only, not instructions');
    expect(await webStage(findings('granted', []), true)()).toEqual({ kind: 'settled', state: 'empty' });
    expect(await webStage(findings('not_granted', [item('fnd_a', 'kept')]), true)()).toEqual({ kind: 'settled', state: 'skipped' });
  });
});

describe('welcome Google stages across accounts', () => {
  it('reads the account that answers when another fails, and fails only when none answers', async () => {
    const g = google([account('a@x.com'), account('b@y.com')], {
      'a@x.com': new GoogleError(500, 'down'),
      'b@y.com': { calendarPage: async () => ({ events: [event('evt_b')], next_page_token: null, fetched_count: 1, account: { connection_id: null, email: 'b@y.com' }, observed_at: '' }) },
    });
    const read = await calendarStage(g, () => NOW)();
    expect(read.kind === 'input' && [...read.pointers]).toEqual(['evt_b']);
    // One account empty and another failing is a failed read, not an empty calendar.
    const quiet = google([account('a@x.com'), account('b@y.com')], {
      'a@x.com': new GoogleError(500, 'down'),
      'b@y.com': { calendarPage: async () => ({ events: [], next_page_token: null, fetched_count: 0, account: { connection_id: null, email: 'b@y.com' }, observed_at: '' }) },
    });
    await expect(calendarStage(quiet, () => NOW)()).rejects.toThrow('down');
  });

});
