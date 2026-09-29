// Independent evaluator-side receipt validation. No synthetic reviewer assertion alone
// can certify a trial: the runner and each adapter must sign a common trial identity.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { CapturedArtifact, ObservedTrial } from './grading-contract';
import type { IsolatedCapture } from './isolated-capture';

export type SealedReceipt = Readonly<{
  case_id: string; seed: string; owner_id: string; field: keyof Omit<ObservedTrial, 'case_id' | 'seed'>;
  digest: string; role: string; signature: string;
}>;
export type ReceiptKeys = Readonly<Record<'runner' | 'source_adapter' | 'effect_interceptor' | 'provider_readback', string>>;
const fields = ['fixture_manifest', 'transcript', 'tool_trace', 'authority_timeline', 'source_revisions', 'intercepted_effects', 'final_state_readback'] as const;
const expectedRoles = ['runner', 'runner', 'runner', 'runner', 'source_adapter', 'effect_interceptor', 'provider_readback'] as const;
const payload = (receipt: Omit<SealedReceipt, 'signature'>): string => JSON.stringify(receipt);
const validSignature = (receipt: SealedReceipt, key: string): boolean => {
  const expected = createHmac('sha256', key).update(payload({ case_id: receipt.case_id, seed: receipt.seed, owner_id: receipt.owner_id,
    field: receipt.field, digest: receipt.digest, role: receipt.role })).digest();
  if (!/^[0-9a-f]{64}$/.test(receipt.signature)) return false;
  return timingSafeEqual(expected, Buffer.from(receipt.signature, 'hex'));
};
export const sealCaptureReceipt = (trial: ObservedTrial, owner_id: string, field: SealedReceipt['field'], role: string, key: string): SealedReceipt => {
  if (!key || !owner_id || !fields.includes(field)) throw new Error('invalid receipt input');
  const base = { case_id: trial.case_id, seed: trial.seed, owner_id, field, digest: trial[field].digest, role };
  return { ...base, signature: createHmac('sha256', key).update(payload(base)).digest('hex') };
};
export const verifyCaptureReceipts = (trial: ObservedTrial, capture: Pick<IsolatedCapture, 'owners' | 'candidate_owner'>,
  receipts: readonly SealedReceipt[], keys: ReceiptKeys): readonly string[] => {
  const errors: string[] = [];
  if (Object.values(keys).some((key) => !key) || new Set(Object.values(keys)).size !== 4) errors.push('adapter keys must be nonempty and distinct');
  if (capture.owners.length !== 2 || capture.owners[0] === capture.owners[1] || !capture.owners.includes(capture.candidate_owner)) errors.push('invalid two-owner isolation');
  if (receipts.length !== fields.length || new Set(receipts.map((item) => item.field)).size !== fields.length) errors.push('missing or duplicate capture receipt');
  for (const [index, field] of fields.entries()) {
    const receipt = receipts.find((item) => item.field === field);
    const role = expectedRoles[index]!;
    const artifact: CapturedArtifact = trial[field];
    if (!receipt || receipt.case_id !== trial.case_id || receipt.seed !== trial.seed || receipt.owner_id !== capture.candidate_owner ||
      receipt.role !== role || artifact.source !== `${role}:${capture.candidate_owner}` || !keys[role] || receipt.digest !== artifact.digest ||
      artifact.digest !== `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}` ||
      !validSignature(receipt, keys[role])) errors.push(`invalid ${field} receipt`);
  }
  return errors;
};
