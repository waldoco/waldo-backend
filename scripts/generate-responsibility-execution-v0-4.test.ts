import { describe, it } from 'vitest';
import { buildResponsibilityExecutionV04Bundle } from '../packages/contracts/src';
import { writeResponsibilityV04FixtureBundle } from './write-responsibility-v0-4-fixture-bundle';
describe('generate execution v0.4', () => {
  it('writes fixtures', () =>
    writeResponsibilityV04FixtureBundle(
      new URL('../packages/contracts/fixtures/responsibility-execution/v0.4/', import.meta.url),
      buildResponsibilityExecutionV04Bundle,
    ));
});
