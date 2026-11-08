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
  it('runs the good-day Brief, the Check-in, the Close, the capacity Close, the Brief a WhatsApp copy repeats word for word and the capacity budget Brief nightly, each with a receipt, a rubric, a voice rubric and a card step', () => {
    expect(CARD_SCENARIOS.map((entry) => entry.id)).toEqual(['d1-brief-good-day-one-line', 'd2-checkin-rest-of-low-day', 'd3-close-one-body-line', 'd4-close-tomorrow-deep-work', 'd5-brief-stands-alone-as-chat', 'd6-brief-budget-moves-what-can-give']);
    for (const entry of CARD_SCENARIOS) {
      expect(NIGHTLY_SCENARIOS).toContain(entry);
      expect(entry.receipts?.length, entry.id).toBeGreaterThan(0);
      expect(entry.rubric.must_not.length, entry.id).toBeGreaterThan(0);
      // The voice judge grades a trial only when its scenario carries a voice rubric, and the cards are what owners read most.
      expect(entry.rubric.voice?.moment, entry.id).toBeTruthy();
      expect(entry.steps.some((step) => 'card' in step), entry.id).toBe(true);
    }
  });
});

describe('a day card in the nightly world', () => {
  it('d5: asks the card model for a clash the Brief must name, through the same card prompt the app and WhatsApp share', async () => {
    const { failed, sent } = await card('d5-brief-stands-alone-as-chat', 'Friday: board review 11 to 1. Design review and spin class overlap from 5:30 to 6:30; want me to move the spin class to 7?');
    expect(failed).toEqual([]);
    expect(sent[0]).toContain('Design review');
    expect(sent[0]).toContain('Spin class with Dev');
    expect(sent[0]).toContain('compact card for chat');
  });

  it('d1: shows the Brief the great night, and a card that quotes the score fails', async () => {
    const honest = await card('d1-brief-good-day-one-line', 'Friday: board review 11 to 1, design review at 3, spin at 6. A good day against your baseline.');
    expect(honest.failed).toEqual([]);
    expect(honest.sent[0]).toContain('Form zone:');
    expect(honest.sent[0]).not.toContain('86.1');
    expect((await card('d1-brief-good-day-one-line', 'Friday looks good: Form is 86.1.')).failed).toEqual(['no score or reading appears on a card']);
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

  it('d4: one deep-work card for tomorrow passes, and a Close that raises a second card fails', async () => {
    const hold = (from: string, to: string, title: string) => ({ name: 'propose_calendar_change',
      arguments: { action: 'create', title, start: `2026-09-25T${from}:00+05:30`, end: `2026-09-25T${to}:00+05:30`, block: 'deep_work', reason: 'Your best hours come early' } });
    const close = async (calls: ReturnType<typeof hold>[]) => {
      const gateway = scriptedGateway({ rules: [{ match: /Scheduled card/, rounds: [{ toolCalls: calls }, { text: 'Friday: hold the early stretch before Standup; the card waits on your yes.' }] }], unmatchedText: 'ok' });
      const record = await runTrial(scenario('d4-close-tomorrow-deep-work'), { gateway, budget: callBudget(10) });
      expect(record.status).toBe('ran');
      return failedReceipts([...STATE_INVARIANTS, ...scenario('d4-close-tomorrow-deep-work').receipts!], record);
    };
    expect(await close([hold('07:30', '09:30', 'Deck')])).toEqual([]);
    expect(await close([hold('07:30', '09:30', 'Deck'), hold('16:45', '18:00', 'Notes')])).toEqual(['at most one card']);
  });

  it('sends nothing when the card says SKIP', async () => {
    const { record } = await card('d1-brief-good-day-one-line', 'SKIP');
    expect(record.transcript.filter((turn) => turn.role === 'waldo')).toEqual([]);
  });

  it('d6: the planning Brief reads the week ahead, one move passes, and a Brief that raises a second card fails', async () => {
    const move = (id: string, title: string, day: string, from: string, to: string) => ({ name: 'propose_calendar_change',
      arguments: { action: 'move', event_id: id, title, start: `2026-09-${day}T${from}:00+05:30`, end: `2026-09-${day}T${to}:00+05:30`, reason: 'Today runs past what holds for you' } });
    const brief = async (calls: ReturnType<typeof move>[]) => {
      const gateway = scriptedGateway({ rules: [{ match: /Scheduled card/, rounds: [{ toolCalls: calls }, { text: 'Thursday asks more than holds; the expense report can wait for Monday, on a card for your yes.' }] }], unmatchedText: 'ok' });
      const record = await runTrial(scenario('d6-brief-budget-moves-what-can-give'), { gateway, budget: callBudget(10) });
      expect(record.status).toBe('ran');
      return failedReceipts([...STATE_INVARIANTS, ...scenario('d6-brief-budget-moves-what-can-give').receipts!], record);
    };
    expect(await brief([move('cb-expenses', 'Expense report', '28', '13:30', '14:30')])).toEqual([]);
    expect(await brief([move('cb-expenses', 'Expense report', '28', '13:30', '14:30'), move('cb-standup', 'Standup', '25', '09:30', '09:45')])).toEqual(['at most one card']);
  });
});

describe('the live call plan', () => {
  it('counts a day card and a health change as one model turn each', () => {
    const base = { ...CARD_SCENARIOS[0]!, steps: [{ health: 'shared' }, { card: 'card:brief' }, { health_change: true }] } as unknown as (typeof NIGHTLY_SCENARIOS)[number];
    expect(callPlan([base], 3).owner_turns).toBe(6);
  });
});
