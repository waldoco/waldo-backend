import { describe, expect, it } from 'vitest';
import { measure, TURN_TYPES } from '../evals/context-budget';

// The context measure runs every turn type it names, and a conversation's turns keep re-sending the same leading bytes:
// the tool list and system prompt lead, so a provider cache can serve nearly all of each later turn.
describe('the context measure', () => {
  it.each([false, true])('measures every turn type and keeps a conversation\'s prefix stable (prompt v2 %s)', async (promptV2) => {
    const sizes = await measure({ toolLoader: 'harness', promptV2 });
    expect(Object.keys(sizes)).toEqual(Object.keys(TURN_TYPES));
    for (const size of Object.values(sizes)) {
      expect(size.calls).toBeGreaterThan(0);
      expect(size.mean.system).toBeGreaterThan(0);
    }
    expect(sizes.long_chat!.prefix_share).toBeGreaterThanOrEqual(0.9);
  }, 120_000);
});
