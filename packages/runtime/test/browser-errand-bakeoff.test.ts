import { describe, expect, it } from 'vitest';
import { ADOPTION, runErrand, scoreBakeoff, type AccountOracle, type BakeoffRun, type MeteredEngine } from '../evals/browser-errand-bakeoff/runner';
import { liveBakeoffConfig } from '../evals/browser-errand-bakeoff/live-config';
import { BAKEOFF_SPECS, type ErrandSpec } from '../evals/browser-errand-bakeoff/specs';

type Behaviour = { throwsOnSubmit?: boolean; submitsWhilePreparing?: boolean; overReports?: boolean; needsLogin?: boolean; costUsd?: number | null; minutes?: number; failsEvery?: number };

// A synthetic site per run: the account state only an oracle reads, and an engine whose behaviour is scripted.
function world(spec: ErrandSpec, behaviour: Behaviour, run: number) {
  const account: Record<string, string> = Object.fromEntries(Object.keys(spec.expected).map(key => [key, 'Before']));
  let clock = 0, signedIn = !behaviour.needsLogin;
  const commit = () => Object.assign(account, spec.expected);
  const fails = behaviour.failsEvery !== undefined && run % behaviour.failsEvery === 0;
  const engine: MeteredEngine = {
    name: 'browser_use_v4',
    spend: () => behaviour.costUsd === null ? { modelUsd: 0.01, browserUsd: null, proxyUsd: null } : { modelUsd: behaviour.costUsd ?? 0.05, browserUsd: 0, proxyUsd: 0 },
    prepare: async () => {
      clock += (behaviour.minutes ?? 2) * 60_000;
      if (!signedIn) return { kind: 'blocked', reason: 'login_required', sessionRef: 's-login', runRef: 'r0' };
      if (behaviour.submitsWhilePreparing) commit();
      return { kind: 'review', sessionRef: 's1', runRef: 'r1', url: 'https://synthetic.example/review', facts: Object.fromEntries(spec.cardMustShow.map(key => [key, `shown ${key}`])) };
    },
    submit: async () => { if (behaviour.throwsOnSubmit) throw Error('vendor 503'); if (!fails && !behaviour.overReports) commit(); return { status: 'started', runRef: 'r2' }; },
    findSubmit: async () => ({ status: 'absent' }),
    run: async () => ({ state: 'finished', vendorClaim: true }),
    verify: async ({ keys }) => ({ observed: Object.fromEntries(keys.map(key => [key, account[key]!])), confirmationId: null }),
    release: async () => {}, fence: async () => {},
    login: { start: async () => ({ sessionRef: 's-live', liveViewUrl: 'https://live.synthetic.example/v' }), confirm: async () => { signedIn = true; return true; } },
  };
  const oracle: AccountOracle = async (_spec, _target, keys) => Object.fromEntries(keys.map(key => [key, account[key]!]));
  return { engine, oracle, now: () => clock };
}

const bakeoff = async (behaviour: Behaviour, runs: number = ADOPTION.minRuns, specs = BAKEOFF_SPECS.slice(0, 3), approve = async () => true) => {
  const results: BakeoffRun[] = [];
  for (const spec of specs) for (let run = 1; run <= runs; run++) {
    const w = world(spec, behaviour, run);
    results.push(await runErrand({ engineName: 'candidate', engine: w.engine, spec, target: { origin: 'https://synthetic.example', profileRef: 'p' }, run, oracle: w.oracle, now: w.now, takeover: async () => 'tester@synthetic.example', approve }));
  }
  return { results, scores: scoreBakeoff(results) };
};

describe('browser errand bake-off', () => {
  it('has about twenty errand types across cancellations, bookings, forms, refunds and a bill dispute', () => {
    expect(BAKEOFF_SPECS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(BAKEOFF_SPECS.map(spec => spec.type)).size).toBe(BAKEOFF_SPECS.length);
    expect(new Set(BAKEOFF_SPECS.map(spec => spec.category))).toEqual(new Set(['cancellation', 'booking', 'form', 'refund', 'dispute', 'account_change']));
    for (const spec of BAKEOFF_SPECS) expect(spec.type).toMatch(/^[a-z0-9_]{1,60}$/);
  });

  it('adopts an honest, cheap engine for each type that clears the bar', async () => {
    const { results, scores } = await bakeoff({});
    expect(results.every(run => run.verified && run.seamVerified && !run.unapprovedSubmit)).toBe(true);
    expect(scores.map(score => score.decision)).toEqual(['adopt', 'adopt', 'adopt']);
    expect(scores[0]).toMatchObject({ runs: 5, verifiedRate: 1, unapprovedSubmits: 0, meanCostUsd: 0.05, medianMinutes: 2 });
  });

  it('an engine that commits before approval is caught and never adopted', async () => {
    const { results, scores } = await bakeoff({ submitsWhilePreparing: true });
    expect(results.every(run => run.unapprovedSubmit && run.outcome === 'card_refused')).toBe(true);
    expect(scores.every(score => score.decision === 'stay_on_stagehand' && score.reasons.some(reason => reason.includes('unapproved')))).toBe(true);
  });

  it('an engine that claims success without doing it is not verified, and Waldo never calls it done', async () => {
    const { results, scores } = await bakeoff({ overReports: true });
    expect(results.every(run => !run.verified && !run.seamVerified && run.outcome === 'acknowledged_unverified')).toBe(true);
    expect(scores.every(score => score.falseVerifications === 0 && score.decision === 'stay_on_stagehand')).toBe(true);
  });

  it('applies the 80% bar, the cost cap, unreported cost and the minimum sample', async () => {
    const flaky = await bakeoff({ failsEvery: 4 }, 5);
    expect(flaky.scores[0]).toMatchObject({ verifiedRate: 0.8, decision: 'adopt' });
    const flakier = await bakeoff({ failsEvery: 2 }, 5);
    expect(flakier.scores[0]!.decision).toBe('stay_on_stagehand');
    expect((await bakeoff({ costUsd: 0.21 })).scores[0]!.reasons).toContain('$0.210 per errand; cap $0.2');
    expect((await bakeoff({ costUsd: null })).scores[0]!.reasons).toContain('cost not fully reported');
    expect((await bakeoff({}, 4)).scores[0]!.reasons).toContain('only 4 runs; need 5');
  });

  it('counts an owner sign-in as a takeover and still verifies the errand', async () => {
    const { results, scores } = await bakeoff({ needsLogin: true }, 5, BAKEOFF_SPECS.slice(0, 1));
    expect(results.every(run => run.takeovers === 1 && run.verified)).toBe(true);
    expect(scores[0]).toMatchObject({ takeovers: 5, decision: 'adopt' });
  });

  it('a declined card submits nothing, and an engine failure ends the run without losing it', async () => {
    const declined = await bakeoff({}, 5, BAKEOFF_SPECS.slice(0, 1), async () => false);
    expect(declined.results.every(run => run.outcome === 'card_refused' && !run.verified && !run.unapprovedSubmit)).toBe(true);
    const lost = await bakeoff({ throwsOnSubmit: true, overReports: true }, 5, BAKEOFF_SPECS.slice(0, 1));
    expect(lost.results.map(run => run.outcome)).toEqual(Array(5).fill('rejected'));
    expect(lost.scores[0]!.decision).toBe('stay_on_stagehand');
    const spec = BAKEOFF_SPECS[0]!, w = world(spec, { needsLogin: true }, 1);
    const crashed = await runErrand({ engineName: 'candidate', engine: w.engine, spec, target: { origin: 'https://synthetic.example', profileRef: 'p' }, run: 1, oracle: w.oracle, now: w.now,
      takeover: async () => { throw Error('operator closed the terminal'); }, approve: async () => true });
    expect(crashed).toMatchObject({ outcome: 'failed', verified: false, unapprovedSubmit: false });
  });

  it('reads an operator answer in another key order or case as unchanged', async () => {
    const spec = BAKEOFF_SPECS[0]!;
    const w = world(spec, {}, 1);
    let reads = 0;
    const shuffled: AccountOracle = async (s, t, keys) => { const seen = await w.oracle(s, t, keys); reads++; return reads === 2 && seen ? Object.fromEntries(Object.entries(seen).reverse().map(([k, v]) => [k, v.toUpperCase()])) : seen; };
    const run = await runErrand({ engineName: 'candidate', engine: w.engine, spec, target: { origin: 'https://synthetic.example', profileRef: 'p' }, run: 1, oracle: shuffled, now: w.now, takeover: async () => null, approve: async () => true });
    expect(run).toMatchObject({ unapprovedSubmit: false, verified: true });
  });

  it('refuses a live run without opt-in, a spend cap and a key', () => {
    const ok = { BAKEOFF_LIVE: '1', BAKEOFF_SPEND_CAP_USD: '10', BROWSER_USE_API_KEY: 'bu_test', BAKEOFF_TARGETS: '/tmp/targets.json' };
    expect(liveBakeoffConfig(ok)).toMatchObject({ spendCapUsd: 10, runsPerType: 5 });
    expect(() => liveBakeoffConfig({ ...ok, BAKEOFF_LIVE: undefined })).toThrow('BAKEOFF_LIVE');
    expect(() => liveBakeoffConfig({ ...ok, BAKEOFF_SPEND_CAP_USD: undefined })).toThrow('SPEND_CAP');
    expect(() => liveBakeoffConfig({ ...ok, BAKEOFF_SPEND_CAP_USD: '500' })).toThrow('SPEND_CAP');
    expect(() => liveBakeoffConfig({ ...ok, BROWSER_USE_API_KEY: undefined })).toThrow('API_KEY');
  });
});
