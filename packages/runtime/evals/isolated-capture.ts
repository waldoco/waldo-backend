// Evaluator-only capture assembler. The caller supplies raw, independently collected
// receipts from a sealed two-owner world. This never treats a scripted test as a W/R run.
import { createHash } from 'node:crypto';
import type { CapturedArtifact, ObservedTrial } from './grading-contract';

export type CaptureSource = Readonly<{ owner_id: string; role: 'runner' | 'source_adapter' | 'effect_interceptor' | 'provider_readback'; bytes: string }>;
export type IsolatedCapture = Readonly<{
  case_id: string;
  seed: string;
  owners: readonly [string, string];
  candidate_owner: string;
  fixture_manifest: CaptureSource;
  transcript: CaptureSource;
  tool_trace: CaptureSource;
  authority_timeline: CaptureSource;
  source_revisions: CaptureSource;
  intercepted_effects: CaptureSource;
  final_state_readback: CaptureSource;
}>;
const sourceRoles: Readonly<Record<keyof Omit<ObservedTrial, 'case_id' | 'seed'>, CaptureSource['role']>> = {
  fixture_manifest: 'runner', transcript: 'runner', tool_trace: 'runner', authority_timeline: 'runner',
  source_revisions: 'source_adapter', intercepted_effects: 'effect_interceptor', final_state_readback: 'provider_readback',
};
const fields = Object.keys(sourceRoles) as (keyof typeof sourceRoles)[];
const digest = (bytes: string): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export const assembleIsolatedCapture = (capture: IsolatedCapture): ObservedTrial => {
  if (!capture.case_id || !capture.seed || capture.owners.length !== 2 ||
    !capture.owners.every(Boolean) || capture.owners[0] === capture.owners[1] ||
    !capture.owners.includes(capture.candidate_owner)) throw new Error('invalid isolated trial identity');
  const artifacts = {} as Record<keyof typeof sourceRoles, CapturedArtifact>;
  for (const field of fields) {
    const item = capture[field];
    if (item.owner_id !== capture.candidate_owner || item.role !== sourceRoles[field] || !item.bytes.trim())
      throw new Error(`unbound or empty ${field} capture`);
    // This checks only labels and bytes. Callers must independently establish that
    // adapter receipts reflect the actual intercepted calls and provider state.
    artifacts[field] = { source: `${item.role}:${item.owner_id}`, bytes: item.bytes, digest: digest(item.bytes) };
  }
  return { case_id: capture.case_id, seed: capture.seed, ...artifacts };
};
