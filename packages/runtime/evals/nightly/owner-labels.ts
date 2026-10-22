// The owner's own calls on the labelled replies, and the agreement between the voice judge and them. The shipped set
// (voice-labels-v0.jsonl) is a set of drafts: agreement with it says how the judge compares with the draft labels, not
// with the owner's. An owner label is a person's call on the same reply, kept in its own file, so the draft file never
// changes. The owner labels blind: the sheet shows each reply under an opaque id and the draft's own id (which names its
// verdict and defect) is mapped back only here, by the scorer. No such file ships: every row in it must be a person's.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { VOICE_TESTS, voicePacket } from './voice';
import { labelInput, testKey, voiceAgreement, type LabelledVerdict, type VoiceLabel } from './voice-labels';

export const OWNER_LABELS_PATH = new URL('../fixtures/voice-owner-labels.jsonl', import.meta.url);
// A kappa from a handful of labels reads as precision it does not have. Below this the report still shows the numbers,
// flagged, so a thin set degrades to a hint rather than being refused.
export const OWNER_LABELS_NEEDED = 30;

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

// The id each reply wears on the labelling sheet: L01 onward in an order set by a hash of the draft's id, so neither the
// file order nor the id says anything about the verdict. The suffix fingerprints the whole set: ids from a sheet printed
// for a different set stop matching, so a label can never attach to another reply.
export const opaqueIds = (drafts: readonly VoiceLabel[]): ReadonlyMap<string, string> => {
  const fingerprint = digest([...drafts.map((draft) => draft.id)].sort().join('\n')).slice(0, 4);
  const ordered = [...drafts].sort((a, b) => (digest(`order:${a.id}`) < digest(`order:${b.id}`) ? -1 : 1));
  return new Map(ordered.map((draft, index) => [draft.id, `L${String(index + 1).padStart(2, '0')}-${fingerprint}`]));
};

const decisionSchema = z.object({
  id: z.string().min(1),
  label: z.enum(['pass', 'fail']),
  failed_tests: z.array(testKey).min(1).optional(),
  reviewed_by: z.string().min(1),
}).strict().refine((row) => (row.label === 'fail') === (row.failed_tests !== undefined), { error: 'a fail names its failed tests; a pass names none' });
export type OwnerLabel = z.infer<typeof decisionSchema>;

// Rows are written with the opaque id from the sheet; the decisions come back keyed by the draft's own id.
export const parseOwnerLabels = (text: string, drafts: readonly VoiceLabel[]): readonly OwnerLabel[] => {
  const draftOf = new Map([...opaqueIds(drafts)].map(([draftId, opaqueId]) => [opaqueId, draftId]));
  const rows = text.split('\n').filter((line) => line.trim()).map((line, index) => {
    let json: unknown;
    try { json = JSON.parse(line); } catch { throw new Error(`owner label line ${index + 1}: not JSON`); }
    const parsed = decisionSchema.safeParse(json);
    if (!parsed.success) throw new Error(`owner label line ${index + 1}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    const draftId = draftOf.get(parsed.data.id);
    if (draftId === undefined) throw new Error(`owner label line ${index + 1}: ${parsed.data.id} is not in the labelled set`);
    return { ...parsed.data, id: draftId };
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

// What to hand the owner: each reply exactly as the judge sees it, under an opaque id, with the six tests and the row to
// write. Nothing of the draft's id, call, reasons or author, so the owner's call is their own.
export const labellingSheet = (drafts: readonly VoiceLabel[]): string => {
  const ids = opaqueIds(drafts);
  const shown = [...drafts].sort((a, b) => (ids.get(a.id)! < ids.get(b.id)! ? -1 : 1));
  return [
    '# Voice labelling sheet',
    '',
    'For each reply below, call it pass or fail against the six tests. A reply passes only when it passes all six. Label blind: the draft calls are not shown.',
    '',
    'The six tests:',
    ...VOICE_TESTS.map((entry) => `- \`${entry.key}\`: ${entry.test}`),
    '',
    'Save one row per reply in `packages/runtime/evals/fixtures/voice-owner-labels.jsonl`, with your own name in `reviewed_by` and the id exactly as the sheet prints it:',
    '',
    '    {"id":"<id>","label":"pass","reviewed_by":"<your name>"}',
    '    {"id":"<id>","label":"fail","failed_tests":["<every test it fails>"],"reviewed_by":"<your name>"}',
    '',
    'A fail lists every test the reply fails; a test left out counts as a pass. Skip a reply you cannot call: it stays uncounted.',
    '',
    ...shown.flatMap((draft) => [`## ${ids.get(draft.id)!}`, '', voicePacket(labelInput(draft)), '']),
  ].join('\n');
};

// The judge's verdicts scored twice, and never blended: against the owner's calls (the figure that matters) and against
// the draft labels. The drafts were written by an AI and the judge is an AI, so agreement with them is self-consistency,
// not accuracy, and is reported under that name. `enough` says whether the owner set is big enough to trust the kappa;
// blind counts the calls made on the sheet, apart from drafts signed in place.
export const agreementReport = (drafts: readonly VoiceLabel[], decisions: readonly OwnerLabel[], verdicts: readonly LabelledVerdict[]) => {
  const owner = ownerLabelled(drafts, decisions);
  return {
    against_owner: { owner_labels: owner.length, blind: decisions.length, enough: owner.length >= OWNER_LABELS_NEEDED, ...voiceAgreement(owner, verdicts) },
    self_consistency: { note: 'The draft labels and the judge are both AI: this is self-consistency, not accuracy.', ...voiceAgreement(drafts, verdicts) },
  };
};
