// One mechanism for both judges: a rubric split into dimensions, each answered met, not met, or unknown (null: the
// evidence does not settle it). split asks the judge model about one dimension per call, so no dimension's answer
// colours another's; joint asks about all of them in one call, at a fraction of the calls. A dimension not met fails
// the trial; otherwise an unknown leaves it ungraded; only a trial with every dimension met passes.
import { z } from 'zod';
import { askJudgeModel, jsonIn, type JudgeModelConfig } from './anthropic';

export type JudgeMode = 'split' | 'joint';
export const JUDGE_MODES: readonly JudgeMode[] = ['split', 'joint'];
export type Dimension = Readonly<{ key: string; definition: string }>;
export type DimensionResult = Readonly<{ met: boolean | null; why: string }>;
export type DimensionRun =
  | Readonly<{ status: 'judged'; results: Readonly<Record<string, DimensionResult>> }>
  | Readonly<{ status: 'judge_error' | 'budget_exhausted' }>;

const result = z.object({ met: z.boolean().nullable(), why: z.string() }).strict();
const UNKNOWN = 'Use null when the evidence in front of you does not settle it; never guess. Keep each why to one sentence.';

const shape = (keys: readonly string[]) => `{${keys.map((key) => `"${key}":{"met":true|false|null,"why":"..."}`).join(',')}}`;

export const judgeDimensions = async (
  config: JudgeModelConfig, mode: JudgeMode, preamble: string, dimensions: readonly Dimension[], packet: string,
): Promise<DimensionRun> => {
  const asks = mode === 'joint'
    ? [{ keys: dimensions.map((entry) => entry.key), system: `${preamble}\n\nJudge each of these dimensions:\n${dimensions.map((entry) => `- ${entry.key}: ${entry.definition}`).join('\n')}\n${UNKNOWN}\nAnswer with JSON only: ${shape(dimensions.map((entry) => entry.key))}.` }]
    : dimensions.map((entry) => ({ keys: [entry.key], system: `${preamble}\n\nJudge one dimension only, and nothing else about the trial:\n- ${entry.key}: ${entry.definition}\n${UNKNOWN}\nAnswer with JSON only: ${shape([entry.key])}.` }));
  // A trial's split calls are independent, so they run together: wall time stays near one call's, not six.
  const texts = await Promise.all(asks.map((ask) => askJudgeModel(config, ask.system, packet)));
  if (texts.includes('budget_exhausted')) return { status: 'budget_exhausted' };
  const results: Record<string, DimensionResult> = {};
  for (const [index, ask] of asks.entries()) {
    const text = texts[index];
    if (typeof text !== 'string') return { status: 'judge_error' };
    const parsed = z.object(Object.fromEntries(ask.keys.map((key) => [key, result]))).safeParse(jsonIn(text));
    if (!parsed.success) return { status: 'judge_error' };
    Object.assign(results, parsed.data);
  }
  return { status: 'judged', results };
};

export const combineDimensions = (results: Readonly<Record<string, DimensionResult>>): 'pass' | 'fail' | 'judge_error' => {
  const values = Object.values(results).map((entry) => entry.met);
  if (values.includes(false)) return 'fail';
  return values.includes(null) ? 'judge_error' : 'pass';
};

export const judgeModeOf = (raw: string | undefined): JudgeMode => {
  const mode = raw ?? 'split';
  if (mode !== 'split' && mode !== 'joint') throw new Error('WALDO_EVAL_JUDGE_MODE must be split or joint');
  return mode;
};
