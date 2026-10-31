// The run's settings, all from the environment. The mode is always named, so a scheduled host never
// gets the dry run by accident. Recorded mode needs nothing and reaches no network; live mode needs
// the model key, the judge key and model, and a call budget.
import OpenAI from 'openai';
import { ANTHROPIC_PROVIDER, modelNameSchema, OPENAI_PROVIDER, PROVIDER_OF, WALDO_AUXILIARY_FALLBACK_MODEL, WALDO_CHAT_FALLBACK_MODEL, WALDO_CHAT_MODEL } from '@waldo/contracts';
import { AnthropicMessagesAdapter } from '../../src/llm/anthropic';
import { validModelCredential } from '../../src/llm/credential-shape';
import { OpenAIResponsesAdapter } from '../../src/llm/openai';
import { routedGateway } from '../../src/llm/provider';
import { scriptedGateway } from '../../src/testing/scripted-gateway';
import { ablating, ablationLabel } from './ablation';
import { callBudget } from './budget';
import { assertIndependentJudge, liveJudge, type Judge } from './judge';
import { liveVoiceJudge } from './voice';
import { judgeModeOf } from './dimensions';
import { readStagingVars, stagingProfile, type StagingProfile, type StagingVars } from './staging-profile';
import type { MemoryMode } from './world';
import { compactionSettings, type CompactionSettings } from '../../src/conversation/compaction';
import { fakeEmbeddings } from '../../src/testing/fake-embeddings';
import { workersAiRest } from './embeddings';
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

// The dry run: the responder answers with fixed text and nothing is graded, so its card shows no pass
// rate at all. It proves the harness runs end to end, never the model's quality.
const recordedJudge: Judge = async () => ({ outcome: 'judge_error' });

// WALDO_EVAL_ABLATE=<rule id>[,<rule id>...] takes those behaviour rules out of every reply's system prompt (rules.ts lists
// them); the scorecard's candidate names them, so it is compared only with an unablated run.
const withAblation = (run: NightlyRun, env: Env): NightlyRun => {
  const ids = (env.WALDO_EVAL_ABLATE ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!ids.length) return run;
  if (!ids.every((id) => /^[0-9a-f]{8}$/.test(id))) throw new Error('WALDO_EVAL_ABLATE takes 8-hex rule ids');
  let misses = 0;
  return { ...run, gateway: () => ablating(run.gateway(), ids, () => { misses += 1; }), candidate: ablationLabel(run.candidate, ids), ablationMisses: () => misses };
};

// WALDO_EVAL_PROFILE=staging runs the staging Worker's turn shape (staging-profile.ts): its tool loader, compaction and forget
// barrier from wrangler.jsonc, and the Anthropic fallback the owner route takes when the first model fails. The profile and
// the two settings it would contradict are never set together, so a card is never half one and half the other.
const profileOf = (env: Env, vars: () => StagingVars): StagingProfile | undefined => {
  const named = env.WALDO_EVAL_PROFILE;
  if (named === undefined || named === '') return undefined;
  if (named !== 'staging') throw new Error('WALDO_EVAL_PROFILE must be staging when set');
  if (env.WALDO_EVAL_TOOL_SEARCH !== undefined || env.WALDO_EVAL_COMPACTION !== undefined || env.WALDO_EVAL_SEMANTIC !== undefined || env.WALDO_EVAL_MEMORY_SELECTION !== undefined) throw new Error('WALDO_EVAL_PROFILE=staging sets the tool menu, compaction, semantic recall and memory selection; leave WALDO_EVAL_TOOL_SEARCH, WALDO_EVAL_COMPACTION, WALDO_EVAL_SEMANTIC and WALDO_EVAL_MEMORY_SELECTION unset');
  return stagingProfile(vars());
};
// A recorded run's fake model never fails, so this key only opens the route's second step, as a deployed key does.
const RECORDED_FALLBACK_KEY = 'eval-recorded-fallback';

export const nightlyConfig = (env: Env, stagingVars: () => StagingVars = readStagingVars): NightlyRun => withAblation(baseConfig(env, stagingVars), env);

const baseConfig = (env: Env, stagingVars: () => StagingVars): NightlyRun => {
  const mode = env.WALDO_EVAL_MODE;
  if (mode !== 'recorded' && mode !== 'live') throw new Error('WALDO_EVAL_MODE must be recorded or live');
  const profile = profileOf(env, stagingVars);
  const trials = positive(env, 'WALDO_EVAL_TRIALS', '3');
  // WALDO_EVAL_TOOL_SEARCH=on runs the brain's flag-on menu (core tools up front, the rest found by tool search), as
  // WALDO_TOOL_SEARCH=on does for an owner; the scorecard names it so the two menus' results are never mixed up.
  const toolSearch = profile ? profile.toolSearch === true : env.WALDO_EVAL_TOOL_SEARCH === 'on';
  const menu = profile ? { ...(profile.toolSearch ? { toolSearch: true } : {}), ...(profile.toolLoader ? { toolLoader: profile.toolLoader } : {}), forgetBarrier: profile.forgetBarrier, profile: profile.label }
    : toolSearch ? { toolSearch: true } : {};
  // WALDO_EVAL_COMPACTION=on runs every trial's chat on the canonical store with compaction on, as WALDO_COMPACTION=on does
  // for the app; the scorecard names it so the two runs are never mixed up.
  const compaction: Readonly<{ compaction?: CompactionSettings }> = profile ? (profile.compaction.enabled ? { compaction: profile.compaction } : {})
    : env.WALDO_EVAL_COMPACTION === 'on' ? { compaction: compactionSettings({ WALDO_COMPACTION: 'on' }) } : {};
  // WALDO_EVAL_SEMANTIC=on runs every trial with semantic recall on, as MEMORY_SEMANTIC_RECALL=1 does for an owner: a
  // recorded run over the concept fake, a live one over Workers AI (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN). The card
  // names it, so a run with the leg is never compared as one without.
  if (![undefined, 'on', 'off'].includes(env.WALDO_EVAL_SEMANTIC)) throw new Error('WALDO_EVAL_SEMANTIC must be on or off');
  const semantic = profile ? profile.semantic : env.WALDO_EVAL_SEMANTIC === 'on';
  // WALDO_EVAL_MEMORY_SELECTION=on shows every trial option B's memory, as MEMORY_SELECTION=1 does for an owner; the card
  // names it, so the two ways of choosing memory are compared, never mixed.
  if (![undefined, 'on', 'off'].includes(env.WALDO_EVAL_MEMORY_SELECTION)) throw new Error('WALDO_EVAL_MEMORY_SELECTION must be on or off');
  const memorySelection = profile ? profile.memorySelection : env.WALDO_EVAL_MEMORY_SELECTION === 'on';
  const memory = env.WALDO_EVAL_MEMORY ?? 'claims';
  if (memory !== 'claims' && memory !== 'raw_history') throw new Error('WALDO_EVAL_MEMORY must be claims or raw_history');
  if (semantic && memory === 'raw_history') throw new Error('raw_history has no claim store for semantic recall to embed');
  if (memorySelection && memory === 'raw_history') throw new Error('raw_history has no claim store to select from');
  // The raw-history baseline's card names its mode, so it is never read as the normal run's.
  const label = (name: string) => {
    const menuNamed = (profile ? `${name}+${profile.label}` : `${name}${toolSearch ? '+tool_search' : ''}${compaction.compaction ? '+compaction' : ''}`) + (semantic ? '+semantic' : '') + (memorySelection ? '+selection' : '');
    return memory === 'raw_history' ? `${menuNamed} (raw_history)` : menuNamed;
  };
  const memoryMode: Readonly<{ memory?: MemoryMode; memorySelection?: true }> = memory === 'raw_history' ? { memory } : memorySelection ? { memorySelection: true } : {};
  if (mode === 'recorded') {
    return {
      trials, budget: callBudget(positive(env, 'WALDO_EVAL_MAX_CALLS', '10000')),
      gateway: () => scriptedGateway({ rules: [], unmatchedText: 'Recorded reply.' }),
      judge: recordedJudge, candidate: label('recorded'), judgeModel: 'recorded', ...menu, ...memoryMode, ...compaction,
      ...(semantic ? { embeddings: () => fakeEmbeddings() } : {}),
      ...(profile ? { fallbackKey: RECORDED_FALLBACK_KEY } : {}),
    };
  }
  const model = modelNameSchema.parse(env.WALDO_EVAL_MODEL ?? WALDO_CHAT_MODEL);
  if (PROVIDER_OF[model] !== OPENAI_PROVIDER) throw new Error('WALDO_EVAL_MODEL must be an OpenAI roster model');
  if (profile && model !== profile.model) throw new Error('WALDO_EVAL_PROFILE=staging runs the staging chat model; leave WALDO_EVAL_MODEL unset');
  const apiKey = required(env, 'OPENAI_API_KEY');
  const judgeKey = required(env, 'ANTHROPIC_API_KEY');
  const judgeModel = required(env, 'WALDO_EVAL_JUDGE_MODEL');
  assertIndependentJudge(model, judgeModel);
  // The fallback models answer some trials under the profile, so the judge must differ from them as well.
  if (profile) {
    if (!validModelCredential(judgeKey)) throw new Error('WALDO_EVAL_PROFILE=staging needs a usable ANTHROPIC_API_KEY for the fallback');
    for (const fallback of [WALDO_CHAT_FALLBACK_MODEL, WALDO_AUXILIARY_FALLBACK_MODEL]) assertIndependentJudge(fallback, judgeModel);
  }
  const embeddings = semantic ? workersAiRest({ accountId: required(env, 'CLOUDFLARE_ACCOUNT_ID'), token: required(env, 'CLOUDFLARE_API_TOKEN') }) : undefined;
  const budget = callBudget(positive(env, 'WALDO_EVAL_MAX_CALLS'));
  const judgeMode = judgeModeOf(env.WALDO_EVAL_JUDGE_MODE);
  return {
    trials, budget, candidate: label(model), judgeModel: `${judgeModel} (${judgeMode})`, model, holdState: true, ...menu, ...memoryMode, ...compaction,
    ...(embeddings ? { embeddings: () => embeddings } : {}),
    // No client retries: every attempt is one counted call. The profile adds the second provider the owner route falls back to.
    gateway: () => {
      const openai = new OpenAIResponsesAdapter({ client: new OpenAI({ apiKey, maxRetries: 0, timeout: 60_000 }) });
      return profile ? routedGateway({ [OPENAI_PROVIDER]: openai, [ANTHROPIC_PROVIDER]: new AnthropicMessagesAdapter({ apiKey: judgeKey, timeoutMs: 60_000 }) }) : openai;
    },
    ...(profile ? { fallbackKey: judgeKey } : {}),
    judge: liveJudge({ apiKey: judgeKey, model: judgeModel, budget }, judgeMode),
    voiceJudge: liveVoiceJudge({ apiKey: judgeKey, model: judgeModel, budget }, judgeMode),
  };
};
