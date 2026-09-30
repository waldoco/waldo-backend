// Evaluator-side snapshots of the fictional adapters, not external provider custody.
// Keys stay in the test supervisor; this function never accepts caller-authored evidence bytes.
import { createHash } from 'node:crypto';
import type { IsolatedSourceWorld } from '../scenarios/isolated-source-world';
import type { CapturedArtifact, ObservedTrial } from './grading-contract';
import { sealArtifactReceipt, type ReceiptKeys, type SealedReceipt } from './trial-provenance';

export type FixtureAdapterCapture = Readonly<{
  artifacts: Pick<ObservedTrial, 'source_revisions' | 'intercepted_effects' | 'final_state_readback'>;
  receipts: readonly SealedReceipt[];
}>;
export const captureFixtureAdapters = (world: IsolatedSourceWorld,
  identity: Readonly<{ case_id: string; seed: string; candidate_owner: string; control_owner: string }>,
  keys: Pick<ReceiptKeys, 'source_adapter' | 'effect_interceptor' | 'provider_readback'>): FixtureAdapterCapture => {
  if (!identity.case_id || !identity.seed || !identity.candidate_owner || !identity.control_owner ||
    identity.candidate_owner === identity.control_owner) throw new Error('invalid fixture capture identity');
  // Both owners must actually exist in the world, even if the control has no effects.
  world.accessLog(identity.control_owner);
  const adapterKeys = [keys.source_adapter, keys.effect_interceptor, keys.provider_readback];
  if (adapterKeys.some((key) => !key) || new Set(adapterKeys).size !== 3)
    throw new Error('fixture adapter keys must be nonempty and distinct');
  const owner = identity.candidate_owner;
  const artifact = (role: string, data: unknown): CapturedArtifact => {
    const bytes = JSON.stringify({ fixture_only: true, owner_id: owner, captured_at: world.now(), data });
    return { source: `${role}:${owner}`, bytes, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  };
  const artifacts = {
    source_revisions: artifact('source_adapter', { accesses: world.accessLog(owner), revisions: world.revisionLog(owner) }),
    intercepted_effects: artifact('effect_interceptor', world.outbox(owner)),
    final_state_readback: artifact('provider_readback', { calendar: world.providerCalendarReadback(owner) }),
  };
  const roles = { source_revisions: 'source_adapter', intercepted_effects: 'effect_interceptor', final_state_readback: 'provider_readback' } as const;
  const receipts = (Object.keys(roles) as (keyof typeof roles)[]).map((field) =>
    sealArtifactReceipt(identity, owner, field, artifacts[field], roles[field], keys[roles[field]]));
  return { artifacts, receipts };
};
