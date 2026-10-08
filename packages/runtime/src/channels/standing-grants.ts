import { standingGrantSchema, grantAreaSchema, grantModeSchema, type StandingGrant, type GrantArea, type GrantMode } from '@waldo/contracts';
export type StandingGrantStore = {
  list(owner: string): readonly StandingGrant[];
  get(owner: string, id: string): StandingGrant | null;
  put(grant: StandingGrant): void;
  getMode(owner: string, area: GrantArea): GrantMode | null;
  putMode(owner: string, area: GrantArea, mode: GrantMode): void;
};
export type GrantAction = {
  owner_ref: string; area: GrantArea; action: string;
  recipients?: readonly string[]; calendars?: readonly string[]; accounts?: readonly string[];
  content_kind?: 'reminder' | 'reply' | 'scheduling'; amount?: { currency: string; value: number };
  source_taint: 'external' | null;
};
export type GrantUsageLedger = Readonly<{
  count(input: Readonly<{ owner_ref: string; grant_ref: string; area: GrantArea; action: string; local_day: string; timezone: string }>): Promise<number>;
}>;
export type GrantEligibility =
  | Readonly<{ disposition: 'card' | 'prepare' }>
  | Readonly<{ disposition: 'eligible'; grant_ref: string; revision: number }>;
type Proposal = Readonly<{ id: string; grant: StandingGrant }>;

const exactScopeMatches = (allowed: string[] | undefined, actual: readonly string[] | undefined): boolean =>
  allowed === undefined || (actual !== undefined && actual.length > 0 && actual.every(value => allowed.includes(value)));

// Eligibility is not dispatch authority. A host must re-evaluate at dispatch and every retry,
// bind the confirmed shape, and reserve the effect through its durable ledger before any I/O.
export class StandingGrantModule {
  private readonly proposals = new Map<string, Proposal>();
  constructor(
    private readonly store: StandingGrantStore,
    private readonly now: () => number,
    private readonly newId: () => string,
    private readonly usage?: GrantUsageLedger,
  ) {}

  propose(authenticatedOwner: string, input: unknown): Proposal {
    const grant = standingGrantSchema.parse(input);
    if (grant.owner_ref !== authenticatedOwner) throw new Error('grant owner mismatch');
    if (grant.revoked_at !== undefined) throw new Error('cannot propose a revoked grant');
    const prior = this.store.get(authenticatedOwner, grant.id);
    if (grant.revision !== (prior?.revision ?? 0) + 1) throw new Error('grant revision mismatch');
    const proposal = { id: this.newId(), grant };
    if (this.proposals.has(proposal.id)) throw new Error('grant proposal identifier reused');
    this.proposals.set(proposal.id, structuredClone(proposal));
    return structuredClone(proposal);
  }

  // Host-only seam: call after owner-channel confirmation of the complete proposal shape.
  // No model handler is given access to this method.
  confirm(authenticatedOwner: string, proposalId: string, reviewedShape: unknown): StandingGrant {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.grant.owner_ref !== authenticatedOwner) throw new Error('grant proposal not found');
    const reviewed = standingGrantSchema.parse(reviewedShape);
    if (JSON.stringify(reviewed) !== JSON.stringify(proposal.grant)) throw new Error('grant shape mismatch');
    const prior = this.store.get(authenticatedOwner, reviewed.id);
    if (reviewed.revision !== (prior?.revision ?? 0) + 1) throw new Error('grant revision mismatch');
    this.store.put(structuredClone(reviewed));
    this.proposals.delete(proposalId);
    return structuredClone(reviewed);
  }

  list(authenticatedOwner: string): StandingGrant[] {
    return this.store.list(authenticatedOwner).map(input => {
      const grant = standingGrantSchema.parse(input);
      if (grant.owner_ref !== authenticatedOwner) throw new Error('grant store owner mismatch');
      return structuredClone(grant);
    });
  }

  revoke(authenticatedOwner: string, id: string): boolean {
    const current = this.store.get(authenticatedOwner, id);
    if (!current) return false;
    if (current.owner_ref !== authenticatedOwner) throw new Error('grant store owner mismatch');
    if (!current.revoked_at) this.store.put({ ...current, revoked_at: new Date(this.now()).toISOString(), revision: current.revision + 1 });
    for (const [key, proposal] of this.proposals) {
      if (proposal.grant.owner_ref === authenticatedOwner && proposal.grant.id === id) this.proposals.delete(key);
    }
    return true;
  }

  setMode(authenticatedOwner: string, area: GrantArea, mode: GrantMode): void {
    this.store.putMode(authenticatedOwner, grantAreaSchema.parse(area), grantModeSchema.parse(mode));
  }

  async evaluate(action: GrantAction, timezone: string): Promise<GrantEligibility> {
    if (action.source_taint !== null) return { disposition: 'card' };
    const areaMode = this.store.getMode(action.owner_ref, action.area) ?? 'ask';
    if (areaMode === 'tell') return { disposition: 'prepare' };
    if (areaMode === 'ask') return { disposition: 'card' };
    const matches = this.list(action.owner_ref).filter(grant => this.matches(grant, action));
    // Overlap resolution needs an owner-visible policy; do not choose by storage order.
    if (matches.length > 1) return { disposition: 'card' };
    for (const grant of matches) {
      if (grant.mode === 'tell') return { disposition: 'prepare' };
      if (grant.mode === 'ask') return { disposition: 'card' };
      if (grant.constraints.max_per_day !== undefined) {
        if (!this.usage) continue;
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(this.now());
        const part = (name: string) => parts.find(item => item.type === name)!.value;
        const count = await this.usage.count({ owner_ref: action.owner_ref, grant_ref: grant.id,
          area: action.area, action: action.action, local_day: `${part('year')}-${part('month')}-${part('day')}`, timezone });
        if (!Number.isSafeInteger(count) || count < 0 || count >= grant.constraints.max_per_day) continue;
      }
      const stored = this.store.get(action.owner_ref, grant.id);
      const current = stored === null ? null : standingGrantSchema.parse(stored);
      const currentMode = this.store.getMode(action.owner_ref, action.area) ?? 'ask';
      if (currentMode === 'tell') return { disposition: 'prepare' };
      if (currentMode === 'ask') return { disposition: 'card' };
      if (!current || current.revision !== grant.revision || !this.matches(current, action)) continue;
      if (this.list(action.owner_ref).filter(candidate => this.matches(candidate, action)).length !== 1) return { disposition: 'card' };
      return { disposition: 'eligible', grant_ref: grant.id, revision: grant.revision };
    }
    return { disposition: 'card' };
  }

  private matches(grant: StandingGrant, action: GrantAction): boolean {
    const c = grant.constraints;
    if (grant.owner_ref !== action.owner_ref || grant.area !== action.area || grant.action !== action.action || grant.revoked_at !== undefined) return false;
    if (grant.expires_at !== undefined && this.now() >= Date.parse(grant.expires_at)) return false;
    if (!exactScopeMatches(c.recipients, action.recipients) || !exactScopeMatches(c.calendars, action.calendars) || !exactScopeMatches(c.accounts, action.accounts)) return false;
    if (c.content_kinds !== undefined && (action.content_kind === undefined || !c.content_kinds.includes(action.content_kind))) return false;
    if (c.amount_max !== undefined && (!action.amount || action.amount.currency !== c.amount_max.currency || !Number.isFinite(action.amount.value) || action.amount.value < 0 || action.amount.value > c.amount_max.value)) return false;
    return true;
  }
}
