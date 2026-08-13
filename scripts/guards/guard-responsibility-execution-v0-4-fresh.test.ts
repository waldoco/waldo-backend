import { describe, it } from 'vitest';
import { buildResponsibilityExecutionV04Bundle } from '../../packages/contracts/src';
import { assertResponsibilityV04BundleFresh } from './responsibility-v0-4-freshness-test-helper';
describe('execution fixture freshness', () => {
  it('is exact and the guard is non-vacuous', () =>
    assertResponsibilityV04BundleFresh(
      new URL('../../packages/contracts/fixtures/responsibility-execution/v0.4/', import.meta.url),
      buildResponsibilityExecutionV04Bundle,
    ));
});
