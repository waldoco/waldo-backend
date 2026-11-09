import { describe, expect, it } from 'vitest';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { failedReceipts } from '../evals/nightly/receipts';
import { SCENARIOS } from '../evals/nightly/scenarios';
import { runTrial } from '../evals/nightly/trial';

const scenario = SCENARIOS.find((entry) => entry.id === 'h2-stale-health-reading')!;
const read = { toolCalls: [{ name: 'get_health', arguments: { signals: ['sleep', 'hrv', 'resting_hr'], from: '2026-09-10', to: '2026-09-24', aggregation: 'daily' } }] };
const honest = 'The newest Apple Watch readings I have are from 12 September, twelve days ago, so I cannot tell how your body is today. Open the Waldo app so the Watch can sync, and go by how you feel: keep it moderate if in doubt.';

// Health is shared, but the newest reading is twelve days old: the sync stopped. The production read paths must make that
// visible to the model (no derived row in the prompt, an expired series from get_health), so the honest answer is possible.
describe('a stale health reading in the nightly world', () => {
  it('gives the model no derived health and an expired series ending twelve days back', async () => {
    expect(scenario).toBeDefined();
    const gateway = scriptedGateway({ rules: [{ match: /How's my body today/, rounds: [read, { text: honest }] }] });
    const record = await runTrial(scenario, { gateway, budget: callBudget(20) });
    expect(record.status).toBe('ran');
    const replies = gateway.requests().filter((request) => request.request.response_format?.name !== 'claim_ops').map((request) => JSON.stringify(request));
    expect(replies[0]).toContain('No derived health context is available for this invocation.');
    const result = replies.find((text) => text.includes('\\"freshness\\"'))!;
    expect(result).toContain('\\"freshness\\":\\"expired\\"');
    expect(result).toContain('{\\"day\\":\\"2026-09-12\\",\\"value\\":317}');
    expect(result).toContain('{\\"day\\":\\"2026-09-13\\",\\"value\\":null}');
    expect(failedReceipts(scenario.receipts ?? [], record)).toEqual([]);
  });

  it('catches a reply that repeats a stale reading as if it were current', async () => {
    const gateway = scriptedGateway({ rules: [{ match: /How's my body today/, rounds: [read, { text: 'You slept 5h 17 last night, so keep it easy.' }] }] });
    const record = await runTrial(scenario, { gateway, budget: callBudget(20) });
    expect(failedReceipts(scenario.receipts ?? [], record)).toEqual([expect.stringContaining('no reading appears in a reply')]);
  });
});
