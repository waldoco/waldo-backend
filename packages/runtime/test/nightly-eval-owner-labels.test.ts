// Every owner label in this file is synthetic and lives in the test only; the repository holds none until the owner
// signs some. Nothing here may be copied into a fixture as though a person had made the call.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agreementReport, labellingSheet, loadOwnerLabels, OWNER_LABELS_NEEDED, OWNER_LABELS_PATH, ownerLabelled, parseOwnerLabels } from '../evals/nightly/owner-labels';
import { VOICE_TESTS } from '../evals/nightly/voice';
import { loadVoiceLabels, type LabelledVerdict, type VoiceLabel } from '../evals/nightly/voice-labels';

const drafts = loadVoiceLabels();
const row = (over: Record<string, unknown> = {}) => JSON.stringify({ id: drafts[0]!.id, label: 'pass', reviewed_by: 'test-owner', ...over });
const lines = (...rows: string[]) => rows.join('\n');

describe('owner label file', () => {
  it('reads a pass and a fail that names its tests, keyed by the draft\'s id', () => {
    const decisions = parseOwnerLabels(lines(row(), row({ id: drafts[1]!.id, label: 'fail', failed_tests: ['kind', 'one_job'] })), drafts);
    expect(decisions).toEqual([
      { id: drafts[0]!.id, label: 'pass', reviewed_by: 'test-owner' },
      { id: drafts[1]!.id, label: 'fail', failed_tests: ['kind', 'one_job'], reviewed_by: 'test-owner' },
    ]);
  });

  it('refuses an id the set does not have, a repeated id, a fail with no tests, a pass with tests, no name, or a stray field', () => {
    expect(() => parseOwnerLabels(row({ id: 'not-in-the-set' }), drafts)).toThrow(/not-in-the-set/);
    expect(() => parseOwnerLabels(lines(row(), row()), drafts)).toThrow(/once/);
    expect(() => parseOwnerLabels(row({ label: 'fail' }), drafts)).toThrow(/failed tests/);
    expect(() => parseOwnerLabels(row({ failed_tests: ['kind'] }), drafts)).toThrow(/failed tests/);
    expect(() => parseOwnerLabels(row({ reviewed_by: '' }), drafts)).toThrow(/line 1/);
    expect(() => parseOwnerLabels(row({ why: 'x' }), drafts)).toThrow(/line 1/);
    expect(() => parseOwnerLabels(row({ failed_tests: ['not_a_test'], label: 'fail' }), drafts)).toThrow(/line 1/);
  });

  it('is empty when the owner has not labelled anything yet, and the repository ships no owner labels', () => {
    expect(loadOwnerLabels(join(tmpdir(), 'no-such-owner-labels.jsonl'), drafts)).toEqual([]);
    expect(loadOwnerLabels(OWNER_LABELS_PATH, drafts)).toEqual([]);
  });

  it('reads a file the owner saved, and still names the line of a broken one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owner-labels-'));
    const good = join(dir, 'good.jsonl');
    writeFileSync(good, `${lines(row(), row({ id: drafts[1]!.id }))}\n`);
    expect(loadOwnerLabels(good, drafts)).toHaveLength(2);
    const broken = join(dir, 'broken.jsonl');
    writeFileSync(broken, `${row()}\n{"id":\n`);
    expect(() => loadOwnerLabels(broken, drafts)).toThrow(/line 2/);
  });
});

describe('owner-labelled replies', () => {
  it('takes the owner\'s call over the draft\'s, keeps the reply, and leaves out replies no person has called', () => {
    const flipped = drafts[0]!.label === 'pass' ? 'fail' : 'pass';
    const decisions = parseOwnerLabels(row({ label: flipped, ...(flipped === 'fail' ? { failed_tests: ['kind'] } : {}) }), drafts);
    const owned = ownerLabelled(drafts, decisions);
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ id: drafts[0]!.id, label: flipped, reviewed_by: 'test-owner', labelled_by: 'test-owner', transcript: drafts[0]!.transcript });
    expect(drafts[0]!.reviewed_by).toBeNull();
  });

  it('counts a draft the owner reviewed in place, and lets a blind decision override it', () => {
    const inPlace: VoiceLabel[] = drafts.map((label, index) => (index < 2 ? { ...label, reviewed_by: 'test-owner' } : label));
    expect(ownerLabelled(inPlace, []).map((label) => label.id)).toEqual([drafts[0]!.id, drafts[1]!.id]);
    const override = parseOwnerLabels(row({ id: drafts[1]!.id, label: 'fail', failed_tests: ['discreet'] }), drafts);
    expect(ownerLabelled(inPlace, override).find((label) => label.id === drafts[1]!.id)).toMatchObject({ label: 'fail', failed_tests: ['discreet'] });
  });
});

describe('labelling sheet', () => {
  const sheet = labellingSheet(drafts);

  it('shows every reply with what the judge sees and the six tests to call it against', () => {
    for (const label of drafts) {
      expect(sheet).toContain(label.id);
      expect(sheet).toContain(label.voice.moment);
      for (const turn of label.transcript) expect(sheet).toContain(turn.text);
    }
    for (const entry of VOICE_TESTS) { expect(sheet).toContain(entry.key); expect(sheet).toContain(entry.test); }
    expect(sheet).toContain('voice-owner-labels.jsonl');
  });

  it('hides the draft\'s call, its reasons and its author, so the owner labels blind', () => {
    for (const label of drafts) expect(sheet).not.toContain(label.why);
    expect(sheet).not.toContain('claude-draft');
  });
});

describe('judge agreement against owner labels', () => {
  const verdictsLike = (labels: readonly VoiceLabel[], wrong: ReadonlySet<string>): LabelledVerdict[] => labels.map((label) => ({
    id: label.id,
    outcome: (wrong.has(label.id) ? (label.label === 'pass' ? 'fail' : 'pass') : label.label) as 'pass' | 'fail',
    failed_tests: label.failed_tests ?? [], unknown_tests: [],
  }));

  it('reports no kappa against the owner until a person has labelled something, and still reports the drafts apart', () => {
    const report = agreementReport(drafts, [], verdictsLike(drafts, new Set()));
    expect(report.against_owner).toMatchObject({ owner_labels: 0, blind: 0, enough: false, kappa: null });
    expect(report.against_claude_drafts).toMatchObject({ labels: drafts.length, kappa: 1 });
  });

  it('computes kappa from the owner\'s calls alone: a judge that matches the drafts can still disagree with the owner', () => {
    const decisions = parseOwnerLabels(drafts.map((label, index) => row({
      id: label.id, label: index % 2 === 0 ? (label.label === 'pass' ? 'fail' : 'pass') : label.label,
      ...((index % 2 === 0 ? label.label === 'pass' : label.label === 'fail') ? { failed_tests: label.failed_tests ?? ['kind'] } : {}),
    })).join('\n'), drafts);
    const report = agreementReport(drafts, decisions, verdictsLike(drafts, new Set()));
    expect(report.against_claude_drafts.kappa).toBe(1);
    expect(report.against_owner.owner_labels).toBe(drafts.length);
    expect(report.against_owner.blind).toBe(drafts.length);
    expect(report.against_owner.kappa!).toBeLessThan(0.5);
    expect(report.against_owner.disagreements.length).toBe(Math.ceil(drafts.length / 2));
  });

  it('computes Cohen\'s kappa exactly on a hand-made owner set, and flags a set too small to trust', () => {
    const owner = drafts.slice(0, 20);
    const passes = owner.filter((label) => label.label === 'pass').map((label) => label.id);
    const fails = owner.filter((label) => label.label === 'fail').map((label) => label.id);
    // The judge is wrong on one pass and one fail: observed agreement 18/20, chance from the two marginals.
    const wrong = new Set([passes[0]!, fails[0]!]);
    const decisions = parseOwnerLabels(owner.map((label) => row({ id: label.id, label: label.label, ...(label.label === 'fail' ? { failed_tests: label.failed_tests } : {}) })).join('\n'), drafts);
    const report = agreementReport(drafts, decisions, verdictsLike(drafts, wrong));
    const [p, f] = [passes.length, fails.length];
    const observed = 18 / 20;
    // One wrong each way leaves the judge's pass and fail counts equal to the owner's.
    const chance = ((p / 20) ** 2) + ((f / 20) ** 2);
    expect(report.against_owner.kappa).toBeCloseTo((observed - chance) / (1 - chance), 6);
    expect(report.against_owner.false_pass_rate).toBeCloseTo(1 / f);
    expect(report.against_owner.enough).toBe(owner.length >= OWNER_LABELS_NEEDED);
    expect(report.against_owner.enough).toBe(false);
  });

  it('trusts a set at the size the owner is asked to label', () => {
    expect(OWNER_LABELS_NEEDED).toBeLessThanOrEqual(drafts.length);
    const decisions = parseOwnerLabels(drafts.map((label) => row({ id: label.id, label: label.label, ...(label.label === 'fail' ? { failed_tests: label.failed_tests } : {}) })).join('\n'), drafts);
    expect(agreementReport(drafts, decisions, verdictsLike(drafts, new Set())).against_owner).toMatchObject({ enough: true, kappa: 1 });
  });
});
