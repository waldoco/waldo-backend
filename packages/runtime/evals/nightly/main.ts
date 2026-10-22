// Nightly eval entry: `pnpm --filter @waldo/runtime eval:nightly`. Settings come from the
// environment (see config.ts). Prints the scorecard; WALDO_EVAL_OUT also writes it to a file.
// WALDO_EVAL_ONLY=<scenario id> runs one scenario and prints its synthetic transcript and the
// judge's reasons (the voice judge's and any failed receipts too), for a local look at a failure.
// WALDO_EVAL_RULES=1 prints the behaviour rules with their ids and standing, and runs nothing.
// WALDO_EVAL_VERDICT=<rule id> with WALDO_EVAL_RUNS=<baseline.json>:<ablated.json>[,...] prints that rule's verdict from
// scorecards already written, and runs nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { ablationVerdict } from './ablation';
import { nightlyConfig } from './config';
import { NIGHTLY_SCENARIOS as SCENARIOS } from './catalogue';
import { evalBehaviourPrompt, ruleInventory } from './rules';
import type { Scorecard } from './scorecard';
import { runNightly } from './suite';

if (process.env.WALDO_EVAL_RULES) {
  const inventory = await ruleInventory(evalBehaviourPrompt());
  console.log(JSON.stringify(inventory.map(({ rule, ...standing }) => ({ id: rule.id, section: rule.section, ...standing, text: rule.text })), null, 2));
} else if (process.env.WALDO_EVAL_VERDICT) {
  const id = process.env.WALDO_EVAL_VERDICT;
  const status = (await ruleInventory(evalBehaviourPrompt())).find((entry) => entry.rule.id === id);
  if (!status) throw new Error(`no rule ${id}`);
  const card = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Scorecard;
  const runs = (process.env.WALDO_EVAL_RUNS ?? '').split(',').filter(Boolean).map((pair) => {
    const [baseline, ablated] = pair.split(':');
    if (!baseline || !ablated) throw new Error('WALDO_EVAL_RUNS takes <baseline.json>:<ablated.json> pairs');
    return { baseline: card(baseline), ablated: card(ablated) };
  });
  console.log(JSON.stringify({ id, ...ablationVerdict(status, runs) }, null, 2));
} else {
  const only = process.env.WALDO_EVAL_ONLY;
  const scenarios = only ? SCENARIOS.filter((scenario) => scenario.id === only) : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`no scenario ${only}`);
  const config = nightlyConfig(process.env);
  const card = await runNightly(scenarios, {
    ...config,
    ...(only ? { show: (scenario, record, verdict, checks) => console.log(JSON.stringify({ scenario: scenario.id, verdict, ...checks, transcript: record.transcript, tools: record.tools, effects: record.effects }, null, 2)) } : {}),
  });
  const text = JSON.stringify(card, null, 2);
  if (process.env.WALDO_EVAL_OUT) writeFileSync(process.env.WALDO_EVAL_OUT, `${text}\n`);
  console.log(text);
}
