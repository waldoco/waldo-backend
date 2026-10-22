// Nightly eval entry: `pnpm --filter @waldo/runtime eval:nightly`. Settings come from the
// environment (see config.ts). Prints the scorecard; WALDO_EVAL_OUT also writes it to a file.
// WALDO_EVAL_ONLY=<scenario id> runs one scenario and prints its synthetic transcript and the
// judge's reasons (the voice judge's and any failed receipts too), for a local look at a failure.
import { writeFileSync } from 'node:fs';
import { nightlyConfig } from './config';
import { NIGHTLY_SCENARIOS, rawHistoryScenarios } from './catalogue';
import { runNightly } from './suite';

// WALDO_EVAL_MEMORY=raw_history runs the memory cases without a claim store, as the baseline for memory changes;
// its card is not gated. WALDO_EVAL_JUDGE_MODE=joint asks each judge about every dimension in one call (split is the default).
const SCENARIOS = process.env.WALDO_EVAL_MEMORY === 'raw_history' ? rawHistoryScenarios(NIGHTLY_SCENARIOS) : NIGHTLY_SCENARIOS;
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
