import { describe, expect, it } from 'vitest';
import { evidenceLaneSchema, evidenceRunSchema, HERMETIC_EVIDENCE_LANES } from './evidence';

describe('evidence lanes', () => {
  it('pins the Phase D verification lane names', () => {
    expect(evidenceLaneSchema.options).toEqual(['scenario', 'property', 'mutation', 'live_dogfood']);
    expect(HERMETIC_EVIDENCE_LANES).toEqual(['scenario', 'property', 'mutation']);
  });

  it('requires scenario, property, and mutation evidence to be hermetic by default', () => {
    for (const lane of HERMETIC_EVIDENCE_LANES) {
      expect(
        evidenceRunSchema.safeParse({
          lane,
          status: 'pass',
          hermetic: true,
          live_provider: false,
          opt_in: false,
          artifact_uri: `artifacts/${lane}.json`,
        }).success,
      ).toBe(true);
    }

    expect(
      evidenceRunSchema.safeParse({
        lane: 'scenario',
        status: 'pass',
        hermetic: false,
        live_provider: true,
        opt_in: true,
      }).success,
    ).toBe(false);
  });

  it('requires live dogfood evidence to be explicit opt-in provider evidence', () => {
    expect(
      evidenceRunSchema.safeParse({
        lane: 'live_dogfood',
        status: 'skipped',
        hermetic: false,
        live_provider: true,
        opt_in: true,
        metadata: { environment: 'dogfood' },
      }).success,
    ).toBe(true);

    expect(
      evidenceRunSchema.safeParse({
        lane: 'live_dogfood',
        status: 'pass',
        hermetic: true,
        live_provider: false,
        opt_in: false,
      }).success,
    ).toBe(false);
  });

  it('rejects identifiers and raw health metadata', () => {
    expect(
      evidenceRunSchema.safeParse({
        lane: 'property',
        status: 'pass',
        hermetic: true,
        live_provider: false,
        opt_in: false,
        metadata: { run_id: 'run-1' },
      }).success,
    ).toBe(false);
  });

  it('rejects arbitrary string-bearing metadata', () => {
    expect(
      evidenceRunSchema.safeParse({
        lane: 'scenario',
        status: 'pass',
        hermetic: true,
        live_provider: false,
        opt_in: false,
        metadata: { note: 'a@b.com' },
      }).success,
    ).toBe(false);
  });
});
