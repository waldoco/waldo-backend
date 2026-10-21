import {
  browserErrandCheckpointSchema, browserTaskReceiptSchema,
  type BrowserErrandBlocked, type BrowserErrandCheckpoint, type BrowserErrandEngineName, type BrowserLoginState,
} from '@waldo/contracts';
import type { BrowserSubmitProposal } from './approvals';
import type { BrowserSubmitOutcome } from '../tools/live/browser';
import { fixtureDigest } from './public-fixture-browser';
import { expireLogin, loginPausesAutomation, loginTerminal, nextLoginState, type BrowserLoginEvent } from './browser-login-handoff';

type Facts = Readonly<Record<string, string>>;

// The engine seam for logged-in errands. An engine is a hosted browser agent or a step driver; either way it is a
// worker behind Waldo's approval, never the authority. It reports what it saw; it never decides that an errand is done.
export type BrowserErrandEngine = Readonly<{
  name: BrowserErrandEngineName;
  // Runs the errand up to its final review screen, stops before the committing action, and keeps the browser open
  // for holdSeconds. The facts are what the review screen says the final action would commit.
  prepare(input: Readonly<{ goal: string; origin: string; finalAction: string; profileRef: string | null; holdSeconds: number }>): Promise<
    | Readonly<{ kind: 'review'; sessionRef: string; runRef: string; url: string; facts: Facts }>
    | Readonly<{ kind: 'blocked'; reason: BrowserErrandBlocked; sessionRef: string | null; runRef: string | null }>
    | Readonly<{ kind: 'failed'; sessionRef: string | null; runRef: string | null }>>;
  // Performs only the approved final action in the held browser. 'not_started' means the engine knows no run started.
  // A throw means the outcome is unknown.
  submit(input: Readonly<{ sessionRef: string; submitKey: string; profileRef: string | null; finalAction: string; facts: Facts }>): Promise<
    Readonly<{ status: 'started'; runRef: string }> | Readonly<{ status: 'not_started' }>>;
  // Looks for a submit run the errand started but never recorded, ignoring the runs it already knows.
  findSubmit(input: Readonly<{ sessionRef: string; knownRunRefs: readonly string[] }>): Promise<
    Readonly<{ status: 'found'; runRef: string }> | Readonly<{ status: 'absent' }> | Readonly<{ status: 'unknown' }>>;
  // A finished run says nothing about success: vendorClaim is the agent's own report and is never trusted.
  run(runRef: string): Promise<Readonly<{ state: 'running' }> | Readonly<{ state: 'finished'; vendorClaim: boolean | null }> | Readonly<{ state: 'missing' }>>;
  // A separate read-only look at the account. It returns what the page shows for the asked keys, or null.
  verify(input: Readonly<{ origin: string; check: string; keys: readonly string[]; profileRef: string | null; sessionRef: string | null }>): Promise<
    Readonly<{ observed: Facts; confirmationId: string | null }> | null>;
  // Stops the held browser. Fence also ends the engine session so nothing queued or in flight can start afterwards.
  release(sessionRef: string): Promise<void>;
  fence(sessionRef: string): Promise<void>;
  login?: Readonly<{
    start(input: Readonly<{ origin: string; profileRef: string | null; minutes: number }>): Promise<Readonly<{ sessionRef: string; liveViewUrl: string }>>;
    // Reads which account is signed in, after the owner has handed control back.
    confirm(input: Readonly<{ origin: string; profileRef: string | null; sessionRef: string; account: string }>): Promise<boolean>;
  }>;
}>;

export type BrowserErrandStore = Readonly<{
  // A per-owner, per-errand mutex. External I/O runs inside it, never inside an SQLite transaction.
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  load(): Promise<unknown>;
  save(record: BrowserErrandCheckpoint): Promise<void>;
}>;

export type BrowserErrandPlan = Readonly<{
  errandType: string;
  origin: string;
  goal: string;
  finalAction: string;
  // Postconditions the verifying read must observe on the account, declared before anything runs.
  expected: Facts;
  verifyCheck: string;
  profileRef: string | null;
  // Set by the host from ingress classification. Health-adjacent errands need a zero-retention project first.
  healthAdjacent: boolean;
}>;

export type BrowserErrandPrepared =
  | Readonly<{ status: 'review'; proposal: BrowserSubmitProposal }>
  | Readonly<{ status: 'blocked'; blocked: BrowserErrandBlocked }>
  | Readonly<{ status: 'failed'; message: string }>;

export type BrowserErrandView = Readonly<{
  errandId: string; phase: BrowserErrandCheckpoint['phase']; blocked: BrowserErrandBlocked | null;
  login: BrowserLoginState | null; approvalExpiresAt: number | null;
}>;

export type BrowserErrandOperation = 'prepare' | 'submit' | 'verify' | 'login';

const IN_FLIGHT: ReadonlySet<BrowserErrandCheckpoint['phase']> = new Set(['submitting', 'submitted', 'unknown']);
const TERMINAL: ReadonlySet<BrowserErrandCheckpoint['phase']> = new Set(['verified', 'not_applied', 'expired', 'cancelled', 'failed']);
const DEFAULT_HOLD_SECONDS = 1800;
const DEFAULT_SUBMIT_MARGIN_MS = 120_000;
const DEFAULT_LOGIN_MINUTES = 15;

const sortedFacts = (facts: Facts) => Object.entries(facts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function browserErrand(options: Readonly<{
  enabled: boolean; ownerId: string; errandId: string;
  engine: BrowserErrandEngine; store: BrowserErrandStore;
  now(): number; newId(): string;
  // Trusted host admission: a current grant reference, rechecked before every engine call. Page text cannot grant it.
  admit(operation: BrowserErrandOperation, evidence?: Readonly<Record<string, string>>): Promise<string | null>;
  // Final submits run on this engine only for errand types the bake-off adopted. Every other type stays on the
  // guarded Stagehand path, which prepares and submits in its own session.
  submitAdopted(errandType: string): boolean;
  holdSeconds?: number; submitMarginMs?: number; loginMinutes?: number;
}>) {
  const holdSeconds = options.holdSeconds ?? DEFAULT_HOLD_SECONDS;
  const margin = options.submitMarginMs ?? DEFAULT_SUBMIT_MARGIN_MS;
  const identity = (owner: string) => { if (owner !== options.ownerId) throw Error('browser errand unavailable'); };
  const enabled = (owner: string) => { identity(owner); if (!options.enabled) throw Error('browser errand unavailable'); };
  const save = async (record: BrowserErrandCheckpoint) => {
    const next = browserErrandCheckpointSchema.parse({ ...record, updatedAt: options.now() });
    await options.store.save(next);
    return next;
  };
  const load = async (): Promise<BrowserErrandCheckpoint | null> => {
    const raw = await options.store.load();
    if (raw === null || raw === undefined) return null;
    const record = browserErrandCheckpointSchema.parse(raw);
    if (record.errandId !== options.errandId || record.ownerId !== options.ownerId || record.engine !== options.engine.name) throw Error('browser errand unavailable');
    return record;
  };
  const get = async () => { const record = await load(); if (!record) throw Error('browser errand unavailable'); return record; };
  const permit = async (operation: BrowserErrandOperation, evidence?: Readonly<Record<string, string>>) => {
    if (!options.enabled) return null;
    try { const ref = await options.admit(operation, evidence); return typeof ref === 'string' && ref.length > 0 && ref.length <= 200 ? ref : null; }
    catch { return null; }
  };
  // Stopping the browser is cleanup, not an outcome. A failed stop keeps the reference so the next sweep retries it.
  const release = async (record: BrowserErrandCheckpoint, phase: BrowserErrandCheckpoint['phase'], fence = false) => {
    const sessionRef = record.custody.sessionRef;
    let stopped = sessionRef === null;
    if (sessionRef !== null) {
      try { await (fence ? options.engine.fence(sessionRef) : options.engine.release(sessionRef)); stopped = true; }
      catch { console.warn(JSON.stringify({ event: 'browser_errand_release_failed', engine: options.engine.name })); }
    }
    return save({ ...record, phase, holdExpiresAt: null, custody: { ...record.custody, liveViewUrl: null, sessionRef: stopped ? null : sessionRef } });
  };
  const factsDigest = (facts: Facts) => fixtureDigest(sortedFacts(facts));
  const scopeDigest = (record: BrowserErrandCheckpoint, proposalId: string) => fixtureDigest({
    owner: options.ownerId, errand: options.errandId, engine: options.engine.name, origin: record.origin, facts: record.review?.factsDigest ?? null, proposalId,
  });
  const actionDigest = (record: BrowserErrandCheckpoint) => fixtureDigest({ errand: options.errandId, origin: record.origin, finalAction: record.finalAction, facts: record.review?.factsDigest ?? null });
  const sameOrigin = (url: string, origin: string) => { try { return new URL(url).origin === origin; } catch { return false; } };

  const rejected = (message: string): BrowserSubmitOutcome => ({ status: 'rejected', message });
  const uncertain = (message = 'The errand outcome is unknown. Check the account before trying again; nothing will be resubmitted automatically.'): BrowserSubmitOutcome => ({ status: 'uncertain', message });
  const known = (record: BrowserErrandCheckpoint): BrowserSubmitOutcome | null => record.receipt
    ? { status: 'verified_with_receipt', message: 'The errand was checked on the account afterwards and its result matched what you approved.', receipt: record.receipt }
    : null;

  // Readback after a submit. It never sends the final action again; at most it follows the run the errand started.
  const readback = async (start: BrowserErrandCheckpoint): Promise<BrowserSubmitOutcome> => {
    let record = start;
    const prior = known(record); if (prior) return prior;
    if (!IN_FLIGHT.has(record.phase)) return rejected('No submitted errand is waiting to be checked.');
    if (record.custody.submitRunRef === null) {
      // The submit request may have reached the engine before the process lost its answer. End the engine session
      // first so nothing can start later, then look for the run.
      const sessionRef = record.custody.sessionRef;
      if (sessionRef === null) { await save({ ...record, phase: 'unknown' }); return uncertain(); }
      try { await options.engine.fence(sessionRef); }
      catch { await save({ ...record, phase: 'unknown' }); return uncertain(); }
      let found: Awaited<ReturnType<BrowserErrandEngine['findSubmit']>>;
      try { found = await options.engine.findSubmit({ sessionRef, knownRunRefs: record.custody.prepareRunRef ? [record.custody.prepareRunRef] : [] }); }
      catch { found = { status: 'unknown' }; }
      if (found.status === 'absent') {
        await save({ ...record, phase: 'not_applied', holdExpiresAt: null, custody: { ...record.custody, sessionRef: null, liveViewUrl: null } });
        return rejected('The final step never started, so nothing was submitted. Ask me to prepare it again.');
      }
      if (found.status === 'unknown') { await save({ ...record, phase: 'unknown' }); return uncertain(); }
      record = await save({ ...record, phase: 'submitted', custody: { ...record.custody, submitRunRef: found.runRef } });
    }
    let run: Awaited<ReturnType<BrowserErrandEngine['run']>>;
    try { run = await options.engine.run(record.custody.submitRunRef!); }
    catch { await save({ ...record, phase: 'unknown' }); return uncertain(); }
    if (run.state === 'running') { await save({ ...record, phase: 'submitted' }); return uncertain('The final step is still running. I will check the account when it finishes; nothing will be resubmitted.'); }
    if (run.state === 'missing') { await save({ ...record, phase: 'unknown' }); return uncertain(); }
    // The run ended. Whatever the agent claims, completion is decided only by an independent read of the account.
    if (!await permit('verify', { errandId: options.errandId })) { await save({ ...record, phase: 'unknown' }); return uncertain(); }
    let seen: Awaited<ReturnType<BrowserErrandEngine['verify']>> = null;
    try {
      seen = await options.engine.verify({ origin: record.origin, check: record.verifyCheck, keys: Object.keys(record.expected), profileRef: record.custody.profileRef, sessionRef: record.custody.sessionRef });
    } catch { seen = null; }
    const matched = seen !== null && sortedFacts(record.expected).every(([key, value]) => typeof seen!.observed[key] === 'string' && same(seen!.observed[key]!, value));
    if (!matched) {
      await save({ ...record, phase: 'unknown' });
      return { status: 'acknowledged_unverified', message: 'The final step ran, but the account does not yet show the result you approved. Check it before trying again; nothing will be resubmitted automatically.' };
    }
    const receipt = browserTaskReceiptSchema.parse({
      id: seen!.confirmationId?.trim().slice(0, 100) || (await fixtureDigest(sortedFacts(seen!.observed))).slice(7, 39),
      observed_at: new Date(options.now()).toISOString(), source: 'provider',
      action_digest: await actionDigest(record), binding_digest: record.review!.factsDigest,
    });
    const verified = await release({ ...record, receipt }, 'verified');
    return known(verified)!;
  };

  return {
    errandId: options.errandId,

    view: async (owner: string): Promise<BrowserErrandView | null> => {
      identity(owner);
      const record = await load();
      return record && { errandId: record.errandId, phase: record.phase, blocked: record.blocked, login: record.login?.state ?? null, approvalExpiresAt: record.approvalExpiresAt };
    },

    async prepare(owner: string, plan: BrowserErrandPlan): Promise<BrowserErrandPrepared> {
      enabled(owner);
      if (plan.healthAdjacent) return { status: 'failed', message: 'Health-related errands cannot run in a hosted browser yet.' };
      return options.store.exclusive(async () => {
        const prior = await load();
        if (prior && prior.phase !== 'ready') throw Error('browser errand already exists');
        if (prior && (prior.origin !== plan.origin || prior.errandType !== plan.errandType)) throw Error('browser errand target changed');
        if (!await permit('prepare', { errandType: plan.errandType, origin: plan.origin })) throw Error('browser errand unavailable');
        const intent = await save(browserErrandCheckpointSchema.parse({
          version: 1, errandId: options.errandId, ownerId: options.ownerId, errandType: plan.errandType, engine: options.engine.name, origin: plan.origin,
          phase: 'preparing', holdExpiresAt: null, review: null, finalAction: plan.finalAction, expected: plan.expected, verifyCheck: plan.verifyCheck, proposalId: null, approvalExpiresAt: null, submit: null,
          blocked: null, login: prior?.login ?? null, receipt: null, updatedAt: options.now(),
          custody: { profileRef: plan.profileRef, sessionRef: prior?.custody.sessionRef ?? null, prepareRunRef: null, submitRunRef: null, liveViewUrl: null },
        }));
        let result: Awaited<ReturnType<BrowserErrandEngine['prepare']>>;
        try { result = await options.engine.prepare({ goal: plan.goal, origin: plan.origin, finalAction: plan.finalAction, profileRef: plan.profileRef, holdSeconds }); }
        catch { await save({ ...intent, phase: 'failed' }); return { status: 'failed', message: 'The browser could not get to the review screen.' }; }
        const custody = { ...intent.custody, sessionRef: result.sessionRef ?? intent.custody.sessionRef, prepareRunRef: result.runRef };
        if (result.kind === 'failed') { await release({ ...intent, custody }, 'failed'); return { status: 'failed', message: 'The browser could not get to the review screen.' }; }
        if (result.kind === 'blocked') {
          // A login wall keeps the browser for the owner's sign-in; any other block releases it.
          if (result.reason === 'login_required' && custody.sessionRef !== null) {
            await save({ ...intent, phase: 'blocked', blocked: 'login_required', holdExpiresAt: options.now() + holdSeconds * 1000, custody });
          } else await release({ ...intent, blocked: result.reason, custody }, 'blocked');
          return { status: 'blocked', blocked: result.reason };
        }
        if (!sameOrigin(result.url, plan.origin)) {
          await release({ ...intent, custody }, 'failed');
          return { status: 'failed', message: 'The review screen was on a different site than the errand, so nothing was proposed.' };
        }
        const proposalId = options.newId(), holdExpiresAt = options.now() + holdSeconds * 1000;
        let review: BrowserErrandCheckpoint['review'];
        try { review = { url: result.url, facts: { ...result.facts }, factsDigest: await factsDigest(result.facts) }; browserErrandCheckpointSchema.shape.review.parse(review); }
        catch { await release({ ...intent, custody }, 'failed'); return { status: 'failed', message: 'The review screen facts could not be read, so nothing was proposed.' }; }
        const held = await save({ ...intent, phase: 'awaiting_approval', review, proposalId, holdExpiresAt, approvalExpiresAt: holdExpiresAt - margin, custody });
        return { status: 'review', proposal: {
          url: review!.url, action: { selector: 'errand:final', description: plan.finalAction }, binding: review!.facts, steps: [],
          continuation: { version: 1, taskRef: options.errandId, proposalId, scopeDigest: await scopeDigest(held, proposalId) },
          approvalExpiresAt: held.approvalExpiresAt!,
        } };
      });
    },

    // The owner signs in through a live view of the held browser; automation stays paused until they hand back.
    async beginLogin(owner: string): Promise<Readonly<{ expiresAt: number }>> {
      enabled(owner);
      const login = options.engine.login;
      if (!login) throw Error('browser errand login unavailable');
      return options.store.exclusive(async () => {
        const record = await get();
        if (record.phase !== 'blocked' || record.blocked !== 'login_required') throw Error('browser errand login unavailable');
        if (!await permit('login', { origin: record.origin })) throw Error('browser errand unavailable');
        const minutes = options.loginMinutes ?? DEFAULT_LOGIN_MINUTES;
        // The agent's browser is released first so no run or screenshot overlaps the owner's typing.
        const cleared = await release(record, 'blocked');
        const started = await login.start({ origin: record.origin, profileRef: record.custody.profileRef, minutes });
        const expiresAt = options.now() + minutes * 60_000;
        await save({ ...cleared, phase: 'login_handoff', login: { state: 'requested', expiresAt }, custody: { ...cleared.custody, sessionRef: started.sessionRef, liveViewUrl: started.liveViewUrl } });
        return { expiresAt };
      });
    },

    // Only the authenticated console route calls this. The link is a credential: it never reaches model text or logs.
    async liveView(owner: string): Promise<string | null> {
      enabled(owner);
      return options.store.exclusive(async () => {
        const record = await get();
        if (record.phase !== 'login_handoff' || !record.login || !loginPausesAutomation(record.login.state) || record.custody.liveViewUrl === null) return null;
        const state = expireLogin(record.login.state, options.now(), record.login.expiresAt);
        if (state === 'expired') { await release({ ...record, login: { ...record.login, state } }, 'expired'); return null; }
        if (record.login.state === 'requested') await save({ ...record, login: { ...record.login, state: nextLoginState('requested', { type: 'owner_opened' }, options.now(), record.login.expiresAt) } });
        return record.custody.liveViewUrl;
      });
    },

    async loginEvent(owner: string, event: BrowserLoginEvent, account?: string): Promise<BrowserLoginState> {
      enabled(owner);
      return options.store.exclusive(async () => {
        const record = await get();
        if (record.phase !== 'login_handoff' || !record.login) throw Error('browser errand login unavailable');
        let state = nextLoginState(record.login.state, event, options.now(), record.login.expiresAt);
        if (state === 'owner_done') {
          // The owner handed control back. The link stops working here; one read confirms the intended account.
          const handed = await save({ ...record, login: { ...record.login, state }, custody: { ...record.custody, liveViewUrl: null } });
          const confirm = options.engine.login?.confirm, sessionRef = handed.custody.sessionRef;
          let signedIn = false;
          if (confirm && sessionRef !== null && account && await permit('login', { origin: record.origin })) {
            try { signedIn = await confirm({ origin: record.origin, profileRef: record.custody.profileRef, sessionRef, account }); } catch { signedIn = false; }
          }
          state = nextLoginState(state, { type: 'confirmed', signedIn }, options.now(), record.login.expiresAt);
          if (state === 'signed_in') { await release({ ...handed, blocked: null, login: { ...record.login, state } }, 'ready'); return state; }
          await release({ ...handed, login: { ...record.login, state } }, state === 'expired' ? 'expired' : 'failed');
          return state;
        }
        if (loginTerminal(state)) { await release({ ...record, login: { ...record.login, state } }, state === 'cancelled' ? 'cancelled' : state === 'expired' ? 'expired' : 'failed'); return state; }
        await save({ ...record, login: { ...record.login, state } });
        return state;
      });
    },

    async submit(owner: string, proposal: BrowserSubmitProposal, approvalRef: string): Promise<BrowserSubmitOutcome> {
      enabled(owner);
      return options.store.exclusive(async () => {
        const record = await get();
        const prior = known(record); if (prior && record.proposalId === proposal.continuation?.proposalId) return prior;
        if (!approvalRef || !proposal.continuation || proposal.continuation.taskRef !== options.errandId || proposal.continuation.proposalId !== record.proposalId) return rejected('This approval is not for the errand that is waiting.');
        // A repeated approval follows the first submit; it never sends the final action again.
        if (IN_FLIGHT.has(record.phase)) return readback(record);
        if (record.phase !== 'awaiting_approval' || !record.review) return rejected('This errand is no longer waiting for approval.');
        if (proposal.continuation.scopeDigest !== await scopeDigest(record, record.proposalId!) || proposal.url !== record.review.url
          || await factsDigest(proposal.binding) !== record.review.factsDigest) return rejected('The approval no longer matches the review screen.');
        if (record.approvalExpiresAt === null || options.now() >= record.approvalExpiresAt) {
          await release(record, 'expired');
          return rejected('The approval expired and the browser was closed, so nothing was submitted. Ask me to prepare it again.');
        }
        if (!options.submitAdopted(record.errandType)) {
          await release(record, 'cancelled');
          return rejected('This kind of errand cannot be submitted by this browser yet, so nothing was submitted.');
        }
        const grant = await permit('submit', { errandId: options.errandId, proposalId: record.proposalId!, approvalRef, factsDigest: record.review.factsDigest });
        if (!grant || record.custody.sessionRef === null) return rejected('The approval could not be confirmed, so nothing was submitted.');
        // The intent is durable before the request leaves, so a lost answer becomes a readback, never a second submit.
        const intent = await save({ ...record, phase: 'submitting', submit: { key: (await fixtureDigest(options.newId())).slice(7, 39), startedAt: options.now() } });
        let started: Awaited<ReturnType<BrowserErrandEngine['submit']>>;
        try { started = await options.engine.submit({ sessionRef: record.custody.sessionRef, submitKey: intent.submit!.key, profileRef: record.custody.profileRef, finalAction: record.finalAction, facts: record.review.facts }); }
        catch { return readback(intent); }
        if (started.status === 'not_started') {
          // No run was created, but the held browser is still signed in, and on a conflict another run is active in it:
          // the session is ended so nothing in it can act. A failed end keeps the reference for the sweep.
          await release({ ...intent, review: null, proposalId: null, approvalExpiresAt: null, submit: null, custody: { ...intent.custody, prepareRunRef: null } }, 'ready', true);
          return rejected('The final step could not start, so nothing was submitted. Ask me to prepare it again and approve the new review.');
        }
        return readback(await save({ ...intent, phase: 'submitted', custody: { ...intent.custody, submitRunRef: started.runRef } }));
      });
    },

    async reconcile(owner: string): Promise<BrowserSubmitOutcome> {
      identity(owner);
      return options.store.exclusive(async () => readback(await get()));
    },

    async deny(owner: string, proposalId: string): Promise<void> {
      identity(owner);
      await options.store.exclusive(async () => {
        const record = await get();
        if (record.phase === 'awaiting_approval' && record.proposalId === proposalId) await release(record, 'cancelled');
      });
    },

    async cancel(owner: string): Promise<BrowserErrandCheckpoint['phase']> {
      identity(owner);
      return options.store.exclusive(async () => {
        const record = await get();
        // Once the final step may have run, stopping the browser could leave it half done: only readback applies.
        if (IN_FLIGHT.has(record.phase) || TERMINAL.has(record.phase)) return record.phase;
        return (await release(record, 'cancelled')).phase;
      });
    },

    // Called from the owner object's alarm. Closes a held browser whose approval or login ran out, and retries a
    // failed browser stop. An expired card never leaves a signed-in browser running.
    async sweep(owner: string): Promise<BrowserErrandCheckpoint['phase'] | null> {
      identity(owner);
      return options.store.exclusive(async () => {
        const record = await load();
        if (!record) return null;
        const now = options.now();
        if (record.phase === 'awaiting_approval' && record.approvalExpiresAt !== null && now >= record.approvalExpiresAt) return (await release(record, 'expired')).phase;
        if (record.phase === 'blocked' && record.holdExpiresAt !== null && now >= record.holdExpiresAt) return (await release(record, 'expired')).phase;
        if (record.phase === 'login_handoff' && record.login && expireLogin(record.login.state, now, record.login.expiresAt) === 'expired') {
          return (await release({ ...record, login: { ...record.login, state: 'expired' } }, 'expired')).phase;
        }
        if (TERMINAL.has(record.phase) && record.custody.sessionRef !== null) return (await release(record, record.phase)).phase;
        // Only a failed stop leaves a ready errand holding a browser.
        if (record.phase === 'ready' && record.custody.sessionRef !== null) return (await release(record, 'ready', true)).phase;
        return record.phase;
      });
    },

    // The approval desk promotes an errand to done only when the stored receipt is exactly the one returned.
    async receiptVerified(owner: string, proposalId: string, receipt: unknown): Promise<boolean> {
      identity(owner);
      return options.store.exclusive(async () => {
        const record = await load();
        const parsed = browserTaskReceiptSchema.safeParse(receipt);
        return !!record && record.phase === 'verified' && record.proposalId === proposalId && record.receipt !== null && parsed.success
          && await fixtureDigest(record.receipt) === await fixtureDigest(parsed.data);
      });
    },
  };
}
