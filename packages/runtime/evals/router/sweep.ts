// The router's thresholds, chosen from the labelled set instead of guessed.
//   OPENAI_API_KEY=... tsx evals/router/sweep.ts record > verdicts.json   asks the Decisions router about every labelled case
//   tsx evals/router/sweep.ts verdicts.json                               the threshold grid for those verdicts, offline
// Recording spends one Decisions call per case; the sweep makes none. Each case is routed as the first turn of a cold
// conversation, the only place the router's verdict alone decides the tier.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openAIDecisionsRouter } from '../../src/llm/router/decisions';
import { routeTurn, type RouterPolicy, type RouterVerdict, type Tier, type WarmCaches } from '../../src/llm/router/policy';
import { ROUTER_LABELLED, type LabelledCase } from './labelled';

export type RecordedVerdict = Readonly<{ id: string; verdict: RouterVerdict }>;
export type SweepRow = Readonly<{
  escalateAt: number; lunaAt: number;
  // A turn that needed more than the light model and got it: the quality risk.
  light_wrong: number;
  // A demanding turn left on the chat model, and a turn that didn't need the reasoning model but got it: the cost.
  deep_missed: number; deep_wasted: number;
  routed: Readonly<Record<Tier, number>>;
}>;

export const ESCALATE_GRID = [0.5, 0.6, 0.7, 0.8, 0.9] as const;
export const LIGHT_GRID = [0.7, 0.8, 0.9, 0.95] as const;
const COLD: WarmCaches = { light: false, standard: false, deep: false };

export const sweep = (cases: readonly LabelledCase[], recorded: readonly RecordedVerdict[]): SweepRow[] => {
  const verdicts = new Map(recorded.map((row) => [row.id, row.verdict]));
  const missing = cases.filter((labelled) => !verdicts.has(labelled.id)).map((labelled) => labelled.id);
  if (missing.length > 0) throw new Error(`no recorded verdict for ${missing.join(', ')}`);
  return ESCALATE_GRID.flatMap((escalateAt) => LIGHT_GRID.map((lunaAt) => {
    const policy: RouterPolicy = { escalateAt, lunaAt, coldAfterMs: 0 };
    const routed = { light: 0, standard: 0, deep: 0 };
    let light_wrong = 0, deep_missed = 0, deep_wasted = 0;
    for (const labelled of cases) {
      const { tier } = routeTurn(undefined, verdicts.get(labelled.id)!, COLD, 0, policy);
      routed[tier] += 1;
      if (tier === 'light' && labelled.tier !== 'light') light_wrong += 1;
      if (labelled.tier === 'deep' && tier !== 'deep') deep_missed += 1;
      if (tier === 'deep' && labelled.tier !== 'deep') deep_wasted += 1;
    }
    return { escalateAt, lunaAt, light_wrong, deep_missed, deep_wasted, routed };
  }));
};

export const renderSweep = (rows: readonly SweepRow[], total: number): string => [
  `## Router thresholds over ${total} labelled cases`,
  '',
  '| escalateAt | lunaAt | light, wrong | deep, missed | deep, wasted | light / standard / deep |',
  '|---|---|---|---|---|---|',
  ...rows.map((row) => `| ${row.escalateAt} | ${row.lunaAt} | ${row.light_wrong} | ${row.deep_missed} | ${row.deep_wasted} | ${row.routed.light} / ${row.routed.standard} / ${row.routed.deep} |`),
].join('\n');

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [arg] = process.argv.slice(2);
  if (arg === 'record') {
    const router = openAIDecisionsRouter({ apiKey: process.env.OPENAI_API_KEY ?? '' });
    const recorded: RecordedVerdict[] = [];
    for (const labelled of ROUTER_LABELLED) recorded.push({ id: labelled.id, verdict: await router.route(labelled.turns) });
    // The router answers null for a bad key or a dead network as well as a refusal, so a run of nothing but nulls is a
    // broken recording, not a result.
    if (recorded.every((row) => row.verdict === null)) throw new Error('the router answered no case: check OPENAI_API_KEY and the network');
    process.stdout.write(`${JSON.stringify(recorded, null, 2)}\n`);
  } else if (arg) {
    process.stdout.write(`${renderSweep(sweep(ROUTER_LABELLED, JSON.parse(readFileSync(arg, 'utf8')) as RecordedVerdict[]), ROUTER_LABELLED.length)}\n`);
  } else {
    process.stderr.write('usage: tsx evals/router/sweep.ts record | <verdicts.json>\n');
    process.exitCode = 2;
  }
}
