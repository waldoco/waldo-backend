import { describe, expect, it } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { ablating, ablationLabel, ablationReport, ablationRuns, ablationVerdict, TRIALS, type AblationRun } from '../evals/nightly/ablation';
import { nightlyConfig } from '../evals/nightly/config';
import { RULE_COVERAGE, evalBehaviourPrompt, promptRules, ruleInventory, type RuleStatus } from '../evals/nightly/rules';
import { scorecard, type ScenarioTrials, type TrialOutcome } from '../evals/nightly/scorecard';
import { SCENARIOS } from '../evals/nightly/scenarios';
import { runNightly } from '../evals/nightly/suite';

const rule = async (anchor: string) => (await ruleInventory(evalBehaviourPrompt())).find((status) => status.rule.text.includes(anchor))!;

describe('the behaviour rule inventory', () => {
  it('gives every rule of the prompt a trial sends one id and one standing, and every map entry exactly one rule', async () => {
    const inventory = await ruleInventory(evalBehaviourPrompt());
    expect(inventory.length).toBe((await promptRules(evalBehaviourPrompt())).length);
    expect(new Set(inventory.map((status) => status.rule.id)).size).toBe(inventory.length);
    expect(inventory.filter((status) => status.kind !== 'uncovered')).toHaveLength(RULE_COVERAGE.length);
    expect((await rule('Never give medication, supplement or dose instructions')).kind).toBe('boundary');
    expect((await rule('Every message passes six tests')).kind).toBe('mapped');
  });

  it('refuses a map entry that names no rule or an unknown scenario', async () => {
    const system = evalBehaviourPrompt();
    await expect(ruleInventory(system, [...RULE_COVERAGE, { anchor: 'a rule nobody wrote', scenarios: [] }])).rejects.toThrow('names 0 rules');
    await expect(ruleInventory(system, [{ anchor: 'Ask almost nothing', scenarios: ['z99-not-a-scenario'] }])).rejects.toThrow('unknown scenario z99-not-a-scenario');
    const renamed = system.replace('- Ask almost nothing', '- Ask nearly nothing');
    await expect(ruleInventory(renamed)).rejects.toThrow('"Ask almost nothing" names 0 rules');
  });

  it('calls a rule mapped to no scenario uncovered, so no run can prune it', async () => {
    const empty = (await ruleInventory(evalBehaviourPrompt(), [{ anchor: 'Ask almost nothing', scenarios: [] }])).find((status) => status.rule.text.includes('Ask almost nothing'))!;
    expect(empty.kind).toBe('uncovered');
    expect(ablationVerdict(empty, [])).toMatchObject({ verdict: 'uncovered' });
  });
});

describe('a run with rules taken out', () => {
  const capture = () => {
    const systems: string[] = [];
    const inner: LLMGatewayAdapter = { complete: async (call) => { systems.push(String(call.request.system)); return { ok: true, data: { model: call.request.model, text: 'ok', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } }; } };
    return { inner, systems };
  };
  const request = (system: string) => ({ request: { model: 'fixture', system, messages: [{ role: 'user' as const, content: 'hi' }], max_tokens: 10 } }) as unknown as Parameters<LLMGatewayAdapter['complete']>[0];

  it('drops exactly the named rule from a reply\'s behaviour prompt and leaves other calls alone', async () => {
    const { inner, systems } = capture();
    const target = await rule('Ask almost nothing');
    let misses = 0;
    const gateway = ablating(inner, [target.rule.id], () => { misses += 1; });
    const system = evalBehaviourPrompt();
    await gateway.complete(request(system));
    await gateway.complete(request('Summarise this conversation.'));
    expect(systems[0]).toBe(system.split('\n').filter((line) => line !== target.rule.text).join('\n'));
    expect(systems[1]).toBe('Summarise this conversation.');
    expect(misses).toBe(0);
  });

  it('removes nothing and counts a miss for a rule that is absent or a hard boundary', async () => {
    const boundary = await rule('Never give medication, supplement or dose instructions');
    for (const ids of [['0badc0de'], [boundary.rule.id]]) {
      const { inner, systems } = capture();
      let misses = 0;
      await ablating(inner, ids, () => { misses += 1; }).complete(request(evalBehaviourPrompt()));
      expect(misses).toBe(1);
      expect(systems[0]).toBe(evalBehaviourPrompt());
    }
  });

  it('reports a trial that could not drop its rules as a harness error, and names the ablation on the scorecard', async () => {
    const scenario = SCENARIOS.find((entry) => entry.id === 't01-calendar-free-hour')!;
    const run = (ids: string) => runNightly([scenario], nightlyConfig({ WALDO_EVAL_MODE: 'recorded', WALDO_EVAL_TRIALS: '1', WALDO_EVAL_ABLATE: ids }));
    const missing = await run('0badc0de');
    expect(missing.candidate_model).toBe(ablationLabel('recorded', ['0badc0de']));
    expect(missing.scenarios[0]).toMatchObject({ trials: 1, ungraded: 1, harness_errors: ['AblationMiss'] });
    const real = await run((await rule('Ask almost nothing')).rule.id);
    expect(real.scenarios[0]!.harness_errors).toBeUndefined();
  });

  it('refuses an id that is not a rule id', () => {
    expect(() => nightlyConfig({ WALDO_EVAL_MODE: 'recorded', WALDO_EVAL_ABLATE: 'ask-almost-nothing' })).toThrow('8-hex rule ids');
  });
});

describe('the verdict on one rule', () => {
  const trials = (passed: number): TrialOutcome[] => [...Array(passed).fill('pass'), ...Array(TRIALS - passed).fill('fail')];
  type Rows = Readonly<Record<string, number | readonly TrialOutcome[]>>;
  // Every card is a run of its own, as two real runs never write the same card.
  let serial = 0;
  const card = (candidate: string, rows: Rows) =>
    scorecard(Object.entries(rows).map(([id, row]): ScenarioTrials => {
      const outcomes = typeof row === 'number' ? trials(row) : row;
      return { id, pain: 'judgment', outcomes, ...(outcomes.includes('harness_error') ? { harness_errors: ['AblationMiss'] } : {}) };
    }), { candidate, judge: 'judge', trials: TRIALS, usage: { candidate_calls: (serial += 1), judge_calls: 0, budget: 0, exhausted: false, candidate_tokens: 0, judge_tokens: 0 } });
  let target: RuleStatus;
  const pair = (base: Rows, ablated: Rows): AblationRun => ({ baseline: card('model', base), ablated: card(ablationLabel('model', [target.rule.id]), ablated) });
  const twice = (make: () => AblationRun): AblationRun[] => [make(), make()];
  const fullBase = { 'v03-week-one-preference': 5, 'e1-look-before-asking': 5, 't01-calendar-free-hour': 5, 't05-find-confirmation': 5, 't10-compare-flights': 5 };
  const governedBy = (status: RuleStatus): readonly string[] => (status.kind === 'mapped' ? status.scenarios : []);

  it('keeps a rule whose removal adds 2 failures out of 5 on a scenario it governs, in one run', async () => {
    target = await rule('Ask almost nothing');
    expect(ablationVerdict(target, [pair(fullBase, { ...fullBase, 'e1-look-before-asking': 3 })])).toMatchObject({ verdict: 'keep' });
  });

  it('keeps a rule when the overall rate falls 5 points in two runs, and calls one such run inconclusive', async () => {
    target = await rule('Ask almost nothing');
    const fall = () => pair(fullBase, { ...fullBase, 't01-calendar-free-hour': 4, 't10-compare-flights': 4 });
    expect(ablationVerdict(target, [fall()])).toMatchObject({ verdict: 'inconclusive' });
    expect(ablationVerdict(target, twice(fall))).toMatchObject({ verdict: 'keep' });
  });

  it('prunes only on two runs within 2 points with no governed scenario losing a trial; disagreement is inconclusive', async () => {
    target = await rule('Ask almost nothing');
    expect(ablationVerdict(target, twice(() => pair(fullBase, fullBase)))).toMatchObject({ verdict: 'prune' });
    const governedLoss = pair(fullBase, { ...fullBase, 'v03-week-one-preference': 4 });
    expect(ablationVerdict(target, [pair(fullBase, fullBase), governedLoss])).toMatchObject({ verdict: 'inconclusive' });
  });

  it('prunes at a 2-point overall drop, and not at a 3-point drop with no governed loss', async () => {
    target = await rule('Ask almost nothing');
    const wide = { ...fullBase, ...Object.fromEntries(Array.from({ length: 15 }, (_, n) => [`spare-${n}`, 5])) };
    expect(ablationVerdict(target, twice(() => pair(wide, { ...wide, 'spare-0': 3 })))).toMatchObject({ verdict: 'prune' });
    expect(ablationVerdict(target, twice(() => pair(wide, { ...wide, 'spare-0': 2 })))).toMatchObject({ verdict: 'inconclusive' });
  });

  it('keeps at a 5-point overall fall in every run, and not when only one of two runs falls', async () => {
    target = await rule('Ask almost nothing');
    const wide = { ...fullBase, ...Object.fromEntries(Array.from({ length: 15 }, (_, n) => [`spare-${n}`, 5])) };
    const fall = () => pair(wide, { ...wide, 'spare-0': 3, 'spare-1': 2 });
    expect(ablationVerdict(target, twice(fall))).toMatchObject({ verdict: 'keep' });
    expect(ablationVerdict(target, [fall(), pair(wide, wide)])).toMatchObject({ verdict: 'inconclusive' });
  });

  it('does not prune on a card that reports no overall rate', async () => {
    target = await rule('Ask almost nothing');
    const unrated = () => {
      const run = pair(fullBase, fullBase);
      return { ...run, ablated: { ...run.ablated, overall: { ...run.ablated.overall, pass_rate: null } } };
    };
    expect(ablationVerdict(target, twice(unrated))).toMatchObject({ verdict: 'inconclusive' });
  });

  it('never prunes on one run counted twice: a repeated pair, a shared card or an identical copy is inconclusive', async () => {
    target = await rule('Ask almost nothing');
    const held = pair(fullBase, fullBase);
    expect(ablationVerdict(target, [held, held])).toMatchObject({ verdict: 'inconclusive' });
    expect(ablationVerdict(target, [held, { ...pair(fullBase, fullBase), baseline: held.baseline }])).toMatchObject({ verdict: 'inconclusive' });
    expect(ablationVerdict(target, [held, JSON.parse(JSON.stringify(held)) as AblationRun])).toMatchObject({ verdict: 'inconclusive' });
  });

  it('never judges a run list that names one scorecard file twice', () => {
    const read = (path: string) => JSON.stringify({ path });
    expect(ablationRuns('base-1.json:abl-1.json,base-2.json:abl-2.json', read)).toHaveLength(2);
    expect(() => ablationRuns('base-1.json:abl-1.json,base-1.json:abl-2.json', read)).toThrow('names base-1.json twice');
    expect(() => ablationRuns('base-1.json', read)).toThrow('<baseline.json>:<ablated.json> pairs');
  });

  it('never prunes an uncovered rule, never judges a boundary rule, and needs 5 trials on a matching pair', async () => {
    const uncovered = await rule('Answer a greeting or small talk');
    expect(ablationVerdict(uncovered, [])).toMatchObject({ verdict: 'uncovered' });
    const boundary = await rule('If the owner may be in danger');
    expect(() => ablationVerdict(boundary, [])).toThrow('never ablated');
    target = await rule('Ask almost nothing');
    const short = () => ({ baseline: { ...card('model', fullBase), trials_per_scenario: 3 }, ablated: { ...card(ablationLabel('model', [target.rule.id]), fullBase), trials_per_scenario: 3 } });
    expect(ablationVerdict(target, twice(short))).toMatchObject({ verdict: 'inconclusive' });
    const otherRule = () => ({ baseline: card('model', fullBase), ablated: card(ablationLabel('model', ['0badc0de']), fullBase) });
    expect(ablationVerdict(target, twice(otherRule))).toMatchObject({ verdict: 'inconclusive' });
  });

  it('does not prune when a governed scenario loses a trial that another scenario makes up overall', async () => {
    target = await rule('Ask almost nothing');
    const governed = governedBy(target)[0]!;
    const spare = 't13-compare-purchase';
    expect(governedBy(target)).not.toContain(spare);
    expect(ablationVerdict(target, twice(() => pair({ ...fullBase, [spare]: 4 }, { ...fullBase, [governed]: 4, [spare]: 5 })))).toMatchObject({ verdict: 'inconclusive' });
  });

  it('compares only a pair that differs by the ablation: an ablated baseline, another mode or another judge is inconclusive', async () => {
    target = await rule('Ask almost nothing');
    const ablatedBase = () => ({ baseline: card(ablationLabel('model', ['0badc0de']), fullBase), ablated: card(ablationLabel('model', [target.rule.id]), fullBase) });
    expect(ablationVerdict(target, twice(ablatedBase))).toMatchObject({ verdict: 'inconclusive' });
    const otherMode = () => ({ baseline: card('model', fullBase), ablated: card(ablationLabel('model+tool_search', [target.rule.id]), fullBase) });
    expect(ablationVerdict(target, twice(otherMode))).toMatchObject({ verdict: 'inconclusive' });
    const otherJudge = () => ({ baseline: { ...card('model', fullBase), judge_model: 'another-judge' }, ablated: card(ablationLabel('model', [target.rule.id]), fullBase) });
    expect(ablationVerdict(target, twice(otherJudge))).toMatchObject({ verdict: 'inconclusive' });
  });

  it('does not prune without every trial graded on every governed scenario in both runs of each pair', async () => {
    target = await rule('Ask almost nothing');
    const governed = governedBy(target)[0]!;
    const missing = () => pair(fullBase, Object.fromEntries(Object.entries(fullBase).filter(([id]) => id !== governed)));
    expect(ablationVerdict(target, twice(missing))).toMatchObject({ verdict: 'inconclusive' });
    const judgeErrors: TrialOutcome[] = Array(TRIALS).fill('judge_error');
    expect(ablationVerdict(target, twice(() => pair(fullBase, { ...fullBase, [governed]: judgeErrors })))).toMatchObject({ verdict: 'inconclusive' });
    const noGovernedAnywhere = Object.fromEntries(Object.entries(fullBase).filter(([id]) => !governedBy(target).includes(id)));
    expect(ablationVerdict(target, twice(() => pair(noGovernedAnywhere, noGovernedAnywhere)))).toMatchObject({ verdict: 'inconclusive' });
    const oneOfFive: TrialOutcome[] = ['pass', ...Array(TRIALS - 1).fill('judge_error')];
    expect(card('model', { [governed]: oneOfFive }).scenarios[0]!.status).toBe('graded');
    expect(ablationVerdict(target, twice(() => pair(fullBase, { ...fullBase, [governed]: oneOfFive })))).toMatchObject({ verdict: 'inconclusive' });
    expect(ablationVerdict(target, twice(() => pair({ ...fullBase, [governed]: oneOfFive }, fullBase)))).toMatchObject({ verdict: 'inconclusive' });
    const governedBlocked = { ...fullBase, [governed]: Array(TRIALS).fill('blocked') as TrialOutcome[] };
    expect(ablationVerdict(target, twice(() => pair(governedBlocked, governedBlocked)))).toMatchObject({ verdict: 'inconclusive' });
  });

  it('does not prune on a run that did not finish: a spent budget, a harness error or an incomplete scenario on either side', async () => {
    target = await rule('Ask almost nothing');
    const spent = (side: 'baseline' | 'ablated') => () => {
      const run = pair(fullBase, fullBase);
      return { ...run, [side]: { ...run[side], budget_exhausted: true } };
    };
    expect(ablationVerdict(target, twice(spent('ablated')))).toMatchObject({ verdict: 'inconclusive' });
    expect(ablationVerdict(target, twice(spent('baseline')))).toMatchObject({ verdict: 'inconclusive' });
    const errored = Object.fromEntries(Object.keys(fullBase).map((id) => [id, governedBy(target).includes(id) ? 5 : Array(TRIALS).fill('harness_error') as TrialOutcome[]]));
    expect(ablationVerdict(target, twice(() => pair(fullBase, errored)))).toMatchObject({ verdict: 'inconclusive' });
    expect(ablationVerdict(target, twice(() => pair(errored, fullBase)))).toMatchObject({ verdict: 'inconclusive' });
    const oneError = { ...fullBase, 't01-calendar-free-hour': ['harness_error', ...trials(4)] as TrialOutcome[] };
    expect(ablationVerdict(target, twice(() => pair(fullBase, oneError)))).toMatchObject({ verdict: 'inconclusive' });
    const cut = { ...fullBase, 't01-calendar-free-hour': [...trials(5).slice(2), 'budget_exhausted', 'budget_exhausted'] as TrialOutcome[] };
    expect(card('model', cut).scenarios.find((row) => row.id === 't01-calendar-free-hour')!.status).toBe('incomplete');
    expect(ablationVerdict(target, twice(() => pair(fullBase, cut)))).toMatchObject({ verdict: 'inconclusive' });
  });

  it('does not prune when the two cards of a pair ran different scenarios, and still prunes past a scenario blocked in both', async () => {
    target = await rule('Ask almost nothing');
    const fewer = Object.fromEntries(Object.entries(fullBase).filter(([id]) => id !== 't05-find-confirmation'));
    expect(ablationVerdict(target, twice(() => pair(fullBase, fewer)))).toMatchObject({ verdict: 'inconclusive' });
    expect(ablationVerdict(target, twice(() => pair(fewer, fullBase)))).toMatchObject({ verdict: 'inconclusive' });
    const blocked = { ...fullBase, 't05-find-confirmation': Array(TRIALS).fill('blocked') as TrialOutcome[] };
    expect(ablationVerdict(target, twice(() => pair(blocked, blocked)))).toMatchObject({ verdict: 'prune' });
  });

  it('does not prune when the judge left a trial ungraded on any scenario, governed or not, on either side', async () => {
    target = await rule('Ask almost nothing');
    const judgeErrors: TrialOutcome[] = Array(TRIALS).fill('judge_error');
    const others = Object.keys(fullBase).filter((id) => !governedBy(target).includes(id));
    const allOthers = Object.fromEntries(Object.keys(fullBase).map((id) => [id, others.includes(id) ? judgeErrors : 5]));
    const oneOther = { ...fullBase, [others[0]!]: judgeErrors };
    const oneTrial = { ...fullBase, [others[0]!]: ['judge_error', ...trials(4)] as TrialOutcome[] };
    for (const shape of [allOthers, oneOther, oneTrial]) {
      expect(ablationVerdict(target, twice(() => pair(fullBase, shape)))).toMatchObject({ verdict: 'inconclusive' });
      expect(ablationVerdict(target, twice(() => pair(shape, fullBase)))).toMatchObject({ verdict: 'inconclusive' });
    }
  });

  it('does not prune when removing the rule adds only a voice failure or only a receipt failure on a governed scenario', async () => {
    target = await rule('Ask almost nothing');
    const governed = governedBy(target)[0]!;
    const oneFail = { ...fullBase, [governed]: 4 };
    const marked = (mark: Readonly<{ voice_failed?: number; receipt_failed?: number }>) => (): AblationRun => {
      const run = pair(oneFail, oneFail);
      return { ...run, ablated: { ...run.ablated, scenarios: run.ablated.scenarios.map((row) => (row.id === governed ? { ...row, ...mark } : row)) } };
    };
    expect(ablationVerdict(target, twice(marked({})))).toMatchObject({ verdict: 'prune' });
    expect(ablationVerdict(target, twice(marked({ voice_failed: 1 })))).toMatchObject({ verdict: 'inconclusive' });
    expect(ablationVerdict(target, twice(marked({ receipt_failed: 1 })))).toMatchObject({ verdict: 'inconclusive' });
  });

  it('gives no single-rule verdict from a run that took out more than this rule', async () => {
    target = await rule('Ask almost nothing');
    const other = await rule('Look before you ask');
    const joint = () => ({ baseline: card('model', fullBase), ablated: card(ablationLabel('model', [target.rule.id, other.rule.id]), fullBase) });
    expect(ablationVerdict(target, twice(joint))).toMatchObject({ verdict: 'inconclusive', reason: expect.stringContaining('more than this rule') });
    const jointLoss = () => ({ baseline: card('model', fullBase), ablated: card(ablationLabel('model', [target.rule.id, other.rule.id]), { ...fullBase, 'e1-look-before-asking': 3 }) });
    expect(ablationVerdict(target, [jointLoss()])).toMatchObject({ verdict: 'inconclusive' });
  });

  it('calls a mapped rule with no scenarios uncovered, whatever the runs show', async () => {
    target = await rule('Ask almost nothing');
    const empty: RuleStatus = { rule: target.rule, kind: 'mapped', scenarios: [] };
    expect(ablationVerdict(empty, twice(() => pair(fullBase, fullBase)))).toMatchObject({ verdict: 'uncovered' });
  });

  it('says whether the verdict came from live judges, so recorded cards are never read as a live result', async () => {
    target = await rule('Ask almost nothing');
    const live = twice(() => pair(fullBase, fullBase));
    expect(ablationReport(target, live)).toMatchObject({ id: target.rule.id, live: true, judges: ['judge'], verdict: 'prune' });
    const recordedPair = () => {
      const run = pair(fullBase, fullBase);
      return { baseline: { ...run.baseline, judge_model: 'recorded' }, ablated: { ...run.ablated, judge_model: 'recorded' } };
    };
    expect(ablationReport(target, twice(recordedPair))).toMatchObject({ live: false, judges: ['recorded'] });
    expect(ablationReport(target, [live[0]!, recordedPair()])).toMatchObject({ live: false, judges: ['judge', 'recorded'] });
    expect(ablationReport(target, [])).toMatchObject({ live: false, judges: [] });
  });
});
