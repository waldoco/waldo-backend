import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { callPlan } from '../evals/nightly/plan';
import { LIVE_RUNS, liveRunPlan } from '../evals/nightly/live-plan';
import { parseShard, shardOf } from '../evals/nightly/shard';
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

describe('shards', () => {
  it('cover the selected scenarios once each, in catalogue order, the same way every time', () => {
    const shards = [1, 2, 3, 4].map((index) => shardOf(NIGHTLY_SCENARIOS, `${index}/4`));
    expect(shards.flat().length).toBe(NIGHTLY_SCENARIOS.length);
    expect(new Set(shards.flat()).size).toBe(NIGHTLY_SCENARIOS.length);
    for (const shard of shards) expect(shard.map((scenario) => NIGHTLY_SCENARIOS.indexOf(scenario))).toEqual([...shard.map((scenario) => NIGHTLY_SCENARIOS.indexOf(scenario))].sort((a, b) => a - b));
    expect(shardOf(NIGHTLY_SCENARIOS, '2/4')).toEqual(shards[1]);
  });

  it('take about the same time: no shard plans more than a fifth over the lightest', () => {
    const needs = [1, 2, 3, 4].map((index) => callPlan(shardOf(NIGHTLY_SCENARIOS, `${index}/4`), 3).suggested_max_calls);
    expect(Math.max(...needs)).toBeLessThanOrEqual(Math.min(...needs) * 1.2);
  });

  it('are the whole selection for one shard or none, and refuse a spec that is not n/of', () => {
    expect(shardOf(NIGHTLY_SCENARIOS, undefined)).toBe(NIGHTLY_SCENARIOS);
    expect(shardOf(NIGHTLY_SCENARIOS, '1/1')).toEqual(NIGHTLY_SCENARIOS);
    for (const bad of ['0/4', '5/4', '1/0', '1', '1/4; id', 'a/b', '1/100', '-1/4', '1/4/4']) expect(() => parseShard(bad), bad).toThrow('WALDO_EVAL_SHARD takes');
  });

  it('give a shard card the size of its shard at the gate', () => {
    const picked = shardOf(NIGHTLY_SCENARIOS, '3/4');
    const card = scorecard(picked.map((scenario) => ({ id: scenario.id, pain: scenario.pain, outcomes: ['pass' as const] })), { candidate: 'x', judge: 'y', trials: 1, usage: { candidate_calls: 1, judge_calls: 1, budget: 1100, exhausted: false, candidate_tokens: 1, judge_tokens: 1 }, shard: '3/4' });
    expect(card.shard).toBe('3/4');
    expect(gateScorecard(card, thresholdsFor('live', picked.length))).toEqual({ ok: true, failures: [] });
  });
});

describe('the live run plan', () => {
  it('cuts the weekly run into four shards at three trials, and the subset into one at two', () => {
    expect(liveRunPlan('all', NIGHTLY_SCENARIOS)).toMatchObject({ subset: 'all', trials: 3 });
    expect(liveRunPlan('all', NIGHTLY_SCENARIOS).shards.map((shard) => shard.shard)).toEqual(['1/4', '2/4', '3/4', '4/4']);
    expect(liveRunPlan('live', NIGHTLY_SCENARIOS)).toMatchObject({ subset: 'live', trials: 2, shards: [{ index: 1, shard: '1/1' }] });
    expect(liveRunPlan(undefined, NIGHTLY_SCENARIOS).subset).toBe('live');
    expect(liveRunPlan('t03-reminder', NIGHTLY_SCENARIOS)).toMatchObject({ subset: 't03-reminder', trials: 2 });
  });

  it('holds each shard\'s cap at or above the plan for what it runs, and their sum at or under the total', () => {
    for (const spec of ['all', 'live']) {
      const plan = liveRunPlan(spec, NIGHTLY_SCENARIOS);
      const total = plan.shards.reduce((sum, shard) => sum + shard.cap, 0);
      expect(total).toBeLessThanOrEqual((spec === 'all' ? LIVE_RUNS.all : LIVE_RUNS.subset).total_cap);
      for (const shard of plan.shards) expect(shard.cap).toBeGreaterThanOrEqual(callPlan(shardOf(selectScenarios(spec, NIGHTLY_SCENARIOS), shard.shard), plan.trials).suggested_max_calls);
    }
    expect(LIVE_RUNS.subset.total_cap).toBeLessThanOrEqual(600);
  });

  it('leaves each weekly shard well under a runner\'s 360-minute job limit', () => {
    // At 6 s a candidate call (the 10 October baseline) and up to 30 s for each trial's judge wave, the high estimate.
    for (const shard of liveRunPlan('all', NIGHTLY_SCENARIOS).shards) {
      const scenarios = shardOf(NIGHTLY_SCENARIOS, shard.shard).filter((scenario) => !scenario.blocked);
      const plan = callPlan(scenarios, LIVE_RUNS.all.trials);
      expect((plan.candidate_calls.high * 6 + scenarios.length * LIVE_RUNS.all.trials * 30) / 60).toBeLessThan(150);
    }
  });

  it('refuses a plan over what the run may spend, before any call', () => {
    const room = NIGHTLY_SCENARIOS.filter((scenario) => !scenario.blocked && scenario.rubric.voice);
    expect(() => liveRunPlan('all', [...NIGHTLY_SCENARIOS, ...room, ...room, ...room])).toThrow(/may spend/);
    expect(() => liveRunPlan('all', [...NIGHTLY_SCENARIOS, ...room.slice(0, 2)])).not.toThrow();
  });

  it.each(['live; echo pwned', '$(id)', '`id`', 'live && id', 'live\nall', 'LIVE', 'a b', 'live|id', '../x', 'a'.repeat(5000)])('refuses the subset %j', (spec) => {
    expect(() => liveRunPlan(spec, NIGHTLY_SCENARIOS)).toThrow(/takes all, live/);
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

  it('puts nothing from the event, its inputs or another job into a shell command', () => {
    for (const body of runBodies()) expect(body).not.toMatch(/\$\{\{/);
    const subsetEnv = lines.filter((line) => line.includes('inputs.subset'));
    expect(subsetEnv).toHaveLength(1);
    expect(subsetEnv[0]).toMatch(/^\s+INPUT_SUBSET: \$\{\{ inputs\.subset \}\}$/);
  });

  it('holds no trial count, shard count or call cap: the evaluated tree plans them', () => {
    expect(workflow).not.toMatch(/\b(cap|trials|shards?)=\d/);
    expect(workflow).not.toMatch(/WALDO_EVAL_(MAX_CALLS|TRIALS|SHARD): '?\d/);
    expect(workflow).toMatch(/WALDO_EVAL_MAX_CALLS: \$\{\{ matrix\.cap \}\}/);
    expect(workflow).toMatch(/WALDO_EVAL_SHARD: \$\{\{ matrix\.shard \}\}/);
    expect(workflow).toMatch(/WALDO_EVAL_TRIALS: \$\{\{ needs\.plan\.outputs\.trials \}\}/);
    expect(workflow).toMatch(/include: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/);
  });

  it('checks out the branch it evaluates in every job, since main carries no eval code, and keeps no credentials', () => {
    const checkouts = [...workflow.matchAll(/ref: \$\{\{ inputs\.ref \|\| 'beta-mvp' \}\}\n\s+persist-credentials: false/g)];
    expect(checkouts).toHaveLength(2);
    expect(workflow.match(/actions\/checkout@/g)).toHaveLength(2);
  });

  it('keeps each job under the runner limit, runs shards independently, and uploads the scorecard even when a shard fails', () => {
    const limits = [...workflow.matchAll(/timeout-minutes: (\d+)/g)].map((match) => Number(match[1]));
    expect(limits.length).toBe(2);
    for (const limit of limits) expect(limit).toBeLessThan(360);
    expect(workflow).toMatch(/fail-fast: false/);
    expect(workflow).toMatch(/if: \$\{\{ always\(\) \}\}\n\s+uses: actions\/upload-artifact@[0-9a-f]{40}/);
    expect(workflow).toMatch(/name: evals-live-scorecard-\$\{\{ matrix\.index \}\}/);
  });

  it('runs the nightly subset and the weekly full run on two schedules the plan step tells apart', () => {
    const crons = [...workflow.matchAll(/- cron: '([^']+)'/g)].map((match) => match[1]);
    expect(crons).toHaveLength(2);
    expect(stepScript('Plan the run')).toContain(`'${crons[1]}') subset=all`);
  });

  // Runs the plan step's shell with a stand-in for pnpm that records what it was given.
  const plan = (env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-live-plan-'));
    try {
      const log = join(dir, 'pnpm.log');
      writeFileSync(join(dir, 'pnpm'), `#!/bin/bash\necho "args: $*" >> '${log}'\necho "subset: $WALDO_EVAL_SUBSET" >> '${log}'\n`);
      chmodSync(join(dir, 'pnpm'), 0o755);
      const run = spawnSync('bash', ['-c', stepScript('Plan the run')], { env: { PATH: `${dir}:${process.env.PATH ?? ''}`, EVENT: 'workflow_dispatch', SCHEDULE: '', INPUT_SUBSET: '', ...env }, encoding: 'utf8' });
      let seen = '';
      try { seen = readFileSync(log, 'utf8'); } catch { /* the planner was never reached */ }
      return { status: run.status, seen };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('hands the subset to the planner through its environment only, never on its command line', () => {
    expect(plan({ EVENT: 'schedule', SCHEDULE: '30 20 * * *' }).seen).toContain('subset: live');
    expect(plan({ EVENT: 'schedule', SCHEDULE: '30 21 * * 0' }).seen).toContain('subset: all');
    expect(plan({ EVENT: 'schedule', SCHEDULE: '0 0 * * *' }).seen).toContain('subset: live');
    expect(plan({ INPUT_SUBSET: 'all' }).seen).toContain('subset: all');
    expect(plan({}).seen).toContain('subset: live');
    const hostile = plan({ INPUT_SUBSET: 'live; echo pwned $(id) `id`' });
    expect(hostile.status).toBe(0);
    expect(hostile.seen).toContain('args: exec tsx evals/nightly/live-plan.ts\n');
    expect(hostile.seen).not.toMatch(/pwned.*\n.*args|args:.*pwned/);
  });

  it('passes the staging profile and the plan to the runner through its environment only', () => {
    expect(workflow).toMatch(/WALDO_EVAL_PROFILE: staging/);
    expect(workflow).toMatch(/WALDO_EVAL_SUBSET: \$\{\{ needs\.plan\.outputs\.subset \}\}/);
    for (const name of ['WALDO_EVAL_MODE: live', 'OPENAI_API_KEY:', 'ANTHROPIC_API_KEY:', 'WALDO_EVAL_JUDGE_MODEL:']) expect(workflow).toContain(name);
  });
});
