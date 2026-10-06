import {
  BrowserSessionBoundary, browserTaskCheckpointSchema, browserTaskProposalSchema, browserTaskReceiptSchema,
  type BrowserTaskCheckpoint, type BrowserTaskProposal, type BrowserTaskReceipt, type BrowserTaskContinuation, type BrowserCommand, type BrowserSession,
} from '@waldo/contracts';
import { parseSyntheticCommand, type SyntheticCommand } from './browser-synthetic-commands';
import type { BrowserSubmitOutcome } from '../tools/live/browser';
import { fixtureDigest, type FixtureObservation, type BrowserSourceGuard } from './public-fixture-browser';

export type BrowserTaskStore = Readonly<{
  // A canonical owner/task mutex, never an SQLite transaction around external I/O.
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  load(): Promise<unknown>;
  save(record: BrowserTaskCheckpoint): Promise<void>;
}>;
export type BrowserTaskDriver = Readonly<{
  provider: BrowserSession['provider']; origin: string; pageUrl: string; runId: string; submitRef: string;
  start(lifetimeMs: number, source?: BrowserSourceGuard): Promise<string>; navigate(id: string, source?: BrowserSourceGuard): Promise<unknown>;
  inspect(id: string, source?: BrowserSourceGuard): Promise<FixtureObservation>;
  fill(id: string, field: string, value: string, stateDigest: string, before: () => Promise<void>, source?: BrowserSourceGuard, assertCurrent?: () => void): Promise<unknown>;
  submit(id: string, stateDigest: string, before: () => Promise<void>, source?: BrowserSourceGuard, assertApproval?: () => void): Promise<unknown>;
  verify(bindingDigest: string, source?: BrowserSourceGuard): Promise<Readonly<{ id: string; observed_at: string; source: BrowserTaskReceipt['source']; binding_digest: string }> | null>;
  end(id: string): Promise<void>;
  command?(id: string, command: SyntheticCommand, stateDigest: string, before: BrowserSourceGuard, source?: BrowserSourceGuard, assertCurrent?: () => void): Promise<{ held: boolean; nativeSubmit?: boolean; reason?: 'page_write_blocked' }>;
}>;
type Driver = BrowserTaskDriver;
type Evidence = Readonly<{ actionDigest?: string; bindingDigest?: string; stateDigest?: string; proposalId?: string; approvalRef?: string }>;
export function browserTaskContinuity(options: Readonly<{
  enabled: boolean; ownerId: string; taskId: string; manifestDigest: string;
  store: BrowserTaskStore; driver: Driver; now(): number; newId(): string;
  // Trusted host returns a current grant reference. Model/page content cannot grant it.
  admit(operation: BrowserCommand['operation'], evidence?: Evidence): Promise<string | null>;
}>) {
  if (!/^sha256:[0-9a-f]{64}$/.test(options.manifestDigest) || options.taskId !== options.driver.runId || !options.ownerId) throw Error('browser task manifest rejected');
  const identity = (authenticatedOwner: string) => { if (authenticatedOwner !== options.ownerId) throw Error('browser task unavailable'); };
  const owner = (authenticatedOwner: string) => { identity(authenticatedOwner); if (!options.enabled) throw Error('browser task unavailable'); };
  const assertCurrent = (record: BrowserTaskCheckpoint) => { if (!options.enabled || record.session.expiresAt <= options.now()) throw Error('browser task expired or revoked'); };
  const save = (record: BrowserTaskCheckpoint) => options.store.save(browserTaskCheckpointSchema.parse(record));
  const get = async () => {
    const record = browserTaskCheckpointSchema.parse(await options.store.load());
    if (record.taskId !== options.taskId || record.origin !== options.driver.origin || record.manifestDigest !== options.manifestDigest || record.session.ownerId !== options.ownerId || record.session.provider !== options.driver.provider || record.session.mode !== 'public' || record.session.contextHandle !== null) throw Error('browser task unavailable');
    return record;
  };
  const end = async (record: BrowserTaskCheckpoint) => {
    if (record.session.state === 'ended') {
      if (record.phase !== 'closed') await save({ ...record, phase: 'closed' });
      return { stopped: 'cancelled' as const, actions_fenced: true as const };
    }
    // Old submitting/unknown checkpoints lack the optional marker. Preserve their
    // uncertainty during cleanup; closure certifies session end, not effect outcome.
    const pending = { ...record, submissionAttempted: record.submissionAttempted === true || ['submitting', 'unknown'].includes(record.phase),
      phase: 'cleanup_pending' as const, session: { ...record.session, state: 'ending' as const, updatedAt: options.now() } };
    await save(pending);
    if (record.session.providerSessionId === 'pending') { await save({ ...pending, session: { ...pending.session, state: 'lost' } }); return { stopped: 'cleanup_pending' as const, actions_fenced: true as const }; }
    try { await options.driver.end(record.session.providerSessionId); } catch { return { stopped: 'cleanup_pending' as const, actions_fenced: true as const }; }
    await save({ ...pending, phase: 'closed', session: { ...pending.session, state: 'ended' } });
    return { stopped: 'cancelled' as const, actions_fenced: true as const };
  };
  const grant = async (record: BrowserTaskCheckpoint, operation: BrowserCommand['operation'], evidence?: Evidence) => {
    let ref: string | null = null;
    if (options.enabled && record.session.expiresAt > options.now()) { try { ref = await options.admit(operation, evidence); } catch { /* unavailable authority denies */ } }
    if (!options.enabled || record.session.expiresAt <= options.now() || !ref || typeof ref !== 'string' || ref.length > 200) { await end(record); throw Error('browser task expired or revoked'); }
    return ref;
  };
  const cleanupAfterFailure = async (cause: unknown, allocated?: BrowserTaskCheckpoint) => {
    try {
      // Admission may already have fenced/closed the task. Reload instead of
      // restoring a stale active record or repeating a failed cleanup attempt.
      const latest = await get();
      if (latest.phase !== 'cleanup_pending' && latest.session.state !== 'ended') await end(allocated ?? latest);
    } catch (cleanupCause) {
      throw new Error('browser task cleanup unavailable', { cause: new AggregateError([cause, cleanupCause], 'browser operation and cleanup failed') });
    }
  };
  const cleanupOnFailure = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (cause) { await cleanupAfterFailure(cause); throw cause; }
  };
  const issue = async <T>(record: BrowserTaskCheckpoint, operation: BrowserCommand['operation'], body: object, work: () => Promise<T>): Promise<T> => {
    const boundary = new BrowserSessionBoundary({ now: options.now, authorizeManifest: digest => digest === options.manifestDigest, executor: {
      // This freshly minted command is issued once. The durable task intent, not
      // provider exactly-once semantics, prevents final-action replay across calls.
      recover: async () => ({ status: 'known_not_applied' }), issue: async () => work(),
    } });
    boundary.put(options.ownerId, record.session);
    return await boundary.dispatch(options.ownerId, { ownerId: options.ownerId, sessionId: record.session.id, generation: record.session.generation, capabilityManifestDigest: options.manifestDigest, idempotencyKey: (await fixtureDigest(options.newId())).slice(7), expiresAt: record.session.expiresAt, operation, ...body }) as T;
  };
  const actionDigest = (url: string, actionRef: string, request: FixtureObservation['action'], binding: BrowserTaskProposal['binding']) => fixtureDigest({ url, actionRef, method: 'click', ...(request ? { request, binding } : {}) });
  const scopeDigest = (record: BrowserTaskCheckpoint) => fixtureDigest({ owner: options.ownerId, task: options.taskId, manifest: options.manifestDigest, origin: record.origin, session: record.session.id, providerSession: record.session.providerSessionId, generation: record.session.generation });
  const observation = async (record: BrowserTaskCheckpoint) => {
    await grant(record, 'extract');
    if (!['active', 'approval_pending', 'submitting', 'unknown'].includes(record.phase)) throw Error('browser task unavailable');
    const snapshot = await cleanupOnFailure(() => issue(record, 'extract', { instruction: 'Read configured synthetic form state', schemaDigest: options.manifestDigest }, () => options.driver.inspect(record.session.providerSessionId)));
    if (snapshot.url !== options.driver.pageUrl) { await end(record); throw Error('browser task target changed'); }
    return snapshot;
  };
  const uncertain = (): BrowserSubmitOutcome => ({ status: 'uncertain', message: 'The browser submit outcome is unknown. Inspect its result before any retry.' });
  const known = (record: BrowserTaskCheckpoint): BrowserSubmitOutcome | null => record.receipt ? ({ status: 'verified_with_receipt', message: record.receipt.source === 'controlled_fixture' ? 'The controlled synthetic fixture result was verified.' : 'The public form result was verified.', receipt: record.receipt }) : null;
  const readback = async (record: BrowserTaskCheckpoint): Promise<BrowserSubmitOutcome> => {
    if (record.proposal && record.proposal.scopeDigest !== await scopeDigest(record)) return { status: 'rejected', message: 'The browser session changed. Observe and approve a new task.' };
    const prior = known(record); if (prior) return prior;
    if (!record.proposal || !['submitting', 'unknown'].includes(record.phase) && !(record.submissionAttempted && ['closed', 'cleanup_pending'].includes(record.phase))) return { status: 'rejected', message: 'No submitted fixture task is available for verification.' };
    let permit: string | null = null;
    try { permit = await options.admit('extract', { proposalId: record.proposal.id, bindingDigest: record.proposal.bindingDigest }); } catch { /* read authorization unavailable */ }
    if (!permit) return uncertain();
    let result: Awaited<ReturnType<Driver['verify']>> = null;
    try { result = await options.driver.verify(record.proposal.bindingDigest); } catch { /* verification failure never retries submit */ }
    const receipt = result ? browserTaskReceiptSchema.safeParse({ ...result, action_digest: record.proposal.actionDigest }) : null;
    if (!receipt?.success || receipt.data.binding_digest !== record.proposal.bindingDigest) {
      await save({ ...record, phase: ['closed', 'cleanup_pending'].includes(record.phase) ? record.phase : 'unknown' }); return uncertain();
    }
    const verified = browserTaskCheckpointSchema.parse({ ...record, phase: 'verified', receipt: receipt.data });
    await save(verified); await end(verified); return known(verified)!;
  };
  return {
    taskRef: options.taskId, pageUrl: options.driver.pageUrl,
    async open(authenticatedOwner: string, lifetimeMs = 60000, resumeExisting = false) {
      owner(authenticatedOwner);
      return options.store.exclusive(async () => {
        if (await options.store.load() !== null) {
          if (resumeExisting) return observation(await get());
          throw Error('browser task already exists');
        }
        const template = browserTaskCheckpointSchema.parse({ taskId: options.taskId, origin: options.driver.origin, manifestDigest: options.manifestDigest, phase: 'active', steps: 0, proposal: null, receipt: null, session: { id: options.newId(), ownerId: options.ownerId, provider: options.driver.provider, providerSessionId: 'pending', contextHandle: null, mode: 'public', state: 'starting', generation: 0, expiresAt: options.now() + lifetimeMs, updatedAt: options.now() } });
        if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 10000 || lifetimeMs > 600000) throw Error('browser task lifetime rejected');
        let initialGrant: string | null = null;
        try { initialGrant = await options.admit('navigate'); } catch { /* no allocation on unavailable authority */ }
        if (!options.enabled || template.session.expiresAt <= options.now() || !initialGrant || typeof initialGrant !== 'string' || initialGrant.length > 200) throw Error('browser task unavailable');
        // Preserve allocation intent before acquiring. A crash in the provider-ID
        // write window remains an allocation uncertainty bounded by provider TTL.
        await save(template);
        let active = template;
        try {
          const id = await options.driver.start(lifetimeMs);
          active = { ...template, session: { ...template.session, providerSessionId: id, state: 'active' } };
          await save(active); await grant(active, 'navigate');
          await issue(active, 'navigate', { url: options.driver.pageUrl }, () => options.driver.navigate(id));
          return await observation(active);
        } catch (cause) {
          await cleanupAfterFailure(cause, active);
          throw new Error('browser task could not open', { cause });
        }
      });
    },
    async inspect(authenticatedOwner: string) {
      owner(authenticatedOwner);
      return options.store.exclusive(async () => observation(await get()));
    },
    async fill(authenticatedOwner: string, field: string, value: string) {
      owner(authenticatedOwner);
      if (!value || value.length > 1000) throw Error('browser task fill rejected');
      return options.store.exclusive(async () => {
        const record = await get(); await grant(record, 'act');
        if (!['active', 'approval_pending'].includes(record.phase) || record.steps >= 5) throw Error('browser task preparation unavailable');
        const snapshot = await observation(record), actionDigest = await fixtureDigest({ field, value });
        const currentGrant = await grant(record, 'act', { actionDigest, stateDigest: snapshot.stateDigest });
        const counted = { ...record, phase: 'active' as const, proposal: null, steps: record.steps + 1 }; await save(counted);
        await cleanupOnFailure(() => issue(counted, 'act', { actionRef: field, actionDigest, approvalRef: currentGrant }, () => options.driver.fill(record.session.providerSessionId, field, value, snapshot.stateDigest, async () => { await grant(counted, 'act', { actionDigest, stateDigest: snapshot.stateDigest }); }, undefined, () => assertCurrent(counted))));
        return observation(counted);
      });
    },
    async validateProposal(authenticatedOwner: string, reference: BrowserTaskContinuation, payload: { url: string; action: { selector: string; method?: string; arguments?: string[] }; binding: Readonly<Record<string, string>>; request?: FixtureObservation['action']; approvalExpiresAt?: number }) { identity(authenticatedOwner); return options.store.exclusive(async () => { const record = await get(), proposal = record.proposal; return proposal !== null && proposal.id === reference.proposalId && proposal.scopeDigest === reference.scopeDigest && proposal.scopeDigest === await scopeDigest(record) && reference.taskRef === options.taskId && payload.url === proposal.url && JSON.stringify(payload.request) === JSON.stringify(proposal.request) && payload.approvalExpiresAt === proposal.approvalExpiresAt && payload.action.selector === proposal.actionRef && payload.action.method === 'click' && (payload.action.arguments?.length ?? 0) === 0 && await fixtureDigest(Object.entries(payload.binding).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) === proposal.bindingDigest; }); },
    async validateReceipt(authenticatedOwner: string, proposalId: string, receipt: unknown) { identity(authenticatedOwner); return options.store.exclusive(async () => { const record = await get(); return record.proposal?.id === proposalId && record.receipt !== null && browserTaskReceiptSchema.safeParse(receipt).success && await fixtureDigest(record.receipt) === await fixtureDigest(browserTaskReceiptSchema.parse(receipt)); }); },
    async read(authenticatedOwner: string) { owner(authenticatedOwner); return this.open(authenticatedOwner, options.driver.command ? 600000 : 60000, true); },
    async finishRun(authenticatedOwner: string) {
      identity(authenticatedOwner);
      if (!options.driver.command) return;
      return options.store.exclusive(async () => {
        if (await options.store.load() === null) return;
        const record = await get();
        if (record.phase === 'approval_pending' && record.steps < 5 && record.session.expiresAt > options.now()) return;
        await end(record);
      });
    },
    async deny(authenticatedOwner: string, proposalId: string) {
      identity(authenticatedOwner);
      return options.store.exclusive(async () => {
        const record = await get();
        if (record.phase !== 'approval_pending' || record.proposal?.id !== proposalId) return;
        await save({ ...record, phase: 'active', proposal: null });
      });
    },
    async command(authenticatedOwner: string, input: unknown) {
      owner(authenticatedOwner);
      const command = parseSyntheticCommand(input);
      if (!options.driver.command) throw Error('Synthetic commands are unavailable.');
      if (command.operation === 'goto' && command.url !== options.driver.pageUrl) throw Error('browser task destination rejected');
      await this.read(authenticatedOwner);
      const result = await options.store.exclusive(async () => {
        const record = await get();
        if (!['active', 'approval_pending'].includes(record.phase) || record.steps >= 5) throw Error('browser task command bound exceeded');
        const snapshot = await observation(record);
        const counted = { ...record, steps: record.steps + 1 }; await save(counted);
        const outcome = await cleanupOnFailure(() => options.driver.command!(record.session.providerSessionId, command, snapshot.stateDigest, async () => { await grant(counted, 'act', { stateDigest: snapshot.stateDigest }); }, undefined, () => assertCurrent(counted)));
        if (!outcome.held && ['type', 'click', 'goto'].includes(command.operation)) await save({ ...counted, phase: 'active', proposal: null });
        return outcome;
      });
      const proposeWithCleanup = async () => {
        try { return await this.propose(authenticatedOwner); }
        catch (cause) { await options.store.exclusive(() => cleanupAfterFailure(cause)); throw cause; }
      };
      return result.held && result.nativeSubmit === false ? { held: true as const, reason: result.reason ?? 'declared_send_unsupported' as const } : result.held ? { held: true as const, proposal: await proposeWithCleanup() } : { held: false as const, snapshot: await this.inspect(authenticatedOwner) };
    },
    async cancel(authenticatedOwner: string) { identity(authenticatedOwner); return options.store.exclusive(async () => end(await get())); },
    async reconcile(authenticatedOwner: string): Promise<BrowserSubmitOutcome> { identity(authenticatedOwner); return options.store.exclusive(async () => readback(await get())); },
    async submit(authenticatedOwner: string, proposalId: string, approvalRef: string): Promise<BrowserSubmitOutcome> {
      owner(authenticatedOwner);
      return options.store.exclusive(async () => {
        const record = await get(), proposal = record.proposal;
        if (!proposal || proposal.id !== proposalId || !approvalRef) return { status: 'rejected', message: 'The browser approval is unavailable.' };
        if (proposal.scopeDigest !== await scopeDigest(record)) return { status: 'rejected', message: 'The browser session changed. Observe and approve a new task.' };
        const prior = known(record); if (prior) return prior;
        if (['submitting', 'unknown'].includes(record.phase) || record.submissionAttempted) return uncertain();
        if (record.phase !== 'approval_pending' || record.steps >= 5) {
          if (options.driver.command && record.phase === 'approval_pending') await end(record);
          return { status: 'rejected', message: 'The browser task is no longer available for submit.' };
        }
        if (proposal.scopeDigest !== await scopeDigest(record)) return { status: 'rejected', message: 'The browser session changed. Observe and approve a new task.' };
        const digest = await actionDigest(proposal.url, proposal.actionRef, proposal.request, proposal.binding);
        const approvedFacts = await fixtureDigest(Object.entries(proposal.binding).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        if (proposal.url !== options.driver.pageUrl || proposal.actionRef !== options.driver.submitRef || digest !== proposal.actionDigest || approvedFacts !== proposal.bindingDigest) return { status: 'rejected', message: 'The approval no longer matches its exact target and facts.' };
        let snapshot: Awaited<ReturnType<Driver['inspect']>>;
        try { snapshot = await observation(record); } catch { return { status: 'rejected', message: 'The browser task expired or could not be observed. Prepare and approve a new task.' }; }
        if (JSON.stringify(snapshot.action) !== JSON.stringify(proposal.request) || snapshot.url !== proposal.url || snapshot.stateDigest !== proposal.stateDigest || await fixtureDigest(Object.entries(snapshot.binding).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) !== proposal.bindingDigest) {
          await save({ ...record, phase: 'active', proposal: null });
          return { status: 'rejected', message: 'The form changed. Observe and approve its current state again.' };
        }
        const evidence = { proposalId, approvalRef, actionDigest: digest, bindingDigest: proposal.bindingDigest, stateDigest: proposal.stateDigest };
        let approvedGrant: string;
        try { approvedGrant = await grant(record, 'act', evidence); } catch { return { status: 'rejected', message: 'The browser approval expired or was revoked.' }; }
        const intent = { ...record, submissionAttempted: true, phase: 'submitting' as const, steps: record.steps + 1 };
        await save(intent); // Before physical click, even if the next response is lost.
        try { await issue(intent, 'act', { actionRef: proposal.actionRef, actionDigest: digest, approvalRef: approvedGrant }, () => options.driver.submit(record.session.providerSessionId, proposal.stateDigest, async () => { await grant(intent, 'act', evidence); }, undefined, () => assertCurrent(intent))); } catch { /* in doubt, never repeat act */ }
        const latest = await get();
        if (!['submitting', 'unknown'].includes(latest.phase)) return uncertain();
        return readback(latest);
      });
    },
    async propose(authenticatedOwner: string): Promise<BrowserTaskProposal> {
      owner(authenticatedOwner);
      return options.store.exclusive(async () => {
        const record = await get(); await grant(record, 'extract');
        if (!['active', 'approval_pending'].includes(record.phase) || record.steps >= 5) throw Error('browser task proposal unavailable');
        const snapshot = await observation(record);
        const actionRef = options.driver.submitRef;
        const proposal = browserTaskProposalSchema.parse({ id: options.newId(), url: snapshot.url, actionRef, scopeDigest: await scopeDigest(record), actionDigest: await actionDigest(snapshot.url, actionRef, snapshot.action, snapshot.binding), request: snapshot.action, approvalExpiresAt: record.session.expiresAt, stateDigest: snapshot.stateDigest, bindingDigest: await fixtureDigest(Object.entries(snapshot.binding).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), binding: snapshot.binding });
        await save({ ...record, phase: 'approval_pending', proposal });
        return proposal;
      });
    },
  };
}
