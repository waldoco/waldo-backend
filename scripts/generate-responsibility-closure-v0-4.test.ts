import { describe, it } from 'vitest';
import { buildResponsibilityClosureV04Bundle } from '../packages/contracts/src';
import { writeResponsibilityV04FixtureBundle } from './write-responsibility-v0-4-fixture-bundle';
describe('generate closure v0.4', () => {
  it('writes fixtures', () =>
    writeResponsibilityV04FixtureBundle(
      new URL('../packages/contracts/fixtures/responsibility-closure/v0.4/', import.meta.url),
      buildResponsibilityClosureV04Bundle,
    ));
});
