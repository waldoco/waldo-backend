// The run's settings, all from the environment. Recorded mode (the default) needs nothing and
// reaches no network; live mode needs the model key, the judge key and model, and a call budget.
import OpenAI from 'openai';
import { modelNameSchema, OPENAI_PROVIDER, PROVIDER_OF, WALDO_CHAT_MODEL } from '@waldo/contracts';
import { OpenAIResponsesAdapter } from '../../src/llm/openai';
import { scriptedGateway } from '../../src/testing/scripted-gateway';
import { callBudget } from './budget';
import { assertIndependentJudge, liveJudge, type Judge } from './judge';
import type { NightlyRun } from './suite';

type Env = Readonly<Record<string, string | undefined>>;

const positive = (env: Env, name: string, fallback?: string): number => {
  const raw = env[name] ?? fallback;
  if (raw === undefined) throw new Error(`${name} is required for a live run`);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};
const required = (env: Env, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for a live run`);
  return value;
};

// The dry run: the responder answers with fixed text and every trial passes. It proves the harness
// runs end to end, never the model's quality; its scorecard names the judge "recorded".
const recordedJudge: Judge = async () => ({ outcome: 'pass' });

export const nightlyConfig = (env: Env): NightlyRun => {
  const mode = env.WALDO_EVAL_MODE ?? 'recorded';
  const trials = positive(env, 'WALDO_EVAL_TRIALS', '3');
  if (mode === 'recorded') {
    return {
      trials, budget: callBudget(positive(env, 'WALDO_EVAL_MAX_CALLS', '10000')),
      gateway: () => scriptedGateway({ rules: [], unmatchedText: 'Recorded reply.' }),
      judge: recordedJudge, candidate: 'recorded', judgeModel: 'recorded',
    };
  }
  if (mode !== 'live') throw new Error('WALDO_EVAL_MODE must be recorded or live');
  const model = modelNameSchema.parse(env.WALDO_EVAL_MODEL ?? WALDO_CHAT_MODEL);
  if (PROVIDER_OF[model] !== OPENAI_PROVIDER) throw new Error('WALDO_EVAL_MODEL must be an OpenAI roster model');
  const apiKey = required(env, 'OPENAI_API_KEY');
  const judgeKey = required(env, 'ANTHROPIC_API_KEY');
  const judgeModel = required(env, 'WALDO_EVAL_JUDGE_MODEL');
  assertIndependentJudge(model, judgeModel);
  const budget = callBudget(positive(env, 'WALDO_EVAL_MAX_CALLS'));
  return {
    trials, budget, candidate: model, judgeModel, model,
    // No client retries: every attempt is one counted call.
    gateway: () => new OpenAIResponsesAdapter({ client: new OpenAI({ apiKey, maxRetries: 0, timeout: 60_000 }) }),
    judge: liveJudge({ apiKey: judgeKey, model: judgeModel, budget }),
  };
};
