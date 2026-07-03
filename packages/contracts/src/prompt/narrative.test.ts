// Owning ADRs: ADR-0028 (the REASONS O-layer health block), zone vocabulary from ADR-0011
// via the health/crs single owner, numeric-egress wall owned by the ADR-0024 Scribe overlay.
// Invariant under test: NarrativeContext is derived-only by structure — zone words from the
// single owner, bounded strings, strictObject — so a raw biometric value cannot parse and
// each descriptor word belongs to exactly one band vocabulary.
// Failure mode caught: a numeric sensor key drifting onto the shape, 'peak' leaking from
// Load into Form zones (or 'energized' the other way), an unbounded day_summary, or the
// zone field drifting away from the health/crs vocabulary.
import { describe, expect, it } from 'vitest';
import { formZoneSchema } from '../health/crs';
import { narrativeContextSchema } from './narrative';

const baseContext = {
  zone: 'steady',
  recovery_descriptor: 'solid',
  load_descriptor: 'moderate',
  day_summary: 'Back-to-back meetings until three, then open focus time; one deadline tomorrow.',
  compiled_at: '2026-07-01T06:30:00Z',
} as const;

const fullContext = {
  ...baseContext,
  active_goals: ['ship the harness foundation'],
  upcoming_high_stakes: ['board call on Thursday'],
} as const;

describe('narrativeContext', () => {
  it('accepts a full compiled block', () => {
    expect(narrativeContextSchema.safeParse(fullContext).success).toBe(true);
  });

  it('defaults absent goal lists to empty arrays', () => {
    const parsed = narrativeContextSchema.parse(baseContext);
    expect(parsed.active_goals).toEqual([]);
    expect(parsed.upcoming_high_stakes).toEqual([]);
  });

  it('accepts every Form zone word from the health/crs owner', () => {
    for (const zone of formZoneSchema.options) {
      expect(narrativeContextSchema.safeParse({ ...fullContext, zone }).success).toBe(true);
    }
  });

  it("rejects zone 'peak' — a Load word, never a Form zone", () => {
    expect(narrativeContextSchema.safeParse({ ...fullContext, zone: 'peak' }).success).toBe(false);
  });

  it("accepts load_descriptor 'peak' — the word belongs to Load alone", () => {
    expect(
      narrativeContextSchema.safeParse({ ...fullContext, load_descriptor: 'peak' }).success,
    ).toBe(true);
  });

  it("rejects load_descriptor 'energized' — a Form word, never a Load band", () => {
    expect(
      narrativeContextSchema.safeParse({ ...fullContext, load_descriptor: 'energized' }).success,
    ).toBe(false);
  });

  it('rejects an unknown recovery_descriptor', () => {
    expect(
      narrativeContextSchema.safeParse({ ...fullContext, recovery_descriptor: 'optimal' }).success,
    ).toBe(false);
  });

  it('accepts a day_summary at exactly the 2000-char cap', () => {
    expect(
      narrativeContextSchema.safeParse({ ...fullContext, day_summary: 'a'.repeat(2000) }).success,
    ).toBe(true);
  });

  it('rejects a day_summary over the 2000-char cap', () => {
    expect(
      narrativeContextSchema.safeParse({ ...fullContext, day_summary: 'a'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('rejects an empty string in active_goals (items are non-empty)', () => {
    expect(narrativeContextSchema.safeParse({ ...fullContext, active_goals: [''] }).success).toBe(
      false,
    );
  });

  it('rejects a date-only compiled_at (ISO8601 datetime required)', () => {
    expect(
      narrativeContextSchema.safeParse({ ...fullContext, compiled_at: '2026-07-01' }).success,
    ).toBe(false);
  });

  it('rejects a raw sensor key drifting in (strictObject is the structural wall)', () => {
    expect(narrativeContextSchema.safeParse({ ...fullContext, hrv: 45 }).success).toBe(false);
  });
});
