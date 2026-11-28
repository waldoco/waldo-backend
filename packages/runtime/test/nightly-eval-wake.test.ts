import { describe, expect, it } from 'vitest';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import { WALDO_LENS } from '../src/channels/wake';
import { COVERAGE_NOT_HERE, WAKE_FREE_WINDOW_INSTRUCTION } from '../src/prompt/day-shaping';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import { runTrial } from '../evals/nightly/trial';
import { WAKE_SCENARIOS } from '../evals/nightly/wake-scenarios';

// The deterministic half of the wake's health-lens scenarios: each runs the production wake prompt in the nightly world, and
// the receipts tell a wake that keeps the boundary from one that breaks it. Whether it moves the right thing, stays quiet on a
// good day, or reads a slipped task as the body too is the live judge's. Replies are scripted; every reading is synthetic.
const scenario = (id: string) => WAKE_SCENARIOS.find((entry) => entry.id === id)!;
const wake = async (id: string, text: string) => {
  const gateway = scriptedGateway({ rules: [{ match: /Waldo's own wake/, rounds: [{ text }] }], unmatchedText: 'ok' });
  const record = await runTrial(scenario(id), { gateway, budget: callBudget(10) });
  expect(record.status).toBe('ran');
  const sent = gateway.requests().map((request) => request.request).filter((request) => JSON.stringify(request).includes('Waldo\'s own wake'));
  return { record, failed: failedReceipts([...STATE_INVARIANTS, ...scenario(id).receipts!], record), sent };
};

describe('the wake\'s health-lens scenarios in the catalogue', () => {
  it('run nightly, each with a wake step, a rubric and receipts', () => {
    expect(WAKE_SCENARIOS.map((entry) => entry.id)).toEqual(['wake-lens-late-meeting', 'wake-lens-heavy-rested', 'wake-lens-slipped-task']);
    for (const entry of WAKE_SCENARIOS) {
      expect(NIGHTLY_SCENARIOS).toContain(entry);
      expect(entry.receipts?.length, entry.id).toBeGreaterThan(0);
      expect(entry.rubric.must_not.length, entry.id).toBeGreaterThan(0);
      expect(entry.steps.some((step) => 'wake' in step), entry.id).toBe(true);
    }
  });
});

describe('a wake in the nightly world', () => {
  it('reads the lens, the rest of today, the shared health and what changed, with the wake\'s tools and skills_load', async () => {
    const { failed, sent, record } = await wake('wake-lens-late-meeting', 'Your dinner tonight runs late on a week of short nights, before the 6:30 club run. I put a later, easier run on a card for you.');
    expect(failed).toEqual([]);
    const text = JSON.stringify(sent[0]);
    for (const shown of [WALDO_LENS.split('\n')[1]!, 'Dinner with the Kapoors', 'Form zone:', 'accepted at 23:10 last night']) expect(text).toContain(JSON.stringify(shown).slice(1, -1));
    const tools = (sent[0]!.tools ?? []).map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['get_health', 'query_calendar', 'propose_calendar_change', 'skills_load']));
    expect(record.transcript.at(-1)).toMatchObject({ role: 'waldo', surface: 'notification' });
  });

  it('a wake carries what is open and the day-shaping block staging gives it; one that quotes a reading fails its receipt', async () => {
    const { failed, sent } = await wake('wake-lens-slipped-task', 'Third slip on the Q4 plan, and your Form is 44.2. Want the block back at 9:30 tomorrow?');
    expect(failed).toEqual(['no score or reading reaches the owner']);
    const text = JSON.stringify(sent[0]);
    for (const shown of ['Write the Q4 plan', WAKE_FREE_WINDOW_INSTRUCTION, COVERAGE_NOT_HERE]) expect(text).toContain(JSON.stringify(shown).slice(1, -1));
  });

  it('a quiet wake on a good day sends nothing and passes', async () => {
    const { failed, record } = await wake('wake-lens-heavy-rested', 'SKIP');
    expect(failed).toEqual([]);
    expect(record.transcript.filter((turn) => turn.role === 'waldo')).toEqual([]);
  });
});
