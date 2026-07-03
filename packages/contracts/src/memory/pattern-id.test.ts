// Owning ADR: ADR-0037 (stable pattern_id) + its value-free hash-input amendment, forced by
// ADR-0046.
// Invariant under test: pattern_id = md5(normalised value-free claim_key + '::' + sorted
// conditions) sliced to 12 lowercase hex — deterministic, order-insensitive on conditions,
// and structurally unable to encode a measured (Art-9) value.
// Failure mode caught: a valued claim key minting a new pattern per value, so no supersedence
// chain ever forms (the ADR-0046 fatal red-team finding), or a health value leaking into an
// id that then travels through logs and supersedence chains.
// Golden note: ADR-0037's illustrative wake-time hex (f3a92c4b18e7) is NOT the real md5 of
// the pinned value-free input; the golden below asserts the REAL md5 (9b686cae0708) so any
// drift in normalisation, separator, condition ordering, or slice width goes red.
// The contracts package carries no ambient Node types (tsconfig pins `types: []` so the
// runtime-portable source can never lean on Node globals); this test runs under Node vitest,
// where node:crypto exists — the untyped import is confined to this line and the adapter
// below re-establishes the typed seam.
// @ts-expect-error TS2307 — no @types/node in the pure contracts package
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { claimKeySchema, generatePatternId, patternIdSchema } from './pattern-id';

// Real md5 adapter — the Node leg of the injected digest seam (the DO runtime supplies the
// workerd leg).
const md5Hex = (input: string): string => createHash('md5').update(input).digest('hex');

const WAKE_KEY = 'user wake time';
const WAKE_CONDITIONS = ['timezone:America/Los_Angeles', 'weekday'];
const WAKE_GOLDEN = '9b686cae0708';

describe('generatePatternId — golden (ADR-0037 wake-time example, value-free per ADR-0046)', () => {
  it('produces the pinned 12-hex id for the wake-time claim under a real md5', () => {
    expect(generatePatternId(WAKE_KEY, WAKE_CONDITIONS, md5Hex)).toBe(WAKE_GOLDEN);
  });

  it('keeps the id across a value change: the value lives in content, never the key', () => {
    // A 6:30 -> 7:00 wake-time change alters only block content; the claim key and
    // conditions are unchanged, so the chain-forming id is unchanged.
    expect(generatePatternId(WAKE_KEY, WAKE_CONDITIONS, md5Hex)).toBe(
      generatePatternId(WAKE_KEY, WAKE_CONDITIONS, md5Hex),
    );
    expect(generatePatternId(WAKE_KEY, WAKE_CONDITIONS, md5Hex)).toBe(WAKE_GOLDEN);
  });
});

describe('generatePatternId — determinism and condition sensitivity', () => {
  it('is order-insensitive on conditions: permutation hashes identically', () => {
    expect(
      generatePatternId(WAKE_KEY, ['weekday', 'timezone:America/Los_Angeles'], md5Hex),
    ).toBe(WAKE_GOLDEN);
  });

  it('diverges when conditions differ', () => {
    expect(generatePatternId(WAKE_KEY, [...WAKE_CONDITIONS, 'day:monday'], md5Hex)).not.toBe(
      WAKE_GOLDEN,
    );
  });

  it("forces distinct ids for 'basis:reported' vs 'basis:measured' — dual claim, not correction", () => {
    const reported = generatePatternId('user sleep quality', ['basis:reported'], md5Hex);
    const measured = generatePatternId('user sleep quality', ['basis:measured'], md5Hex);
    expect(reported).not.toBe(measured);
  });

  it('matches the canonical 12-char lowercase hex shape', () => {
    const id = generatePatternId('user sleep quality', ['basis:reported'], md5Hex);
    expect(id).toMatch(/^[a-f0-9]{12}$/);
    expect(patternIdSchema.safeParse(id).success).toBe(true);
  });
});

describe('generatePatternId — normalisation', () => {
  it('hashes mixed case and collapsed whitespace identically', () => {
    expect(generatePatternId('User  Wake   Time', WAKE_CONDITIONS, md5Hex)).toBe(WAKE_GOLDEN);
  });

  it('trims surrounding whitespace before hashing', () => {
    expect(generatePatternId('  user wake time  ', WAKE_CONDITIONS, md5Hex)).toBe(WAKE_GOLDEN);
  });
});

describe('claimKeySchema — the value-free guard (Art-9 wall)', () => {
  it('accepts a value-free claim key', () => {
    expect(claimKeySchema.safeParse(WAKE_KEY).success).toBe(true);
  });

  it('rejects a valued sentence passed as claim_key', () => {
    expect(claimKeySchema.safeParse('user wakes at 6:30am').success).toBe(false);
  });

  it('rejects a whitespace-only claim key', () => {
    expect(claimKeySchema.safeParse('   ').success).toBe(false);
  });

  it('hostile: generatePatternId refuses a claim key carrying a raw physiological value', () => {
    expect(() => generatePatternId('hrv 42 baseline', [], md5Hex)).toThrow(/value-free/);
  });

  it('hostile: generatePatternId refuses the valued wake-time sentence', () => {
    expect(() => generatePatternId('user wakes at 6:30am', WAKE_CONDITIONS, md5Hex)).toThrow(
      /value-free/,
    );
  });
});

describe('patternIdSchema — canonical shape drift guard', () => {
  it('accepts the golden id', () => {
    expect(patternIdSchema.safeParse(WAKE_GOLDEN).success).toBe(true);
  });

  it('rejects uppercase hex — one canonical representation', () => {
    expect(patternIdSchema.safeParse('9B686CAE0708').success).toBe(false);
  });

  it('rejects an 11-char id', () => {
    expect(patternIdSchema.safeParse(WAKE_GOLDEN.slice(0, 11)).success).toBe(false);
  });

  it('rejects a full 32-char digest — the 12-char slice is the contract', () => {
    expect(patternIdSchema.safeParse(md5Hex('user wake time::')).success).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(patternIdSchema.safeParse('9b686cae070z').success).toBe(false);
  });
});

describe('generatePatternId — digest seam conformance', () => {
  it('fails closed on a non-canonical (uppercase) digest adapter instead of laundering ids', () => {
    const upperMd5 = (input: string) => md5Hex(input).toUpperCase();
    expect(() => generatePatternId(WAKE_KEY, WAKE_CONDITIONS, upperMd5)).toThrow();
  });
});
