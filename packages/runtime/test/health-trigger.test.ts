import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ProposeCalendarChangeArgs } from '@waldo/contracts';
import type { Proactivity } from '../src/channels/loops';
import { localIso } from '../src/channels/reminders';
import type { CalendarItem, TaskItem } from '../src/connectors/google';
import type { Loop } from '../src/channels/loops';
import { DeliveryGateStore } from '../src/delivery-gate/store';
import { ensureSchema } from '../src/tracer/schema';
import {
  calendarEgressClear, comingItemsFrom, healthCardBudget, healthTriggerBook, healthTriggerDueAt, healthTriggerPrompt, healthTriggerView, ownerInstant, parseHealthDecision, runHealthTrigger,
  HEALTH_ASK_AFTER_SKIPS, HEALTH_FALSE_ALARM_WINDOW_MS, HEALTH_KEEP_ASKING, HEALTH_TRIGGER_FLOOR_MS, HEALTH_TRIGGER_FORMAT, resolveHealthMode, type ComingItem, type HealthTriggerDeps, type HealthTriggerOutcome,
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
type Harness = Readonly<{ sql: SqlStorage; storage: DurableObjectStorage; deps: (over?: Partial<HealthTriggerDeps>) => HealthTriggerDeps; prompts: string[]; proposals: ProposeCalendarChangeArgs[]; logs: string[]; reschedules: number[]; charged: string[] }>;
const withTrigger = <T>(work: (h: Harness) => Promise<T>) => runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`health-trigger-${sequence++}`)), async (_instance, state) => {
  const sql = state.storage.sql;
  const book = healthTriggerBook(sql);
  const prompts: string[] = [], proposals: ProposeCalendarChangeArgs[] = [], logs: string[] = [], reschedules: number[] = [], charged: string[] = [];
  let ids = 0;
  const deps = (over: Partial<HealthTriggerDeps> = {}): HealthTriggerDeps => ({
    book, now: () => NOW, newId: () => `r${++ids}`, timezone: TZ, enabled: () => true, proactivity: () => NO_QUIET, modeSetting: () => 'auto',
    readHealth: async () => ROW, comingItems: async () => [REVIEW, DRIVE, TAX],
    admit: () => ({ verdict: 'send' }), charge: key => { charged.push(key); },
    decide: async (_id, prompt) => { prompts.push(prompt); return move(); },
    propose: async args => { proposals.push(args); return `p${proposals.length}`; },
    reschedule: async at => { reschedules.push(at); },
    log: line => { logs.push(JSON.stringify(line)); },
    ...over,
  });
  return work({ sql, storage: state.storage, deps, prompts, proposals, logs, reschedules, charged });
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

  // One evaluation over the delivery gate's real budget, at a time and in a zone the test names: the marked day is the
  // owner-local day there, the meeting two hours out, and the model moves it two hours later.
  const gatedRun = (h: Harness, at: number, timezone: string, over: Partial<HealthTriggerDeps> = {}) => {
    const day = localIso(at, timezone).slice(0, 10);
    h.deps().book.mark(day, at - 60_000);
    let clock = at;
    const budget = healthCardBudget(new DeliveryGateStore(h.sql), 'owner-1', timezone, () => clock);
    return runHealthTrigger(h.deps({ now: () => clock, timezone, admit: budget.admit, charge: budget.charge,
      readHealth: async () => ({ ...ROW, context: { ...ROW.context, day, compiled_at: new Date(at - 600_000).toISOString() } }),
      comingItems: async () => [{ ...REVIEW, start: new Date(at + 7_200_000).toISOString(), end: new Date(at + 9_000_000).toISOString() }],
      decide: async (_id, prompt) => {
        h.prompts.push(prompt);
        // The model takes a few seconds, so the card is booked after the run started.
        clock += 5_000;
        return JSON.stringify({ kind: 'propose', action: 'move', item: 'e1', start: localIso(at + 14_400_000, timezone), end: localIso(at + 18_000_000, timezone), title: null, notify_guests: false, reason: 'A later slot.' });
      }, ...over }));
  };

  it('lets the delivery gate\'s budget govern: three proposed changes a day, then none until the owner\'s next day, counted in the zone they are in now', async () => {
    await withTrigger(async h => {
      ensureSchema(h.storage);
      const hour = HEALTH_TRIGGER_FLOOR_MS;
      for (const at of [NOW, NOW + hour + 5_000, NOW + 2 * hour + 10_000]) expect(await gatedRun(h, at, TZ)).toBe('proposed');
      expect(h.proposals).toHaveLength(3);
      expect(await gatedRun(h, NOW + 3 * hour + 15_000, TZ)).toBe('budget_gate');
      expect(h.deps().book.pending(NOW + 3 * hour + 15_000)).toBeNull();
      // The owner flies to New York: 16:00 UTC is still 21 October there, so the day's budget is spent.
      expect(await gatedRun(h, Date.parse('2026-10-21T16:00:00Z'), 'America/New_York')).toBe('budget_gate');
      // 05:00 UTC on the 22nd is 01:00 on the 22nd in New York: a new day.
      expect(await gatedRun(h, Date.parse('2026-10-22T05:00:00Z'), 'America/New_York')).toBe('proposed');
      expect(h.proposals).toHaveLength(4);
      expect(h.prompts).toHaveLength(4);
    });
  });

  it('holds a card the gate\'s cooldown still covers and keeps the change for when it ends, though the hourly floor came first', async () => {
    await withTrigger(async h => {
      ensureSchema(h.storage);
      expect(await gatedRun(h, NOW, TZ)).toBe('proposed');
      // The next evaluation is armed an hour after the last one started; the card was booked five seconds later.
      const next = healthTriggerDueAt(NOW + 30 * 60_000, h.deps().book.lastRunAt());
      expect(next).toBe(NOW + HEALTH_TRIGGER_FLOOR_MS);
      expect(await gatedRun(h, next, TZ)).toBe('held_cooldown');
      expect(h.prompts).toHaveLength(1);
      expect(h.reschedules).toEqual([NOW + 5_000 + HEALTH_TRIGGER_FLOOR_MS]);
      expect(h.deps().book.pending(next)).not.toBeNull();
      expect(await gatedRun(h, h.reschedules[0]!, TZ)).toBe('proposed');
      expect(h.proposals).toHaveLength(2);
    });
  });

  it('respects the per-owner interrupt budget of the delivery gate', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      deps().book.mark('2026-10-21', NOW - 60_000);
      expect(await runHealthTrigger(deps({ admit: () => ({ verdict: 'spent' }) }))).toBe('budget_gate');
      expect([prompts.length, deps().book.pending(NOW)]).toEqual([0, null]);
    });
  });

  it('runs one evaluation for a burst of zone changes, and keeps a change that lands mid-run', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      const book = deps().book;
      book.mark('2026-10-21', NOW - 120_000);
      book.mark('2026-10-21', NOW - 60_000);
      let during = false;
      expect(await runHealthTrigger(deps({ decide: async (_id, prompt) => { prompts.push(prompt); book.mark('2026-10-21', NOW + 5_000); during = true; return noOp; } }))).toBe('no_op');
      expect([prompts.length, during, book.pending(NOW + 10_000)]).toEqual([1, true, { at: NOW + 5_000, days: ['2026-10-21'] }]);
    });
  });

  describe('a wake that lands while a run is in progress', () => {
    // The scheduler holds the entry while the run works, so the arm a wake makes then does nothing: the run itself has to
    // leave the next one behind.
    const runWith = async (h: Harness, wakesMidRun: number) => {
      h.deps().book.mark('2026-10-21', NOW - 60_000);
      return runHealthTrigger(h.deps({ decide: async (_id, prompt) => { h.prompts.push(prompt); for (let i = 0; i < wakesMidRun; i += 1) h.deps().book.mark('2026-10-21', NOW + 5_000 + i); return noOp; } }));
    };

    it('is re-armed once when the run ends, and that follow-up run takes it', async () => {
      await withTrigger(async h => {
        expect(await runWith(h, 1)).toBe('no_op');
        expect(h.reschedules).toEqual([NOW + HEALTH_TRIGGER_FLOOR_MS]);
        const followUp = h.reschedules[0]!;
        expect(await runHealthTrigger(h.deps({ now: () => followUp, decide: async (_id, prompt) => { h.prompts.push(prompt); return noOp; } }))).toBe('no_op');
        expect(h.prompts).toHaveLength(2);
        expect(h.reschedules).toHaveLength(1);
        expect(await runHealthTrigger(h.deps({ now: () => followUp + HEALTH_TRIGGER_FLOOR_MS }))).toBe('idle');
      });
    });

    it('is still one follow-up when several land', async () => {
      await withTrigger(async h => {
        expect(await runWith(h, 2)).toBe('no_op');
        expect(h.reschedules).toHaveLength(1);
      });
    });

    it('leaves nothing armed when none landed', async () => {
      await withTrigger(async h => {
        expect(await runWith(h, 0)).toBe('no_op');
        expect(h.reschedules).toEqual([]);
        expect(h.deps().book.pending(NOW)).toBeNull();
      });
    });

    it('does not arm a second time for a run that already put itself back', async () => {
      await withTrigger(async h => {
        h.deps().book.mark('2026-10-21', NOW - 60_000);
        const failed = await runHealthTrigger(h.deps({ decide: async () => { h.deps().book.mark('2026-10-21', NOW + 5_000); throw new Error('model down'); } }));
        expect([failed, h.reschedules]).toEqual(['failed', [NOW + HEALTH_TRIGGER_FLOOR_MS]]);
      });
      await withTrigger(async h => {
        h.deps().book.mark('2026-10-21', NOW - 60_000);
        const until = NOW + 20 * 60_000;
        const held = await runHealthTrigger(h.deps({ admit: () => ({ verdict: 'wait', until }), readHealth: async () => { h.deps().book.mark('2026-10-21', NOW + 5_000); return ROW; } }));
        expect([held, h.reschedules]).toEqual(['held_cooldown', [until]]);
      });
    });
  });

  // The budget is faked to admit every card, so only the skip accounting decides these tests.
  const proposeOn = async (h: Harness, at: number, day: string, over: Partial<HealthTriggerDeps> = {}) => {
    h.deps().book.mark(day, at - 60_000);
    return runHealthTrigger(h.deps({ now: () => at, readHealth: async () => ({ ...ROW, context: { ...ROW.context, day, compiled_at: new Date(at - 600_000).toISOString() } }),
      comingItems: async () => [{ ...REVIEW, start: new Date(at + 7_200_000).toISOString(), end: new Date(at + 9_000_000).toISOString() }],
      decide: async () => JSON.stringify({ kind: 'propose', action: 'move', item: 'e1', start: localIso(at + 14_400_000, TZ), end: localIso(at + 18_000_000, TZ), title: null, notify_guests: false, reason: 'A later slot.' }), ...over }));
  };
  const skip = (sql: SqlStorage, id: string, at: number) => sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at, decided_at) VALUES (?, 'calendar_change', 'skipped', 's', '{}', ?, ?)", id, at, at + 600_000);
  const ledgerTable = (sql: SqlStorage) => sql.exec('CREATE TABLE ledger (id TEXT PRIMARY KEY, kind TEXT, status TEXT, summary TEXT, payload_json TEXT, undo_json TEXT, created_at INTEGER, decided_at INTEGER, deferred_at INTEGER)');
  const DAY_MS = 24 * 3_600_000;
  const dayOf = (at: number) => localIso(at, TZ).slice(0, 10);

  it('keeps proposing live after a skip: a skip often means "not now", so it is counted and never mutes the owner', async () => {
    await withTrigger(async h => {
      ledgerTable(h.sql);
      expect(await proposeOn(h, NOW, '2026-10-21')).toBe('proposed');
      skip(h.sql, 'p1', NOW);
      expect(h.deps().book.week(NOW + HEALTH_TRIGGER_FLOOR_MS)).toEqual({ shown: 1, accepted: 0, false_alarms: 1, shadow: 0 });
      const tomorrow = NOW + DAY_MS;
      expect(await proposeOn(h, tomorrow, dayOf(tomorrow))).toBe('proposed');
      expect(h.proposals).toHaveLength(2);
      expect(h.proposals[1]!.reason).toBe('A later slot.');
    });
  });

  it('asks on the next card, once a week, whether to keep these coming after three skips in seven days', async () => {
    await withTrigger(async h => {
      ledgerTable(h.sql);
      let at = NOW;
      for (let i = 0; i < HEALTH_ASK_AFTER_SKIPS; i += 1) {
        expect(await proposeOn(h, at, dayOf(at))).toBe('proposed');
        skip(h.sql, `p${i + 1}`, at);
        at += DAY_MS;
      }
      expect(h.proposals.map(p => p.reason)).toEqual(['A later slot.', 'A later slot.', 'A later slot.']);
      expect(await proposeOn(h, at, dayOf(at))).toBe('proposed');
      expect(h.proposals[3]!.reason).toBe(`A later slot. ${HEALTH_KEEP_ASKING}`);
      expect(h.proposals[3]!.reason.length).toBeLessThanOrEqual(300);
      // The week has had its ask: the next card goes out as a plain proposal, whatever the owner did with this one.
      skip(h.sql, 'p4', at);
      at += DAY_MS;
      expect(await proposeOn(h, at, dayOf(at))).toBe('proposed');
      expect(h.proposals[4]!.reason).toBe('A later slot.');
      expect(h.sql.exec('SELECT count(*) AS n FROM health_trigger_runs WHERE asked = 1').toArray()[0]).toEqual({ n: 1 });
    });
  });

  it('asks the same day when the owner skips three cards in one day, now that a day can carry several', async () => {
    await withTrigger(async h => {
      ledgerTable(h.sql);
      let at = NOW;
      for (let i = 0; i < HEALTH_ASK_AFTER_SKIPS; i += 1) {
        expect(await proposeOn(h, at, '2026-10-21')).toBe('proposed');
        skip(h.sql, `p${i + 1}`, at);
        at += HEALTH_TRIGGER_FLOOR_MS;
      }
      expect(await proposeOn(h, at, '2026-10-21')).toBe('proposed');
      expect(h.proposals[3]!.reason).toBe(`A later slot. ${HEALTH_KEEP_ASKING}`);
    });
  });

  it('shows the model what it proposed earlier today and how the owner answered, so a later run does not put the same change up again', async () => {
    await withTrigger(async h => {
      ledgerTable(h.sql);
      const card = (id: string, args: ProposeCalendarChangeArgs) => h.sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at) VALUES (?, 'calendar_change', 'open', 's', ?, ?)", id, JSON.stringify(args), NOW);
      const later = NOW + HEALTH_TRIGGER_FLOOR_MS;
      const first = move(localIso(NOW + 14_400_000, TZ), localIso(NOW + 18_000_000, TZ));
      expect(await proposeOn(h, NOW, '2026-10-21', { decide: async (_id, prompt) => { h.prompts.push(prompt); return first; }, propose: async args => { h.proposals.push(args); card('p1', args); return 'p1'; } })).toBe('proposed');
      expect(await proposeOn(h, later, '2026-10-21', { decide: async (_id, prompt) => { h.prompts.push(prompt); return noOp; } })).toBe('no_op');
      expect(h.prompts[0]).toContain('Nothing proposed earlier on 2026-10-21.');
      expect(h.prompts[1]).toContain(`Earlier on 2026-10-21 you proposed: [{"action":"move","item":"e1","start":"${localIso(NOW + 14_400_000, TZ)}","end":"${localIso(NOW + 18_000_000, TZ)}","answer":"waiting for the owner"}]`);
      h.sql.exec("UPDATE ledger SET status = 'skipped', decided_at = ? WHERE id = 'p1'", later);
      expect(await proposeOn(h, later + HEALTH_TRIGGER_FLOOR_MS, '2026-10-21', { decide: async (_id, prompt) => { h.prompts.push(prompt); return noOp; } })).toBe('no_op');
      expect(h.prompts[2]).toContain('"answer":"skipped"');
      for (const leak of LEAKS) for (const text of h.prompts) expect(text).not.toContain(leak);
    });
  });

  it('refuses, uncharged, a change it already put up that day while the owner is still deciding on it, put it off or skipped it', async () => {
    await withTrigger(async h => {
      ledgerTable(h.sql);
      const same = move('2026-10-21T15:00', '2026-10-21T16:00');
      let cards = 0;
      const propose = async (args: ProposeCalendarChangeArgs) => {
        h.proposals.push(args);
        const id = `p${++cards}`;
        h.sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at) VALUES (?, 'calendar_change', 'card_unconfirmed', 's', ?, ?)", id, JSON.stringify({ ...args, account: 'owner@example.test', operation_ref: 'health:x', time_zone: TZ }), NOW);
        return id;
      };
      const run = (at: number, day: string, answer = same) => proposeOn(h, at, day, { decide: async () => answer, propose });
      const hour = HEALTH_TRIGGER_FLOOR_MS;
      expect(await run(NOW, '2026-10-21')).toBe('proposed');
      // The model words its reason anew; the change is the same one, still waiting on its card.
      const reworded = JSON.stringify({ ...JSON.parse(same), reason: 'Still compromised; the later slot still helps.' });
      expect(await run(NOW + hour, '2026-10-21', reworded)).toBe('duplicate');
      h.sql.exec("UPDATE ledger SET status = 'open', deferred_at = ? WHERE id = 'p1'", NOW + hour);
      expect(await run(NOW + 2 * hour, '2026-10-21')).toBe('duplicate');
      h.sql.exec("UPDATE ledger SET status = 'skipped', decided_at = ? WHERE id = 'p1'", NOW + 2 * hour);
      expect(await run(NOW + 3 * hour, '2026-10-21')).toBe('duplicate');
      expect([h.proposals.length, h.charged.length]).toEqual([1, 1]);
      expect(h.sql.exec('SELECT outcome FROM health_trigger_runs ORDER BY at').toArray().map(row => row.outcome)).toEqual(['proposed', 'duplicate', 'duplicate', 'duplicate']);
      // Another time for the same event is another change, and a new owner-local day starts afresh.
      expect(await run(NOW + 4 * hour, '2026-10-21', move('2026-10-21T17:00', '2026-10-21T18:00'))).toBe('proposed');
      const nextDay = Date.parse('2026-10-21T19:00:00Z'); // 00:30 on the 22nd in Kolkata
      expect(await run(nextDay, '2026-10-22', move('2026-10-22T15:00', '2026-10-22T16:00'))).toBe('proposed');
      expect([h.proposals.length, h.charged.length]).toEqual([3, 3]);
    });
  });

  it('leaves room for the question: a reason too long to carry it is refused, not trimmed', async () => {
    await withTrigger(async h => {
      ledgerTable(h.sql);
      let at = NOW;
      for (let i = 0; i < HEALTH_ASK_AFTER_SKIPS; i += 1) { await proposeOn(h, at, dayOf(at)); skip(h.sql, `p${i + 1}`, at); at += DAY_MS; }
      const long = (reason: string) => async () => JSON.stringify({ kind: 'propose', action: 'move', item: 'e1', start: localIso(at + 14_400_000, TZ), end: localIso(at + 18_000_000, TZ), title: null, notify_guests: false, reason });
      expect(await proposeOn(h, at, dayOf(at), { decide: long('x'.repeat(280)) })).toBe('invalid');
      expect(await proposeOn(h, at, dayOf(at), { decide: long('x'.repeat(200)) })).toBe('proposed');
    });
  });

  it('compares Form band to band, so a held word never reads as a change the score did not make', () => {
    // Form fell from 58 to 57 while both days' stored words held steady: no improvement and no change.
    const held = healthTriggerView({ context: { ...ROW.context, form: { ...ROW.context.form, score: 57, zone: 'good' } }, previous: { ...ROW.previous, form_score: 58 } }, NOW, TZ)!;
    expect(held.now.form).toBe('flagging');
    expect(held.before?.zones.form).toBe('flagging');
  });

  it('under auto, suggests from the first zone change: the model is told when there is no earlier day to compare with', async () => {
    expect(resolveHealthMode('auto')).toBe('live');
    expect(resolveHealthMode('live')).toBe('live');
    expect(resolveHealthMode('shadow')).toBe('shadow');
    await withTrigger(async h => {
      // Day one on a new wearable: no Recovery zone yet (its baseline has not matured) and no earlier day of its own.
      const firstDay = { context: { ...ROW.context, recovery: { reason: 'baseline_immature' } }, previous: { ...ROW.previous, basis: [{ source: 'health_connect', consent_epoch: 1 }] } };
      h.deps().book.mark('2026-10-21', NOW - 60_000);
      expect(await runHealthTrigger(h.deps({ readHealth: async () => firstDay }))).toBe('proposed');
      expect(h.prompts[0]).toContain('recovery unavailable');
      expect(h.prompts[0]).toContain('still being learned');
      expect(h.sql.exec('SELECT mode FROM health_trigger_runs').toArray()).toEqual([{ mode: 'live' }]);
    });
  });

  it('records and shows nothing in shadow, and the owner can flip it with one setting', async () => {
    await withTrigger(async h => {
      h.deps().book.mark('2026-10-21', NOW - 60_000);
      expect(await runHealthTrigger(h.deps({ modeSetting: () => 'shadow' }))).toBe('shadow_proposed');
      expect(h.proposals).toEqual([]);
      expect(h.sql.exec('SELECT mode, outcome FROM health_trigger_runs').toArray()).toEqual([{ mode: 'shadow', outcome: 'shadow_proposed' }]);
      h.deps().book.mark('2026-10-21', NOW + 1_000);
      expect(await runHealthTrigger(h.deps({ now: () => NOW + 2_000, modeSetting: () => 'live' }))).toBe('proposed');
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
      expect(deps().book.pending(NOW)).toEqual({ at: NOW - 60_000, days: ['2026-10-21'] });
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

describe('the day a change was marked on', () => {
  const rowFor = (day: string, previousDay: string, compiledAt: string) => ({ context: { ...ROW.context, day, compiled_at: compiledAt }, previous: { ...ROW.previous, day: previousDay } });

  it('lists every pending day, and takes no health row for a day nothing marked as that change', async () => {
    await withTrigger(async ({ sql, deps, prompts, proposals, logs }) => {
      const book = deps().book;
      book.mark('2026-10-20', NOW - 3 * 3_600_000);
      book.mark('2026-10-21', NOW - 60_000);
      expect(book.pending(NOW)).toEqual({ at: NOW - 60_000, days: ['2026-10-21', '2026-10-20'] });
      // The row the read returns is a day no mark names: no change was marked on it, so nothing is claimed and the model is not asked.
      const outcome = await runHealthTrigger(deps({ readHealth: async () => rowFor('2026-10-19', '2026-10-18', '2026-10-19T03:00:00Z') }));
      expect([outcome, prompts.length, proposals.length, book.pending(NOW)]).toEqual(['stale_day', 0, 0, null]);
      expect(logs.map(line => JSON.parse(line).code)).toEqual(['stale_day']);
      expect(sql.exec('SELECT * FROM health_trigger_runs').toArray()).toEqual([]);
      book.mark('2026-10-21', NOW - 30_000);
      expect(await runHealthTrigger(deps())).toBe('proposed');
    });
  });

  it('evaluates when an older mark names the row\'s day and a newer mark names another, since two zones can mark different days', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      const book = deps().book;
      // The owner's phone and the WHOOP sync can name a day in different zones: today's mark is older than tomorrow's.
      book.mark('2026-10-21', NOW - 3 * 3_600_000);
      book.mark('2026-10-22', NOW - 60_000);
      expect(await runHealthTrigger(deps({ decide: async (_id, prompt) => { prompts.push(prompt); return noOp; } }))).toBe('no_op');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('for 2026-10-21');
      expect(book.pending(NOW)).toBeNull();
    });
  });

  it('after a quiet-hours hold past midnight across a DST change, evaluates the marked day and never says it changed today', async () => {
    await withTrigger(async ({ deps, prompts, reschedules }) => {
      const zone = 'Europe/Berlin';
      const night = Date.parse('2026-03-28T22:30:00Z'); // 23:30 CET, the night before clocks spring forward
      const quiet: Proactivity = { quiet_start: '22:00', quiet_end: '07:00', volume: 'normal' };
      const row = rowFor('2026-03-28', '2026-03-27', '2026-03-28T22:00:00Z');
      deps().book.mark('2026-03-28', night - 60_000);
      expect(await runHealthTrigger(deps({ now: () => night, timezone: zone, proactivity: () => quiet, readHealth: async () => row }))).toBe('held_quiet');
      expect(reschedules).toEqual([Date.parse('2026-03-29T05:00:00Z')]); // 07:00 CEST
      const morning = reschedules[0]!;
      expect(await runHealthTrigger(deps({ now: () => morning, timezone: zone, proactivity: () => quiet, readHealth: async () => row, decide: async (_id, prompt) => { prompts.push(prompt); return noOp; } }))).toBe('no_op');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('for 2026-03-28');
      expect(prompts[0]).toContain('Now (2026-03-28, stale)');
      expect(prompts[0]).not.toMatch(/\btoday\b/);
    });
  });

  it('compares the marked day with the row\'s own day, so the zone the owner is in now does not change the answer', async () => {
    await withTrigger(async ({ deps, prompts, proposals }) => {
      // 12:00Z is already the 22nd in Kiritimati and still the 21st in Kolkata; the row and the mark both say the 21st.
      const later = Date.parse('2026-10-21T12:00:00Z');
      const noOpDecide = async (_id: string, prompt: string) => { prompts.push(prompt); return noOp; };
      deps().book.mark('2026-10-21', later - 60_000);
      expect(await runHealthTrigger(deps({ now: () => later, timezone: 'Pacific/Kiritimati', decide: noOpDecide }))).toBe('no_op');
      deps().book.mark('2026-10-22', later - 30_000);
      expect(await runHealthTrigger(deps({ now: () => later, timezone: 'Pacific/Kiritimati', decide: noOpDecide }))).toBe('stale_day');
      expect([prompts.length, proposals.length]).toEqual([1, 0]);
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

  it('checks every calendar field that reaches Google, as whole words', () => {
    const words = ['compromised', 'recovery', 'sleep'];
    expect(calendarEgressClear({ title: 'Focus block' }, words)).toBe(true);
    expect(calendarEgressClear({ title: 'Sleep in' }, words)).toBe(false);
    expect(calendarEgressClear({ title: 'Block', description: 'recovery time' }, words)).toBe(false);
    expect(calendarEgressClear({ title: 'Sleepless in Seattle screening' }, words)).toBe(true);
  });

  it('cancels only an event, and asks Google to email guests only when the model said so', () => {
    const cancel = (notify: boolean | null) => parseHealthDecision(JSON.stringify({ kind: 'propose', action: 'cancel', item: 'e1', start: null, end: null, title: null, notify_guests: notify, reason: 'Clear the morning.' }), [REVIEW], NOW, TZ);
    expect(cancel(true)).toEqual({ kind: 'propose', args: { action: 'cancel', event_id: 'gcal-review-1', reason: 'Clear the morning.', send_updates: 'all' } });
    expect(cancel(null)).toEqual({ kind: 'propose', args: { action: 'cancel', event_id: 'gcal-review-1', reason: 'Clear the morning.', send_updates: 'none' } });
  });

  it('carries the kind the model gave a new block, and refuses a kind on a move or one it does not know', () => {
    const answer = (over: Record<string, unknown>) => JSON.stringify({ kind: 'propose', action: 'create', item: null, start: '2026-10-21T15:00', end: '2026-10-21T16:00', title: 'Recharge', notify_guests: null, reason: 'Keep the afternoon light.', ...over });
    const create = (block: unknown) => parseHealthDecision(answer({ block }), [REVIEW], NOW, TZ);
    expect(create('rest')).toEqual({ kind: 'propose', args: { action: 'create', title: 'Recharge', start: '2026-10-21T09:30:00.000Z', end: '2026-10-21T10:30:00.000Z', reason: 'Keep the afternoon light.', block: 'rest' } });
    expect(create('deep_work')).toMatchObject({ args: { block: 'deep_work' } });
    // Null, and an answer written before the field existed, make an ordinary event.
    expect([create(null), parseHealthDecision(answer({}), [REVIEW], NOW, TZ)].map(d => d.kind === 'propose' && 'block' in d.args)).toEqual([false, false]);
    expect(() => create('nap')).toThrow('invalid health decision shape');
    expect(() => parseHealthDecision(answer({ action: 'move', item: 'e1', title: null, block: 'rest' }), [REVIEW], NOW, TZ)).toThrow('invalid health decision shape');
    expect(HEALTH_TRIGGER_FORMAT.schema.required).toContain('block');
    expect(HEALTH_TRIGGER_FORMAT.schema.properties.block).toEqual({ type: ['string', 'null'], enum: ['rest', 'deep_work', null] });
    expect(healthTriggerPrompt({ view: healthTriggerView(ROW, NOW, TZ)!, items: [REVIEW], now: NOW, timezone: TZ, feedback: {} })).toContain('block (rest or deep_work for a create, else null)');
  });

  it('arms the evaluation no earlier than an hour after the last one', () => {
    expect(healthTriggerDueAt(NOW, null)).toBe(NOW);
    expect(healthTriggerDueAt(NOW, NOW - 600_000)).toBe(NOW - 600_000 + HEALTH_TRIGGER_FLOOR_MS);
    expect(healthTriggerDueAt(NOW, NOW - 2 * HEALTH_TRIGGER_FLOOR_MS)).toBe(NOW);
  });
});

describe('coming decisions', () => {
  const from = NOW, to = NOW + 24 * 3_600_000;
  const event = (over: Partial<CalendarItem>): CalendarItem => ({ id: 'ev', title: 'Standup', start: '2026-10-21T05:00:00Z', end: '2026-10-21T05:15:00Z', all_day: false, ...over });
  const loop = (over: Partial<Loop>): Loop => ({ id: 'o1', title: 'Send the deck', due: '2026-10-21T18:00', status: 'open', created_at: 0, closed_at: null, ...over });

  it('takes events that overlap the next day, open tasks and own loops due by its end, in time order', async () => {
    const items = await comingItemsFrom({
      events: async () => [event({ id: 'later', start: '2026-10-21T11:00:00Z', end: '2026-10-21T12:00:00Z', attendees: 3 }), event({ id: 'soon' }), event({ id: 'gone', status: 'cancelled' }),
        event({ id: 'past', start: '2026-10-21T01:00:00Z', end: '2026-10-21T02:00:00Z' }), event({ id: 'far', start: '2026-10-23T05:00:00Z', end: '2026-10-23T06:00:00Z' })],
      tasks: async () => [{ id: 't', title: 'Return', status: 'todo', due: '2026-10-22T00:00:00.000Z' }, { id: 'd', title: 'Done', status: 'done', due: '2026-10-21' }, { id: 'n', title: 'Someday', status: 'todo' }, { id: 'f', title: 'Next week', status: 'todo', due: '2026-10-29' }] as TaskItem[],
      loops: () => [loop({}), loop({ id: 'o2', source_ref: 'mail:1', title: 'From an email' }), loop({ id: 'o3', due: '2026-10-25T09:00' }), loop({ id: 'o4', due: null })],
    }, from, to, TZ);
    expect(items.map(item => [item.kind, item.id])).toEqual([['event', 'soon'], ['event', 'later'], ['task', 't'], ['loop', 'o1']]);
    expect(items[1]).toMatchObject({ guests: 3 });
  });

  it('fails when the calendar cannot be read, and shrugs off tasks it cannot read', async () => {
    await expect(comingItemsFrom({ events: async () => { throw new Error('calendar 503'); }, tasks: null, loops: () => [] }, from, to, TZ)).rejects.toThrow('calendar 503');
    expect(await comingItemsFrom({ events: null, tasks: async () => { throw new Error('no tasks grant'); }, loops: () => [loop({})] }, from, to, TZ)).toEqual([{ kind: 'loop', id: 'o1', title: 'Send the deck', due: '2026-10-21T18:00' }]);
  });
});

describe('the health card budget', () => {
  it('admits a card on a day with interruptions left, charges it once, and has the next wait out the cooldown', async () => {
    await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`health-budget-${sequence++}`)), async (_instance, state) => {
      ensureSchema(state.storage);
      let now = NOW;
      const budget = healthCardBudget(new DeliveryGateStore(state.storage.sql), 'owner-1', TZ, () => now);
      expect(budget.admit('health:2026-10-21')).toEqual({ verdict: 'send' });
      budget.charge('health:2026-10-21');
      const booked = now;
      now += 10 * 60_000;
      expect(budget.admit('health:2026-10-21')).toEqual({ verdict: 'wait', until: booked + 60 * 60_000 });
    });
  });
});

describe('telling the app a health card is up', () => {
  const dayOfNow = () => localIso(NOW, TZ).slice(0, 10);
  const mark = (h: Harness, at = NOW) => h.deps().book.mark(dayOfNow(), at - 60_000);
  const notifying = () => { const told: string[] = []; return { told, notify: async (id: string) => { told.push(id); } }; };

  it('tells the app once, with the approval id, after the card is up and its budget booked', async () => {
    await withTrigger(async h => {
      const { told, notify } = notifying();
      mark(h);
      expect(await runHealthTrigger(h.deps({ notify, charge: key => { h.charged.push(key); expect(told).toEqual([]); } }))).toBe('proposed');
      expect(told).toEqual(['p1']);
      expect(h.charged).toEqual(['health:2026-10-21']);
    });
  });

  it('stays silent whenever no card goes up: no consent, nothing coming, no_op, quiet hours, the gate, shadow, a refused title, an off switch', async () => {
    const quiet: Proactivity = { quiet_start: '07:00', quiet_end: '12:00', volume: 'normal' };
    const create = (title: string) => async () => JSON.stringify({ kind: 'propose', action: 'create', item: null, start: '2026-10-21T15:00', end: '2026-10-21T16:00', title, notify_guests: null, reason: 'Protect an hour.' });
    const scenarios: readonly (readonly [HealthTriggerOutcome, Partial<HealthTriggerDeps>])[] = [
      ['no_health', { readHealth: async () => null }],
      ['nothing_coming', { comingItems: async () => [] }],
      ['no_op', { decide: async () => noOp }],
      ['held_quiet', { proactivity: () => quiet }],
      ['budget_gate', { admit: () => ({ verdict: 'spent' }) }],
      ['held_cooldown', { admit: () => ({ verdict: 'wait', until: NOW + HEALTH_TRIGGER_FLOOR_MS }) }],
      ['shadow_proposed', { modeSetting: () => 'shadow' }],
      ['egress_refused', { decide: create('Recovery block') }],
      ['invalid', { decide: async () => 'not json' }],
      ['opted_out', { enabled: () => false }],
    ];
    for (const [outcome, over] of scenarios) {
      await withTrigger(async h => {
        const { told, notify } = notifying();
        mark(h);
        expect([outcome, await runHealthTrigger(h.deps({ ...over, notify }))]).toEqual([outcome, outcome]);
        expect([outcome, told]).toEqual([outcome, []]);
      });
    }
  });

  it('stays silent for a run with nothing pending and for a change already waiting on its card', async () => {
    await withTrigger(async h => {
      h.sql.exec('CREATE TABLE ledger (id TEXT PRIMARY KEY, kind TEXT, status TEXT, summary TEXT, payload_json TEXT, undo_json TEXT, created_at INTEGER, decided_at INTEGER, deferred_at INTEGER)');
      const { told, notify } = notifying();
      const propose = async (args: ProposeCalendarChangeArgs) => {
        h.sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at) VALUES ('p1', 'calendar_change', 'card_unconfirmed', 's', ?, ?)", JSON.stringify({ ...args, account: 'owner@example.test', operation_ref: 'health:x', time_zone: TZ }), NOW);
        return 'p1';
      };
      expect(await runHealthTrigger(h.deps({ notify, propose }))).toBe('idle');
      mark(h);
      expect(await runHealthTrigger(h.deps({ notify, propose }))).toBe('proposed');
      mark(h, NOW + 1_000);
      expect(await runHealthTrigger(h.deps({ notify, propose, now: () => NOW + 1_000 }))).toBe('duplicate');
      expect(told).toEqual(['p1']);
    });
  });

  const LEDGER = 'CREATE TABLE ledger (id TEXT PRIMARY KEY, kind TEXT, status TEXT, summary TEXT, payload_json TEXT, undo_json TEXT, created_at INTEGER, decided_at INTEGER, deferred_at INTEGER)';
  const waiting = (h: Harness, cards: { n: number }) => async (args: ProposeCalendarChangeArgs) => {
    const id = `p${++cards.n}`;
    h.sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at) VALUES (?, 'calendar_change', 'card_unconfirmed', 's', ?, ?)", id, JSON.stringify({ ...args, account: 'owner@example.test', operation_ref: 'health:x', time_zone: TZ }), NOW);
    return id;
  };
  const recorded = (h: Harness) => h.sql.exec<{ outcome: string; approval_id: string | null }>('SELECT outcome, approval_id FROM health_trigger_runs').toArray();

  it('records the run and clears the mark before it tells the app, so nothing the push does can lose the run', async () => {
    await withTrigger(async h => {
      mark(h);
      const seen: unknown[] = [];
      const notify = async () => { seen.push([recorded(h), h.deps().book.pending(NOW)]); };
      expect(await runHealthTrigger(h.deps({ notify }))).toBe('proposed');
      expect(seen).toEqual([[[{ outcome: 'proposed', approval_id: 'p1' }], null]]);
    });
  });

  it('a push that hangs leaves the run recorded and the mark cleared', async () => {
    await withTrigger(async h => {
      mark(h);
      let reached!: () => void;
      const called = new Promise<void>(resolve => { reached = resolve; });
      void runHealthTrigger(h.deps({ notify: () => { reached(); return new Promise<void>(() => undefined); } }));
      await called;
      expect(recorded(h)).toEqual([{ outcome: 'proposed', approval_id: 'p1' }]);
      expect(h.deps().book.pending(NOW)).toBeNull();
    });
  });

  it('a push that throws never fails the run, and the next run puts up no second card and sends no second push', async () => {
    await withTrigger(async h => {
      h.sql.exec(LEDGER);
      const cards = { n: 0 }, propose = waiting(h, cards), told: string[] = [];
      const notify = async (id: string) => { told.push(id); throw new Error('push directory unavailable'); };
      mark(h);
      expect(await runHealthTrigger(h.deps({ notify, propose }))).toBe('proposed');
      expect(h.charged).toEqual(['health:2026-10-21']);
      expect(h.reschedules).toEqual([]);
      mark(h, NOW + 1_000);
      expect(await runHealthTrigger(h.deps({ notify, propose, now: () => NOW + 1_000 }))).toBe('duplicate');
      expect([cards.n, told, recorded(h).map(row => row.outcome)]).toEqual([1, ['p1'], ['proposed', 'duplicate']]);
    });
  });

  it('a throwing re-arm after a run that landed is logged as a failure and never thrown, so the scheduler does not retry before the floor', async () => {
    await withTrigger(async h => {
      const book = h.deps().book;
      book.mark('2026-10-21', NOW - 60_000);
      const decide = async () => { book.mark('2026-10-21', NOW + 5_000); return noOp; };
      await expect(runHealthTrigger(h.deps({ decide, reschedule: async () => { throw new Error('scheduler unavailable'); } }))).resolves.toBe('no_op');
      expect(h.logs.at(-1)).toContain('"code":"failed"');
    });
  });
});
