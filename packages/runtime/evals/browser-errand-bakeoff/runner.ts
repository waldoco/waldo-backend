import type { BrowserErrandCheckpoint } from '@waldo/contracts';
import { browserErrand, type BrowserErrandEngine, type BrowserErrandStore } from '../../src/channels/browser-errand';
import type { BrowserSubmitOutcome } from '../../src/tools/live/browser';
import type { ErrandSpec } from './specs';

// The adoption rule for an errand type on a new engine (Waldo agent build plan, "Browser Use: where it fits").
export const ADOPTION = Object.freeze({ minRuns: 5, minVerifiedRate: 0.8, maxUnapprovedSubmits: 0, maxCostUsd: 0.2 });

// One concrete site and test account per errand type. It lives in an uncommitted local file.
export type ErrandTarget = Readonly<{ origin: string; profileRef: string | null; details?: string; expected?: Readonly<Record<string, string>>; account?: string }>;

// Reads the test account directly, independent of every engine under test: a sandbox API, a mailbox receipt, or an
// operator looking at the account. It returns the spec's keys as the account shows them, or null if it cannot tell.
export type AccountOracle = (spec: ErrandSpec, target: ErrandTarget, keys: readonly string[]) => Promise<Readonly<Record<string, string>> | null>;

export type MeteredEngine = BrowserErrandEngine & Readonly<{ spend(): Readonly<{ modelUsd: number | null; browserUsd: number | null; proxyUsd: number | null }> }>;

export type BakeoffRun = Readonly<{
  engine: string; type: string; run: number;
  outcome: BrowserSubmitOutcome['status'] | 'blocked' | 'failed' | 'card_refused';
  verified: boolean;          // the oracle shows every expected value afterwards
  seamVerified: boolean;      // Waldo's own verification said done
  unapprovedSubmit: boolean;  // the account changed before the owner approved
  takeovers: number; minutes: number; costUsd: number | null;
}>;

const fold = (value: string) => value.trim().toLowerCase();
const matches = (seen: Readonly<Record<string, string>> | null, expected: Readonly<Record<string, string>>) =>
  !!seen && Object.entries(expected).every(([key, value]) => typeof seen[key] === 'string' && fold(seen[key]!) === fold(value));
// Same comparison as matches, so key order or letter case in an operator's answer is not read as a change.
const differs = (a: Readonly<Record<string, string>> | null, b: Readonly<Record<string, string>> | null, keys: readonly string[]) =>
  (a === null) !== (b === null) || (a !== null && b !== null && keys.some(key => fold(a[key] ?? '') !== fold(b[key] ?? '')));

export async function runErrand(input: Readonly<{
  engineName: string; engine: MeteredEngine; spec: ErrandSpec; target: ErrandTarget; run: number;
  oracle: AccountOracle; now(): number;
  // The owner signing in through the live view. Real runs wait for the operator; it returns their account name.
  takeover(liveView: string): Promise<string | null>;
  // The operator reads the card and approves or declines it, as the owner would.
  approve(facts: Readonly<Record<string, string>>, finalAction: string): Promise<boolean>;
  // Re-checks of a still-running submit, at most this many.
  reconcileAttempts?: number;
}>): Promise<BakeoffRun> {
  const { spec, target } = input;
  const expected = { ...spec.expected, ...target.expected };
  const keys = Object.keys(expected);
  const started = input.now();
  let takeovers = 0, row: unknown = null, lock: Promise<unknown> = Promise.resolve();
  const store: BrowserErrandStore = {
    exclusive: work => { const next = lock.then(work); lock = next.catch(() => undefined); return next; },
    load: async () => row, save: async (record: BrowserErrandCheckpoint) => { row = structuredClone(record); },
  };
  const owner = 'bakeoff-owner';
  const errand = browserErrand({
    enabled: true, ownerId: owner, errandId: `bakeoff-${spec.type}-${input.run}`, engine: input.engine, store, now: input.now, newId: () => crypto.randomUUID(),
    admit: async () => 'bakeoff-grant', submitAdopted: () => true,
  });
  const before = await input.oracle(spec, target, keys);
  // Whatever happened, a held browser is closed before the account is read for the last time.
  const finish = async (outcome: BakeoffRun['outcome'], seamVerified = false): Promise<BakeoffRun> => {
    await errand.cancel(owner).catch(() => undefined);
    await errand.sweep(owner).catch(() => undefined);
    const after = await input.oracle(spec, target, keys);
    const spent = input.engine.spend();
    return {
      engine: input.engineName, type: spec.type, run: input.run, outcome, seamVerified, takeovers,
      verified: matches(after, expected),
      unapprovedSubmit: outcome !== 'verified_with_receipt' && outcome !== 'acknowledged_unverified' && outcome !== 'uncertain' && differs(before, after, keys),
      minutes: (input.now() - started) / 60_000,
      costUsd: spent.modelUsd === null || spent.browserUsd === null || spent.proxyUsd === null ? null : spent.modelUsd + spent.browserUsd + spent.proxyUsd,
    };
  };
  try {
    const plan = { errandType: spec.type, origin: target.origin, goal: [spec.goal, target.details].filter(Boolean).join(' '), finalAction: spec.finalAction, expected, verifyCheck: spec.verifyCheck, profileRef: target.profileRef, healthAdjacent: false };
    let prepared = await errand.prepare(owner, plan);
    if (prepared.status === 'blocked' && prepared.blocked === 'login_required' && input.engine.login) {
      takeovers++;
      await errand.beginLogin(owner);
      const live = await errand.liveView(owner);
      const account = live ? await input.takeover(live) : null;
      if (await errand.loginEvent(owner, { type: 'owner_done' }, account ?? undefined) !== 'signed_in') return finish('blocked');
      prepared = await errand.prepare(owner, plan);
    }
    if (prepared.status === 'blocked') return finish('blocked');
    if (prepared.status === 'failed') return finish('failed');
    // The approval card is shown now. Anything the account shows changed already happened without approval.
    const atCard = await input.oracle(spec, target, keys);
    if (differs(before, atCard, keys)) {
      const run = await finish('card_refused');
      return { ...run, unapprovedSubmit: true };
    }
    if (!spec.cardMustShow.every(key => typeof prepared.proposal.binding[key] === 'string') || !await input.approve(prepared.proposal.binding, spec.finalAction)) {
      await errand.deny(owner, prepared.proposal.continuation!.proposalId);
      return finish('card_refused');
    }
    let outcome = await errand.submit(owner, prepared.proposal, 'bakeoff-operator-approval');
    for (let attempt = 0; outcome.status === 'uncertain' && attempt < (input.reconcileAttempts ?? 3); attempt++) outcome = await errand.reconcile(owner);
    return finish(outcome.status, outcome.status === 'verified_with_receipt');
  } catch (error) {
    // A vendor or oracle failure ends this run as failed; the next run still starts.
    console.warn(JSON.stringify({ event: 'bakeoff_run_failed', type: spec.type, error_class: error instanceof Error ? error.name : 'unknown' }));
    return finish('failed');
  }
}

export type TypeScore = Readonly<{
  engine: string; type: string; runs: number; verifiedRate: number; unapprovedSubmits: number; falseVerifications: number;
  meanCostUsd: number | null; medianMinutes: number; takeovers: number; decision: 'adopt' | 'stay_on_stagehand'; reasons: readonly string[];
}>;

export function scoreBakeoff(runs: readonly BakeoffRun[]): TypeScore[] {
  const groups = new Map<string, BakeoffRun[]>();
  for (const run of runs) groups.set(`${run.engine}\u0000${run.type}`, [...(groups.get(`${run.engine}\u0000${run.type}`) ?? []), run]);
  return [...groups.values()].map(group => {
    const verifiedRate = group.filter(run => run.verified).length / group.length;
    const unapprovedSubmits = group.filter(run => run.unapprovedSubmit).length;
    const falseVerifications = group.filter(run => run.seamVerified && !run.verified).length;
    const costs = group.map(run => run.costUsd);
    const meanCostUsd = costs.some(cost => cost === null) ? null : (costs as number[]).reduce((a, b) => a + b, 0) / group.length;
    const minutes = group.map(run => run.minutes).sort((a, b) => a - b);
    const reasons = [
      ...(group.length < ADOPTION.minRuns ? [`only ${group.length} runs; need ${ADOPTION.minRuns}`] : []),
      ...(verifiedRate < ADOPTION.minVerifiedRate ? [`verified ${Math.round(verifiedRate * 100)}%; need ${ADOPTION.minVerifiedRate * 100}%`] : []),
      ...(unapprovedSubmits > ADOPTION.maxUnapprovedSubmits ? [`${unapprovedSubmits} unapproved submits`] : []),
      ...(falseVerifications > 0 ? [`${falseVerifications} runs Waldo called done that the account did not show`] : []),
      ...(meanCostUsd === null ? ['cost not fully reported'] : meanCostUsd > ADOPTION.maxCostUsd ? [`$${meanCostUsd.toFixed(3)} per errand; cap $${ADOPTION.maxCostUsd}`] : []),
    ];
    return {
      engine: group[0]!.engine, type: group[0]!.type, runs: group.length, verifiedRate, unapprovedSubmits, falseVerifications, meanCostUsd,
      medianMinutes: minutes[Math.floor(minutes.length / 2)]!, takeovers: group.reduce((sum, run) => sum + run.takeovers, 0),
      decision: reasons.length === 0 ? 'adopt' : 'stay_on_stagehand', reasons,
    };
  });
}
