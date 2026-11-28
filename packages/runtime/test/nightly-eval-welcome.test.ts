import { describe, expect, it } from 'vitest';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { callPlan } from '../evals/nightly/plan';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import { runTrial } from '../evals/nightly/trial';
import { WELCOME_SCENARIOS } from '../evals/nightly/welcome-scenarios';

// The deterministic half of the welcome build's nightly case: the stage runs through the production welcome call over a
// calendar that mixes Waldo's housekeeping with the owner's life, and the receipts tell spots that write the housekeeping back
// from spots that leave it out. Which spots are about the owner is the live judge's. Replies are scripted; every event is
// synthetic.
const [scenario] = WELCOME_SCENARIOS;
const spot = (text: string, pointer: string) => ({ area: 'work', text, source: 'calendar', pointers: [pointer], people: [] });
const stage = async (spots: readonly ReturnType<typeof spot>[]) => {
  const gateway = scriptedGateway({ rules: [{ match: /Source: the owner's calendars/, rounds: [{ text: JSON.stringify({ spots }) }] }], unmatchedText: 'ok' });
  const record = await runTrial(scenario!, { gateway, budget: callBudget(10) });
  expect(record.status, record.error).toBe('ran');
  const sent = gateway.requests().map((request) => JSON.stringify(request.request)).filter((text) => text.includes('welcome_nodes'));
  return { record, failed: failedReceipts([...STATE_INVARIANTS, ...scenario!.receipts!], record), sent };
};

describe('the welcome build in the nightly catalogue', () => {
  it('runs one calendar stage nightly, with a receipt, a rubric and a counted model call', () => {
    expect(NIGHTLY_SCENARIOS).toContain(scenario);
    expect(scenario!.steps.some((step) => 'welcome' in step)).toBe(true);
    expect(scenario!.rubric.must_not.length).toBeGreaterThan(0);
    expect(callPlan([scenario!], 1).owner_turns).toBe(1);
  });

  it('shows the stage the whole calendar through the second build\'s call, and a spot written from the smoke test fails', async () => {
    const kept = await stage([spot('Keeps a block to plan the week every Monday morning', 'w-plan')]);
    expect(kept.failed).toEqual([]);
    expect(kept.sent).toHaveLength(1);
    for (const item of ['w-smoke', 'w-docs', 'w-gym']) expect(kept.sent[0]).toContain(item);
    const leaked = await stage([spot('Scheduled a smoke test of Waldo\'s onboarding', 'w-smoke')]);
    expect(leaked.failed).toEqual(['no spot is written from the smoke test or the docs page']);
  });

  it('records an answer that is not a spot list as writing nothing, not as a harness error', async () => {
    const gateway = scriptedGateway({ rules: [], unmatchedText: 'not a spot list' });
    const record = await runTrial(scenario!, { gateway, budget: callBudget(10) });
    expect(record.status).toBe('ran');
    expect(record.transcript.at(-1)).toMatchObject({ role: 'waldo', text: expect.stringContaining('nothing written') });
  });
});
