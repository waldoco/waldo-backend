// Evaluator-side synthetic authority clock. This record never enters a model prompt.
// It checks timed grants and owner branches; it does not authorize a real-world effect.
import type { NativeManifest } from './native-manifest';

type Grant = NativeManifest['grants'][number];
type Branch = NativeManifest['branches'][number];
export type AuthorityAt = Readonly<{
  at: string;
  owner_id: string;
  active_grants: readonly Grant[];
  active_branches: readonly Branch[];
  permitted_effects: readonly string[];
}>;
const instant = (value: string): number => {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('invalid synthetic authority time');
  return ms;
};
export class FixtureAuthorityClock {
  private nowMs: number;
  constructor(private readonly manifest: Pick<NativeManifest, 'candidate_owner' | 'control_owner' | 'world' | 'grants' | 'branches'>) {
    this.nowMs = instant(manifest.world.clock);
    if (!manifest.candidate_owner || !manifest.control_owner || manifest.candidate_owner === manifest.control_owner ||
      new Set(manifest.world.owners.map((owner) => owner.id)).size !== 2 ||
      !manifest.world.owners.some((owner) => owner.id === manifest.candidate_owner) ||
      !manifest.world.owners.some((owner) => owner.id === manifest.control_owner)) throw new Error('invalid synthetic owners');
    for (const grant of manifest.grants) {
      this.owner(grant.owner_id);
      if (!grant.purpose || !grant.scope || !Array.isArray(grant.allowed_effects) ||
        grant.allowed_effects.some((effect) => !effect) || new Set(grant.allowed_effects).size !== grant.allowed_effects.length ||
        instant(grant.effective_at) >= instant(grant.expires_at)) throw new Error('invalid synthetic grant');
    }
    const branchIds = new Set<string>();
    for (const branch of manifest.branches) {
      this.owner(branch.owner_id);
      instant(branch.trigger_at);
      if (!branch.id || branchIds.has(`${branch.owner_id}:${branch.id}`) ||
        branch.permitted_effects.some((effect) => !effect) ||
        new Set(branch.permitted_effects).size !== branch.permitted_effects.length) throw new Error('invalid synthetic branch');
      branchIds.add(`${branch.owner_id}:${branch.id}`);
    }
  }
  private owner(id: string): void {
    if (id !== this.manifest.candidate_owner && id !== this.manifest.control_owner) throw new Error('unknown synthetic owner');
  }
  now(): string { return new Date(this.nowMs).toISOString(); }
  advance(to: string): void {
    const next = instant(to);
    if (next < this.nowMs) throw new Error('synthetic authority clock cannot go backward');
    this.nowMs = next;
  }
  snapshot(owner_id: string): AuthorityAt {
    this.owner(owner_id);
    const active_grants = this.manifest.grants.filter((grant) => grant.owner_id === owner_id &&
      instant(grant.effective_at) <= this.nowMs && this.nowMs < instant(grant.expires_at));
    const active_branches = this.manifest.branches.filter((branch) => branch.owner_id === owner_id && instant(branch.trigger_at) <= this.nowMs);
    // A branch can only narrow a typed current grant. Neither prose scope nor the
    // branch's own effect list authorizes a different effect.
    const granted = new Set(active_grants.flatMap((grant) => grant.allowed_effects));
    const permitted_effects = [...new Set(active_branches.flatMap((branch) => branch.permitted_effects))]
      .filter((effect) => granted.has(effect));
    return structuredClone({ at: this.now(), owner_id, active_grants, active_branches, permitted_effects });
  }
}
