// L1 scenario harness: runs the shared catalog through the real responder with the scripted
// gateway and checks tools, hops, state and replies exactly (SCENARIO_HARNESS_SPEC_2026-09-25).
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../scenarios/catalog';
import { checkScenario, runScenario, type ScenarioRun } from '../scenarios/run-l1';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import { sanitise } from '../src/scribe/sanitiser';
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

describe('recall by relevance', () => {
  const r1 = SCENARIOS.find((scenario) => scenario.id === 'r1-recall-across-day')!;
  // The <recalled> block of the system prompt that produced a turn's reply. All of r1 sits in the history window,
  // so asserting on the whole model input would pass without recall; the block is what proves it ran.
  const recalled = (run: ScenarioRun, turn: number): string => {
    const system = run.modelRequests[turn - 1]?.at(-1)?.request.system ?? '';
    const start = system.indexOf('<recalled>');
    return start < 0 ? '' : system.slice(start, system.indexOf('</recalled>', start) + '</recalled>'.length);
  };

  it('r1 with no claim written: the last turn recalls the locker from the episode index', async () => {
    const run = await runScenario(r1);
    expect(checkScenario(r1, run)).toEqual([]);
    expect(run.tools).not.toContain('remember');
    // Index row 1 is turn 1's owner message (tg-1), saved after that turn.
    expect(recalled(run, 8)).toMatch(/- \[owner, \d{4}-\d{2}-\d{2}, ref 1\] .*214/);
  });

  it('r1 with the fact remembered: the claim is recalled, its source turn counts once, and a machine turn gets claims only', async () => {
    const scenario: Scenario = {
      ...r1,
      turns: [...r1.turns, '@remind check the gym locker'],
      llm: [
        { match: /locker at the gym is number 214/, rounds: [{ toolCalls: [{ name: 'remember', arguments: { kind: 'fact', text: 'Gym locker is number 214, the one with the blue door', evidence_quote: 'My locker at the gym is number 214, the one with the blue door' } }] }, { text: 'Got it.' }] },
        ...r1.llm!.slice(1),
        { match: /Reminder due now/, rounds: [{ text: 'Time to check the gym locker.' }] },
      ],
    };
    const run = await runScenario(scenario);
    expect(checkScenario(scenario, run)).toEqual([]);
    expect(run.tools).toContain('remember');
    const last = recalled(run, 8);
    expect(last).toMatch(/- \[fact, stated, owner-grounded, \d{4}-\d{2}-\d{2}\] Gym locker is number 214, the one with the blue door/);
    // The owner turn the claim was learned from (tg-1, index row 1) is not repeated as an episode line.
    expect(last).not.toContain('ref 1]');
    const machine = recalled(run, 9);
    expect(machine).toContain('Gym locker is number 214');
    expect(machine).not.toMatch(/ref \d+\]/);
  });

  it('a recalled episode carrying a link, an email address and a health-shaped reading still reaches the model', async () => {
    // Synthetic values. The reply's system prompt is owner-context (null taint), so the sanitiser must neither fail the
    // turn closed on these nor redact them away.
    const scenario: Scenario = {
      id: 'recall-sanitiser-falsifier',
      category: 'memory',
      turns: ['Invoice portal https://pay.example.com/inv-77 billing@example.com heart rate 52 bpm', 'Which invoice portal do I use?'],
      llm: [
        { match: /^Invoice portal https/, rounds: [{ text: 'Noted.' }] },
        { match: /Which invoice portal/, rounds: [{ text: 'pay.example.com' }] },
      ],
      assert: { replies: ['Noted.', 'pay.example.com'], hops: [{ hop: 'llm_reply', ok: true }] },
    };
    const run = await runScenario(scenario);
    expect(checkScenario(scenario, run)).toEqual([]);
    const block = recalled(run, 2);
    for (const text of ['pay.example.com/inv-77', 'billing@example.com', 'heart rate 52 bpm']) expect(block).toContain(text);
    // The fixture does trip the health scan: the same block as external content is refused, as owner context it passes unchanged.
    const scribe = (source_taint: 'external' | null) => sanitise({ payload: block, destination: 'system_prompt', source_taint, canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'] });
    expect(scribe('external')).toMatchObject({ ok: false, reason: 'health_value_leak' });
    expect(scribe(null)).toMatchObject({ ok: true, payload: block });
  });
});
