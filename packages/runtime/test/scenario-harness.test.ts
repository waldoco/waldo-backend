// L1 scenario harness: runs the shared catalog through the real responder with the scripted
// gateway and checks tools, hops, state and replies exactly (SCENARIO_HARNESS_SPEC_2026-09-25).
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../scenarios/catalog';
import { checkScenario, runScenario } from '../scenarios/run-l1';

describe('L1 scenario harness', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.id, async () => {
      const run = await runScenario(scenario);
      expect(checkScenario(scenario, run)).toEqual([]);
    });
  }
});
