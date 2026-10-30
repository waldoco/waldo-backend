import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { callPlan } from '../evals/nightly/plan';
import { selectScenarios } from '../evals/nightly/subset';
import { gateScorecard, NIGHTLY_THRESHOLDS, thresholdsFor } from '../evals/nightly/gate';
import { scorecard } from '../evals/nightly/scorecard';

const live = NIGHTLY_SCENARIOS.filter((scenario) => scenario.live_subset);

describe('the live-judged subset', () => {
  it('covers 12 to 20 runnable scenarios, each named once in the catalogue', () => {
    expect(live.length).toBeGreaterThanOrEqual(12);
    expect(live.length).toBeLessThanOrEqual(20);
    expect(live.every((scenario) => !scenario.blocked)).toBe(true);
    const ids = NIGHTLY_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('holds the harness-sensitive cases: a deferred tool, a long chat, a mid-errand failure and a forget', () => {
    const ids = live.map((scenario) => scenario.id);
    expect(ids).toEqual(expect.arrayContaining(['t02-calendar-change-card', 'r3-long-conversation', 'x22-mail-read-fails-mid-errand', 'm05-forget-then-ask', 'c1-connected-tracker']));
  });
});

describe('WALDO_EVAL_SUBSET', () => {
  it('runs the whole catalogue when it is empty or all', () => {
    expect(selectScenarios(undefined, NIGHTLY_SCENARIOS)).toBe(NIGHTLY_SCENARIOS);
    expect(selectScenarios('', NIGHTLY_SCENARIOS)).toBe(NIGHTLY_SCENARIOS);
    expect(selectScenarios(' all ', NIGHTLY_SCENARIOS)).toBe(NIGHTLY_SCENARIOS);
  });

  it('runs the flagged scenarios for live, in catalogue order', () => {
    expect(selectScenarios('live', NIGHTLY_SCENARIOS).map((scenario) => scenario.id)).toEqual(live.map((scenario) => scenario.id));
  });

  it('runs the named scenarios, in catalogue order', () => {
    expect(selectScenarios('r3-long-conversation,t03-reminder', NIGHTLY_SCENARIOS).map((scenario) => scenario.id)).toEqual(['t03-reminder', 'r3-long-conversation']);
  });

  it('refuses an id the catalogue does not have, naming it, before anything is built', () => {
    expect(() => selectScenarios('t03-reminder,t99-nothing', NIGHTLY_SCENARIOS)).toThrow('WALDO_EVAL_SUBSET names no scenario t99-nothing');
    expect(() => selectScenarios('live', NIGHTLY_SCENARIOS.filter((scenario) => !scenario.live_subset))).toThrow(/matches no scenario/);
  });

  it.each(['t03-reminder; rm -rf /', '$(id)', '`id`', 't03-reminder && echo pwned', 't03-reminder\nlive', 'T03-REMINDER', 't03_reminder', 'a,,b', 't03-reminder,', '../x', '*', "t03' OR '1'='1"])(
    'refuses %j without echoing it', (spec) => {
      expect(() => selectScenarios(spec, NIGHTLY_SCENARIOS)).toThrow('WALDO_EVAL_SUBSET takes all, live, or scenario ids separated by commas');
    });

  it('refuses a list longer than any real subset', () => {
    expect(() => selectScenarios(Array.from({ length: 65 }, () => 't03-reminder').join(','), NIGHTLY_SCENARIOS)).toThrow(/takes all, live/);
  });

  it('holds a subset card to the size of its subset, not the catalogue', () => {
    const rows = live.map((scenario) => ({ id: scenario.id, pain: scenario.pain, outcomes: ['pass' as const] }));
    const card = scorecard(rows, { candidate: 'x', judge: 'y', trials: 1, usage: { candidate_calls: 1, judge_calls: 1, budget: 600, exhausted: false, candidate_tokens: 1, judge_tokens: 1 }, subset: 'live' });
    expect(gateScorecard(card, thresholdsFor('live')).failures).toEqual([`scenarios ${live.length} < ${NIGHTLY_THRESHOLDS.live.min_scenarios}`]);
    expect(gateScorecard(card, thresholdsFor('live', live.length))).toEqual({ ok: true, failures: [] });
  });
});

describe('the call plan for a subset', () => {
  it('scales with the scenarios it covers', () => {
    const full = callPlan(NIGHTLY_SCENARIOS, 3);
    const subset = callPlan(live, 3);
    expect(subset.runnable).toBe(live.length);
    expect(subset.suggested_max_calls).toBeLessThan(full.suggested_max_calls / 4);
  });
});

const workflow = readFileSync(new URL('../../../.github/workflows/evals-live.yml', import.meta.url), 'utf8');
const lines = workflow.split('\n');

// The body of every `run:` in the file: the inline command, or the block that follows `run: |`.
const runBodies = (): readonly string[] => lines.flatMap((line, index) => {
  const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
  if (!match) return [];
  if (!/^[|>]/.test(match[2]!)) return [match[2]!];
  const body: string[] = [];
  for (let next = index + 1; next < lines.length && (lines[next]!.trim() === '' || lines[next]!.search(/\S/) > match[1]!.length); next += 1) body.push(lines[next]!);
  return [body.join('\n')];
});
const stepScript = (name: string): string => {
  const at = lines.findIndex((line) => line.includes(`name: ${name}`));
  const start = lines.findIndex((line, index) => index > at && /^\s*run: \|/.test(line));
  const indent = lines[start]!.search(/\S/);
  const body: string[] = [];
  for (let next = start + 1; next < lines.length && (lines[next]!.trim() === '' || lines[next]!.search(/\S/) > indent); next += 1) body.push(lines[next]!.slice(indent + 2));
  return body.join('\n');
};

describe('evals-live.yml', () => {
  it('is dispatch- and schedule-only, with read-only permissions and every action pinned to a commit', () => {
    expect(workflow).not.toMatch(/^\s+(push|pull_request\w*):/m);
    expect(workflow).toMatch(/^permissions:\n  contents: read\n\nconcurrency:/m);
    expect(workflow.match(/permissions:/g)).toHaveLength(1);
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('puts nothing from the event or its inputs into a shell command', () => {
    for (const body of runBodies()) expect(body).not.toContain('${{ github.');
    for (const body of runBodies()) expect(body).not.toMatch(/\$\{\{\s*(inputs|github\.event|github\.head_ref|steps\.plan)/);
    const subsetEnv = lines.filter((line) => line.includes('inputs.subset'));
    expect(subsetEnv).toHaveLength(1);
    expect(subsetEnv[0]).toMatch(/^\s+INPUT_SUBSET: \$\{\{ inputs\.subset \}\}$/);
  });

  it('checks out the branch it evaluates, since main carries no eval code, and keeps no credentials', () => {
    expect(workflow).toMatch(/ref: \$\{\{ inputs\.ref \|\| 'beta-mvp' \}\}\n\s+persist-credentials: false/);
  });

  it('runs the nightly subset and the weekly full run on two schedules the plan step tells apart', () => {
    const crons = [...workflow.matchAll(/- cron: '([^']+)'/g)].map((match) => match[1]);
    expect(crons).toHaveLength(2);
    expect(stepScript('Plan the run')).toContain(`'${crons[1]}') subset=all`);
  });

  const plan = (env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-live-plan-'));
    try {
      const output = join(dir, 'out');
      const run = spawnSync('bash', ['-c', stepScript('Plan the run')], { env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output, EVENT: 'workflow_dispatch', SCHEDULE: '', INPUT_SUBSET: '', ...env }, encoding: 'utf8' });
      let outputs = '';
      try { outputs = readFileSync(output, 'utf8'); } catch { /* nothing was written */ }
      return { status: run.status, stdout: run.stdout, outputs: Object.fromEntries(outputs.split('\n').filter(Boolean).map((row) => row.split('=') as [string, string])) };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('runs the subset at two trials under a 600-call cap, and the weekly run on everything at three trials under 4,400', () => {
    expect(plan({ EVENT: 'schedule', SCHEDULE: '30 20 * * *' })).toMatchObject({ status: 0, outputs: { subset: 'live', trials: '2', cap: '600' } });
    expect(plan({ EVENT: 'schedule', SCHEDULE: '30 21 * * 0' })).toMatchObject({ status: 0, outputs: { subset: 'all', trials: '3', cap: '4400' } });
    expect(plan({ INPUT_SUBSET: 'all' })).toMatchObject({ status: 0, outputs: { subset: 'all', trials: '3', cap: '4400' } });
    expect(plan({ INPUT_SUBSET: 't03-reminder,r3-long-conversation' })).toMatchObject({ status: 0, outputs: { subset: 't03-reminder,r3-long-conversation', trials: '2', cap: '600' } });
    expect(plan({})).toMatchObject({ status: 0, outputs: { subset: 'live' } });
  });

  it('keeps each cap at or above the plan for what it runs', () => {
    for (const run of [plan({ INPUT_SUBSET: 'live' }), plan({ INPUT_SUBSET: 'all' })]) {
      const scenarios = selectScenarios(run.outputs.subset, NIGHTLY_SCENARIOS);
      expect(Number(run.outputs.cap)).toBeGreaterThanOrEqual(callPlan(scenarios, Number(run.outputs.trials)).suggested_max_calls);
    }
    expect(Number(plan({ INPUT_SUBSET: 'live' }).outputs.cap)).toBeLessThanOrEqual(600);
  });

  it.each(['live; echo pwned', '$(id)', '`id`', 'live && id', 'live\nall', 'LIVE', 'a b', 'live|id', '../x'])('refuses the subset %j and writes nothing', (subset) => {
    const run = plan({ INPUT_SUBSET: subset });
    expect(run.status).not.toBe(0);
    expect(run.outputs).toEqual({});
    expect(run.stdout).not.toContain('pwned');
  });

  it('refuses a subset longer than any list of scenario ids, and a schedule it does not know falls to the nightly subset', () => {
    expect(plan({ INPUT_SUBSET: 'a'.repeat(4001) }).status).not.toBe(0);
    expect(plan({ EVENT: 'schedule', SCHEDULE: '0 0 * * *' }).outputs.subset).toBe('live');
  });

  it('passes the staging profile and the plan to the runner through its environment only', () => {
    expect(workflow).toMatch(/WALDO_EVAL_PROFILE: staging/);
    expect(workflow).toMatch(/WALDO_EVAL_SUBSET: \$\{\{ steps\.plan\.outputs\.subset \}\}/);
    expect(workflow).toMatch(/WALDO_EVAL_MAX_CALLS: \$\{\{ steps\.plan\.outputs\.cap \}\}/);
    expect(workflow).toMatch(/WALDO_EVAL_TRIALS: \$\{\{ steps\.plan\.outputs\.trials \}\}/);
    for (const name of ['WALDO_EVAL_MODE: live', 'OPENAI_API_KEY:', 'ANTHROPIC_API_KEY:', 'WALDO_EVAL_JUDGE_MODEL:']) expect(workflow).toContain(name);
  });
});
