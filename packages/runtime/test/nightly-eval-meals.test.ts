import { describe, expect, it } from 'vitest';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { LIVE_RUNS, liveRunPlan } from '../evals/nightly/live-plan';
import { MEAL_SCENARIOS } from '../evals/nightly/meal-scenarios';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import { runTrial } from '../evals/nightly/trial';

// The recorded half of the Indian-meal set: each scenario runs through the production responder in the nightly world with the
// production log tools, a scripted model logs what the script says, and the receipts tell a portion-aware log from one that
// is not. How good the live model's estimate and wording are is the judges'. Every figure here is synthetic.
type Meal = Readonly<{ description: string; items?: readonly string[]; calories_estimate?: number }>;
const scenario = (id: string) => MEAL_SCENARIOS.find((entry) => entry.id === id)!;
const trial = async (id: string, logs: readonly Meal[]) => {
  const entry = scenario(id);
  const said = entry.steps.find((step) => 'say' in step);
  const rules = [{
    match: new RegExp((said && 'say' in said ? said.say : '').slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    rounds: [...logs.map((meal) => ({ toolCalls: [{ name: 'log_meal', arguments: meal }] })), { text: 'Logged, with the calories as a rough estimate.' }],
  }];
  const record = await runTrial(entry, { gateway: scriptedGateway({ rules, unmatchedText: 'ok' }), budget: callBudget(16) });
  expect(record.status).toBe('ran');
  return { record, failed: failedReceipts([...STATE_INVARIANTS, ...(entry.receipts ?? [])], record) };
};

describe('the Indian-meal set in the catalogue', () => {
  it('replaces two cases rather than adding any, and the weekly run stays within its cap', () => {
    expect(MEAL_SCENARIOS.map((entry) => entry.id)).toEqual(['n1-thali-portions', 'n2-breakfast-and-street-plate']);
    expect(NIGHTLY_SCENARIOS).toHaveLength(159);
    for (const gone of ['t16-rough-day', 't14-birthday-note']) {
      expect(NIGHTLY_SCENARIOS.map((entry) => entry.id)).not.toContain(gone);
    }
    for (const entry of MEAL_SCENARIOS) {
      expect(NIGHTLY_SCENARIOS).toContain(entry);
      expect(entry.receipts?.length, entry.id).toBeGreaterThan(0);
      expect(entry.blocked, entry.id).toBeUndefined();
    }
    const plan = liveRunPlan('all', NIGHTLY_SCENARIOS);
    expect(plan.shards.reduce((sum, shard) => sum + shard.cap, 0)).toBeLessThanOrEqual(LIVE_RUNS.all.total_cap);
  });
});

describe('a meal logged in the nightly world', () => {
  const lunch = { description: '2 phulkas, 1 katori toor dal, 1 katori rice, bhindi sabzi and a small bowl of curd', items: ['phulka x2', 'toor dal, 1 katori', 'rice, 1 katori', 'bhindi sabzi', 'curd'], calories_estimate: 620 };

  it('n1: lunch and the doubled dinner, logged once each with the dinner about twice lunch, pass', async () => {
    const { record, failed } = await trial('n1-thali-portions', [lunch, { ...lunch, description: 'The same thali, double of everything', calories_estimate: 1240 }]);
    expect(record.tools.filter((tool) => tool.name === 'log_meal')).toEqual([{ name: 'log_meal', ok: true }, { name: 'log_meal', ok: true }]);
    expect(failed).toEqual([]);
  });

  it('n1: a dinner estimated as if nothing were doubled fails the portion receipt', async () => {
    const { failed } = await trial('n1-thali-portions', [lunch, { ...lunch, description: 'Same thali for dinner', calories_estimate: 650 }]);
    expect(failed).toEqual(['lunch is estimated from its portions, and the doubled dinner at about twice lunch']);
  });

  it('n1: a lunch logged with no estimate, or a dinner never logged, fails', async () => {
    const { calories_estimate: _dropped, ...noEstimate } = lunch;
    expect((await trial('n1-thali-portions', [noEstimate, { ...lunch, calories_estimate: 1240 }])).failed)
      .toEqual(['lunch is estimated from its portions, and the doubled dinner at about twice lunch']);
    expect((await trial('n1-thali-portions', [lunch])).failed)
      .toEqual(['lunch and dinner are logged once each', 'lunch is estimated from its portions, and the doubled dinner at about twice lunch']);
  });

  it('n2: the breakfast and the stall plate, each in range, pass; a stall plate far outside its portions, a dropped lassi or a third log fails', async () => {
    const breakfast = { description: '2 aloo parathe with butter and a glass of meethi lassi', items: ['aloo paratha x2', 'butter', 'meethi lassi, 1 glass'], calories_estimate: 900 };
    const plate = { description: 'Pav bhaji at the stall near office, 2 pav with extra butter', calories_estimate: 750 };
    expect((await trial('n2-breakfast-and-street-plate', [breakfast, plate])).failed).toEqual([]);
    const portions = 'the breakfast is logged with the parathas and the lassi, and the dinner as pav bhaji, each with an estimate for the portions said';
    expect((await trial('n2-breakfast-and-street-plate', [breakfast, { ...plate, calories_estimate: 180 }])).failed).toEqual([portions]);
    expect((await trial('n2-breakfast-and-street-plate', [{ description: '2 aloo parathe with butter', calories_estimate: 650 }, plate])).failed).toEqual([portions]);
    expect((await trial('n2-breakfast-and-street-plate', [breakfast, plate, { ...plate, description: 'Extra butter on the pav bhaji' }])).failed)
      .toEqual(['breakfast and dinner are logged once each']);
  });

  it('only the meal scenarios are offered the log tools', async () => {
    const other = NIGHTLY_SCENARIOS.find((entry) => entry.id === 't01-calendar-free-hour')!;
    const gateway = scriptedGateway({ rules: [], unmatchedText: 'ok' });
    await runTrial(other, { gateway, budget: callBudget(8) });
    const offered = gateway.requests().flatMap((request) => (request.request.tools ?? []).map((tool) => tool.name));
    expect(offered).not.toContain('log_meal');
  });
});
