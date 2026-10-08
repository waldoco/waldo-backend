// L1 scenario harness: runs the shared catalog through the real responder with the scripted
// gateway and checks tools, hops, state and replies exactly (SCENARIO_HARNESS_SPEC_2026-09-25).
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../scenarios/catalog';
import { checkScenario, runScenario } from '../scenarios/run-l1';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import type { Scenario } from '../scenarios/types';

describe('L1 scenario harness', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.id, async () => {
      const run = await runScenario(scenario);
      expect(checkScenario(scenario, run)).toEqual([]);
    });
  }
});

describe('L1 harness extensions', () => {
  const twoTurns: Scenario = {
    id: 'harness-history',
    category: 'tools',
    turns: ['my sister is called Meera', 'what is my sister called'],
    llm: [
      { match: /my sister is called/, rounds: [{ text: 'Noted.' }] },
      { match: /what is my sister called/, rounds: [{ text: 'Meera.' }] },
    ],
    assert: { replies: ['Noted.', 'Meera.'], modelInput: [{ turn: 2, mustContain: ['my sister is called Meera', 'Noted.'], systemPresent: true }] },
  };

  it('keeps conversation history across turns and exposes it to modelInput assertions', async () => {
    const run = await runScenario(twoTurns);
    expect(checkScenario(twoTurns, run)).toEqual([]);
  });

  it('reports a failing modelInput assertion', async () => {
    const run = await runScenario(twoTurns);
    const failing: Scenario = { ...twoTurns, assert: { modelInput: [{ turn: 1, mustContain: ['no such text'] }, { turn: 9 }] } };
    expect(checkScenario(failing, run)).toEqual([
      'modelInput turn 1: model input missing "no such text"',
      'modelInput turn 9: the model received no request',
    ]);
  });

  it('feeds claimOps per writer call and records every request', async () => {
    const gateway = scriptedGateway({ rules: [], claimOps: (turn) => `ops-${turn}` });
    const request = (name?: string) => ({
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, temperature: 0, ...(name ? { response_format: { name, schema: {} } } : {}) },
    }) as never;
    const first = await gateway.complete(request('claim_ops'));
    await gateway.complete(request());
    const second = await gateway.complete(request('claim_ops'));
    expect([first, second].map((result) => (result.ok ? result.data.text : ''))).toEqual(['ops-0', 'ops-1']);
    expect(gateway.requests()).toHaveLength(3);
  });
});
