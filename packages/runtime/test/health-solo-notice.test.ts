import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Proactivity } from '../src/channels/loops';
import {
  healthNoticeId, healthNoticePrompt, healthTriggerBook, healthTriggerView, parseHealthNotice, runHealthTrigger,
  HEALTH_NOTICE_FORMAT, HEALTH_TRIGGER_FLOOR_MS, type HealthTriggerDeps,
} from '../src/health/trigger';

// The health trigger on a day with nothing on the owner's plate. With HEALTH_SOLO_NOTICE on, the model decides whether one
// short note is worth sending now, and a note goes out as an update card under the same budget, quiet hours and update-card
// preferences as every other. Every reading is synthetic and distinctive, so finding one anywhere is a leak.
const LEAKS = ['47.3', '37.9', '61.4', '52.6'];
const TZ = 'Asia/Kolkata';
const NOW = Date.parse('2026-10-21T03:30:00Z'); // 09:00 in Kolkata
const DAY = '2026-10-21';
const ROW = {
  context: {
    id: 'ctx-1', day: DAY, compiled_at: '2026-10-21T03:00:00Z', basis: [{ source: 'whoop', consent_epoch: 3 }], drivers: ['breathing rate above usual'],
    recovery: { score: 47.3, zone: 'low', algorithm_version: 'recovery.candidate.v1', activation: 'candidate_unaccepted' },
    form: { score: 37.9, zone: 'low', algorithm_version: 'form.candidate.v3', activation: 'candidate_unaccepted' },
    weight: { score: 61.4, zone: 'high', algorithm_version: 'weight.candidate.v3', activation: 'candidate_unaccepted' },
  },
  previous: { day: '2026-10-20', form_score: 52.6, recovery_zone: 'good', weight_zone: 'moderate', basis: [{ source: 'whoop', consent_epoch: 3 }] },
};
const NO_QUIET: Proactivity = { quiet_start: null, quiet_end: null, volume: 'normal' };
const LINE = 'Update\nRecovery is compromised after a short night. With nothing booked today, an easy evening and an early night would help.';
const note = (text = LINE) => JSON.stringify({ kind: 'notice', text });
const quiet = JSON.stringify({ kind: 'no_op', text: '' });

type Delivered = Readonly<{ id: string; text: string }>;
type Harness = Readonly<{
  sql: SqlStorage; deps: (over?: Partial<HealthTriggerDeps>, notice?: Partial<NonNullable<HealthTriggerDeps['soloNotice']>>) => HealthTriggerDeps;
  prompts: string[]; formats: string[]; delivered: Delivered[]; charged: string[]; reschedules: number[]; logs: string[];
}>;
let sequence = 0;
const withNotice = <T>(work: (h: Harness) => Promise<T>) => runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`health-notice-${sequence++}`)), async (_instance, state) => {
  const sql = state.storage.sql;
  const book = healthTriggerBook(sql);
  const prompts: string[] = [], formats: string[] = [], delivered: Delivered[] = [], charged: string[] = [], reschedules: number[] = [], logs: string[] = [];
  let ids = 0;
  const deps: Harness['deps'] = (over = {}, notice = {}) => ({
    book, now: () => NOW, newId: () => `r${++ids}`, timezone: TZ, enabled: () => true, proactivity: () => NO_QUIET, modeSetting: () => 'auto',
    readHealth: async () => ROW, comingItems: async () => [],
    admit: () => ({ verdict: 'send' }), charge: key => { charged.push(key); },
    decide: async (_id, prompt, format) => { prompts.push(prompt); formats.push(format?.name ?? 'health_proposal'); return note(); },
    propose: async () => { throw new Error('a health-only day proposes no calendar change'); },
    reschedule: async at => { reschedules.push(at); },
    log: line => { logs.push(JSON.stringify(line)); },
    soloNotice: {
      enabled: () => true, held: () => null,
      // As the owner object does it: the outbox write and the commit land together.
      deliver: async (id, text, commit) => { delivered.push({ id, text }); commit(); },
      ...notice,
    },
    ...over,
  });
  book.mark(DAY, NOW - 60_000);
  return work({ sql, deps, prompts, formats, delivered, charged, reschedules, logs });
});
const runs = (sql: SqlStorage) => sql.exec<{ local_day: string; mode: string; outcome: string }>('SELECT local_day, mode, outcome FROM health_trigger_runs ORDER BY at, rowid').toArray();
const everything = (sql: SqlStorage) => JSON.stringify([sql.exec('SELECT * FROM health_trigger_runs').toArray(), sql.exec('SELECT * FROM health_trigger_pending').toArray(), sql.exec('SELECT * FROM health_trigger_wakes').toArray()]);

describe('the health trigger on a day with nothing coming', () => {
  it('with the switch off, stays silent exactly as before: nothing_coming and no model call', async () => {
    await withNotice(async ({ sql, deps, prompts, delivered }) => {
      expect(await runHealthTrigger(deps({}, { enabled: () => false }))).toBe('nothing_coming');
      expect([prompts.length, delivered.length, runs(sql).length]).toEqual([0, 0, 0]);
      expect(deps().book.pending(NOW)).toBeNull();
    });
    await withNotice(async ({ deps, prompts }) => {
      expect(await runHealthTrigger(deps({ soloNotice: undefined }))).toBe('nothing_coming');
      expect(prompts).toEqual([]);
    });
  });

  it('asks the model whether a note is worth it and sends the one it writes as an update card, in zone words only', async () => {
    await withNotice(async ({ sql, deps, prompts, formats, delivered, charged, logs }) => {
      expect(await runHealthTrigger(deps())).toBe('noticed');
      expect(formats).toEqual([HEALTH_NOTICE_FORMAT.name]);
      expect(prompts[0]).toContain('Now (2026-10-21, fresh): recovery compromised, form depleted, load peak.');
      expect(prompts[0]).toContain('Before (2026-10-20): recovery solid, form flagging, load moderate.');
      expect(prompts[0]).toContain('Nothing is on the owner\'s calendar, tasks or open loops in the next 24 hours.');
      expect(delivered).toEqual([{ id: healthNoticeId(DAY), text: LINE }]);
      expect(charged).toEqual([`health:${DAY}`]);
      expect(runs(sql)).toEqual([{ local_day: DAY, mode: 'live', outcome: 'noticed' }]);
      expect(deps().book.pending(NOW)).toBeNull();
      for (const leak of LEAKS) for (const text of [...prompts, ...logs, everything(sql), JSON.stringify(delivered)]) expect(text).not.toContain(leak);
      // The run's bookkeeping stays value-free: the note's words reach the outbox and nowhere in the trigger's own tables.
      expect(everything(sql)).not.toContain('compromised');
    });
  });

  it('sends nothing, and spends nothing, when the model judges the change is not worth a note', async () => {
    await withNotice(async ({ sql, deps, delivered, charged }) => {
      expect(await runHealthTrigger(deps({ decide: async () => quiet }))).toBe('no_op');
      expect([delivered, charged]).toEqual([[], []]);
      expect(runs(sql).map(run => run.outcome)).toEqual(['no_op']);
    });
  });

  it('goes silent when health sharing is revoked or never given: no model call, no note', async () => {
    for (const health of [null, { context: null, previous: null }]) {
      await withNotice(async ({ deps, prompts, delivered }) => {
        expect(await runHealthTrigger(deps({ readHealth: async () => health }))).toBe('no_health');
        expect([prompts.length, delivered.length, deps().book.pending(NOW)]).toEqual([0, 0, null]);
      });
    }
  });

  it('in shadow mode asks the model and records what it would have said, but sends and spends nothing', async () => {
    await withNotice(async ({ sql, deps, prompts, delivered, charged }) => {
      expect(await runHealthTrigger(deps({ modeSetting: () => 'shadow' }))).toBe('shadow_noticed');
      expect([prompts.length, delivered.length, charged.length]).toEqual([1, 0, 0]);
      expect(runs(sql)).toEqual([{ local_day: DAY, mode: 'shadow', outcome: 'shadow_noticed' }]);
    });
  });

  it('holds when an update card could not go out now (preference off, Close sent, low volume, outside the window), before any model call', async () => {
    for (const gate of ['held_preference', 'held_closed', 'held_volume', 'held_window']) {
      await withNotice(async ({ sql, deps, prompts, delivered }) => {
        expect(await runHealthTrigger(deps({}, { held: () => gate }))).toBe('notice_held');
        expect([prompts.length, delivered.length]).toEqual([0, 0]);
        expect(runs(sql).map(run => run.outcome)).toEqual(['notice_held']);
        expect(deps().book.pending(NOW)).toBeNull();
      });
    }
  });

  it('holds a note when the Close goes out while the model is writing it', async () => {
    await withNotice(async ({ deps, delivered, charged }) => {
      let closed = false;
      const run = runHealthTrigger(deps({ decide: async () => { closed = true; return note(); } }, { held: () => (closed ? 'held_closed' : null) }));
      expect(await run).toBe('notice_held');
      expect([delivered, charged]).toEqual([[], []]);
    });
  });

  it('waits out the delivery gate\'s cooldown and stops when the day\'s budget is spent', async () => {
    await withNotice(async ({ deps, prompts, reschedules }) => {
      const until = NOW + 20 * 60_000;
      expect(await runHealthTrigger(deps({ admit: () => ({ verdict: 'wait', until }) }))).toBe('held_cooldown');
      expect([prompts.length, reschedules]).toEqual([0, [until]]);
      expect(deps().book.pending(NOW)).not.toBeNull();
    });
    await withNotice(async ({ deps, prompts, delivered }) => {
      expect(await runHealthTrigger(deps({ admit: () => ({ verdict: 'spent' }) }))).toBe('budget_gate');
      expect([prompts.length, delivered.length, deps().book.pending(NOW)]).toEqual([0, 0, null]);
    });
  });

  it('sends at most one note on an owner-local day; a later change that day asks the model nothing', async () => {
    await withNotice(async ({ sql, deps, prompts, delivered }) => {
      expect(await runHealthTrigger(deps())).toBe('noticed');
      const later = NOW + 2 * HEALTH_TRIGGER_FLOOR_MS;
      deps().book.mark(DAY, later - 60_000, 'driver_far');
      expect(await runHealthTrigger(deps({ now: () => later, readHealth: async () => ({ ...ROW, context: { ...ROW.context, compiled_at: new Date(later - 600_000).toISOString() } }) }))).toBe('duplicate');
      expect([prompts.length, delivered.length]).toEqual([1, 1]);
      expect(runs(sql).map(run => run.outcome)).toEqual(['noticed', 'duplicate']);
    });
  });

  it('refuses, and sends nothing for, an answer that is not a short note: bad JSON, a wrong kind, an empty or overlong text', async () => {
    for (const raw of ['not json', JSON.stringify({ kind: 'propose', text: LINE }), note('   '), note(`Update\n${'a'.repeat(400)}`), JSON.stringify({ kind: 'notice' })]) {
      await withNotice(async ({ sql, deps, delivered, charged }) => {
        expect(await runHealthTrigger(deps({ decide: async () => raw }))).toBe('invalid');
        expect([delivered, charged]).toEqual([[], []]);
        expect(runs(sql).map(run => run.outcome)).toEqual(['invalid']);
      });
    }
  });

  it('refuses a note that carries a reading: a notification never names a health number', async () => {
    for (const text of ['Update\nYou slept 5 hours last night, so keep it light.', 'Update\nHRV 38 ms, below your usual.']) {
      await withNotice(async ({ sql, deps, delivered }) => {
        expect(await runHealthTrigger(deps({ decide: async () => note(text) }))).toBe('egress_refused');
        expect(delivered).toEqual([]);
        expect(runs(sql).map(run => run.outcome)).toEqual(['egress_refused']);
      });
    }
  });

  it('a delivery that fails records no run, spends nothing, and keeps the change for the next floor', async () => {
    await withNotice(async ({ sql, deps, charged, reschedules }) => {
      expect(await runHealthTrigger(deps({}, { deliver: async () => { throw new Error('outbox unavailable'); } }))).toBe('failed');
      expect([runs(sql), charged, reschedules]).toEqual([[], [], [NOW + HEALTH_TRIGGER_FLOOR_MS]]);
      expect(deps().book.pending(NOW)).not.toBeNull();
    });
  });

  it('keeps a change that lands while the note is being written, and arms the next evaluation for it', async () => {
    await withNotice(async ({ deps, reschedules }) => {
      const book = deps().book;
      expect(await runHealthTrigger(deps({ decide: async () => { book.mark(DAY, NOW + 5_000, 'driver_appeared'); return quiet; } }))).toBe('no_op');
      expect(book.pending(NOW + 10_000)).toEqual({ at: NOW + 5_000, days: [DAY] });
      expect(reschedules).toEqual([NOW + HEALTH_TRIGGER_FLOOR_MS]);
    });
  });

  it('a calendar day still goes to the calendar proposal, never to a note', async () => {
    await withNotice(async ({ deps, formats, delivered }) => {
      const review = { kind: 'event' as const, id: 'gcal-review-1', title: 'Quarterly board review', start: '2026-10-21T05:30:00Z', end: '2026-10-21T07:00:00Z' };
      const noOp = JSON.stringify({ kind: 'no_op', action: null, item: null, start: null, end: null, title: null, block: null, notify_guests: null, reason: '' });
      expect(await runHealthTrigger(deps({ comingItems: async () => [review], decide: async (_id, _prompt, format) => { formats.push(format?.name ?? 'health_proposal'); return noOp; } }))).toBe('no_op');
      expect([formats, delivered]).toEqual([['health_proposal'], []]);
    });
  });
});

describe('the note prompt and its answer', () => {
  const view = healthTriggerView(ROW, NOW, TZ)!;

  it('leaves whether to speak to the model, names what changed, and forbids numbers, diagnosis and alarm', () => {
    const prompt = healthNoticePrompt({ view, now: NOW, timezone: TZ, reasons: ['sleep_debt_building'] });
    expect(prompt).toContain('What changed: Sleep debt has been building over the last few days.');
    expect(prompt).toContain('return no_op');
    expect(prompt).toContain('Never diagnose or alarm');
    expect(prompt).toContain('never a number');
    for (const leak of LEAKS) expect(prompt).not.toContain(leak);
  });

  it('names the signals outside usual only when a driver woke the run', () => {
    expect(healthNoticePrompt({ view, now: NOW, timezone: TZ, reasons: ['driver_appeared'] })).toContain('Signals outside the owner\'s usual range now: breathing rate above usual.');
    expect(healthNoticePrompt({ view, now: NOW, timezone: TZ, reasons: ['zone_change'] })).not.toContain('Signals outside');
  });

  it('reads an answer strictly', () => {
    expect(parseHealthNotice(quiet)).toEqual({ kind: 'no_op' });
    expect(parseHealthNotice(note(`  ${LINE}  `))).toEqual({ kind: 'notice', text: LINE });
    expect(() => parseHealthNotice('[]')).toThrow('invalid health notice');
    expect(() => parseHealthNotice(JSON.stringify({ kind: 'notice', text: 7 }))).toThrow('invalid health notice');
  });
});
