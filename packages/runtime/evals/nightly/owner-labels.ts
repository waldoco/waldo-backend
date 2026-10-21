// The owner's own calls on the labelled replies, and the agreement between the voice judge and them. The shipped set
// (voice-labels-v0.jsonl) is Claude's draft: agreement with it says how the judge compares with Claude's reading, not
// with the owner's. An owner label is a person's call on the same reply, kept in its own file keyed by the draft's id,
// so the draft file never changes and the owner can label blind, without the draft's call in front of them. No such
// file ships: every row in it must be a person's.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { VOICE_TESTS, voicePacket } from './voice';
import { labelInput, testKey, voiceAgreement, type LabelledVerdict, type VoiceLabel } from './voice-labels';

export const OWNER_LABELS_PATH = new URL('../fixtures/voice-owner-labels.jsonl', import.meta.url);
// A kappa from a handful of labels reads as precision it does not have. Below this the report still shows the numbers,
// flagged, so a thin set degrades to a hint rather than being refused.
export const OWNER_LABELS_NEEDED = 30;

const decisionSchema = z.object({
  id: z.string().min(1),
  label: z.enum(['pass', 'fail']),
  failed_tests: z.array(testKey).min(1).optional(),
  reviewed_by: z.string().min(1),
}).strict().refine((row) => (row.label === 'fail') === (row.failed_tests !== undefined), { error: 'a fail names its failed tests; a pass names none' });
export type OwnerLabel = z.infer<typeof decisionSchema>;

export const parseOwnerLabels = (text: string, drafts: readonly VoiceLabel[]): readonly OwnerLabel[] => {
  const known = new Set(drafts.map((draft) => draft.id));
  const rows = text.split('\n').filter((line) => line.trim()).map((line, index) => {
    let json: unknown;
    try { json = JSON.parse(line); } catch { throw new Error(`owner label line ${index + 1}: not JSON`); }
    const parsed = decisionSchema.safeParse(json);
    if (!parsed.success) throw new Error(`owner label line ${index + 1}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    if (!known.has(parsed.data.id)) throw new Error(`owner label line ${index + 1}: ${parsed.data.id} is not in the labelled set`);
    return parsed.data;
  });
  const repeated = rows.find((row, index) => rows.findIndex((other) => other.id === row.id) !== index);
  if (repeated) throw new Error(`owner label ${repeated.id} appears more than once; each reply is called once`);
  return rows;
};

// A missing file means the owner has not labelled anything yet, which is a state the report names, not an error.
export const loadOwnerLabels = (path: URL | string, drafts: readonly VoiceLabel[]): readonly OwnerLabel[] => {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return parseOwnerLabels(text, drafts);
};

// The replies a person has called: those in the owner file (their call replaces the draft's) and any draft the owner
// signed in place by naming themselves in reviewed_by. A reply nobody has called is left out, never counted as agreed.
export const ownerLabelled = (drafts: readonly VoiceLabel[], decisions: readonly OwnerLabel[]): readonly VoiceLabel[] => {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  return drafts.flatMap((draft): VoiceLabel[] => {
    const decision = byId.get(draft.id);
    if (!decision) return draft.reviewed_by === null ? [] : [draft];
    const { failed_tests: _draftTests, ...reply } = draft;
    return [{ ...reply, label: decision.label, ...(decision.failed_tests ? { failed_tests: decision.failed_tests } : {}), reviewed_by: decision.reviewed_by, labelled_by: decision.reviewed_by }];
  });
};

// What to hand the owner: each reply exactly as the judge sees it, the six tests, and the row to write. Nothing of the
// draft's call, its reasons or its author, so the owner's call is their own.
export const labellingSheet = (drafts: readonly VoiceLabel[]): string => [
  '# Voice labelling sheet',
  '',
  'For each reply below, call it pass or fail against the six tests. A reply passes only when it passes all six. Label blind: the draft calls are not shown.',
  '',
  'The six tests:',
  ...VOICE_TESTS.map((entry) => `- \`${entry.key}\`: ${entry.test}`),
  '',
  'Save one row per reply in `packages/runtime/evals/fixtures/voice-owner-labels.jsonl`, with your own name in `reviewed_by`:',
  '',
  '    {"id":"<id>","label":"pass","reviewed_by":"<your name>"}',
  '    {"id":"<id>","label":"fail","failed_tests":["<every test it fails>"],"reviewed_by":"<your name>"}',
  '',
  'A fail lists every test the reply fails; a test left out counts as a pass. Skip a reply you cannot call: it stays uncounted.',
  '',
  ...drafts.flatMap((draft) => [`## ${draft.id}`, '', voicePacket(labelInput(draft)), '']),
].join('\n');

// The judge's verdicts scored twice, and never blended: against the owner's calls (the figure that matters) and against
// Claude's drafts (a check that the judge reads the six tests as Claude does). `enough` says whether the owner set is
// big enough to trust the kappa; blind counts the calls made on the sheet, apart from drafts signed in place.
export const agreementReport = (drafts: readonly VoiceLabel[], decisions: readonly OwnerLabel[], verdicts: readonly LabelledVerdict[]) => {
  const owner = ownerLabelled(drafts, decisions);
  return {
    against_owner: { owner_labels: owner.length, blind: decisions.length, enough: owner.length >= OWNER_LABELS_NEEDED, ...voiceAgreement(owner, verdicts) },
    against_claude_drafts: voiceAgreement(drafts, verdicts),
  };
};
