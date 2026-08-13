import { describe, it } from 'vitest';
import { buildResponsibilityPresenceChannelV04Bundle } from '../packages/contracts/src';
import { writeResponsibilityV04FixtureBundle } from './write-responsibility-v0-4-fixture-bundle';
describe('generate presence channel v0.4', () => {
  it('writes fixtures', () =>
    writeResponsibilityV04FixtureBundle(
      new URL(
        '../packages/contracts/fixtures/responsibility-presence-channel/v0.4/',
        import.meta.url,
      ),
      buildResponsibilityPresenceChannelV04Bundle,
    ));
});
