// CI step after `eval:nightly`: `tsx evals/nightly/report.ts <scorecard.json> <comment.md>`. Writes the PR comment,
// prints any gate failures, and exits 1 when the scorecard misses the thresholds for WALDO_EVAL_MODE.
import { readFileSync, writeFileSync } from 'node:fs';
import { NIGHTLY_SCENARIOS } from './catalogue';
import { gateScorecard, scorecardMarkdown, thresholdsFor } from './gate';
import type { Scorecard } from './scorecard';
import { shardOf } from './shard';
import { selectScenarios } from './subset';

const [cardPath, outPath] = process.argv.slice(2);
if (!cardPath || !outPath) throw new Error('usage: report.ts <scorecard.json> <comment.md>');
const mode = process.env.WALDO_EVAL_MODE;
if (mode !== 'recorded' && mode !== 'live') throw new Error('WALDO_EVAL_MODE must be recorded or live');
const card = JSON.parse(readFileSync(cardPath, 'utf8')) as Scorecard;
// A card from a subset or one shard is held to the size of that part, found the way the run found it.
const expected = card.subset === undefined && card.shard === undefined ? undefined : shardOf(selectScenarios(card.subset, NIGHTLY_SCENARIOS), card.shard).length;
const gate = gateScorecard(card, thresholdsFor(mode, expected));
writeFileSync(outPath, scorecardMarkdown(card, gate, mode));
for (const failure of gate.failures) console.error(`eval gate: ${failure}`);
console.log(`eval gate (${mode}): ${gate.ok ? 'pass' : 'fail'}`);
process.exitCode = gate.ok ? 0 : 1;
