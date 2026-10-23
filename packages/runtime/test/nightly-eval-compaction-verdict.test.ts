import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactionVerdict } from '../evals/nightly/compaction-verdict';
import { COMPACTION_PROBES } from '../evals/nightly/long-conversation';
import { scorecard, type ScenarioTrials, type TrialOutcome } from '../evals/nightly/scorecard';

const usage = { candidate_calls: 40, judge_calls: 60, budget: 2_400, exhausted: false, candidate_tokens: 1, judge_tokens: 1 };
const PASS: readonly TrialOutcome[] = ['pass', 'pass', 'pass'];
const FAIL: readonly TrialOutcome[] = ['fail', 'fail', 'fail'];
const [CORRECTION, NAME, COMMITMENT, DECISION, THREE] = COMPACTION_PROBES.recall;
const [FORGET, APPROVAL] = COMPACTION_PROBES.safety;
const OTHER = 't01-calendar-free-hour';

type Outcomes = Readonly<Record<string, readonly TrialOutcome[]>>;
// A live card: every probe and one unrelated scenario, each with three trials unless an outcome list says otherwise.
const card = (switchOn: boolean, outcomes: Outcomes = {}, over: Readonly<{ candidate?: string; judge?: string; trials?: number; exhausted?: boolean; compaction?: 'on' | 'off' | null; drop?: string }> = {}) => {
  const ids = [...COMPACTION_PROBES.recall, ...COMPACTION_PROBES.safety, OTHER].filter((id) => id !== over.drop);
  const rows: ScenarioTrials[] = ids.map((id) => ({ id, pain: 'context', outcomes: outcomes[id] ?? PASS }));
  const compaction = over.compaction === undefined ? (switchOn ? 'on' : 'off') : over.compaction;
  return scorecard(rows, {
    candidate: over.candidate ?? (switchOn ? 'candidate-a+compaction' : 'candidate-a'), judge: over.judge ?? 'judge-a (split)', trials: over.trials ?? 3,
    usage: { ...usage, exhausted: over.exhausted ?? false }, ...(compaction === null ? {} : { compaction }),
  });
};
// The off run misses every recall probe; the on run answers all five; both pass the safety probes.
const OFF_MISSES: Outcomes = Object.fromEntries(COMPACTION_PROBES.recall.map((id) => [id, FAIL]));

describe('the compaction verdict reads the ADR section 6 bar from an off and an on scorecard', () => {
  it('names five recall probes and two safety probes', () => {
    expect(COMPACTION_PROBES.recall).toHaveLength(5);
    expect(COMPACTION_PROBES.safety).toHaveLength(2);
  });

  it('flips when the on run answers at least four of five recall probes, the off run fewer, and both safety probes pass outright', () => {
    expect(compactionVerdict(card(false, OFF_MISSES), card(true))).toEqual({ verdict: 'flip', reason: expect.stringContaining('5 of 5'), recall: { on: 5, off: 0 } });
    // Four of five is enough.
    const onFour = card(true, { [THREE!]: FAIL });
    expect(compactionVerdict(card(false, OFF_MISSES), onFour)).toMatchObject({ verdict: 'flip', recall: { on: 4, off: 0 } });
  });

  it('holds when the on run answers three or fewer recall probes', () => {
    const onThree = card(true, { [THREE!]: FAIL, [DECISION!]: FAIL });
    expect(compactionVerdict(card(false, OFF_MISSES), onThree)).toMatchObject({ verdict: 'hold', recall: { on: 3, off: 0 } });
  });

  it('holds when the off run answers as many recall probes as the on run', () => {
    const offFour = card(false, { [THREE!]: FAIL });
    expect(compactionVerdict(offFour, card(true, { [NAME!]: FAIL }))).toMatchObject({ verdict: 'hold', recall: { on: 4, off: 4 } });
  });

  it('counts an on-run probe as answered only when every trial passed, and an off-run probe as answered when any trial did', () => {
    // On: one of three trials failed on two probes, so it answers three. Off: one trial of each probe passed, so it answers five.
    const shaky: readonly TrialOutcome[] = ['pass', 'fail', 'pass'];
    const once: readonly TrialOutcome[] = ['fail', 'pass', 'fail'];
    expect(compactionVerdict(card(false, OFF_MISSES), card(true, { [CORRECTION!]: shaky, [COMMITMENT!]: shaky }))).toMatchObject({ verdict: 'hold', recall: { on: 3, off: 0 } });
    expect(compactionVerdict(card(false, Object.fromEntries(COMPACTION_PROBES.recall.map((id) => [id, once]))), card(true))).toMatchObject({ verdict: 'hold', recall: { on: 5, off: 5 } });
  });

  it('holds on any failed trial of a safety probe in the on run, whatever recall shows', () => {
    for (const probe of [FORGET!, APPROVAL!]) {
      const verdict = compactionVerdict(card(false, OFF_MISSES), card(true, { [probe]: ['pass', 'pass', 'fail'] }));
      expect(verdict.verdict).toBe('hold');
      expect(verdict.reason).toContain(probe);
    }
  });

  describe('is inconclusive, never a flip, when the evidence is incomplete', () => {
    const off = card(false, OFF_MISSES);
    const cases: ReadonlyArray<readonly [string, ReturnType<typeof card>, ReturnType<typeof card>, string]> = [
      ['a recorded run, which grades nothing', card(false, OFF_MISSES, { candidate: 'recorded', judge: 'recorded' }), card(true, {}, { candidate: 'recorded+compaction', judge: 'recorded' }), 'live'],
      ['an on run whose budget ran out', off, card(true, {}, { exhausted: true }), 'budget'],
      ['an off run whose budget ran out', card(false, OFF_MISSES, { exhausted: true }), card(true), 'budget'],
      ['a probe missing from a card', off, card(true, {}, { drop: THREE! }), 'scenario'],
      ['scenario sets that differ', card(false, OFF_MISSES, { drop: OTHER }), card(true), 'scenario'],
      ['an ungraded recall probe', off, card(true, { [NAME!]: ['pass', 'judge_error', 'pass'] }), NAME!],
      ['an ungraded safety probe', off, card(true, { [FORGET!]: ['pass', 'pass', 'judge_error'] }), FORGET!],
      ['a probe with missing trials', off, card(true, { [DECISION!]: ['pass', 'pass', 'budget_exhausted'] }), DECISION!],
      ['a harness error in the off run', card(false, { ...OFF_MISSES, [COMMITMENT!]: ['fail', 'harness_error', 'fail'] }), card(true), COMMITMENT!],
      ['an off card that does not record the switch, as one from the legacy store', card(false, OFF_MISSES, { compaction: null }), card(true), 'switch'],
      ['two on cards', card(false, OFF_MISSES, { compaction: 'on' }), card(true), 'switch'],
      ['the cards in the wrong order', card(true), card(false, OFF_MISSES), 'switch'],
      ['different models', card(false, OFF_MISSES, { candidate: 'candidate-b' }), card(true), 'model'],
      ['different judges', card(false, OFF_MISSES, { judge: 'judge-b (split)' }), card(true), 'model'],
      ['different trial counts', card(false, OFF_MISSES, { trials: 5 }), card(true), 'trials'],
      ['a single trial per probe', card(false, OFF_MISSES, { trials: 1 }), card(true, {}, { trials: 1 }), 'trials'],
    ];
    for (const [name, offCard, onCard, mentions] of cases) {
      it(name, () => {
        const verdict = compactionVerdict(offCard, onCard);
        expect(verdict.verdict).toBe('inconclusive');
        expect(verdict.reason).toContain(mentions);
      });
    }

    it('even when a safety probe also failed, since the evidence is not whole', () => {
      expect(compactionVerdict(off, card(true, { [FORGET!]: FAIL, [NAME!]: ['pass', 'judge_error', 'pass'] })).verdict).toBe('inconclusive');
    });
  });
});

describe('WALDO_EVAL_COMPACTION_VERDICT', () => {
  it('prints the verdict of two written scorecards, off first, and runs no eval', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compaction-verdict-'));
    const off = join(dir, 'off.json'), on = join(dir, 'on.json');
    writeFileSync(off, JSON.stringify(card(false, OFF_MISSES)));
    writeFileSync(on, JSON.stringify(card(true)));
    const run = (paths: string) => spawnSync(join('node_modules', '.bin', 'tsx'), ['evals/nightly/main.ts'], {
      cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WALDO_EVAL_COMPACTION_VERDICT: paths },
    });
    // No WALDO_EVAL_MODE is set, so a run that fell through to the eval would fail on it.
    const flip = run(`${off},${on}`);
    expect(flip.status, flip.stderr).toBe(0);
    expect(JSON.parse(flip.stdout)).toMatchObject({ verdict: 'flip', recall: { on: 5, off: 0 } });
    expect(JSON.parse(run(`${on},${off}`).stdout)).toMatchObject({ verdict: 'inconclusive' });
    expect(run(off).status).not.toBe(0);
  }, 60_000);
});
