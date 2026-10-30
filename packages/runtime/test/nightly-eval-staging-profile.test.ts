import { describe, expect, it } from 'vitest';
import { ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, OPENAI_GPT_6_1_SOL_MODEL, OPENAI_PROVIDER, PROVIDER_OF, WALDO_AUXILIARY_FALLBACK_MODEL, WALDO_AUXILIARY_MODEL, WALDO_CHAT_FALLBACK_MODEL, WALDO_CHAT_MODEL, type LLMResponse } from '@waldo/contracts';
import { scriptedGateway, type ScriptRule } from '../src/testing/scripted-gateway';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { callBudget } from '../evals/nightly/budget';
import { nightlyConfig } from '../evals/nightly/config';
import { readStagingVars, staleClasses, STAGING_VAR_CLASSES, stagingProfile, unclassifiedVars } from '../evals/nightly/staging-profile';
import { runTrial, type TrialScenario } from '../evals/nightly/trial';
import { runNightly } from '../evals/nightly/suite';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { scorecardMarkdown, gateScorecard, thresholdsFor } from '../evals/nightly/gate';

const START = '2026-09-24T09:00:00+05:30';
const scenario = (steps: TrialScenario['steps'], world: TrialScenario['world'] = {}): TrialScenario => ({ id: 'profile-test', start: START, steps, world });
const STAGING = readStagingVars();
const LIVE = { WALDO_EVAL_MODE: 'live', OPENAI_API_KEY: 'sk-test-0000000000000000000000', ANTHROPIC_API_KEY: 'ant-key', WALDO_EVAL_JUDGE_MODEL: ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, WALDO_EVAL_MAX_CALLS: '600', WALDO_EVAL_PROFILE: 'staging' };

describe('the staging profile', () => {
  it('classifies every variable the staging block of wrangler.jsonc sets, and nothing it no longer sets', () => {
    expect(unclassifiedVars(STAGING)).toEqual([]);
    expect(staleClasses(STAGING)).toEqual([]);
  });

  it('goes red on a staging variable nobody classified, and on a classification whose variable is gone', () => {
    expect(unclassifiedVars({ ...STAGING, WALDO_NEW_TURN_FLAG: 'on' })).toEqual(['WALDO_NEW_TURN_FLAG']);
    const { WALDO_COMPACTION: _removed, ...without } = STAGING;
    expect(staleClasses(without)).toEqual(['WALDO_COMPACTION']);
  });

  it('gives every classification a reason', () => {
    for (const [name, cls] of Object.entries(STAGING_VAR_CLASSES)) expect(cls.why.length, name).toBeGreaterThan(10);
  });

  it('reads staging as it is deployed: the harness loader, compaction on, the items forget barrier, the chat model', () => {
    const profile = stagingProfile(STAGING);
    expect(profile).toMatchObject({ label: 'staging', model: WALDO_CHAT_MODEL, toolLoader: 'harness', forgetBarrier: 'items' });
    expect(profile.compaction.enabled).toBe(true);
    expect(profile.toolSearch).toBeUndefined();
  });

  it('follows the owner object\'s precedence and defaults when the variables change', () => {
    expect(stagingProfile({ ...STAGING, WALDO_TOOL_LOADER: 'off', WALDO_TOOL_SEARCH: 'on' })).toMatchObject({ toolSearch: true });
    expect(stagingProfile({ ...STAGING, WALDO_TOOL_LOADER: 'harness', WALDO_TOOL_SEARCH: 'on' }).toolSearch).toBeUndefined();
    expect(stagingProfile({ ...STAGING, WALDO_TOOL_LOADER: 'off', WALDO_TOOL_SEARCH: 'off' }).toolLoader).toBeUndefined();
    expect(stagingProfile({ ...STAGING, WALDO_FORGET_BARRIER: 'off' }).forgetBarrier).toBe('reads');
    expect(stagingProfile({ ...STAGING, WALDO_COMPACTION: 'off' }).compaction.enabled).toBe(false);
  });

  it('refuses a staging that turns on what the eval cannot model', () => {
    expect(() => stagingProfile({ ...STAGING, MEMORY_SEMANTIC_RECALL: '1' })).toThrow(/semantic/);
  });
});

describe('the staging profile in the run settings', () => {
  it('turns the loader, compaction, the forget barrier and the fallback route on, and names itself on the card', () => {
    const run = nightlyConfig({ WALDO_EVAL_MODE: 'recorded', WALDO_EVAL_PROFILE: 'staging' });
    expect(run).toMatchObject({ toolLoader: 'harness', forgetBarrier: 'items', profile: 'staging', candidate: 'recorded+staging' });
    expect(run.compaction?.enabled).toBe(true);
    expect(run.fallbackKey).toBeTypeOf('string');
  });

  it('leaves the default run exactly as it was', () => {
    const run = nightlyConfig({ WALDO_EVAL_MODE: 'recorded' });
    for (const key of ['toolLoader', 'forgetBarrier', 'profile', 'fallbackKey', 'compaction', 'toolSearch']) expect(run).not.toHaveProperty(key);
    expect(run.candidate).toBe('recorded');
  });

  it('takes the variables from the file it is given, not from a list of its own', () => {
    const run = nightlyConfig({ WALDO_EVAL_MODE: 'recorded', WALDO_EVAL_PROFILE: 'staging' }, () => ({ ...STAGING, WALDO_TOOL_LOADER: 'off', WALDO_COMPACTION: 'off' }));
    expect(run.toolLoader).toBeUndefined();
    expect(run.compaction).toBeUndefined();
  });

  it('refuses a profile that is not staging, and settings the profile would contradict', () => {
    expect(() => nightlyConfig({ WALDO_EVAL_MODE: 'recorded', WALDO_EVAL_PROFILE: 'production' })).toThrow(/must be staging/);
    expect(() => nightlyConfig({ WALDO_EVAL_MODE: 'recorded', WALDO_EVAL_PROFILE: 'staging', WALDO_EVAL_TOOL_SEARCH: 'on' })).toThrow(/leave WALDO_EVAL_TOOL_SEARCH/);
    expect(() => nightlyConfig({ WALDO_EVAL_MODE: 'recorded', WALDO_EVAL_PROFILE: 'staging', WALDO_EVAL_COMPACTION: 'on' })).toThrow(/leave WALDO_EVAL_TOOL_SEARCH and WALDO_EVAL_COMPACTION/);
    expect(() => nightlyConfig({ ...LIVE, WALDO_EVAL_MODEL: OPENAI_GPT_6_1_SOL_MODEL })).toThrow(/staging chat model/);
  });

  it('holds the judge apart from the fallback models the trials can now meet', () => {
    expect(() => nightlyConfig({ ...LIVE, WALDO_EVAL_JUDGE_MODEL: WALDO_CHAT_FALLBACK_MODEL })).toThrow(/judge must differ/);
    expect(() => nightlyConfig({ ...LIVE, WALDO_EVAL_JUDGE_MODEL: WALDO_AUXILIARY_FALLBACK_MODEL })).toThrow(/judge must differ/);
    expect(nightlyConfig(LIVE)).toMatchObject({ toolLoader: 'harness', candidate: `${WALDO_CHAT_MODEL}+staging` });
    // Without the profile a trial never meets a fallback model, so the earlier rule stands.
    const { WALDO_EVAL_PROFILE: _profile, ...plain } = LIVE;
    expect(() => nightlyConfig({ ...plain, WALDO_EVAL_JUDGE_MODEL: WALDO_CHAT_FALLBACK_MODEL })).not.toThrow();
  });

  it('refuses a fallback key the provider would refuse to read', () => {
    expect(() => nightlyConfig({ ...LIVE, ANTHROPIC_API_KEY: 'has a space' })).toThrow(/usable ANTHROPIC_API_KEY/);
  });
});

const availability = { name: 'query_availability', arguments: { date_range: { from: '2026-09-25T09:00:00+05:30', to: '2026-09-25T18:00:00+05:30' }, duration_minutes: 60 } };
const offered = (gateway: ReturnType<typeof scriptedGateway>) => gateway.requests().filter((request) => request.request.response_format === undefined).flatMap((request) => (request.request.tools ?? []).map((tool) => tool.name));

describe('the harness loader in a trial', () => {
  const rules: readonly ScriptRule[] = [{ match: /free tomorrow/, rounds: [
    { toolCalls: [{ name: 'find_tools', arguments: { groups: ['calendar'] } }] },
    { toolCalls: [{ name: 'use_tool', arguments: { name: 'query_availability', arguments: availability.arguments } }] },
    { text: 'One meeting.' },
  ] }];

  it('reaches a deferred tool through find_tools and use_tool, and counts the rounds', async () => {
    const gateway = scriptedGateway({ rules });
    const run = await runTrial(scenario([{ say: 'What is free tomorrow?' }]), { gateway, budget: callBudget(50), toolLoader: 'harness' });
    expect(run.status).toBe('ran');
    expect(run.tools).toEqual([{ name: 'query_availability', ok: true }]);
    expect(offered(gateway)).toEqual(expect.arrayContaining(['find_tools', 'use_tool']));
    expect(offered(gateway)).not.toContain('query_availability');
    expect(run.metrics).toMatchObject({ rounds: 3, find_tools: 1, use_tool: 1, groups_loaded: 1 });
    expect(run.metrics.peak_result_chars).toBeGreaterThan(0);
  });

  it('offers the deferred tool directly when no loader is set', async () => {
    const gateway = scriptedGateway({ rules: [{ match: /free tomorrow/, rounds: [{ toolCalls: [availability] }, { text: 'One meeting.' }] }] });
    const run = await runTrial(scenario([{ say: 'What is free tomorrow?' }]), { gateway, budget: callBudget(50) });
    expect(offered(gateway)).toContain('query_availability');
    expect(offered(gateway)).not.toContain('find_tools');
    expect(run.metrics).toMatchObject({ rounds: 2, find_tools: 0, use_tool: 0, groups_loaded: 0 });
  });
});

// Answers as a gateway whose OpenAI model is down and whose second provider is up, or as one that reports fixed usage.
const failingFirstProvider = (inner: LLMGatewayAdapter): LLMGatewayAdapter => ({
  complete: async (input) => PROVIDER_OF[input.request.model] === OPENAI_PROVIDER ? { ok: false, code: 'transient', error: 'the first provider is down' } : inner.complete(input),
});
const reporting = (inner: LLMGatewayAdapter, usage: Partial<LLMResponse>): LLMGatewayAdapter => ({
  complete: async (input) => { const result = await inner.complete(input); return result.ok ? { ok: true, data: { ...result.data, ...usage } } : result; },
});

describe('the fallback route in a trial', () => {
  const rules: readonly ScriptRule[] = [{ match: /hello/, rounds: [{ text: 'Hello from the second provider.' }, { text: 'Hello from the second provider.' }, { text: 'Hello from the second provider.' }] }];

  it('answers from the second provider when the first is down, and counts the fallback apart', async () => {
    const run = await runTrial(scenario([{ say: 'hello' }]), { gateway: failingFirstProvider(scriptedGateway({ rules })), budget: callBudget(50), fallbackKey: 'eval-fallback-key' });
    expect(run.status).toBe('ran');
    expect(run.transcript.find((turn) => turn.role === 'waldo')?.text).toContain('second provider');
    expect(run.metrics.fallback_calls).toBeGreaterThan(0);
    expect(run.metrics.failed_calls).toBeGreaterThan(0);
  });

  it('has no second step without a key, so the same outage ends at the floor', async () => {
    const run = await runTrial(scenario([{ say: 'hello' }]), { gateway: failingFirstProvider(scriptedGateway({ rules })), budget: callBudget(50) });
    expect(run.transcript.find((turn) => turn.role === 'waldo')?.text ?? '').not.toContain('second provider');
    expect(run.metrics.fallback_calls).toBe(0);
  });
});

describe('what a trial costs', () => {
  it('prices a call by its model, with cache reads and writes at their own rates', async () => {
    const gateway = reporting(scriptedGateway({ rules: [{ match: /hello/, rounds: [{ text: 'Hi.' }] }] }), { input_tokens: 1000, cache_read_input_tokens: 400, cache_write_input_tokens: 100, output_tokens: 50 });
    const run = await runTrial(scenario([{ say: 'hello' }]), { gateway, budget: callBudget(50) });
    const reply = 1 * (1000 - 400 - 100) / 1e6 + (400 * 0.05) / 1e6 + (100 * 1.25) / 1e6 + (50 * 5) / 1e6;
    expect(run.metrics.rounds).toBe(1);
    expect(run.metrics.input_tokens).toBe(1000 * run.metrics.calls);
    expect(run.metrics.cached_tokens).toBe(400 * run.metrics.calls);
    expect(run.metrics.cache_write_tokens).toBe(100 * run.metrics.calls);
    expect(run.metrics.usd).toBeCloseTo(reply * run.metrics.calls, 9);
    expect(run.metrics.unpriced_calls).toBe(0);
  });

  it('counts a structured side call as a call and not as a round', async () => {
    const [change] = NIGHTLY_SCENARIOS.filter((item) => item.id === 'h1-health-change-card');
    const gateway = scriptedGateway({ rules: [], unmatchedText: '{"action":"none","reason":"nothing to change"}' });
    const run = await runTrial(change!, { gateway, budget: callBudget(50) });
    const structured = gateway.requests().filter((request) => request.request.response_format !== undefined);
    expect(structured.length).toBeGreaterThan(0);
    expect(run.metrics.calls).toBe(gateway.requests().length);
    expect(run.metrics.rounds).toBe(run.metrics.calls - structured.length);
  });

  it('reaches the scorecard as counts only, and the markdown reports them per trial', async () => {
    const [scenarioOne] = NIGHTLY_SCENARIOS.filter((item) => item.id === 't03-reminder');
    const gateway = () => reporting(scriptedGateway({ rules: [], unmatchedText: 'Recorded reply.' }), { input_tokens: 2000, cache_read_input_tokens: 1000, output_tokens: 100 });
    const card = await runNightly([scenarioOne!], { trials: 2, budget: callBudget(100), gateway, judge: async () => ({ outcome: 'judge_error' }), candidate: 'recorded+staging', judgeModel: 'recorded', profile: 'staging', subset: 't03-reminder', toolLoader: 'harness' });
    const [row] = card.scenarios;
    expect(row!.metrics).toMatchObject({ trials: 2 });
    expect(row!.metrics!.rounds).toBeGreaterThanOrEqual(2);
    expect(Object.values(row!.metrics!).every((value) => typeof value === 'number')).toBe(true);
    expect(card).toMatchObject({ profile: 'staging', subset: 't03-reminder' });
    const markdown = scorecardMarkdown(card, gateScorecard(card, thresholdsFor('recorded', 1)), 'recorded');
    expect(markdown).toContain('Cost and rounds per trial');
    expect(markdown).toContain('| t03-reminder |');
    expect(markdown).toContain('Subset `t03-reminder`: 1 scenarios.');
    expect(JSON.stringify(card)).not.toContain('Recorded reply');
  });
});
