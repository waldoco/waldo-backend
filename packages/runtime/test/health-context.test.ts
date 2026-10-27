import { describe, expect, it } from 'vitest';
import type { DerivedHealthDestinationView } from '@waldo/contracts';
import { healthContextBook, rowFreshness, toContextHealthMaterial, type HealthContextRow } from '../src/channels/health-context';
import { localTrustedBriefTurnSnapshot } from '../src/llm/run-loop-adapters';
import { md5Hex } from '../src/channels/md5';

// Fixed clock: 2026-09-28 10:00 UTC = 15:30 IST, local day 2026-09-28.
const NOW = new Date('2026-09-28T10:00:00Z');
const clock = { timezone: 'Asia/Kolkata', now: () => NOW };

const row = (overrides: Partial<HealthContextRow> = {}): HealthContextRow => ({
  context: {
    id: 'ctx-1',
    day: '2026-09-28',
    form: { score: 72, zone: 'good', drivers: ['sleep below baseline'], confidence: 0.8 },
    recovery: { score: 70, zone: 'good' },
    weight: { score: 45, zone: 'moderate' },
    drivers: ['sleep below baseline'],
    confidence: 0.8,
    freshness: 'fresh',
    tags: ['travel'],
    compiled_at: '2026-09-28T04:30:00.000Z',
  },
  previous: { day: '2026-09-27', form_score: 64 },
  ...overrides,
});

const formZoneOf = (material: { view: DerivedHealthDestinationView }): string | undefined =>
  'form_zone' in material.view ? material.view.form_zone : undefined;

describe('toContextHealthMaterial', () => {
  it('redacts a full row to the zone-word material (ADR-0024)', () => {
    const material = toContextHealthMaterial(row(), clock);
    expect(material).not.toBeNull();
    expect(material!.view).toEqual({
      authority: 'backend',
      algorithm_version: 'form.safte-fast.v1',
      form_zone: 'steady',
      trend: 'improving',
      freshness: 'fresh',
      missing_components: [],
      confidence_band: 'high',
      provenance_refs: [`hpr_${md5Hex('health-context.ctx-1')}`],
      destination_eligibility: ['trigger_prompt'],
    });
    expect(material!.narrative).toEqual({
      zone: 'steady',
      recovery_descriptor: 'solid',
      load_descriptor: 'moderate',
      day_summary: 'Form steady; recovery solid; load moderate. Drivers: sleep below baseline. Tags: travel.',
      active_goals: [],
      upcoming_high_stakes: [],
      compiled_at: '2026-09-28T04:30:00.000Z',
    });
    expect(material!.source).toEqual({
      source_key: 'health-context:2026-09-28',
      source_kind: 'derived_health_view',
      scope: 'principal',
      source_taint: null,
      produced_at: Date.parse('2026-09-28T04:30:00.000Z'),
    });
  });

  it('takes the Form zone the backend stored, which holds through a steady move, as the app shows it', () => {
    const at = (score: number, zone: string) => toContextHealthMaterial(row({ context: { ...row().context!, form: { score, zone } } }), clock);
    expect(formZoneOf(at(77, 'high')!)).toBe('energized');
    expect(formZoneOf(at(83, 'good')!)).toBe('steady');
    expect(formZoneOf(at(41, 'moderate')!)).toBe('flagging');
    expect(formZoneOf(at(12, 'low')!)).toBe('depleted');
    // A word the bridge does not know is no Form, as for Recovery and Load, never a zone guessed from the score.
    expect(at(85, 'unknown')!.view.algorithm_version).toBe('recovery.v1');
  });

  it('bridges the app zone vocabulary for recovery and load', () => {
    const at = (recoveryZone: string, weightZone: string) =>
      toContextHealthMaterial(row({ context: { ...row().context!, recovery: { zone: recoveryZone }, weight: { zone: weightZone } } }), clock);
    expect(at('high', 'high')!.narrative).toMatchObject({ recovery_descriptor: 'excellent', load_descriptor: 'peak' });
    expect(at('good', 'good')!.narrative).toMatchObject({ recovery_descriptor: 'solid', load_descriptor: 'heavy' });
    expect(at('moderate', 'moderate')!.narrative).toMatchObject({ recovery_descriptor: 'mixed', load_descriptor: 'moderate' });
    expect(at('low', 'low')!.narrative).toMatchObject({ recovery_descriptor: 'compromised', load_descriptor: 'light' });
  });

  it('derives the trend from the previous Form score with a pinned delta', () => {
    const withPrevious = (form_score: unknown) => toContextHealthMaterial(row({ previous: { day: '2026-09-27', form_score } }), clock);
    expect(withPrevious(60)!.view.trend).toBe('improving');
    expect(withPrevious(84)!.view.trend).toBe('declining');
    expect(withPrevious(69)!.view.trend).toBe('steady');
    expect(toContextHealthMaterial(row({ previous: null }), clock)!.view.trend).toBe('insufficient');
    expect(withPrevious(null)!.view.trend).toBe('insufficient');
  });

  it('ages a row by ADR-0081 §2: fresh six hours after compile on its day or the next, expired after three days, stale between', () => {
    const errors: unknown[] = [];
    const at = (compiled_at: string, day = '2026-09-28') => toContextHealthMaterial(row({ context: { ...row().context!, day, compiled_at } }), clock, error => errors.push(error));
    expect(at('2026-09-28T04:00:00.000Z')!.view.freshness).toBe('fresh');
    expect(at('2026-09-28T04:00:00.000Z', '2026-09-27')!.view.freshness).toBe('fresh');
    expect(at('2026-09-28T04:00:00.000Z', '2026-09-26')!.view.freshness).toBe('stale');
    expect(at('2026-09-28T03:59:59.999Z')!.view.freshness).toBe('stale');
    expect(at('2026-09-25T10:00:00.000Z', '2026-09-25')!.view.freshness).toBe('stale');
    // An expired row is absence for the prompt, as no row is, and not an error.
    expect(at('2026-09-25T09:59:59.999Z', '2026-09-25')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('reads an unreadable compile time as expired, never fresh', () => {
    for (const compiledAt of ['not-a-date', undefined, null, 0]) expect(rowFreshness(compiledAt, '2026-09-28', 'Asia/Kolkata', NOW.getTime())).toBe('expired');
  });

  it('bands confidence and treats a missing confidence as low', () => {
    const at = (confidence: unknown) => toContextHealthMaterial(row({ context: { ...row().context!, confidence } }), clock);
    expect(at(0.9)!.view.confidence_band).toBe('high');
    expect(at(0.5)!.view.confidence_band).toBe('medium');
    expect(at(0.2)!.view.confidence_band).toBe('low');
    expect(at(null)!.view.confidence_band).toBe('low');
  });

  it('keeps app-authored strings word-only: digits and URLs never ride the narrative', () => {
    const material = toContextHealthMaterial(
      row({
        context: {
          ...row().context!,
          form: { score: 72, zone: 'good', drivers: ['sleep below baseline', 'HRV 48 ms', 'see https://evil.example/x'] },
          drivers: ['resting heart rate 61'],
          tags: ['travel', 'sick-day-2'],
        },
      }),
      clock,
    );
    expect(material!.narrative.day_summary).toBe(
      'Form steady; recovery solid; load moderate. Drivers: sleep below baseline. Tags: travel.',
    );
    expect(material!.narrative.day_summary).not.toMatch(/\d/);
  });

  it('stamps the narrative with the row compilation time, satisfying the composer provenance bound', () => {
    // Regression pin: compose receives localTrustedBriefTurnSnapshot() (Date.now() per turn,
    // telegram-turn.ts) and prepareHealth requires compiled_at <= snapshot_at. A read-time
    // stamp is always later and would throw health_context_invalid on every turn with health
    // data; the row's own compilation time is the truthful, always-earlier stamp.
    const fixture = localTrustedBriefTurnSnapshot();
    const material = toContextHealthMaterial(row(), clock);
    expect(material).not.toBeNull();
    expect(Date.parse(material!.narrative.compiled_at)).toBeLessThanOrEqual(fixture.snapshot_at);
    expect(material!.source.produced_at).toBeLessThanOrEqual(fixture.snapshot_at);
  });

  it('reads a Recovery-first row: no Form score yet, Load not computed', () => {
    const material = toContextHealthMaterial(row({ context: { ...row().context!, form: null, weight: null } }), clock);
    expect(material?.view).toMatchObject({ algorithm_version: 'recovery.v1', recovery_zone: 'solid', trend: 'insufficient', freshness: 'fresh' });
    expect(material?.narrative.zone).toBeUndefined();
    expect(material?.narrative.load_descriptor).toBeUndefined();
    expect(material?.narrative.day_summary).toBe('Recovery solid; load unavailable. Drivers: sleep below baseline. Tags: travel.');
  });

  it('keeps Form and Recovery when only Load is missing or unreadable', () => {
    for (const weight of [null, { zone: 'unknown' }, { zone: 'energized' }]) {
      const material = toContextHealthMaterial(row({ context: { ...row().context!, weight } }), clock);
      expect(material?.view).toMatchObject({ algorithm_version: 'form.safte-fast.v1', form_zone: 'steady' });
      expect(material?.narrative.load_descriptor).toBeUndefined();
    }
  });

  it('degrades to absence: no context, no Recovery, or an unmapped Recovery word', () => {
    expect(toContextHealthMaterial(row({ context: null }), clock)).toBeNull();
    expect(toContextHealthMaterial(row({ context: { ...row().context!, recovery: null } }), clock)).toBeNull();
    expect(toContextHealthMaterial(row({ context: { ...row().context!, recovery: { zone: 'unknown' } } }), clock)).toBeNull();
    // An unreadable Form score drops only Form, like an unreadable Load.
    expect(toContextHealthMaterial(row({ context: { ...row().context!, form: { score: 101 } } }), clock)?.view.algorithm_version).toBe('recovery.v1');
    const errors: unknown[] = [];
    expect(
      toContextHealthMaterial(row({ context: { ...row().context!, compiled_at: 'not-a-date' } }), clock, (error) => errors.push(error)),
    ).toBeNull();
    expect(errors).toHaveLength(1);
    expect(
      toContextHealthMaterial(row({ context: { ...row().context!, compiled_at: '2026-09-28T10:00:01.000Z' } }), clock, (error) => errors.push(error)),
    ).toBeNull();
    expect(errors).toHaveLength(2);
  });
});

describe('toContextHealthMaterial reads what the stored row says about its own scores', () => {
  const baseline = (state: string, personal_days: number) => ({ state, personal_days, needed: 14, prior: 'adults' });
  const rich = (extra: Record<string, unknown> = {}): HealthContextRow => {
    const context = row().context!;
    return row({
      context: {
        ...context,
        form: { score: 41, zone: 'moderate', algorithm_version: 'form.v9', activation: 'accepted', confidence: 0.61, baseline: baseline('provisional', 3) },
        recovery: { score: 70, zone: 'good', algorithm_version: 'recovery.v5', activation: 'accepted', confidence: 0.61, baseline: baseline('provisional', 3) },
        weight: { score: 77, zone: 'good', algorithm_version: 'weight.v5', activation: 'accepted', confidence: 0.61, baseline: baseline('personal', 21) },
        sleep_debt: { state: 'available', debt_minutes: 640, need_basis: 'own_average', algorithm_version: 'sleep-debt.v2', activation: 'accepted' },
        windows: [{ start: '09:30', end: '11:30', kind: 'peak' }, { start: '14:00', end: '15:30', kind: 'dip' }],
        ...extra,
      },
    });
  };
  const at = (extra: Record<string, unknown> = {}, onError?: (error: unknown) => void) => toContextHealthMaterial(rich(extra), clock, onError);

  it('carries the version the row names, its baseline state, sleep debt in words and the day\'s windows', () => {
    const material = at();
    expect(material!.view).toMatchObject({
      algorithm_version: 'form.v9', form_zone: 'flagging',
      baseline_state: { recovery: 'provisional', form: 'provisional', load: 'personal' },
      sleep_debt: 'building',
      energy_windows: [{ start: '09:30', end: '11:30', kind: 'peak' }, { start: '14:00', end: '15:30', kind: 'dip' }],
    });
  });

  it('names the Recovery version when Form has no score, and states no minutes, days or scores anywhere', () => {
    const material = at({ form: null });
    expect(material!.view).toMatchObject({ algorithm_version: 'recovery.v5', recovery_zone: 'solid', baseline_state: { recovery: 'provisional', load: 'personal' } });
    expect(material!.view).not.toHaveProperty('baseline_state.form');
    const text = JSON.stringify(material).replace(/"(?:start|end)":"\d\d:\d\d"/g, '');
    for (const value of ['640', 'personal_days', '0.61', '"needed"', 'debt_minutes']) expect(text).not.toContain(value);
  });

  it('produces the material it always did for a row without the new fields', () => {
    const material = toContextHealthMaterial(row(), clock);
    expect(Object.keys(material!.view).sort()).toEqual(['algorithm_version', 'authority', 'confidence_band', 'destination_eligibility', 'form_zone', 'freshness', 'missing_components', 'provenance_refs', 'trend']);
  });

  it('words sleep debt as building, steady, partial or unknown', () => {
    const word = (sleep_debt: unknown) => (at({ sleep_debt })!.view as { sleep_debt?: string }).sleep_debt;
    expect(word({ state: 'available', debt_minutes: 640, need_basis: 'own_average', algorithm_version: 'sleep-debt.v2', activation: 'accepted' })).toBe('building');
    expect(word({ state: 'available', debt_minutes: 30, need_basis: 'owner_confirmed', algorithm_version: 'sleep-debt.v2', activation: 'accepted' })).toBe('steady');
    expect(word({ state: 'available', debt_minutes: 0, need_basis: 'own_average', algorithm_version: 'sleep-debt.v2', activation: 'accepted' })).toBe('steady');
    expect(word({ state: 'partial', confidence: 0.6, algorithm_version: 'sleep-debt.v2', activation: 'accepted' })).toBe('partial');
    expect(word({ state: 'unavailable', reason: 'missing_sleep' })).toBe('unknown');
  });

  it('drops only the line a malformed field would have made', () => {
    for (const sleep_debt of [{ state: 'available', debt_minutes: 'a lot' }, { state: 'available', debt_minutes: -5 }, { state: 'soon' }, 640, 'building', []]) {
      const view = at({ sleep_debt })!.view;
      expect(view, JSON.stringify(sleep_debt)).not.toHaveProperty('sleep_debt');
      expect(view).toMatchObject({ energy_windows: [{ kind: 'peak' }, { kind: 'dip' }], baseline_state: { recovery: 'provisional' } });
    }
    const badWindows: unknown[] = [
      [{ start: '9:30', end: '11:30', kind: 'peak' }], [{ start: '09:30', end: '11:30', kind: 'peak' }, { start: '14:00', end: '15:30', kind: 'high' }],
      Array(5).fill({ start: '09:30', end: '11:30', kind: 'peak' }), [{ start: 'resting heart rate 61', end: '11:30', kind: 'peak' }], 'peak 09:30-11:30', {}, [],
    ];
    for (const windows of badWindows) {
      const view = at({ windows })!.view;
      expect(view, JSON.stringify(windows)).not.toHaveProperty('energy_windows');
      expect(view).toMatchObject({ sleep_debt: 'building', baseline_state: { recovery: 'provisional' } });
    }
    const forming = at({ recovery: { score: 70, zone: 'good', algorithm_version: 'recovery.v5', baseline: { state: 'forming' } } })!.view;
    expect(forming).not.toHaveProperty('baseline_state.recovery');
    expect(forming).toMatchObject({ baseline_state: { form: 'provisional', load: 'personal' }, sleep_debt: 'building' });
  });

  it('reads a pillar whose version is not a stored version name as unreadable, never as another version', () => {
    const errors: unknown[] = [];
    const formBad = at({ form: { score: 41, zone: 'moderate', algorithm_version: 'recovery.v5' } }, (error) => errors.push(error));
    expect(formBad!.view).toMatchObject({ algorithm_version: 'recovery.v5', recovery_zone: 'solid' });
    expect(formBad!.view).not.toHaveProperty('form_zone');
    expect(at({ recovery: { score: 70, zone: 'good', algorithm_version: 'v5; drop table' } }, (error) => errors.push(error))).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('keeps app-authored strings word-only beside the new fields', () => {
    const material = at({ drivers: ['wrist temperature above usual', 'breathing rate 14 above usual'], tags: ['sick-day-2'] });
    expect(material!.narrative.day_summary).toContain('wrist temperature above usual');
    expect(material!.narrative.day_summary).not.toMatch(/\d/);
  });
});

describe('healthContextBook', () => {
  const calls: { fn: string; message: string; args: Record<string, string | number> }[] = [];
  const call = async (fn: string, message: string, args: Record<string, string | number>) => {
    calls.push({ fn, message, args });
    return row();
  };

  it('signs healthctx.read with the do name and returns the material', async () => {
    const book = healthContextBook(call, 'do-health', clock);
    expect(book.linked()).toBe(true);
    const material = await book.latest();
    expect(material).not.toBeNull();
    expect(formZoneOf(material!)).toBe('steady');
    expect(calls[0]).toEqual({ fn: 'health_context_read', message: 'healthctx.read.do-health', args: { p_do_name: 'do-health' } });
  });

  it('emits present/absent success receipt on a same-trace read, never private values', async () => {
    const successes: unknown[] = [];
    const present = healthContextBook(call, 'do-health', clock, undefined, (value, trace) => successes.push({ value, trace }));
    await present.latest('tg-test');
    const absent = healthContextBook(async () => null, 'do-health', clock, undefined, (value, trace) => successes.push({ value, trace }));
    await absent.latest('tg-empty');
    expect(successes).toEqual([{ value: true, trace: 'tg-test' }, { value: false, trace: 'tg-empty' }]);
  });

  it('reads null when unlinked, without calling', async () => {
    const before = calls.length;
    expect(healthContextBook(null, 'do-health', clock).linked()).toBe(false);
    expect(await healthContextBook(null, 'do-health', clock).latest()).toBeNull();
    expect(await healthContextBook(call, null, clock).latest()).toBeNull();
    expect(calls.length).toBe(before);
  });

  it('degrades to null and reports when the rail fails or the owner has no rows', async () => {
    const errors: unknown[] = [];
    const failing = healthContextBook(
      async () => {
        throw new Error('owner directory 500');
      },
      'do-health',
      clock,
      (error) => errors.push(error),
    );
    expect(await failing.latest()).toBeNull();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('owner directory 500');
    const empty = healthContextBook(async () => null, 'do-health', clock);
    expect(await empty.latest()).toBeNull();
  });
});
