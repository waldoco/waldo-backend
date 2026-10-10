import { describe, expect, it } from 'vitest';
import type { DerivedHealthDestinationView } from '@waldo/contracts';
import { healthContextBook, toContextHealthMaterial, type HealthContextRow } from '../src/channels/health-context';
import { localTrustedBriefTurnSnapshot } from '../src/run-loop/adapters';
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
  material.view.algorithm_version === 'form.safte-fast.v1' ? material.view.form_zone : undefined;

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
      produced_at: NOW.getTime(),
    });
  });

  it('owns the Form bands itself: the zone comes from formZoneOf(score), never the app word', () => {
    const at = (score: number) => toContextHealthMaterial(row({ context: { ...row().context!, form: { score, zone: 'high' } } }), clock);
    expect(formZoneOf(at(85)!)).toBe('energized');
    expect(formZoneOf(at(79)!)).toBe('steady');
    expect(formZoneOf(at(41)!)).toBe('flagging');
    expect(formZoneOf(at(12)!)).toBe('depleted');
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

  it('marks today and yesterday fresh, older days stale (owner-local days)', () => {
    const on = (day: string) => toContextHealthMaterial(row({ context: { ...row().context!, day } }), clock);
    expect(on('2026-09-28')!.view.freshness).toBe('fresh');
    expect(on('2026-09-27')!.view.freshness).toBe('fresh');
    expect(on('2026-09-26')!.view.freshness).toBe('stale');
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
          form: { score: 72, drivers: ['sleep below baseline', 'HRV 48 ms', 'see https://evil.example/x'] },
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
  });

  it('degrades to absence: no context, no Form score, or an unmapped pillar', () => {
    expect(toContextHealthMaterial(row({ context: null }), clock)).toBeNull();
    expect(toContextHealthMaterial(row({ context: { ...row().context!, form: null } }), clock)).toBeNull();
    expect(toContextHealthMaterial(row({ context: { ...row().context!, form: { zone: 'good' } } }), clock)).toBeNull();
    expect(toContextHealthMaterial(row({ context: { ...row().context!, recovery: { zone: 'unknown' } } }), clock)).toBeNull();
    expect(toContextHealthMaterial(row({ context: { ...row().context!, weight: null } }), clock)).toBeNull();
    expect(toContextHealthMaterial(row({ context: { ...row().context!, form: { score: 101 } } }), clock)).toBeNull();
    const errors: unknown[] = [];
    expect(
      toContextHealthMaterial(row({ context: { ...row().context!, compiled_at: 'not-a-date' } }), clock, (error) => errors.push(error)),
    ).toBeNull();
    expect(errors).toHaveLength(1);
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
