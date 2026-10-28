import { describe, expect, it } from 'vitest';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { CARD_SCENARIOS } from '../evals/nightly/card-scenarios';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { callPlan } from '../evals/nightly/plan';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import { runTrial } from '../evals/nightly/trial';

// The deterministic half of the day-card set beyond the Brief's health cases: a good-day Brief, the Check-in and the Close
// run through the production card prompt in the nightly world, and the receipts tell a card that keeps the boundary from
// one that breaks it. How well a card names the body is the live judge's. Replies are scripted; every reading is synthetic.
const scenario = (id: string) => CARD_SCENARIOS.find((entry) => entry.id === id)!;
const card = async (id: string, text: string) => {
  const gateway = scriptedGateway({ rules: [{ match: /Scheduled card/, rounds: [{ text }] }], unmatchedText: 'ok' });
  const record = await runTrial(scenario(id), { gateway, budget: callBudget(10) });
  expect(record.status).toBe('ran');
  const sent = gateway.requests().map((request) => JSON.stringify(request.request)).filter((text) => text.includes('Scheduled card'));
  return { record, failed: failedReceipts([...STATE_INVARIANTS, ...scenario(id).receipts!], record), sent };
};

describe('the day-card set in the catalogue', () => {
  it('runs the good-day Brief, the Check-in and the Close nightly, each with a receipt, a rubric and a card step', () => {
    expect(CARD_SCENARIOS.map((entry) => entry.id)).toEqual(['d1-brief-good-day-one-line', 'd2-checkin-rest-of-low-day', 'd3-close-one-body-line']);
    for (const entry of CARD_SCENARIOS) {
      expect(NIGHTLY_SCENARIOS).toContain(entry);
      expect(entry.receipts?.length, entry.id).toBeGreaterThan(0);
      expect(entry.rubric.must_not.length, entry.id).toBeGreaterThan(0);
      expect(entry.steps.some((step) => 'card' in step), entry.id).toBe(true);
    }
  });
});

describe('a day card in the nightly world', () => {
  it('d1: shows the Brief the good day, and a card that quotes the score fails', async () => {
    const honest = await card('d1-brief-good-day-one-line', 'Friday: board review 11 to 1, design review at 3, spin at 6. A good day against your baseline.');
    expect(honest.failed).toEqual([]);
    expect(honest.sent[0]).toContain('Form zone:');
    expect(honest.sent[0]).not.toContain('66.1');
    expect((await card('d1-brief-good-day-one-line', 'Friday looks good: Form is 66.1.')).failed).toEqual(['no score or reading appears on a card']);
  });

  it('d2: shows the Check-in only what is left of the day, with the shared health', async () => {
    const { failed, sent } = await card('d2-checkin-rest-of-low-day', 'Design review at 3 and spin at 6 are left. You are running low, so want me to ease the spin class?');
    expect(failed).toEqual([]);
    expect(sent[0]).toContain('Check-in');
    expect(sent[0]).toContain('Spin class with Dev');
    expect(sent[0]).not.toContain('Standup');
    expect(sent[0]).toContain('Form zone:');
  });

  it('d3: shows the Close tomorrow\'s first thing, and a Close that quotes a reading fails', async () => {
    const { failed, sent } = await card('d3-close-one-body-line', 'A long day done. Breakfast with Mira at 9 tomorrow; an early night would set it up.');
    expect(failed).toEqual([]);
    expect(sent[0]).toContain('Breakfast with Mira');
    expect((await card('d3-close-one-body-line', 'Done for today. Form 29.4, so sleep early.')).failed).toEqual(['no score or reading appears on a card']);
  });

  it('sends nothing when the card says SKIP', async () => {
    const { record } = await card('d1-brief-good-day-one-line', 'SKIP');
    expect(record.transcript.filter((turn) => turn.role === 'waldo')).toEqual([]);
  });
});

describe('the live call plan', () => {
  it('counts a day card and a health change as one model turn each', () => {
    const base = { ...CARD_SCENARIOS[0]!, steps: [{ health: 'shared' }, { card: 'card:brief' }, { health_change: true }] } as unknown as (typeof NIGHTLY_SCENARIOS)[number];
    expect(callPlan([base], 3).owner_turns).toBe(6);
  });
});
