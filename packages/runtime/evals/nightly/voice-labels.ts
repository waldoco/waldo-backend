// The labelled replies the voice judge is measured on, and the agreement between the judge and the labels. A label
// is a person's call on one reply against the six tests; until reviewed_by names someone, it is a draft. A fail's
// failed_tests lists every test the reply fails, and every test it leaves out is a pass: per-test agreement rests on it.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { VOICE_ANCHORS, VOICE_TESTS, type VoiceJudgeInput, type VoiceTestKey, type VoiceVerdict } from './voice';

export const VOICE_LABELS_PATH = new URL('../fixtures/voice-labels-v0.jsonl', import.meta.url);

const testKey = z.enum(VOICE_TESTS.map((entry) => entry.key) as [VoiceTestKey, ...VoiceTestKey[]]);
const labelSchema = z.object({
  id: z.string().min(1),
  voice: z.object({ moment: z.string().min(1), note: z.string().min(1).optional() }).strict(),
  transcript: z.array(z.object({ role: z.enum(['owner', 'waldo', 'world']), text: z.string().min(1), surface: z.enum(['chat', 'notification']).optional() }).strict()).min(1),
  tools: z.array(z.object({ name: z.string().min(1), ok: z.boolean() }).strict()),
  effects: z.array(z.object({ kind: z.string().min(1), payload: z.unknown() }).strict()),
  label: z.enum(['pass', 'fail']),
  failed_tests: z.array(testKey).min(1).optional(),
  why: z.string().min(1),
  labelled_by: z.string().min(1),
  reviewed_by: z.string().min(1).nullable(),
}).strict().refine((row) => (row.label === 'fail') === (row.failed_tests !== undefined), { error: 'a fail names its failed tests; a pass names none' })
  .refine((row) => row.transcript.some((turn) => turn.role === 'waldo'), { error: 'a label grades at least one Waldo message' });
export type VoiceLabel = z.infer<typeof labelSchema>;

export const parseVoiceLabels = (text: string): readonly VoiceLabel[] => {
  const rows = text.split('\n').filter((line) => line.trim()).map((line, index) => {
    const parsed = labelSchema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`voice label line ${index + 1}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    return parsed.data;
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('voice label ids must be unique');
  // A label that repeats a calibration anchor measures recall of the prompt, not judgment.
  const anchors = new Set(VOICE_ANCHORS.flatMap((pair) => [pair.waldo, pair.not_waldo]));
  for (const row of rows) for (const turn of row.transcript) if (anchors.has(turn.text)) throw new Error(`voice label ${row.id} repeats a calibration anchor`);
  return rows;
};
export const loadVoiceLabels = (path: URL | string = VOICE_LABELS_PATH) => parseVoiceLabels(readFileSync(path, 'utf8'));

export const labelInput = (row: VoiceLabel): VoiceJudgeInput => ({ voice: row.voice, transcript: row.transcript, tools: row.tools, effects: row.effects });

export type LabelledVerdict = Readonly<{ id: string; outcome: VoiceVerdict['outcome']; failed_tests?: readonly VoiceTestKey[]; unknown_tests?: readonly VoiceTestKey[] }>;
export const labelledVerdict = (id: string, verdict: VoiceVerdict): LabelledVerdict => ({
  id, outcome: verdict.outcome,
  ...(verdict.tests ? {
    failed_tests: VOICE_TESTS.map((entry) => entry.key).filter((key) => verdict.tests![key].met === false),
    unknown_tests: VOICE_TESTS.map((entry) => entry.key).filter((key) => verdict.tests![key].met === null),
  } : {}),
});

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);

// Cohen's kappa over pass/fail pairs: agreement beyond what the two marginals give by chance. Exact-match agreement
// overstates a judge that mostly says pass on a set that is mostly pass; kappa does not.
const kappaOf = (pairs: readonly Readonly<{ label: 'pass' | 'fail'; judged: 'pass' | 'fail' }>[]) => {
  const n = pairs.length;
  if (n === 0) return { n, kappa: null, exact: null };
  const count = (label: 'pass' | 'fail', judged: 'pass' | 'fail') => pairs.filter((pair) => pair.label === label && pair.judged === judged).length;
  const [pp, pf, fp, ff] = [count('pass', 'pass'), count('pass', 'fail'), count('fail', 'pass'), count('fail', 'fail')];
  const observed = (pp + ff) / n;
  const chance = (((pp + pf) / n) * ((pp + fp) / n)) + (((fp + ff) / n) * ((pf + ff) / n));
  return { n, kappa: chance === 1 ? null : (observed - chance) / (1 - chance), exact: observed };
};

// Agreement on the pass/fail call, over the labels the judge decided. kappa is the headline; coverage (the share of
// labels the judge decided) sits beside it, because a judge that answers unknown to every hard case scores well on the
// rest. false_pass (the judge passes a labelled fail) is the error that lets a bad reply through, so it is reported apart
// from false_fail. per_test is kappa for each of the six tests, over the labels where the judge decided that test.
export const voiceAgreement = (labels: readonly VoiceLabel[], verdicts: readonly LabelledVerdict[]) => {
  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  const decided = labels.flatMap((label) => {
    const verdict = byId.get(label.id);
    return verdict && (verdict.outcome === 'pass' || verdict.outcome === 'fail') ? [{ label, verdict, judged: verdict.outcome as 'pass' | 'fail' }] : [];
  });
  const overall = kappaOf(decided.map((pair) => ({ label: pair.label.label, judged: pair.judged })));
  const cell = (label: 'pass' | 'fail', judged: 'pass' | 'fail') => decided.filter((pair) => pair.label.label === label && pair.judged === judged).length;
  const [pp, pf, fp, ff] = [cell('pass', 'pass'), cell('pass', 'fail'), cell('fail', 'pass'), cell('fail', 'fail')];
  const caught = decided.filter((pair) => pair.label.label === 'fail' && pair.judged === 'fail');
  const perTest = Object.fromEntries(VOICE_TESTS.map(({ key }) => [key, kappaOf(labels.flatMap((label) => {
    const verdict = byId.get(label.id);
    if (!verdict?.failed_tests || verdict.unknown_tests?.includes(key)) return [];
    return [{ label: (label.failed_tests ?? []).includes(key) ? 'fail' as const : 'pass' as const, judged: verdict.failed_tests.includes(key) ? 'fail' as const : 'pass' as const }];
  }))])) as Record<VoiceTestKey, ReturnType<typeof kappaOf>>;
  return {
    labels: labels.length,
    reviewed: labels.filter((label) => label.reviewed_by !== null).length,
    kappa: overall.kappa,
    coverage: ratio(decided.length, labels.length),
    decided: decided.length,
    undecided: labels.length - decided.length,
    exact_match: overall.exact,
    confusion: { label_pass_judge_pass: pp, label_pass_judge_fail: pf, label_fail_judge_pass: fp, label_fail_judge_fail: ff },
    false_pass_rate: ratio(fp, fp + ff),
    false_fail_rate: ratio(pf, pp + pf),
    failed_test_hit: ratio(caught.filter((pair) => (pair.verdict.failed_tests ?? []).some((key) => pair.label.failed_tests!.includes(key))).length, caught.length),
    per_test: perTest,
    disagreements: decided.filter((pair) => pair.label.label !== pair.judged).map((pair) => pair.label.id),
  };
};
export type VoiceAgreement = ReturnType<typeof voiceAgreement>;
