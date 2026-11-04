// WALDO_EVAL_SUBSET picks which scenarios a run covers: nothing or `all` for the catalogue, `live` for the scenarios that carry
// live_subset, or scenario ids separated by commas. The value reaches the runner only through the environment, and it is
// checked against the catalogue before any model is built or called, so a stray character or an unknown id spends nothing.
import type { NightlyScenario } from './scenarios';

const SCENARIO_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUBSET_IDS_MAX = 64;

export const selectScenarios = (spec: string | undefined, scenarios: readonly NightlyScenario[]): readonly NightlyScenario[] => {
  const wanted = (spec ?? '').trim();
  if (wanted === '' || wanted === 'all') return scenarios;
  if (wanted === 'live') {
    const live = scenarios.filter((scenario) => scenario.live_subset);
    if (live.length === 0) throw new Error('WALDO_EVAL_SUBSET=live matches no scenario');
    return live;
  }
  const ids = wanted.split(',');
  if (ids.length > SUBSET_IDS_MAX || ids.some((id) => !SCENARIO_ID.test(id))) throw new Error('WALDO_EVAL_SUBSET takes all, live, or scenario ids separated by commas');
  const known = new Set(scenarios.map((scenario) => scenario.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`WALDO_EVAL_SUBSET names no scenario ${unknown.join(', ')}`);
  return scenarios.filter((scenario) => ids.includes(scenario.id));
};
