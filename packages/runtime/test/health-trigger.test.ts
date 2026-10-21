import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ProposeCalendarChangeArgs } from '@waldo/contracts';
import type { Proactivity } from '../src/channels/loops';
import { localIso } from '../src/channels/reminders';
import {
  calendarEgressClear, healthTriggerBook, healthTriggerDueAt, healthTriggerPrompt, healthTriggerView, ownerInstant, parseHealthDecision, runHealthTrigger,
  HEALTH_FALSE_ALARM_WINDOW_MS, HEALTH_TRIGGER_FLOOR_MS, type ComingItem, type HealthTriggerDeps, type HealthTriggerOutcome,
} from '../src/health/trigger';

// Distinctive synthetic values: if any of them shows up in a prompt, a ledger row, a log line or a proposal, a reading leaked.
const LEAKS = ['47.3', '37.9', '61.4', '52.6'];
const TZ = 'Asia/Kolkata';
const NOW = Date.parse('2026-10-21T03:30:00Z'); // 09:00 in Kolkata
const ROW = {
  context: {
    id: 'ctx-1', day: '2026-10-21', compiled_at: '2026-10-21T03:00:00Z', basis: [{ source: 'whoop', consent_epoch: 3 }],
    recovery: { score: 47.3, zone: 'low', algorithm_version: 'recovery.candidate.v1', activation: 'candidate_unaccepted' },
    form: { score: 37.9, zone: 'low', algorithm_version: 'form.candidate.v3', activation: 'candidate_unaccepted' },
    weight: { score: 61.4, zone: 'high', algorithm_version: 'weight.candidate.v3', activation: 'candidate_unaccepted' },
  },
  previous: { day: '2026-10-20', form_score: 52.6, recovery_zone: 'good', weight_zone: 'moderate', basis: [{ source: 'whoop', consent_epoch: 3 }] },
};
const REVIEW: ComingItem = { kind: 'event', id: 'gcal-review-1', title: 'Quarterly board review', start: '2026-10-21T05:30:00Z', end: '2026-10-21T07:00:00Z', guests: 6 };
const DRIVE: ComingItem = { kind: 'event', id: 'gcal-drive-2', title: 'Drive to Pune', start: '2026-10-21T11:00:00Z', end: '2026-10-21T15:00:00Z' };
const TAX: ComingItem = { kind: 'task', id: 'task-9', title: 'File the quarterly return', due: '2026-10-21' };
const NO_QUIET: Proactivity = { quiet_start: null, quiet_end: null, volume: 'normal' };
const move = (start = '2026-10-21T13:00', end = '2026-10-21T14:30') => JSON.stringify({ kind: 'propose', action: 'move', item: 'e1', start, end, title: null, notify_guests: true, reason: 'Recovery is compromised; a later slot gives you a slower morning.' });
const noOp = JSON.stringify({ kind: 'no_op', action: null, item: null, start: null, end: null, title: null, notify_guests: null, reason: '' });

let sequence = 0;
type Harness = Readonly<{ sql: SqlStorage; deps: (over?: Partial<HealthTriggerDeps>) => HealthTriggerDeps; prompts: string[]; proposals: ProposeCalendarChangeArgs[]; logs: string[]; reschedules: number[]; charged: string[] }>;
const withTrigger = <T>(work: (h: Harness) => Promise<T>) => runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`health-trigger-${sequence++}`)), async (_instance, state) => {
  const sql = state.storage.sql;
  const book = healthTriggerBook(sql);
  const prompts: string[] = [], proposals: ProposeCalendarChangeArgs[] = [], logs: string[] = [], reschedules: number[] = [], charged: string[] = [];
  let ids = 0;
  const deps = (over: Partial<HealthTriggerDeps> = {}): HealthTriggerDeps => ({
    book, now: () => NOW, newId: () => `r${++ids}`, timezone: TZ, enabled: () => true, proactivity: () => NO_QUIET,
    readHealth: async () => ROW, comingItems: async () => [REVIEW, DRIVE, TAX],
    admit: () => true, charge: key => { charged.push(key); },
    decide: async (_id, prompt) => { prompts.push(prompt); return move(); },
    propose: async args => { proposals.push(args); return `p${proposals.length}`; },
    reschedule: async at => { reschedules.push(at); },
    log: line => { logs.push(JSON.stringify(line)); },
    ...over,
  });
  return work({ sql, deps, prompts, proposals, logs, reschedules, charged });
});
const everything = (sql: SqlStorage) => JSON.stringify([
  sql.exec('SELECT * FROM health_trigger_runs').toArray(), sql.exec('SELECT * FROM health_trigger_pending').toArray(),
]);

describe('the health trigger', () => {
  it('proposes one plan change when a zone change meets a coming decision, in zone words only', async () => {
    await withTrigger(async ({ sql, deps, prompts, proposals, logs, charged }) => {
      const book = deps().book;
      book.mark('2026-10-21', NOW - 60_000);
      expect(await runHealthTrigger(deps())).toBe('proposed');
      expect(proposals).toEqual([{ action: 'move', event_id: 'gcal-review-1', start: '2026-10-21T07:30:00.000Z', end: '2026-10-21T09:00:00.000Z', reason: 'Recovery is compromised; a later slot gives you a slower morning.', send_updates: 'all' }]);
      expect(charged).toEqual(['health:2026-10-21']);
      expect(prompts[0]).toContain('Now (2026-10-21, fresh): recovery compromised, form depleted, load peak.');
      expect(prompts[0]).toContain('Before (2026-10-20): recovery solid, form flagging, load moderate.');
      expect(prompts[0]).toContain('"ref":"e1","kind":"event","title":"Quarterly board review","start":"2026-10-21T11:00"');
      expect(prompts[0]).toContain('"ref":"t1","kind":"task","title":"File the quarterly return","due":"2026-10-21"');
      for (const leak of LEAKS) for (const text of [...prompts, ...logs, everything(sql), JSON.stringify(proposals)]) expect(text).not.toContain(leak);
      expect(book.pending(NOW)).toBeNull();
      expect(sql.exec('SELECT local_day, mode, outcome, approval_id FROM health_trigger_runs').toArray()).toEqual([{ local_day: '2026-10-21', mode: 'live', outcome: 'proposed', approval_id: 'p1' }]);
    });
  });

  it('does nothing at all without a pending zone change', async () => {
    await withTrigger(async ({ deps, prompts, proposals }) => {
      let reads = 0;
      expect(await runHealthTrigger(deps({ readHealth: async () => { reads += 1; return ROW; } }))).toBe('idle');
      expect([reads, prompts.length, proposals.length]).toEqual([0, 0, 0]);
    });
  });

  it('goes silent when health sharing is revoked: the consented read returns nothing', async () => {
    await withTrigger(async ({ deps, prompts, proposals }) => {
      deps().book.mark('2026-10-21', NOW - 60_000);
      expect(await runHealthTrigger(deps({ readHealth: async () => null }))).toBe('no_health');
      expect([prompts.length, proposals.length, deps().book.pending(NOW)]).toEqual([0, 0, null]);
    });
  });

  it('reads a day with every pillar unavailable as no health, never as a zero zone', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      deps().book.mark('2026-10-21', NOW - 60_000);
      const missing = { ...ROW, context: { ...ROW.context, recovery: { reason: 'missing_sleep' }, form: { reason: 'intraday_inputs_unavailable' }, weight: { reason: 'calendar_demand_unavailable' } } };
      expect(await runHealthTrigger(deps({ readHealth: async () => missing }))).toBe('no_health');
      expect(prompts).toEqual([]);
    });
  });

  it('runs nothing when nothing is coming in the next day', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      deps().book.mark('2026-10-21', NOW - 60_000);
      expect(await runHealthTrigger(deps({ comingItems: async () => [] }))).toBe('nothing_coming');
      expect(prompts).toEqual([]);
    });
  });

  it('records a no_op and proposes nothing when the model judges the change does not matter', async () => {
    await withTrigger(async ({ sql, deps, proposals }) => {
      deps().book.mark('2026-10-21', NOW - 60_000);
      expect(await runHealthTrigger(deps({ decide: async () => noOp }))).toBe('no_op');
      expect(proposals).toEqual([]);
      expect(sql.exec('SELECT outcome FROM health_trigger_runs').toArray()).toEqual([{ outcome: 'no_op' }]);
    });
  });

  it('holds through quiet hours and wakes at their local end, across a DST change', async () => {
    await withTrigger(async ({ deps, prompts, reschedules }) => {
      const zone = 'America/New_York';
      const night = Date.parse('2026-11-01T05:30:00Z'); // 01:30 EDT, the night clocks fall back
      deps().book.mark('2026-11-01', night - 60_000);
      const quiet: Proactivity = { quiet_start: '22:00', quiet_end: '07:00', volume: 'normal' };
      expect(await runHealthTrigger(deps({ now: () => night, timezone: zone, proactivity: () => quiet }))).toBe('held_quiet');
      expect(prompts).toEqual([]);
      expect(reschedules.map(at => localIso(at, zone))).toEqual(['2026-11-01T07:00']);
      expect(reschedules).toEqual([Date.parse('2026-11-01T12:00:00Z')]);
      expect(deps().book.pending(night)).not.toBeNull();
    });
  });

  it('keeps one health card per owner-local day, counted in the zone the owner is in now', async () => {
    await withTrigger(async ({ deps, prompts, proposals }) => {
      const book = deps().book;
      book.mark('2026-10-21', NOW - 60_000);
      expect(await runHealthTrigger(deps())).toBe('proposed');
      // The owner flies to New York: 16:00 UTC is still 21 October there, so the day's card is spent.
      const later = Date.parse('2026-10-21T16:00:00Z');
      book.mark('2026-10-21', later - 60_000);
      expect(await runHealthTrigger(deps({ now: () => later, timezone: 'America/New_York' }))).toBe('budget_day');
      // Back in Kolkata, 19:00 UTC is already 22 October: a new day.
      const nextDay = Date.parse('2026-10-21T19:00:00Z');
      book.mark('2026-10-22', nextDay - 60_000);
      const tomorrow: ComingItem = { ...REVIEW, start: '2026-10-22T05:30:00Z', end: '2026-10-22T07:00:00Z' };
      expect(await runHealthTrigger(deps({ now: () => nextDay, comingItems: async () => [tomorrow], readHealth: async () => ({ ...ROW, context: { ...ROW.context, day: '2026-10-22', compiled_at: '2026-10-21T18:30:00Z' } }),
        decide: async (_id, prompt) => { prompts.push(prompt); return move('2026-10-22T13:00', '2026-10-22T14:30'); } }))).toBe('proposed');
      expect(proposals).toHaveLength(2);
    });
  });

  it('respects the per-owner interrupt budget of the delivery gate', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      deps().book.mark('2026-10-21', NOW - 60_000);
      expect(await runHealthTrigger(deps({ admit: () => false }))).toBe('budget_gate');
      expect(prompts).toEqual([]);
    });
  });

  it('runs one evaluation for a burst of zone changes, and keeps a change that lands mid-run', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      const book = deps().book;
      book.mark('2026-10-21', NOW - 120_000);
      book.mark('2026-10-21', NOW - 60_000);
      let during = false;
      expect(await runHealthTrigger(deps({ decide: async (_id, prompt) => { prompts.push(prompt); book.mark('2026-10-21', NOW + 5_000); during = true; return noOp; } }))).toBe('no_op');
      expect([prompts.length, during, book.pending(NOW + 10_000)]).toEqual([1, true, NOW + 5_000]);
    });
  });

  it('turns proposals to shadow for a week after a skipped card, then back to live', async () => {
    await withTrigger(async ({ sql, deps, proposals }) => {
      sql.exec('CREATE TABLE ledger (id TEXT PRIMARY KEY, kind TEXT, status TEXT, summary TEXT, payload_json TEXT, undo_json TEXT, created_at INTEGER, decided_at INTEGER, deferred_at INTEGER)');
      const book = deps().book;
      book.mark('2026-10-21', NOW - 60_000);
      expect(await runHealthTrigger(deps())).toBe('proposed');
      sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at, decided_at) VALUES ('p1', 'calendar_change', 'skipped', 's', '{}', ?, ?)", NOW, NOW + 600_000);
      expect(book.week(NOW + HEALTH_TRIGGER_FLOOR_MS)).toEqual({ shown: 1, accepted: 0, false_alarms: 1, shadow: 0 });
      const tomorrow = NOW + 24 * 3_600_000;
      book.mark('2026-10-22', tomorrow - 60_000);
      const tomorrowRow = { ...ROW, context: { ...ROW.context, day: '2026-10-22', compiled_at: new Date(tomorrow - 600_000).toISOString() } };
      const later = (at: number) => deps({ now: () => at, readHealth: async () => ({ ...tomorrowRow, context: { ...tomorrowRow.context, compiled_at: new Date(at - 600_000).toISOString() } }), comingItems: async () => [{ ...REVIEW, start: new Date(at + 7_200_000).toISOString(), end: new Date(at + 9_000_000).toISOString() }],
        decide: async () => JSON.stringify({ kind: 'propose', action: 'move', item: 'e1', start: localIso(at + 14_400_000, TZ), end: localIso(at + 18_000_000, TZ), title: null, notify_guests: false, reason: 'A later slot.' }) });
      expect(await runHealthTrigger(later(tomorrow))).toBe('shadow_proposed');
      expect(proposals).toHaveLength(1);
      const weekOn = NOW + 600_000 + HEALTH_FALSE_ALARM_WINDOW_MS + 60_000;
      book.mark(localIso(weekOn, TZ).slice(0, 10), weekOn - 60_000);
      expect(await runHealthTrigger(later(weekOn))).toBe('proposed');
      expect(proposals).toHaveLength(2);
    });
  });

  it('refuses a proposal whose calendar title would carry a health word to Google', async () => {
    await withTrigger(async ({ deps, proposals }) => {
      deps().book.mark('2026-10-21', NOW - 60_000);
      const create = (title: string) => async () => JSON.stringify({ kind: 'propose', action: 'create', item: null, start: '2026-10-21T15:00', end: '2026-10-21T16:00', title, notify_guests: null, reason: 'Protect an hour.' });
      expect(await runHealthTrigger(deps({ decide: create('Recovery block') }))).toBe('egress_refused');
      deps().book.mark('2026-10-21', NOW - 30_000);
      expect(await runHealthTrigger(deps({ decide: create('Compromised: take it slow') }))).toBe('egress_refused');
      expect(proposals).toEqual([]);
      deps().book.mark('2026-10-21', NOW - 10_000);
      expect(await runHealthTrigger(deps({ decide: create('Focus block') }))).toBe('proposed');
      expect(proposals).toEqual([{ action: 'create', title: 'Focus block', start: '2026-10-21T09:30:00.000Z', end: '2026-10-21T10:30:00.000Z', reason: 'Protect an hour.' }]);
    });
  });

  it('refuses a proposal naming something it was not shown, never repairing it', async () => {
    await withTrigger(async ({ deps, proposals }) => {
      const tries: [string, HealthTriggerOutcome][] = [
        [JSON.stringify({ kind: 'propose', action: 'move', item: 'e9', start: '2026-10-21T13:00', end: '2026-10-21T14:00', title: null, notify_guests: null, reason: 'r' }), 'invalid'],
        [JSON.stringify({ kind: 'propose', action: 'cancel', item: 't1', start: null, end: null, title: null, notify_guests: null, reason: 'r' }), 'invalid'],
        [JSON.stringify({ kind: 'propose', action: 'move', item: 'e1', start: '2026-10-21T08:00', end: '2026-10-21T08:30', title: null, notify_guests: null, reason: 'r' }), 'invalid'],
        [JSON.stringify({ kind: 'propose', action: 'move', item: 'gcal-review-1', start: '2026-10-21T13:00', end: '2026-10-21T14:00', title: null, notify_guests: null, reason: 'r' }), 'invalid'],
        ['not json', 'invalid'],
      ];
      for (const [answer, outcome] of tries) {
        deps().book.mark('2026-10-21', NOW - 60_000);
        expect(await runHealthTrigger(deps({ decide: async () => answer }))).toBe(outcome);
      }
      expect(proposals).toEqual([]);
    });
  });

  it('keeps the change pending and retries after the floor when the model fails', async () => {
    await withTrigger(async ({ deps, reschedules }) => {
      deps().book.mark('2026-10-21', NOW - 60_000);
      expect(await runHealthTrigger(deps({ decide: async () => { throw new Error('model down'); } }))).toBe('failed');
      expect(reschedules).toEqual([NOW + HEALTH_TRIGGER_FLOOR_MS]);
      expect(deps().book.pending(NOW)).toBe(NOW - 60_000);
    });
  });

  it('stops and forgets the pending change when the owner turned health proposals off', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      deps().book.mark('2026-10-21', NOW - 60_000);
      expect(await runHealthTrigger(deps({ enabled: () => false }))).toBe('opted_out');
      expect([prompts.length, deps().book.pending(NOW)]).toEqual([0, null]);
    });
  });

  it('drops a pending change that is older than half a day', async () => {
    await withTrigger(async ({ deps }) => {
      deps().book.mark('2026-10-20', NOW - 13 * 3_600_000);
      expect(await runHealthTrigger(deps())).toBe('idle');
    });
  });
});

describe('the health view', () => {
  it('drops the earlier day when it came from another wearable, so a source switch is never a change', () => {
    const switched = { ...ROW, previous: { ...ROW.previous, basis: [{ source: 'apple', consent_epoch: 1 }] } };
    const view = healthTriggerView(switched, NOW, TZ)!;
    expect(view.before).toBeNull();
    expect(healthTriggerPrompt({ view, items: [REVIEW], now: NOW, timezone: TZ, feedback: {} })).toContain('still being learned');
  });

  it('treats an expired, future-stamped or unreadable row as no health', () => {
    expect(healthTriggerView({ ...ROW, context: { ...ROW.context, compiled_at: '2026-10-17T00:00:00Z' } }, NOW, TZ)).toBeNull();
    expect(healthTriggerView({ ...ROW, context: { ...ROW.context, compiled_at: '2026-10-21T09:00:00Z' } }, NOW, TZ)).toBeNull();
    expect(healthTriggerView({ context: null, previous: null }, NOW, TZ)).toBeNull();
    expect(healthTriggerView(null, NOW, TZ)).toBeNull();
  });
});

describe('proposal checks', () => {
  it('reads owner-local times in the owner zone and refuses one the clock skips', () => {
    expect(ownerInstant('2026-03-08T02:30', 'America/New_York')).toBeNull();
    expect(ownerInstant('2026-03-08T03:30', 'America/New_York')).toBe(Date.parse('2026-03-08T07:30:00Z'));
    expect(ownerInstant('2026-10-21T13:00', 'Asia/Kolkata')).toBe(Date.parse('2026-10-21T07:30:00Z'));
    expect(ownerInstant('2026-10-21 13:00', 'Asia/Kolkata')).toBeNull();
  });

  it('checks every calendar field that reaches Google, and only those', () => {
    const words = ['compromised', 'recovery', 'sleep'];
    expect(calendarEgressClear({ action: 'create', title: 'Focus block', start: 'x', end: 'y', reason: 'Recovery is compromised' }, words)).toBe(true);
    expect(calendarEgressClear({ action: 'create', title: 'Sleep in', start: 'x', end: 'y', reason: 'r' }, words)).toBe(false);
    expect(calendarEgressClear({ action: 'create', title: 'Block', description: 'recovery time', start: 'x', end: 'y', reason: 'r' }, words)).toBe(false);
    expect(calendarEgressClear({ action: 'create', title: 'Sleepless in Seattle screening', start: 'x', end: 'y', reason: 'r' }, words)).toBe(true);
  });

  it('cancels only an event, and asks Google to email guests only when the model said so', () => {
    const cancel = (notify: boolean | null) => parseHealthDecision(JSON.stringify({ kind: 'propose', action: 'cancel', item: 'e1', start: null, end: null, title: null, notify_guests: notify, reason: 'Clear the morning.' }), [REVIEW], NOW, TZ);
    expect(cancel(true)).toEqual({ kind: 'propose', args: { action: 'cancel', event_id: 'gcal-review-1', reason: 'Clear the morning.', send_updates: 'all' } });
    expect(cancel(null)).toEqual({ kind: 'propose', args: { action: 'cancel', event_id: 'gcal-review-1', reason: 'Clear the morning.', send_updates: 'none' } });
  });

  it('arms the evaluation no earlier than an hour after the last one', () => {
    expect(healthTriggerDueAt(NOW, null)).toBe(NOW);
    expect(healthTriggerDueAt(NOW, NOW - 600_000)).toBe(NOW - 600_000 + HEALTH_TRIGGER_FLOOR_MS);
    expect(healthTriggerDueAt(NOW, NOW - 2 * HEALTH_TRIGGER_FLOOR_MS)).toBe(NOW);
  });
});
