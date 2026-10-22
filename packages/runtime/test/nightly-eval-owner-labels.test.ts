// Every owner label in this file is synthetic and lives in the test only; the repository holds none until the owner
// signs some. Nothing here may be copied into a fixture as though a person had made the call.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agreementReport, labellingSheet, loadOwnerLabels, opaqueIds, OWNER_LABELS_NEEDED, OWNER_LABELS_PATH, ownerLabelled, parseOwnerLabels } from '../evals/nightly/owner-labels';
import { VOICE_TESTS } from '../evals/nightly/voice';
import { loadVoiceLabels, type LabelledVerdict, type VoiceLabel } from '../evals/nightly/voice-labels';

const drafts = loadVoiceLabels();
const ids = opaqueIds(drafts);
const opaque = (index: number) => ids.get(drafts[index]!.id)!;
const row = (over: Record<string, unknown> = {}) => JSON.stringify({ id: opaque(0), label: 'pass', reviewed_by: 'test-owner', ...over });
const lines = (...rows: string[]) => rows.join('\n');

describe('opaque ids', () => {
  it('number the replies L01 onward with a fingerprint of the set, and are the same every time', () => {
    const all = [...ids.values()];
    expect(all).toHaveLength(drafts.length);
    expect(new Set(all).size).toBe(drafts.length);
    for (const id of all) expect(id).toMatch(/^L\d{2}-[0-9a-f]{4}$/);
    expect(all.map((id) => Number(id.slice(1, 3))).sort((a, b) => a - b)).toEqual(Array.from({ length: drafts.length }, (_, index) => index + 1));
    expect([...opaqueIds(drafts).values()]).toEqual(all);
  });

  it('say nothing of the draft: not its id, not the file order, not the verdict', () => {
    for (const draft of drafts) expect(ids.get(draft.id)!.toLowerCase()).not.toMatch(/pass|fail|brief|dose|link|close/);
    const inFileOrder = drafts.map((draft) => Number(ids.get(draft.id)!.slice(1, 3)));
    expect(inFileOrder).not.toEqual([...inFileOrder].sort((a, b) => a - b));
    const firstHalf = drafts.filter((draft) => Number(ids.get(draft.id)!.slice(1, 3)) <= Math.floor(drafts.length / 2));
    expect(new Set(firstHalf.map((draft) => draft.label))).toEqual(new Set(['pass', 'fail']));
  });

  it('stop matching when the set changes, so a label can never attach to a different reply', () => {
    const smaller = drafts.slice(1);
    expect([...opaqueIds(smaller).values()].some((id) => id === opaque(1))).toBe(false);
    expect(() => parseOwnerLabels(row({ id: opaque(1) }), smaller)).toThrow(/not in the labelled set/);
  });
});

describe('owner label file', () => {
  it('reads a pass and a fail that names its tests, keyed by the opaque id, and hands back the draft\'s own id', () => {
    const decisions = parseOwnerLabels(lines(row(), row({ id: opaque(1), label: 'fail', failed_tests: ['kind', 'one_job'] })), drafts);
    expect(decisions).toEqual([
      { id: drafts[0]!.id, label: 'pass', reviewed_by: 'test-owner' },
      { id: drafts[1]!.id, label: 'fail', failed_tests: ['kind', 'one_job'], reviewed_by: 'test-owner' },
    ]);
  });

  it('refuses the draft\'s own id, an id the set does not have, a repeated id, a fail with no tests, a pass with tests, no name, or a stray field', () => {
    expect(() => parseOwnerLabels(row({ id: drafts[0]!.id }), drafts)).toThrow(/not in the labelled set/);
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
    writeFileSync(good, `${lines(row(), row({ id: opaque(1) }))}\n`);
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
    const override = parseOwnerLabels(row({ id: opaque(1), label: 'fail', failed_tests: ['discreet'] }), drafts);
    expect(ownerLabelled(inPlace, override).find((label) => label.id === drafts[1]!.id)).toMatchObject({ label: 'fail', failed_tests: ['discreet'] });
  });
});

describe('labelling sheet', () => {
  const sheet = labellingSheet(drafts);
  const items = sheet.slice(sheet.indexOf('\n## L'));

  it('shows every reply with what the judge sees and the six tests to call it against', () => {
    for (const label of drafts) {
      expect(sheet).toContain(label.voice.moment);
      for (const turn of label.transcript) expect(sheet).toContain(turn.text);
    }
    for (const entry of VOICE_TESTS) { expect(sheet).toContain(entry.key); expect(sheet).toContain(entry.test); }
    expect(sheet).toContain('voice-owner-labels.jsonl');
  });

  it('heads every reply with its opaque id alone, in opaque order, and names no draft id anywhere', () => {
    const headings = sheet.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual([...ids.values()].sort().map((id) => `## ${id}`));
    for (const draft of drafts) expect(sheet).not.toContain(draft.id);
  });

  it('carries no verdict: not a draft\'s reasons, author, label or failed tests, and no pass or fail word beside a reply', () => {
    for (const label of drafts) expect(sheet).not.toContain(label.why);
    expect(sheet).not.toContain('claude-draft');
    // The moment's guidance and a failed tool call are context the judge sees too, not a call on the reply.
    const replies = items.split('\n').filter((line) => !line.startsWith('What this moment asks:') && !line.startsWith('Tools called, in order:')).join('\n');
    expect(replies).not.toMatch(/\b(pass|passes|passed|fail|fails|failed)\b/i);
    expect(items).not.toMatch(/"label"|"failed_tests"|reviewed_by/);
  });
});

describe('judge agreement against owner labels', () => {
  const verdictsLike = (labels: readonly VoiceLabel[], wrong: ReadonlySet<string>): LabelledVerdict[] => labels.map((label) => ({
    id: label.id,
    outcome: (wrong.has(label.id) ? (label.label === 'pass' ? 'fail' : 'pass') : label.label) as 'pass' | 'fail',
    failed_tests: label.failed_tests ?? [], unknown_tests: [],
  }));
  const ownerRows = (labels: readonly VoiceLabel[], call: (label: VoiceLabel, index: number) => 'pass' | 'fail') => parseOwnerLabels(labels.map((label, index) => {
    const verdict = call(label, index);
    return row({ id: ids.get(label.id), label: verdict, ...(verdict === 'fail' ? { failed_tests: label.failed_tests ?? ['kind'] } : {}) });
  }).join('\n'), drafts);

  it('reports no kappa against the owner until a person has labelled something, and reports the drafts apart as self-consistency', () => {
    const report = agreementReport(drafts, [], verdictsLike(drafts, new Set()));
    expect(report.against_owner).toMatchObject({ owner_labels: 0, blind: 0, enough: false, kappa: null });
    expect(report.self_consistency).toMatchObject({ labels: drafts.length, kappa: 1 });
    expect(report.self_consistency.note).toMatch(/not accuracy/);
    expect(report).not.toHaveProperty('against_drafts');
  });

  it('computes kappa from the owner\'s calls alone: a judge that matches the drafts can still disagree with the owner', () => {
    const decisions = ownerRows(drafts, (label, index) => (index % 2 === 0 ? (label.label === 'pass' ? 'fail' : 'pass') : label.label));
    const report = agreementReport(drafts, decisions, verdictsLike(drafts, new Set()));
    expect(report.self_consistency.kappa).toBe(1);
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
    const decisions = ownerRows(owner, (label) => label.label);
    const report = agreementReport(drafts, decisions, verdictsLike(drafts, wrong));
    const [p, f] = [passes.length, fails.length];
    const observed = 18 / 20;
    // One wrong each way leaves the judge's pass and fail counts equal to the owner's.
    const chance = ((p / 20) ** 2) + ((f / 20) ** 2);
    expect(report.against_owner.kappa).toBeCloseTo((observed - chance) / (1 - chance), 6);
    expect(report.against_owner.false_pass_rate).toBeCloseTo(1 / f);
    expect(report.against_owner.enough).toBe(false);
  });

  it('trusts a set at the size the owner is asked to label', () => {
    expect(OWNER_LABELS_NEEDED).toBeLessThanOrEqual(drafts.length);
    const decisions = ownerRows(drafts, (label) => label.label);
    expect(agreementReport(drafts, decisions, verdictsLike(drafts, new Set())).against_owner).toMatchObject({ enough: true, kappa: 1 });
  });
});
