import { describe, expect, it } from 'vitest';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { callPlan } from '../evals/nightly/plan';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import { runTrial } from '../evals/nightly/trial';
import { WELCOME_SCENARIOS } from '../evals/nightly/welcome-scenarios';

// The deterministic half of the welcome build's nightly case: the stage runs through the production welcome call over a
// calendar that mixes Waldo's housekeeping with the owner's life, and the receipts tell a constellation that writes the
// housekeeping back from one that leaves it out. Which nodes are about the owner, and how they are worded, is the live
// judge's. Replies are scripted; every event is synthetic.
const [scenario] = WELCOME_SCENARIOS;
const node = (label: string, summary: string, pointer: string) => ({ domain: 'work', label, summary, observation: 'A block on the calendar.', source: 'calendar', pointers: [pointer] });
const stage = async (nodes: readonly ReturnType<typeof node>[]) => {
  const gateway = scriptedGateway({ rules: [{ match: /Source: the owner's calendars/, rounds: [{ text: JSON.stringify({ nodes }) }] }], unmatchedText: 'ok' });
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

  it('shows the stage the whole calendar through the second build\'s call, and a node written from the smoke test fails', async () => {
    const kept = await stage([node('Plans the week on Mondays', 'You keep Monday mornings to plan the week.', 'w-plan')]);
    expect(kept.failed).toEqual([]);
    expect(kept.sent).toHaveLength(1);
    for (const item of ['w-smoke', 'w-docs', 'w-gym']) expect(kept.sent[0]).toContain(item);
    const leaked = await stage([node('Waldo onboarding smoke test', 'You scheduled a smoke test of Waldo\'s onboarding.', 'w-smoke')]);
    expect(leaked.failed).toEqual(['no node is written from the smoke test or the docs page']);
  });
});
