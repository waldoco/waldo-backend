import { describe, it } from 'vitest';
import { buildResponsibilityContinuityV04Bundle } from '../../packages/contracts/src';
import { assertResponsibilityV04BundleFresh } from './responsibility-v0-4-freshness-test-helper';
describe('continuity fixture freshness', () => {
  it('is exact and the guard is non-vacuous', () =>
    assertResponsibilityV04BundleFresh(
      new URL('../../packages/contracts/fixtures/responsibility-continuity/v0.4/', import.meta.url),
      buildResponsibilityContinuityV04Bundle,
    ));
});
