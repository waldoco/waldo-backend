import { describe, expect, it } from 'vitest';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { JOIN_BRIEF_SCENARIOS } from '../evals/nightly/join-brief-scenarios';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import { runTrial, type TrialScenario } from '../evals/nightly/trial';

// The deterministic half of the join-to-Brief case: the join pass runs through the production constellation call over the
// owner's seeded spots, and the Brief runs through the production day card over the same memory. The join's reply and the
// Brief's words are scripted; whether a real Brief uses the pattern well is the live judge's. Every value is synthetic.
const [scenario] = JOIN_BRIEF_SCENARIOS;
const LABEL = 'Late calls, then a low next day';
// Spots 1 and 2 are the calendar's, 3 to 5 the health zone words', in seed order.
const JOIN = { constellations: [{ id: null, replaces: [], area: 'body', label: LABEL, summary: 'Late calls with the US team come before a short night, and Recovery and Form sit low the next morning.', strength: 0.7, spots: [1, 2, 3, 4, 5] }], links: [], promoted: [] };
const run = async (steps = scenario!.steps) => {
  const gateway = scriptedGateway({ rules: [{ match: /<spot id="/, rounds: [{ text: JSON.stringify(JOIN) }] }], unmatchedText: 'A light day; keep tonight\'s call to time.' });
  const record = await runTrial({ ...scenario!, steps } as TrialScenario, { gateway, budget: callBudget(10) });
  expect(record.status, record.error).toBe('ran');
  return record;
};
const brief = (record: Awaited<ReturnType<typeof run>>) => record.model_inputs.at(-1)!.text;

describe('the join\'s pattern reaching the next Brief', () => {
  it('is in the nightly catalogue as one join, one confirm and one Brief', () => {
    expect(NIGHTLY_SCENARIOS).toContain(scenario);
    expect(scenario!.steps.map((step) => Object.keys(step)[0])).toEqual(['health', 'join', 'confirm_patterns', 'card']);
  });

  it('shows the Brief the pattern the owner confirmed, drawn from late calls and low mornings together', async () => {
    const record = await run();
    expect(failedReceipts([...STATE_INVARIANTS, ...scenario!.receipts!], record)).toEqual([]);
    expect(record.transcript.some((turn) => turn.text.includes(`- ${LABEL}:`))).toBe(true);
    expect(brief(record)).toContain(LABEL);
    expect(brief(record)).toContain('Weekly sync with the US team');
    // Its words ride with the shared health; the health notes under it stay out of the Brief's memory.
    expect(brief(record)).not.toContain('Recovery sits low on Tuesday and Thursday mornings');
  });

  it('carries the pattern with the owner\'s shared health: a Brief without shared health shows none of it', async () => {
    const record = await run(scenario!.steps.filter((step) => !('health' in step)));
    expect(record.transcript.some((turn) => turn.text.includes('confirms 1 of'))).toBe(true);
    expect(brief(record)).not.toContain(LABEL);
  });

  it('keeps an unconfirmed pattern out of the Brief: one resting on calendar spots waits for the owner\'s word', async () => {
    const record = await run(scenario!.steps.filter((step) => !('confirm_patterns' in step)));
    expect(record.transcript.some((turn) => turn.text.includes(`- ${LABEL}:`))).toBe(true);
    expect(brief(record)).not.toContain(LABEL);
  });
});
