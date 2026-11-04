import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ProposeCalendarChangeArgs } from '@waldo/contracts';
import type { Proactivity } from '../src/channels/loops';
import { DeliveryGateStore } from '../src/delivery-gate/store';
import { ensureSchema } from '../src/tracer/schema';
import { healthCardBudget, healthTriggerBook, healthTriggerPrompt, healthTriggerView, runHealthTrigger, HEALTH_TRIGGER_FLOOR_MS, HEALTH_TRIGGER_PENDING_TTL_MS, type ComingItem, type HealthTriggerDeps } from '../src/health/trigger';
import type { HealthWakeReason } from '../src/health/wakes';

// The wake reasons beyond a zone change, through the one trigger path: the model still answers propose or no_op, and the
// consent read, quiet hours, cooldown, budget, same-day duplicate refusal and egress check still decide whether a card
// goes up. Synthetic values only; none may be found in a prompt, a log line, a table or a proposal.
const LEAKS = ['47.3', '37.9', '61.4', '52.6', '183.5'];
const TZ = 'Asia/Kolkata';
const NOW = Date.parse('2026-10-21T03:30:00Z'); // 09:00 in Kolkata
const DAY = '2026-10-21';
const ROW = {
  context: {
    id: 'ctx-1', day: DAY, compiled_at: '2026-10-21T03:00:00Z', basis: [{ source: 'whoop', consent_epoch: 3 }], drivers: ['wrist temperature above usual', 'breathing rate far below usual'],
    recovery: { score: 47.3, zone: 'low', algorithm_version: 'recovery.candidate.v1', activation: 'candidate_unaccepted' },
    form: { score: 37.9, zone: 'low', algorithm_version: 'form.candidate.v3', activation: 'candidate_unaccepted' },
    weight: { score: 61.4, zone: 'high', algorithm_version: 'weight.candidate.v3', activation: 'candidate_unaccepted' },
  },
  previous: { day: '2026-10-20', form_score: 52.6, recovery_zone: 'good', weight_zone: 'moderate', basis: [{ source: 'whoop', consent_epoch: 3 }] },
};
const REVIEW: ComingItem = { kind: 'event', id: 'gcal-review-1', title: 'Quarterly board review', start: '2026-10-21T05:30:00Z', end: '2026-10-21T07:00:00Z', guests: 6 };
const NO_QUIET: Proactivity = { quiet_start: null, quiet_end: null, volume: 'normal' };
const move = JSON.stringify({ kind: 'propose', action: 'move', item: 'e1', start: '2026-10-21T13:00', end: '2026-10-21T14:30', title: null, block: null, notify_guests: true, reason: 'A later slot gives you a slower morning.' });
const block = (title: string) => JSON.stringify({ kind: 'propose', action: 'create', item: null, start: '2026-10-21T13:00', end: '2026-10-21T14:00', title, block: 'rest', notify_guests: null, reason: 'A pause before the review.' });
const noOp = JSON.stringify({ kind: 'no_op', action: null, item: null, start: null, end: null, title: null, notify_guests: null, reason: '' });

const SENTENCES: Readonly<Record<Exclude<HealthWakeReason, 'zone_change'>, string>> = {
  sleep_debt_building: 'Sleep debt has been building over the last few days.',
  driver_appeared: 'A signal is outside the owner\'s usual range that was not at the last reading.',
  driver_far: 'A signal that was already outside the owner\'s usual range has moved far outside it.',
  load_jump: 'Load moved by more than a steady amount since the last reading, inside the same zone.',
};

let sequence = 0;
type Harness = Readonly<{ sql: SqlStorage; storage: DurableObjectStorage; deps: (over?: Partial<HealthTriggerDeps>) => HealthTriggerDeps; prompts: string[]; proposals: ProposeCalendarChangeArgs[]; reschedules: number[]; charged: string[]; logs: string[]; reads: () => number }>;
const withTrigger = <T>(work: (h: Harness) => Promise<T>) => runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`health-trigger-wakes-${sequence++}`)), async (_instance, state) => {
  const sql = state.storage.sql;
  const book = healthTriggerBook(sql);
  const prompts: string[] = [], proposals: ProposeCalendarChangeArgs[] = [], reschedules: number[] = [], charged: string[] = [], logs: string[] = [];
  let ids = 0, reads = 0;
  const deps = (over: Partial<HealthTriggerDeps> = {}): HealthTriggerDeps => ({
    book, now: () => NOW, newId: () => `r${++ids}`, timezone: TZ, enabled: () => true, proactivity: () => NO_QUIET, modeSetting: () => 'auto',
    readHealth: async () => { reads += 1; return ROW; }, comingItems: async () => [REVIEW],
    admit: () => ({ verdict: 'send' }), charge: key => { charged.push(key); },
    decide: async (_id, prompt) => { prompts.push(prompt); return move; },
    propose: async args => { proposals.push(args); return `p${proposals.length}`; },
    reschedule: async at => { reschedules.push(at); }, log: line => { logs.push(JSON.stringify(line)); },
    ...over,
  });
  return work({ sql, storage: state.storage, deps, prompts, proposals, reschedules, charged, logs, reads: () => reads });
});
const everything = (sql: SqlStorage) => JSON.stringify([
  sql.exec('SELECT * FROM health_trigger_runs').toArray(), sql.exec('SELECT * FROM health_trigger_pending').toArray(), sql.exec('SELECT * FROM health_trigger_wakes').toArray(),
]);

describe('what the book keeps about a wake', () => {
  it('marks a wake once a day, however many uploads find it, and a new local day is a new wake', async () => {
    await withTrigger(async ({ deps }) => {
      const book = deps().book;
      expect(book.markOnce(DAY, NOW, 'sleep_debt_building')).toBe(true);
      expect(book.markOnce(DAY, NOW + 60_000, 'sleep_debt_building')).toBe(false);
      expect(book.markOnce(DAY, NOW + 60_000, 'driver_appeared')).toBe(true);
      expect(book.markOnce('2026-10-22', NOW + 60_000, 'sleep_debt_building')).toBe(true);
      expect(book.pending(NOW + 60_000)).toMatchObject({ days: ['2026-10-22', DAY] });
    });
  });

  it('still refuses a wake that was already taken by an evaluation, so a later upload the same day does not wake again', async () => {
    await withTrigger(async ({ deps }) => {
      const book = deps().book;
      book.markOnce(DAY, NOW - 60_000, 'driver_far');
      expect(await runHealthTrigger(deps({ decide: async () => noOp }))).toBe('no_op');
      expect(book.pending(NOW)).toBeNull();
      expect(book.markOnce(DAY, NOW + 60_000, 'driver_far')).toBe(false);
      expect(book.pending(NOW + 60_000)).toBeNull();
    });
  });

  it('forgets the wakes of days long gone', async () => {
    await withTrigger(async ({ deps, sql }) => {
      const book = deps().book;
      book.markOnce('2026-10-10', NOW - 11 * 86_400_000, 'load_jump');
      book.markOnce(DAY, NOW, 'load_jump');
      expect(sql.exec('SELECT day FROM health_trigger_wakes').toArray()).toEqual([{ day: DAY }]);
    });
  });

  it('keeps nothing but days, codes and times', async () => {
    await withTrigger(async ({ deps, sql }) => {
      const book = deps().book;
      for (const reason of ['sleep_debt_building', 'driver_appeared', 'driver_far', 'load_jump'] as const) book.markOnce(DAY, NOW, reason);
      expect(sql.exec('SELECT name FROM pragma_table_info(\'health_trigger_wakes\') ORDER BY cid').toArray().map(column => column.name)).toEqual(['day', 'reason', 'at', 'taken']);
      expect(sql.exec('SELECT DISTINCT reason FROM health_trigger_wakes ORDER BY reason').toArray().map(row => row.reason)).toEqual(['driver_appeared', 'driver_far', 'load_jump', 'sleep_debt_building']);
    });
  });
});

describe('what the model is told', () => {
  it('says each reason in words, with no number, and keeps a zone-only prompt as it was', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      deps().book.mark(DAY, NOW - 60_000);
      await runHealthTrigger(deps({ decide: async (_id, prompt) => { prompts.push(prompt); return noOp; } }));
      expect(prompts[0]).toContain(`The owner's derived health state for ${DAY} (owner-local day) moved zone.`);
      for (const sentence of Object.values(SENTENCES)) expect(prompts[0]).not.toContain(sentence);
      expect(prompts[0]).not.toContain('Signals outside');
    });
    for (const [reason, sentence] of Object.entries(SENTENCES)) {
      await withTrigger(async ({ deps, prompts }) => {
        deps().book.markOnce(DAY, NOW - 60_000, reason as HealthWakeReason);
        await runHealthTrigger(deps({ decide: async (_id, prompt) => { prompts.push(prompt); return noOp; } }));
        expect(prompts[0], reason).toContain(sentence);
        expect(prompts[0], reason).toContain(`The owner's derived health state for ${DAY} (owner-local day) changed since the last reading.`);
        expect(prompts[0], reason).not.toContain('moved zone');
        expect(prompts[0], reason).toContain('Now (2026-10-21, fresh): recovery compromised, form depleted, load peak.');
        for (const leak of LEAKS) expect(prompts[0], reason).not.toContain(leak);
      });
    }
  });

  it('names the signals outside the usual range only when a driver woke it', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      deps().book.markOnce(DAY, NOW - 60_000, 'driver_appeared');
      await runHealthTrigger(deps({ decide: async (_id, prompt) => { prompts.push(prompt); return noOp; } }));
      expect(prompts[0]).toContain('Signals outside the owner\'s usual range now: wrist temperature above usual; breathing rate far below usual.');
    });
    await withTrigger(async ({ deps, prompts }) => {
      deps().book.markOnce(DAY, NOW - 60_000, 'sleep_debt_building');
      await runHealthTrigger(deps({ decide: async (_id, prompt) => { prompts.push(prompt); return noOp; } }));
      expect(prompts[0]).not.toContain('wrist temperature');
    });
  });

  it('lists every reason that is waiting, a zone change among them', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      const book = deps().book;
      book.mark(DAY, NOW - 120_000);
      book.markOnce(DAY, NOW - 90_000, 'sleep_debt_building');
      book.markOnce(DAY, NOW - 60_000, 'load_jump');
      await runHealthTrigger(deps({ decide: async (_id, prompt) => { prompts.push(prompt); return noOp; } }));
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('moved zone.');
      expect(prompts[0]).toContain(SENTENCES.sleep_debt_building);
      expect(prompts[0]).toContain(SENTENCES.load_jump);
    });
  });

  it('leaves out a wake that is older than the change window', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      const book = deps().book;
      book.markOnce(DAY, NOW - HEALTH_TRIGGER_PENDING_TTL_MS - 60_000, 'driver_far');
      book.mark(DAY, NOW - 60_000);
      await runHealthTrigger(deps({ decide: async (_id, prompt) => { prompts.push(prompt); return noOp; } }));
      expect(prompts[0]).toContain('moved zone.');
      expect(prompts[0]).not.toContain(SENTENCES.driver_far);
    });
  });

  it('leaves out a wake that an earlier evaluation already took', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      const book = deps().book;
      book.markOnce(DAY, NOW - 120_000, 'driver_far');
      await runHealthTrigger(deps({ decide: async (_id, prompt) => { prompts.push(prompt); return noOp; } }));
      book.mark(DAY, NOW + 60_000);
      await runHealthTrigger(deps({ now: () => NOW + 120_000, decide: async (_id, prompt) => { prompts.push(prompt); return noOp; } }));
      expect(prompts[0]).toContain(SENTENCES.driver_far);
      expect(prompts[1]).toContain('moved zone.');
      expect(prompts[1]).not.toContain(SENTENCES.driver_far);
    });
  });

  it('reads the row\'s drivers only as the closed phrases, and a row without any as having none', () => {
    const view = (drivers: unknown) => healthTriggerView({ ...ROW, context: { ...ROW.context, drivers } }, NOW, TZ)!;
    expect(view(['breathing rate above usual', 'mood far above usual', 4, null]).drivers).toEqual(['breathing rate above usual']);
    for (const bad of [undefined, null, 'breathing rate above usual', {}]) expect(view(bad).drivers, String(bad)).toEqual([]);
  });

  it('shows a driver wake with no drivers on the row as the plain reason, with no empty list', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      deps().book.markOnce(DAY, NOW - 60_000, 'driver_appeared');
      await runHealthTrigger(deps({ readHealth: async () => ({ ...ROW, context: { ...ROW.context, drivers: undefined } }), decide: async (_id, prompt) => { prompts.push(prompt); return noOp; } }));
      expect(prompts[0]).toContain(SENTENCES.driver_appeared);
      expect(prompts[0]).not.toContain('Signals outside');
    });
  });

  it('is built from the view alone, with the reasons the run read', () => {
    const view = healthTriggerView(ROW, NOW, TZ)!;
    const text = healthTriggerPrompt({ view, items: [REVIEW], now: NOW, timezone: TZ, feedback: {}, reasons: ['sleep_debt_building'] });
    expect(text).toContain(SENTENCES.sleep_debt_building);
    expect(healthTriggerPrompt({ view, items: [REVIEW], now: NOW, timezone: TZ, feedback: {} })).toContain('moved zone.');
  });
});

describe('the same gates as a zone change', () => {
  it('turns one wake and a coming meeting into one approval card, charged to the day\'s budget, with the model deciding', async () => {
    await withTrigger(async ({ deps, proposals, charged, sql, prompts, logs }) => {
      deps().book.markOnce(DAY, NOW - 60_000, 'sleep_debt_building');
      expect(await runHealthTrigger(deps())).toBe('proposed');
      expect(proposals).toHaveLength(1);
      expect(charged).toEqual([`health:${DAY}`]);
      expect(sql.exec('SELECT outcome FROM health_trigger_runs').toArray()).toEqual([{ outcome: 'proposed' }]);
      for (const leak of LEAKS) for (const text of [...prompts, ...logs, everything(sql), JSON.stringify(proposals)]) expect(text).not.toContain(leak);
    });
  });

  it('lets the model answer no_op, and then proposes nothing and charges nothing', async () => {
    await withTrigger(async ({ deps, proposals, charged }) => {
      deps().book.markOnce(DAY, NOW - 60_000, 'driver_appeared');
      expect(await runHealthTrigger(deps({ decide: async () => noOp }))).toBe('no_op');
      expect([proposals.length, charged.length]).toEqual([0, 0]);
    });
  });

  it('is silent when model-use consent is withdrawn: nothing is read into a prompt and the wake is dropped', async () => {
    await withTrigger(async ({ deps, prompts, proposals, sql }) => {
      deps().book.markOnce(DAY, NOW - 60_000, 'sleep_debt_building');
      expect(await runHealthTrigger(deps({ readHealth: async () => null }))).toBe('no_health');
      expect([prompts.length, proposals.length, deps().book.pending(NOW)]).toEqual([0, 0, null]);
      expect(sql.exec('SELECT taken FROM health_trigger_wakes').toArray()).toEqual([{ taken: 1 }]);
    });
  });

  it('is silent for a row with every pillar missing, and for a row that names another day than the wake', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      deps().book.markOnce(DAY, NOW - 60_000, 'sleep_debt_building');
      const missing = { ...ROW, context: { ...ROW.context, recovery: { reason: 'missing_sleep' }, form: { reason: 'missing_sleep' }, weight: { reason: 'missing_sleep' } } };
      expect(await runHealthTrigger(deps({ readHealth: async () => missing }))).toBe('no_health');
      deps().book.markOnce('2026-10-20', NOW - 60_000, 'driver_far');
      expect(await runHealthTrigger(deps())).toBe('stale_day');
      expect(prompts).toEqual([]);
    });
  });

  it('opts out when the owner has turned health proposals off, and drops the wake', async () => {
    await withTrigger(async ({ deps, prompts, sql }) => {
      deps().book.markOnce(DAY, NOW - 60_000, 'load_jump');
      expect(await runHealthTrigger(deps({ enabled: () => false }))).toBe('opted_out');
      expect([prompts.length, deps().book.pending(NOW)]).toEqual([0, null]);
      expect(sql.exec('SELECT taken FROM health_trigger_wakes').toArray()).toEqual([{ taken: 1 }]);
    });
  });

  it('waits out the delivery gate\'s cooldown with the wake kept, then asks once with its reason', async () => {
    await withTrigger(async h => {
      ensureSchema(h.storage);
      let clock = NOW;
      const budget = healthCardBudget(new DeliveryGateStore(h.sql), 'owner-1', TZ, () => clock);
      // The model takes a few seconds, so the card is booked after the run started.
      const decide = (answer: string) => async (_id: string, prompt: string) => { h.prompts.push(prompt); clock += 5_000; return answer; };
      const run = (answer: string) => runHealthTrigger(h.deps({ now: () => clock, admit: budget.admit, charge: budget.charge, decide: decide(answer) }));
      h.deps().book.markOnce(DAY, clock - 60_000, 'sleep_debt_building');
      expect(await run(move)).toBe('proposed');
      h.deps().book.markOnce(DAY, clock, 'driver_appeared');
      clock = NOW + HEALTH_TRIGGER_FLOOR_MS;
      expect(await run(move)).toBe('held_cooldown');
      expect(h.prompts).toHaveLength(1);
      expect(h.reschedules).toHaveLength(1);
      expect(h.deps().book.pending(clock)).not.toBeNull();
      clock = h.reschedules[0]!;
      expect(await run(block('Focus block'))).toBe('proposed');
      expect(h.prompts).toHaveLength(2);
      expect(h.prompts[1]).toContain(SENTENCES.driver_appeared);
      expect(h.prompts[1]).not.toContain(SENTENCES.sleep_debt_building);
    });
  });

  it('spends the day\'s budget the same way: no model call once none is left', async () => {
    await withTrigger(async ({ deps, prompts }) => {
      deps().book.markOnce(DAY, NOW - 60_000, 'load_jump');
      expect(await runHealthTrigger(deps({ admit: () => ({ verdict: 'spent' }) }))).toBe('budget_gate');
      expect(prompts).toEqual([]);
    });
  });

  it('holds through quiet hours with the wake kept', async () => {
    await withTrigger(async ({ deps, prompts, reschedules }) => {
      deps().book.markOnce(DAY, NOW - 60_000, 'driver_far');
      const quiet: Proactivity = { quiet_start: '08:00', quiet_end: '10:00', volume: 'normal' };
      expect(await runHealthTrigger(deps({ proactivity: () => quiet }))).toBe('held_quiet');
      expect([prompts.length, reschedules.length, deps().book.pending(NOW) === null]).toEqual([0, 1, false]);
    });
  });

  it('refuses, uncharged, a change it already put up that day while the owner is deciding, whichever wake asked for it', async () => {
    await withTrigger(async h => {
      h.sql.exec('CREATE TABLE ledger (id TEXT PRIMARY KEY, kind TEXT, status TEXT, summary TEXT, payload_json TEXT, undo_json TEXT, created_at INTEGER, decided_at INTEGER, deferred_at INTEGER)');
      const propose = async (args: ProposeCalendarChangeArgs) => {
        h.proposals.push(args);
        h.sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at) VALUES (?, 'calendar_change', 'card_unconfirmed', 's', ?, ?)", `p${h.proposals.length}`, JSON.stringify(args), NOW);
        return `p${h.proposals.length}`;
      };
      h.deps().book.markOnce(DAY, NOW - 60_000, 'sleep_debt_building');
      expect(await runHealthTrigger(h.deps({ propose }))).toBe('proposed');
      const later = NOW + HEALTH_TRIGGER_FLOOR_MS;
      h.deps().book.markOnce(DAY, later - 60_000, 'driver_appeared');
      expect(await runHealthTrigger(h.deps({ now: () => later, propose }))).toBe('duplicate');
      expect([h.proposals.length, h.charged.length]).toEqual([1, 1]);
    });
  });

  it('keeps health words out of a block\'s title that goes to Google, a driver\'s subject among them', async () => {
    await withTrigger(async ({ deps, proposals, sql }) => {
      deps().book.markOnce(DAY, NOW - 60_000, 'driver_appeared');
      expect(await runHealthTrigger(deps({ decide: async () => block('Wrist temperature break') }))).toBe('egress_refused');
      expect(proposals).toEqual([]);
      deps().book.markOnce(DAY, NOW + 1, 'driver_far');
      expect(await runHealthTrigger(deps({ now: () => NOW + 2, decide: async () => block('Breathing rate pause') }))).toBe('egress_refused');
      deps().book.markOnce('2026-10-21', NOW + 3, 'load_jump');
      expect(await runHealthTrigger(deps({ now: () => NOW + 4, decide: async () => block('Focus block') }))).toBe('proposed');
      expect(sql.exec('SELECT outcome FROM health_trigger_runs ORDER BY at').toArray().map(row => row.outcome)).toEqual(['egress_refused', 'egress_refused', 'proposed']);
    });
  });

  it('runs in shadow as it does for a zone change: the model is asked, nothing goes up', async () => {
    await withTrigger(async ({ deps, proposals, charged }) => {
      deps().book.markOnce(DAY, NOW - 60_000, 'sleep_debt_building');
      expect(await runHealthTrigger(deps({ modeSetting: () => 'shadow' }))).toBe('shadow_proposed');
      expect([proposals.length, charged.length]).toEqual([0, 0]);
    });
  });
});
