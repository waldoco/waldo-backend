import { afterEach, describe, expect, it, vi } from 'vitest';
import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import type { Judge } from '../evals/nightly/judge';
import { nightlyConfig } from '../evals/nightly/config';
import { SCENARIOS, type NightlyScenario } from '../evals/nightly/scenarios';
import { runNightly } from '../evals/nightly/suite';
import { evalWorld } from '../evals/nightly/world';

const quick = (id: string, extra: Partial<NightlyScenario> = {}): NightlyScenario => ({
  id, title: id, pain: 'context', start: '2026-09-24T09:00:00+05:30', world: {}, steps: [{ say: `hello ${id}` }],
  rubric: { outcome: 'x', must_not: [] }, ...extra,
});
const reply = () => scriptedGateway({ rules: [{ match: /hello/, rounds: [{ text: 'hi' }] }] });
const judgeCalls: string[] = [];
const passing: Judge = async (input) => { judgeCalls.push(input.scenario); return { outcome: 'pass' }; };
afterEach(() => { judgeCalls.length = 0; vi.unstubAllGlobals(); });

describe('nightly eval suite', () => {
  it('runs k trials per scenario and judges each finished trial once', async () => {
    const card = await runNightly([quick('a'), quick('b', { pain: 'judgment' })], { trials: 3, budget: callBudget(100), gateway: reply, judge: passing, candidate: 'model-a', judgeModel: 'model-b' });
    expect(judgeCalls).toEqual(['a', 'a', 'a', 'b', 'b', 'b']);
    expect(card.scenarios.map((row) => [row.id, row.passed, row.pass_k])).toEqual([['a', 3, true], ['b', 3, true]]);
    expect(card.calls.candidate).toBeGreaterThanOrEqual(6);
  });

  it('reports a blocked scenario without a model or judge call', async () => {
    let gateways = 0;
    const card = await runNightly([quick('image', { blocked: 'no image input' })], { trials: 3, budget: callBudget(100), gateway: () => { gateways += 1; return reply(); }, judge: passing, candidate: 'model-a', judgeModel: 'model-b' });
    expect(gateways).toBe(0);
    expect(judgeCalls).toEqual([]);
    expect(card.scenarios[0]).toMatchObject({ status: 'blocked', pass_k: null });
  });

  it('stops calling once the budget is spent and marks every later trial as not run', async () => {
    const card = await runNightly([quick('a'), quick('b')], { trials: 3, budget: callBudget(5), gateway: reply, judge: passing, candidate: 'model-a', judgeModel: 'model-b' });
    expect(card.budget_exhausted).toBe(true);
    expect(card.calls.candidate + card.calls.judge).toBeLessThanOrEqual(5);
    expect(card.scenarios.at(-1)).toMatchObject({ status: 'incomplete', pass_k: false });
  });

  it('never judges or passes a trial whose model gave an empty reply', async () => {
    const silent = () => scriptedGateway({ rules: [{ match: /hello/, rounds: [{ text: '' }] }] });
    const card = await runNightly([quick('quiet')], { trials: 1, budget: callBudget(10), gateway: silent, judge: passing, candidate: 'model-a', judgeModel: 'model-b' });
    expect(judgeCalls).toEqual([]);
    expect(card.scenarios[0]).toMatchObject({ status: 'ungraded', passed: 0, pass_rate: null, pass_k: false });
  });

  it('does not judge a trial the harness could not finish', async () => {
    const broken = quick('broken', { steps: [{ advance_to: '2026-09-23T09:00:00+05:30' }] });
    const card = await runNightly([broken], { trials: 1, budget: callBudget(10), gateway: reply, judge: passing, candidate: 'model-a', judgeModel: 'model-b' });
    expect(judgeCalls).toEqual([]);
    expect(card.scenarios[0]).toMatchObject({ passed: 0, failed: 0, ungraded: 1, harness_errors: ['Error'] });
  });

  it('dry-runs the whole catalogue with the recorded model and judge, with no network and no scenario text in the scorecard', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('the dry run must not reach the network'); });
    const config = nightlyConfig({ WALDO_EVAL_MODE: 'recorded', WALDO_EVAL_TRIALS: '1' });
    const card = await runNightly(SCENARIOS, config);
    expect(card.scenarios).toHaveLength(SCENARIOS.length);
    expect(card.judge_model).toBe('recorded');
    // A dry run grades nothing: its card can never read as a pass rate.
    expect(card.overall).toMatchObject({ pass_rate: null, pass_k_rate: null });
    expect(card.scenarios.every((row) => row.status === 'blocked' || row.status === 'ungraded')).toBe(true);
    const text = JSON.stringify(card);
    for (const scenario of SCENARIOS) {
      for (const step of scenario.steps) if ('say' in step) expect(text).not.toContain(step.say);
      for (const entry of scenario.world.mail ?? []) { expect(text).not.toContain(entry.subject); expect(text).not.toContain(entry.from); }
      expect(text).not.toContain(scenario.rubric.outcome);
    }
    expect(text).not.toContain('example.com');
  });
});

describe('nightly eval catalogue', () => {
  it('has the twenty research tasks, the owner\'s two, the three errand failures and the background task, each with a pain and a rubric', () => {
    expect(SCENARIOS).toHaveLength(26);
    expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(26);
    expect(SCENARIOS.filter((scenario) => scenario.id.startsWith('t'))).toHaveLength(20);
    expect(SCENARIOS.filter((scenario) => scenario.id.startsWith('e'))).toHaveLength(3);
    expect(SCENARIOS.filter((scenario) => scenario.id.startsWith('w'))).toHaveLength(1);
    expect(new Set(SCENARIOS.map((scenario) => scenario.pain))).toEqual(new Set(['context', 'follow_through', 'judgment']));
    for (const scenario of SCENARIOS) {
      expect(scenario.rubric.outcome.trim()).not.toBe('');
      expect(scenario.steps.some((step) => 'say' in step)).toBe(true);
    }
  });

  it('gives the background-task scenario the production start_task, which records the brief once per call', async () => {
    const scenario = SCENARIOS.find((entry) => entry.id === 'w1-long-read-in-background')!;
    const world = evalWorld(scenario.world, scenario.start);
    const start = world.handlers.find((handler) => handler.name === 'start_task')!;
    expect(start.description).toContain('never this conversation');
    const args = { profile: 'reader', title: 'Promises', goal: 'List promises the owner made.', context: 'Mail from the last three months.', done_when: 'A list: who, what, by when.' };
    const ctx = { turnId: 'turn-1', toolCallId: 'call-1' } as never;
    expect(await start.handle(args as never, ctx)).toMatchObject({ ok: true, data: { status: 'started', profile: 'reader' } });
    expect(await start.handle(args as never, ctx)).toMatchObject({ ok: true, data: { status: 'already_started' } });
    expect(world.effects()).toEqual([{ kind: 'task.start', payload: expect.objectContaining({ profile: 'reader', goal: args.goal, timezone: 'Asia/Kolkata' }) }]);
  });

  it('seeds every fact the errand rubrics require, and makes the named second calendar unreadable', async () => {
    const seeded = (id: string) => SCENARIOS.find((scenario) => scenario.id === id)!;
    for (const [id, facts] of [['e1-look-before-asking', ['07:30', '07:05', 'BOM Terminal 1', '25 September']], ['e2-every-asked-field', ['Seabreeze Residency', '14:00', '14,600', '23:59', '30 September']]] as const) {
      const body = (seeded(id).world.mail ?? []).map((row) => row.body).join(' ');
      for (const fact of facts) { expect(body).toContain(fact); expect(seeded(id).rubric.outcome).toContain(fact); }
    }
    const errand = seeded('e3-one-calendar-unreadable');
    const availability = evalWorld(errand.world, errand.start).handlers.find((handler) => handler.name === 'query_availability')!;
    const answer = await availability.handle({ date_range: { from: '2026-09-25T12:00:00+05:30', to: '2026-09-25T18:00:00+05:30' }, calendar_ids: ['primary', 'family@group.calendar.example'], duration_minutes: 60, work_windows: [] } as never, undefined as never);
    expect(answer).toMatchObject({ ok: true, data: { free_windows: [], unavailable_calendar_ids: ['family@group.calendar.example'] } });
    expect(JSON.stringify(errand.steps)).toContain('family@group.calendar.example');
  });

  it('fires the owner\'s check-back at its time and recalls across a day', () => {
    const checkBack = SCENARIOS.find((scenario) => scenario.id === 'r2-check-back-fires')!;
    expect(checkBack.steps.findIndex((step) => 'fire_due' in step)).toBeGreaterThan(checkBack.steps.findIndex((step) => 'advance_to' in step));
    const recall = SCENARIOS.find((scenario) => scenario.id === 'r1-recall-across-day')!;
    expect(recall.steps.filter((step) => 'say' in step).length).toBeGreaterThanOrEqual(6);
    expect(recall.steps.some((step) => 'advance_to' in step)).toBe(true);
  });
});

describe('nightly eval config', () => {
  const live = { WALDO_EVAL_MODE: 'live', OPENAI_API_KEY: 'sk-test-0000000000000000000000', ANTHROPIC_API_KEY: 'ant-key', WALDO_EVAL_JUDGE_MODEL: 'claude-judge', WALDO_EVAL_MAX_CALLS: '600' };

  it('needs every live setting from the environment', () => {
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'WALDO_EVAL_JUDGE_MODEL', 'WALDO_EVAL_MAX_CALLS']) {
      const env: Record<string, string | undefined> = { ...live, [name]: undefined };
      expect(() => nightlyConfig(env)).toThrow(name);
    }
  });

  it('refuses a judge that is the model under test', () => {
    expect(() => nightlyConfig({ ...live, WALDO_EVAL_JUDGE_MODEL: WALDO_CHAT_MODEL })).toThrow(/judge must differ/);
  });

  it('needs the mode named, so a host never gets the dry run by accident, and defaults to three trials', () => {
    expect(() => nightlyConfig({ ...live, WALDO_EVAL_MODE: undefined })).toThrow('WALDO_EVAL_MODE');
    expect(nightlyConfig({ WALDO_EVAL_MODE: 'recorded' }).judgeModel).toBe('recorded');
    expect(nightlyConfig(live).trials).toBe(3);
    expect(() => nightlyConfig({ ...live, WALDO_EVAL_TRIALS: '0' })).toThrow('WALDO_EVAL_TRIALS');
  });
});
