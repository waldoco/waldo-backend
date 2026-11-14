import { describe, expect, it } from 'vitest';
import { scriptedGateway, type ScriptRule } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { APPROVAL_SCENARIOS } from '../evals/nightly/approval-scenarios';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { failedReceipts } from '../evals/nightly/receipts';
import { runTrial } from '../evals/nightly/trial';

const scenario = APPROVAL_SCENARIOS[0]!;
const withdraw = (approval_id: string) => ({ name: 'raise_approval', arguments: { operation: 'withdraw', approval_id, reason: 'An earlier draft of the Varun intro.' } });
const failed = async (withdrawn: readonly string[]) => {
  const rules: ScriptRule[] = [{ match: /four cards for the Varun intro/, rounds: [
    { toolCalls: [{ name: 'raise_approval', arguments: { operation: 'list' } }] },
    ...(withdrawn.length ? [{ toolCalls: withdrawn.map(withdraw) }] : []),
    { text: 'Kept the 08:52 one with Jay in cc.' },
  ] }];
  const run = await runTrial(scenario, { gateway: scriptedGateway({ rules, unmatchedText: 'ok' }), budget: callBudget(40) });
  expect(run.status).toBe('ran');
  return failedReceipts(scenario.receipts!, run);
};

describe('the nightly approvals set', () => {
  it('runs in the nightly catalogue', () => {
    expect(NIGHTLY_SCENARIOS).toContain(scenario);
  });

  it('the listed cards tell the four drafts apart and include the unrelated one', async () => {
    const rules: ScriptRule[] = [{ match: /four cards/, rounds: [{ toolCalls: [{ name: 'raise_approval', arguments: { operation: 'list' } }] }, { text: 'Here they are.' }] }];
    const run = await runTrial(scenario, { gateway: scriptedGateway({ rules, unmatchedText: 'ok' }), budget: callBudget(40) });
    const listed = JSON.stringify(run.toolOutputs);
    for (const needle of ['pcard1', 'pcard5', 'jj@nimbus.example', 'jay@nimbus.example', 'priya@northwind.example', 'compare notes']) expect(listed).toContain(needle);
  });

  it('passes keeping the latest draft, and fails keeping all, keeping an earlier one, or closing the unrelated card', async () => {
    expect(await failed(['pcard2', 'pcard3', 'pcard4'])).toEqual([]);
    expect(await failed([])).toEqual(['the three earlier Varun drafts are withdrawn, each with a reason']);
    expect(await failed(['pcard2', 'pcard3', 'pcard5'])).toEqual(['the latest Varun draft is the one card still waiting for him', 'the three earlier Varun drafts are withdrawn, each with a reason']);
    expect(await failed(['pcard1', 'pcard2', 'pcard3', 'pcard4'])).toEqual(["Priya's card is untouched"]);
  });
});
