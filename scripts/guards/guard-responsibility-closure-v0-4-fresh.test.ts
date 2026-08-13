import { describe, it } from 'vitest';
import { buildResponsibilityClosureV04Bundle } from '../../packages/contracts/src';
import { assertResponsibilityV04BundleFresh } from './responsibility-v0-4-freshness-test-helper';
describe('closure fixture freshness', () => {
  it('is exact and the guard is non-vacuous', () =>
    assertResponsibilityV04BundleFresh(
      new URL('../../packages/contracts/fixtures/responsibility-closure/v0.4/', import.meta.url),
      buildResponsibilityClosureV04Bundle,
    ));
});
