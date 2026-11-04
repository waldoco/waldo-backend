import { appendFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { browserUseErrandEngine } from '../../src/channels/browser-use-errand-engine';
import { bakeoffTargetsSchema, liveBakeoffConfig } from './live-config';
import { runErrand, scoreBakeoff, type AccountOracle, type BakeoffRun } from './runner';
import { BAKEOFF_SPECS } from './specs';

// Operator-run entry: pnpm --filter @waldo/runtime exec tsx evals/browser-errand-bakeoff/live.ts
// The operator is the account oracle: they look at the test account and type what it shows.
const config = liveBakeoffConfig(process.env);
const targets = bakeoffTargetsSchema.parse(JSON.parse(await readFile(config.targetsPath, 'utf8')));
const io = createInterface({ input: process.stdin, output: process.stdout });
const oracle: AccountOracle = async (spec, _target, keys) => {
  const answer = await io.question(`[${spec.type}] Look at the test account. As JSON, what does it show for ${keys.join(', ')}? (blank if you cannot tell) `);
  try { return answer.trim() ? JSON.parse(answer) as Record<string, string> : null; } catch { return null; }
};
// Each result is appended as it lands, so an interrupted bake-off keeps what it measured.
const resultsPath = `${config.targetsPath}.results.jsonl`;
const runs: BakeoffRun[] = [];
let spent = 0;
outer: for (const spec of BAKEOFF_SPECS) {
  const target = targets[spec.type];
  if (!target) continue;
  for (let run = 1; run <= config.runsPerType; run++) {
    if (spent + config.maxCostUsdPerRun > config.spendCapUsd) { console.log(`Stopping: the next run could pass the $${config.spendCapUsd} cap.`); break outer; }
    const engine = browserUseErrandEngine({ apiKey: config.apiKey, maxCostUsdPerRun: config.maxCostUsdPerRun });
    let result: BakeoffRun;
    try {
      result = await runErrand({ engineName: 'browser_use_v4', engine, spec, target, run, oracle, now: Date.now,
      takeover: async live => { console.log(`Sign in to the test account here, then press Enter: ${live}`); return (await io.question('Signed-in account name: ')).trim() || null; },
      approve: async (facts, finalAction) => (await io.question(`[${spec.type}] Card: ${finalAction} ${JSON.stringify(facts)}. Is every fact right and should it go ahead? (y/n) `)).trim().toLowerCase() === 'y' });
    } catch (error) {
      console.log(`[${spec.type}] run ${run} could not start (${error instanceof Error ? error.name : 'unknown'}); skipping it.`);
      continue;
    }
    runs.push(result);
    await appendFile(resultsPath, `${JSON.stringify(result)}\n`);
    if (result.costUsd === null) { console.log('Stopping: the vendor did not report this run\'s full cost, so the cap cannot be enforced.'); break outer; }
    spent += result.costUsd;
  }
}
io.close();
console.log(JSON.stringify({ spentUsd: spent, runs, scores: scoreBakeoff(runs) }, null, 2));
