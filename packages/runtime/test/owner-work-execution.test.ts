import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';
import { AppInbox } from '../src/channels/app-inbox';
import { assertOwnerAppWorkRunnable, ownerAppWorkContinuationPending, ownerAppWorkExecution, type OwnerAppWorkExecutionOptions } from '../src/channels/owner-app-work-execution';
import { ownerWorkControl } from '../src/channels/owner-work-control';
import { ownerEffectLedger, type EffectReadback } from '../src/channels/owner-effect-ledger';
import { responsibilityBook } from '../src/channels/responsibilities';
import { surfaceOwnerAdmission } from '../src/identity/surface-owner-admission';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { ClosedRunError, type RunEffectScope } from '../src/channels/run-effect-scope';
import { approvalDesk } from '../src/channels/approvals';
import { ownerAppWorkHost } from '../src/channels/owner-app-work-host';
import { runBook } from '../src/channels/background-runs';

const journey = async (name: string, run: (state: DurableObjectState) => Promise<void>) => runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName(name)), async (_, state) => run(state));
const fixture = async (state: DurableObjectState) => {
  const ownerName = 'owner-do-app-only'; let source = 1, revoked = false, stopped = 0, cancelled = 0, scheduled = 0;
  let provider: EffectReadback = { status: 'unknown' }, providerReads = 0;
  const assertLocalCurrent = () => { if (revoked) throw new ClosedRunError(); };
  const assertCurrent = async () => assertLocalCurrent();
  const request: RunEffectScope = { runId: 'authenticated-control', attempt: 'fresh', deadline: 100_000,
    signal: new AbortController().signal, admit: assertLocalCurrent, commit: change => state.storage.transactionSync(() => { assertLocalCurrent(); return change(); }) };
  const context = createOwnerTurnContext(await surfaceOwnerAdmission({ scope: request,
    lookup: async () => ({ ownerId: '11111111-2222-4333-8444-555555555555', bindingRef: 'fresh-native-session', revision: '1', physicalDoId: 'actual-test-do' }),
    expectedPhysicalDoId: 'actual-test-do', surface: 'app', subject: 'fresh-native-session', occurrenceKey: request.runId, occurredAt: 1, text: 'Owner controls Work', now: () => 2 }));
  const { principal_ref: principalRef, tenant_ref: tenantRef } = context.invocation.verified_authority;
  const conversationRef = `owner:${principalRef}`, inbox = new AppInbox(state.storage, () => 1000);
  const initial = await inbox.admit(ownerName, 'old-owner-session', 'initial_owner_message', 'Research my private project', { conversationRef });
  const unrelated = await inbox.admit(ownerName, 'old-owner-session', 'unrelated_owner_message', 'Unrelated work in this conversation', { conversationRef });
  if (initial.kind !== 'admitted' || unrelated.kind !== 'admitted') throw Error('admission');
  const original = inbox.claim(initial.record.id, true)!, other = inbox.claim(unrelated.record.id, true)!;
  const originalScope = inbox.scope(original, new AbortController().signal), otherScope = inbox.scope(other, new AbortController().signal);
  const entry: ConversationEntry = { id: original.id, ownerId: principalRef, chatId: conversationRef, parentId: null, threadAnchorId: null,
    surface: 'app', role: 'user', inputOrigin: 'owner', modelPayload: 'Research my private project', appPayload: 'Research my private project', modelProjection: { mode: 'include' } };
  await canonicalOwnerConversationStore(state.storage, context).save([entry], entry.id, originalScope);
  const book = responsibilityBook(state.storage.sql, { newId: () => 'actual-work', now: () => 1000 });
  const task = book.track({ title: 'Private project', intent: 'Research my private project', items: [], next_check_at: null }, original.id).responsibility;
  const workRef = `responsibility:${task.id}`, effects = ownerEffectLedger(state.storage, () => 1000, () => original.id);
  const scheduledRuns: string[] = [];
  const options: OwnerAppWorkExecutionOptions = { storage: state.storage, inbox, ownerName, principalRef, tenantRef, sessionHash: 'fresh-native-session', responsibilities: book,
    sourceRevision: () => source, assertCurrent, assertLocalCurrent,
    activeRun: () => ({ run_id: other.id, attempt: other.attempt!, fence: () => { stopped++; } }),
    executor: { cancel: async runId => { cancelled++; return { fenced: inbox.records().find(row => row.id === runId)?.state === 'interrupted', evidence_refs: [`executor:${runId}:fenced`] }; },
      reconcile: async runId => ({ fenced: ['interrupted', 'completed'].includes(inbox.records().find(row => row.id === runId)?.state ?? ''), evidence_refs: [`executor:${runId}:readback`] }) },
    reconcileEffect: (record, guard) => effects.reconcile(record.operationId, { assertCurrent: guard, readback: async () => { providerReads++; return provider; } }),
    admitted: (record, ref) => { expect(ref).toBe(workRef); scheduled++; scheduledRuns.push(record.id); } };
  const make = (custom: Partial<OwnerAppWorkExecutionOptions> = {}) => {
    const execution = ownerAppWorkExecution({ ...options, ...custom });
    const control = ownerWorkControl({ ...execution, storage: state.storage, now: () => 1000, sourceRevision: () => source, assertCurrent,
      commit: change => state.storage.transactionSync(change) });
    return { execution, control };
  };
  const intent = (control: ReturnType<typeof ownerWorkControl>, action: 'pause' | 'resume' | 'stop' | 'reconcile', operation: string) => ({ operation_id: operation, work_ref: workRef, action,
    expected_revision: control.read(workRef).revision, expected_source_revision: source, projection_revision: 'a'.repeat(64) });
  return { options, make, intent, original, originalScope, other, otherScope, book, workRef, effects, principalRef, tenantRef, inbox, scheduledRuns, context,
    setProvider: (value: EffectReadback) => { provider = value; }, revoke: () => { revoked = true; }, changeSource: () => { source++; },
    get stopped() { return stopped; }, get cancelled() { return cancelled; }, get scheduled() { return scheduled; }, get providerReads() { return providerReads; } };
};

describe('authoritative native Work execution', () => {
  it('closes only the exact inbox attempt and leaves another live task in the same conversation runnable', async () => journey('work-execution-exact-cancel', async state => {
    const f = await fixture(state);
    expect(f.inbox.cancelRun(f.original.id, 'wrong-attempt', f.original.digest)).toBe(false);
    expect(f.inbox.cancelRun(f.original.id, f.original.attempt, 'wrong-digest')).toBe(false);
    const { control } = f.make();
    const paused = await control.control(f.intent(control, 'pause', 'pause_exact_attempt'));
    expect(paused).toMatchObject({ state: 'recorded', cancellation: 'fenced', external_effects: 'none_recorded' });
    expect(f.cancelled).toBe(1); expect(f.stopped).toBe(0);
    expect(() => f.originalScope.admit()).toThrow(ClosedRunError); expect(() => f.otherScope.admit()).not.toThrow();
    expect(f.inbox.records().find(row => row.id === f.original.id)).toMatchObject({ state: 'interrupted', text: 'Research my private project' });
    expect(f.inbox.records().find(row => row.id === f.other.id)).toMatchObject({ state: 'running', text: 'Unrelated work in this conversation' });
  }));
  it('projects actual admitted inbox runs alongside retained audit rows with exact run controls and truthful deduplicated counters', async () => journey('work-execution-inbox-projection', async state => {
    const f = await fixture(state), { execution } = f.make();
    const desk = approvalDesk(state.storage.sql, { owner: 1, effectOwnerRef: f.principalRef, effects: f.effects, google: async () => null,
      call: async () => ({}), newId: () => 'projection', now: () => 1000, timezone: 'UTC', log: () => {} });
    const audit = runBook(state.storage.sql, { timezone: 'UTC', now: () => new Date(1000) }, () => 'separate-audit');
    audit.start('delegate_task', f.original.id);
    state.storage.sql.exec('INSERT INTO background_runs (id,kind,status,summary,parent_id,started_at,ended_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
      f.original.id, 'event', 'completed', 'Older audit classification', 900, 1000);
    const make = () => ownerAppWorkHost({ accountRef: `acct_${'a'.repeat(64)}`, principalRef: f.principalRef, sessionRef: 'fresh-session', storage: state.storage,
      now: () => 1000, sourceRevision: f.options.sourceRevision, assertCurrent: f.options.assertCurrent,
      books: { responsibilities: f.book, runs: audit, effects: f.effects, desk, canonicalWorkUnits: async () => [], files: async () => [],
        inboxRuns: async () => f.inbox.records().filter(row => row.owner === f.options.ownerName && !row.erased).map(row => ({ id: row.id, kind: 'owner_request', status: row.state,
          summary: row.text.slice(0, 160), parent_id: null, started: new Date(row.admittedAt).toISOString(), ended: row.closedAt === undefined ? null : new Date(row.closedAt).toISOString() })) },
      execution, browser: { state: async () => undefined, open: async () => { throw Error('no handoff'); }, resume: async () => { throw Error('no handoff'); }, revoke: async () => { throw Error('no handoff'); } } });
    const projection = await make().projection(), run = projection.tasks.find(row => row.work_ref === `run:${f.original.id}`)!;
    expect(projection.counts).toMatchObject({ scope: 'retained_owner_records', total: 4, by_kind: { responsibility: 1, work_unit: 0, run: 3 } });
    expect(run).toMatchObject({ status: 'running', controls: { state: 'active', allowed: ['pause', 'stop', 'reconcile'] } });
    expect(projection.tasks.filter(row => row.work_ref === `run:${f.original.id}`)).toHaveLength(1);
    expect(projection.tasks.find(row => row.work_ref === 'run:bg:separate-audit')).toMatchObject({ controls: { state: 'unavailable', allowed: [] } });
    const response = await make().request(new Request('https://waldo.test/app/v1/work/operations', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation_id: 'native_pause_inbox_run', work_ref: run.work_ref, action: 'pause', expected_revision: run.controls.revision,
        expected_source_revision: projection.source_revision, projection_revision: projection.revision }) }));
    expect(response?.status).toBe(200); expect(f.inbox.records().find(row => row.id === f.original.id)?.state).toBe('interrupted');
    expect(() => f.otherScope.admit()).not.toThrow();
  }));
  it('retains queued B before it has a history witness and re-admits its exact envelope after eviction instead of earlier A', async () => journey('work-execution-queued-envelope', async state => {
    const f = await fixture(state), threadId = 'thr_11111111-0000-4000-8000-000000000001';
    const referenced = { thread_id: threadId, title: 'Exact referenced context', revision: 1, state: 'active', created_at: 1000, updated_at: 1000,
      conversation_ref: `owner:${f.principalRef}:thread:${threadId.slice(4)}` };
    state.storage.kv.put(`app-thread-v1:${f.principalRef}:${f.tenantRef}:thread:${threadId}`, referenced);
    const envelope = { conversationRef: f.original.conversationRef!, contextRefs: [{ kind: 'thread' as const, thread_id: threadId, revision: 1 }],
      attachmentRefs: [{ file_id: '22222222-0000-4000-8000-000000000001', revision: 2 }],
      contextSnapshots: [{ threadId, revision: 1, leafId: 'exact-referenced-leaf', digest: `sha256:${'a'.repeat(64)}` }],
      voice: { original: { file_id: '33333333-0000-4000-8000-000000000001', revision: 3 }, processing: 'owner_reviewed' as const, transcript: 'Exact owner reviewed voice B' } };
    const accepted = await f.inbox.admit(f.options.ownerName, 'original-owner-session', 'queued_client_exact_B', 'UNIQUE QUEUED REQUEST B', envelope);
    if (accepted.kind !== 'admitted') throw Error('admission');
    const ref = `run:${accepted.record.id}`, first = f.make();
    const intent = (control: ReturnType<typeof ownerWorkControl>, action: 'pause' | 'resume', id: string) => ({ operation_id: id, work_ref: ref, action,
      expected_revision: control.read(ref).revision, expected_source_revision: 1, projection_revision: 'b'.repeat(64) });
    expect(first.execution.checkpoint(ref)?.checkpoint_ref).toContain(':envelope');
    expect(first.execution.checkpoint(ref)?.checkpoint_ref).not.toContain(`${f.original.id}:`);
    expect(await first.control.control(intent(first.control, 'pause', 'pause_queued_B'))).toMatchObject({ state: 'recorded' });
    expect(f.inbox.records().find(row => row.id === accepted.record.id)).toMatchObject({ state: 'interrupted', text: 'UNIQUE QUEUED REQUEST B', contextSnapshots: envelope.contextSnapshots, voice: envelope.voice });
    const reloaded = f.make({ inbox: new AppInbox(state.storage, () => 1000), sessionHash: 'fresh-owner-session', admitted: () => {} });
    expect(await reloaded.control.control(intent(reloaded.control, 'resume', 'resume_queued_B'))).toMatchObject({ state: 'recorded' });
    const fresh = f.inbox.records().find(row => row.clientId.startsWith('work_'))!;
    expect(fresh).toMatchObject({ state: 'admitted', text: 'UNIQUE QUEUED REQUEST B', sessionHash: 'fresh-owner-session',
      conversationRef: envelope.conversationRef, contextRefs: envelope.contextRefs, attachmentRefs: envelope.attachmentRefs, contextSnapshots: envelope.contextSnapshots, voice: envelope.voice });
    expect(fresh.snapshotDigest).toBe(accepted.record.snapshotDigest); expect(fresh.id).not.toBe(accepted.record.id);
    reloaded.execution.flushAdmissions();
    expect(f.inbox.records().find(row => row.id === accepted.record.id)).toMatchObject({ text: '', attachmentRefs: [], contextSnapshots: [] });
    expect(f.inbox.records().find(row => row.id === accepted.record.id)?.workPause).toBeUndefined();
    expect(f.inbox.records().find(row => row.id === fresh.id)?.text).toBe('UNIQUE QUEUED REQUEST B');
    expect(() => reloaded.execution.flushAdmissions()).not.toThrow();
    const custody = JSON.stringify([...state.storage.kv.list({ prefix: `owner:work-execution.v1:${f.principalRef}:` })]);
    expect(custody).not.toContain('UNIQUE QUEUED REQUEST B'); expect(custody).not.toContain('Exact owner reviewed voice B');
  }));
  for (const failurePoint of ['admission', 'pending'] as const) it(`fences a failed ${failurePoint} publication across reconciliation and a second resume without orphan execution`, async () => journey(`work-execution-orphan-${failurePoint}`, async state => {
    const f = await fixture(state); let fail = false;
    const guard = async () => {
      await f.options.assertCurrent();
      if (fail && (failurePoint === 'admission' ? f.inbox.records().some(row => row.workContinuation) : [...state.storage.kv.list({ prefix: `owner:work-execution.v1:${f.principalRef}:pending:` })].length > 0)) throw new ClosedRunError();
    };
    const own = f.make(); await own.control.control(f.intent(own.control, 'pause', `pause_before_failed_${failurePoint}`));
    fail = true;
    expect(await own.control.control(f.intent(own.control, 'resume', `failed_resume_${failurePoint}`), guard)).toMatchObject({ state: 'unconfirmed' });
    const orphan = f.inbox.records().find(row => row.workContinuation)!;
    expect(orphan).toMatchObject({ state: 'admitted', workContinuation: { owner_ref: f.principalRef, work_ref: f.workRef, predecessor_run_id: f.original.id } });
    expect(ownerAppWorkContinuationPending(state.storage, orphan)).toBe(true);
    expect(() => assertOwnerAppWorkRunnable(state.storage, orphan)).toThrow(ClosedRunError);
    // Even a caller that claims directly cannot clear or run an admission while
    // its exact resume publication is pending; custody remains available.
    expect(f.inbox.claim(orphan.id, true)).toBeNull(); expect(f.inbox.records().find(row => row.id === orphan.id)?.text).toBe(orphan.text);
    expect(own.execution.checkpoint(f.workRef)?.run_id).toBe(f.original.id);
    fail = false; expect(await own.control.control(f.intent(own.control, 'reconcile', `reconcile_failed_${failurePoint}`))).toMatchObject({ state: 'recorded' });
    expect(await own.control.control(f.intent(own.control, 'resume', `winning_resume_${failurePoint}`))).toMatchObject({ state: 'recorded' });
    const fresh = f.inbox.records().find(row => row.workContinuation && row.id !== orphan.id)!;
    expect(fresh.state).toBe('admitted'); expect(() => assertOwnerAppWorkRunnable(state.storage, fresh)).not.toThrow();
    expect(() => assertOwnerAppWorkRunnable(state.storage, orphan)).toThrow(ClosedRunError);
    expect(f.inbox.records().find(row => row.id === orphan.id)).toMatchObject({ state: 'interrupted', text: '', attachmentRefs: [], contextSnapshots: [] });
    expect(f.inbox.claim(orphan.id, true)).toBeNull(); expect(own.execution.workRefForRun(orphan.id)).toBe(f.workRef);
    const running = f.inbox.claim(fresh.id, true)!; const scope = f.inbox.scope(running, new AbortController().signal);
    expect(() => scope.admit()).not.toThrow();
    const holdKey = `owner:work-control.v1:${f.workRef}`, hold = state.storage.kv.get<any>(holdKey);
    state.storage.kv.put(holdKey, { ...hold, mode: 'resume_pending' }); expect(() => scope.admit()).toThrow(ClosedRunError);
    state.storage.kv.put(holdKey, hold); expect(() => scope.admit()).not.toThrow();
  }));
  for (const invalidation of ['session', 'conversation'] as const) it(`clears a pending continuation when its ${invalidation} authority is revoked`, async () => journey(`work-execution-pending-${invalidation}-revoked`, async state => {
    const f = await fixture(state), own = f.make();
    await own.control.control(f.intent(own.control, 'pause', `pause_before_pending_${invalidation}`));
    const guard = async () => { if (f.inbox.records().some(row => row.workContinuation)) throw new ClosedRunError(); };
    expect(await own.control.control(f.intent(own.control, 'resume', `pending_before_${invalidation}_revoked`), guard)).toMatchObject({ state: 'unconfirmed' });
    const pending = f.inbox.records().find(row => row.workContinuation)!;
    expect(ownerAppWorkContinuationPending(state.storage, pending)).toBe(true);
    expect(f.inbox.claim(pending.id, invalidation !== 'session', invalidation !== 'conversation')).toBeNull();
    expect(f.inbox.records().find(row => row.id === pending.id)).toMatchObject({ state: invalidation === 'session' ? 'revoked' : 'interrupted', text: '', attachmentRefs: [], contextSnapshots: [] });
    expect(() => assertOwnerAppWorkRunnable(state.storage, pending)).toThrow(ClosedRunError); expect(f.scheduled).toBe(0);
  }));
  it('anchors a running request to its exact witnessed owner input even when a newer sibling is the conversation leaf', async () => journey('work-execution-exact-history-input', async state => {
    const f = await fixture(state), store = canonicalOwnerConversationStore(state.storage, f.context);
    const sibling: ConversationEntry = { id: f.other.id, ownerId: f.principalRef, chatId: f.original.conversationRef!, parentId: f.original.id,
      threadAnchorId: null, surface: 'app', role: 'user', inputOrigin: 'owner', modelPayload: 'Later unrelated request C', appPayload: 'Later unrelated request C', modelProjection: { mode: 'include' } };
    await store.save([sibling], sibling.id, f.otherScope);
    const own = f.make(), checkpoint = own.execution.checkpoint(f.workRef)!;
    expect(checkpoint.checkpoint_ref.endsWith(`:${f.original.id}`)).toBe(true); expect(checkpoint.checkpoint_ref.endsWith(`:${f.other.id}`)).toBe(false);
    await own.control.control(f.intent(own.control, 'pause', 'pause_exact_owner_witness'));
    await own.control.control(f.intent(own.control, 'resume', 'resume_exact_owner_witness'));
    const fresh = f.inbox.records().find(row => row.clientId.startsWith('work_'))!;
    expect(fresh.text).toContain(`owner-input checkpoint ${f.original.id}`); expect(fresh.text).not.toContain('Later unrelated request C');
  }));
  it('rejects changed retained envelope and revoked session, and clears retained pause custody on stop or deletion', async () => journey('work-execution-envelope-invalidations', async state => {
    const f = await fixture(state), own = f.make();
    await own.control.control(f.intent(own.control, 'pause', 'pause_before_envelope_change'));
    const key = `app:inbox-record:${f.original.id}`, retained = state.storage.kv.get<any>(key)!;
    state.storage.kv.put(key, { ...retained, text: 'Changed pending request' });
    await expect(own.control.control(f.intent(own.control, 'resume', 'reject_changed_envelope'))).rejects.toThrow(ClosedRunError);
    expect(f.scheduled).toBe(0); state.storage.kv.put(key, retained);
    expect(await own.control.control(f.intent(own.control, 'stop', 'stop_retained_envelope'))).toMatchObject({ state: 'recorded' });
    expect(f.inbox.records().find(row => row.id === f.original.id)).toMatchObject({ state: 'interrupted', text: '', attachmentRefs: [], contextSnapshots: [] });
    expect(f.inbox.records().find(row => row.id === f.original.id)?.workPause).toBeUndefined(); expect(own.control.read(f.workRef).allowed).not.toContain('resume');
    f.inbox.eraseConversation(f.original.conversationRef!); expect(own.execution.checkpoint(f.workRef)).toBeNull();
    const signedOut = f.intent(own.control, 'resume', 'reject_signed_out_resume'); f.revoke(); await expect(own.control.control(signedOut)).rejects.toThrow(ClosedRunError);
  }));
  it('retains reference-only custody across eviction and resumes with a fresh authenticated session and run after control publication', async () => journey('work-execution-real-resume', async state => {
    const f = await fixture(state), first = f.make();
    await first.control.control(f.intent(first.control, 'pause', 'pause_before_eviction'));
    const reconstructed = f.make({ inbox: new AppInbox(state.storage, () => 1000), sessionHash: 'replacement-app-session' });
    expect(reconstructed.control.read(f.workRef)).toMatchObject({ state: 'paused', allowed: ['resume', 'stop', 'reconcile'] });
    const resumed = await reconstructed.control.control(f.intent(reconstructed.control, 'resume', 'resume_after_eviction'));
    expect(resumed).toMatchObject({ state: 'recorded', cancellation: 'not_requested' });
    expect(f.scheduled).toBe(0); // The new inbox row must not drain before hold publication.
    // Atomic transfer is complete before flush/drain: a crash here keeps no predecessor bytes.
    expect(f.inbox.records().find(row => row.id === f.original.id)?.text).toBe('');
    expect(f.inbox.records().find(row => row.id === f.original.id)?.workPause).toBeUndefined();
    reconstructed.execution.flushAdmissions(); expect(f.scheduled).toBe(1);
    expect(f.inbox.records().find(row => row.id === f.original.id)).toMatchObject({ text: '', contextSnapshots: [] });
    expect(f.inbox.records().find(row => row.id === f.original.id)?.workPause).toBeUndefined();
    const fresh = f.inbox.records().find(row => row.id === f.scheduledRuns[0])!;
    expect(fresh).toMatchObject({ state: 'admitted', sessionHash: 'replacement-app-session', conversationRef: f.original.conversationRef });
    expect(fresh.id).not.toBe(f.original.id); expect(fresh.text).not.toContain('Research my private project');
    expect(reconstructed.execution.workRefForRun(fresh.id)).toBe(f.workRef);
    expect(() => reconstructed.control.assertRunnable(f.workRef, f.original.id)).toThrow(ClosedRunError);
    expect(() => reconstructed.control.assertRunnable(f.workRef, fresh.id)).not.toThrow();
    const custody = JSON.stringify([...state.storage.kv.list({ prefix: `owner:work-execution.v1:${f.principalRef}:` })]);
    expect(custody).not.toContain('Research my private project'); expect(custody).not.toContain('old-owner-session');
    reconstructed.execution.flushAdmissions(); expect(f.scheduled).toBe(1);
  }));
  it('holds unknown effects through pause and uses independent readback before any new admission, without dispatching again', async () => journey('work-execution-unknown-readback', async state => {
    const f = await fixture(state); let writes = 0;
    const effect = { operationId: 'origin-physical-effect', owner_ref: f.principalRef, tool: 'fixture_provider_write', payload: { exact: 'reviewed' } };
    await expect(f.effects.execute(effect, { dispatch: async () => { writes++; throw Error('ACK lost'); }, reconcile: async () => ({ status: 'unknown' }) })).rejects.toThrow('outcome unknown');
    expect(f.effects.get(effect.operationId)?.origin_run_ref).toBe(f.original.id);
    const { control } = f.make(); await control.control(f.intent(control, 'pause', 'pause_unknown_provider'));
    expect(control.read(f.workRef)).toMatchObject({ state: 'paused', unresolved_effects: 1 }); expect(control.read(f.workRef).allowed).not.toContain('resume');
    f.setProvider({ status: 'done', receipt: { provider_id: 'real-provider-readback-id', result: { exact: 'reviewed' } } });
    const checked = await control.control(f.intent(control, 'reconcile', 'readback_unknown_provider'));
    expect(checked.external_effects).toBe('verified'); expect(f.effects.get(effect.operationId)?.state).toBe('done');
    expect(control.read(f.workRef).allowed).toContain('resume');
    await control.control(f.intent(control, 'resume', 'resume_after_readback')); expect(writes).toBe(1); expect(f.providerReads).toBe(2);
  }));
  it('rejects foreign inbox/history custody, erased input and source revocation instead of advertising a usable checkpoint', async () => journey('work-execution-current-owner', async state => {
    const f = await fixture(state), own = f.make();
    expect(f.make({ ownerName: 'another-owner-do' }).execution.checkpoint(f.workRef)).toBeNull();
    expect(f.make({ principalRef: 'prn_anotherowner' }).execution.checkpoint(f.workRef)).toBeNull();
    expect(own.execution.checkpoint('run:bg:audit-running')).toBeNull();
    await own.control.control(f.intent(own.control, 'pause', 'pause_current_source'));
    const queued = f.intent(own.control, 'resume', 'stale_source_resume'); f.changeSource();
    expect(own.control.read(f.workRef).state).toBe('unavailable'); await expect(own.control.control(queued)).rejects.toThrow(); expect(f.scheduled).toBe(0);
    f.inbox.eraseConversation(f.original.conversationRef!); expect(own.execution.checkpoint(f.workRef)).toBeNull();
  }));
  it('never publishes a recovery receipt if the owner source closes while provider readback is awaited', async () => journey('work-effect-readback-fence', async state => {
    const f = await fixture(state), intent = { operationId: 'readback-fence-effect', owner_ref: f.principalRef, tool: 'fixture_effect', payload: {} };
    f.effects.reserve(intent);
    await expect(f.effects.reconcile(intent.operationId, { assertCurrent: f.options.assertCurrent, readback: async () => { f.revoke(); return { status: 'done', receipt: { provider_id: 'late-provider', result: {} } }; } })).rejects.toThrow(ClosedRunError);
    expect(f.effects.get(intent.operationId)).toMatchObject({ state: 'reserved', origin_run_ref: f.original.id });
    expect(f.effects.get(intent.operationId)?.receipt).toBeUndefined();
  }));
  it('binds frozen approval origin to the admitted run and keeps that origin through a decision from another session', async () => journey('work-approval-origin', async state => {
    const f = await fixture(state); let current = f.original.id;
    const ledger = ownerEffectLedger(state.storage, () => 1000, () => current);
    const desk = approvalDesk(state.storage.sql, { owner: 1, effectOwnerRef: f.principalRef, effects: ledger, currentRunRef: () => current,
      google: async () => null, call: async () => ({}), newId: () => 'origin', now: () => 1000, timezone: 'UTC', log: () => {}, sendMessage: async () => ({ provider_id: 'local-native-delivery-receipt' }) });
    const id = await desk.proposeSendMessage({ channel: 'app', content: 'Exact frozen words', idempotency_key: 'origin-proposal' });
    const frozen = state.storage.sql.exec<{origin_run_ref:string;payload_json:string}>('SELECT origin_run_ref,payload_json FROM ledger WHERE id = ?', id).one();
    expect(frozen.origin_run_ref).toBe(f.original.id); expect(frozen.payload_json).not.toContain('origin_run_ref');
    current = 'new-native-decision-scope'; await desk.decide(id, 'a', 'fresh-session', f.options.assertCurrent);
    expect(ledger.get(`approval:${id}:apply`)).toMatchObject({ state: 'done', origin_run_ref: f.original.id });
  }));
});

it('shows full frozen native browser/MCP review and hides credential-bearing proposals from approval', async () => journey('work-native-browser-mcp-review', async state => {
  let sequence = 0; const cards: string[] = [];
  const effects = ownerEffectLedger(state.storage, () => 1000);
  const desk = approvalDesk(state.storage.sql, { owner: 1, effectOwnerRef: 'canonical-owner', effects, google: async () => null,
    call: async (_method, body) => { cards.push(JSON.stringify(body)); return {}; }, newId: () => String(++sequence), now: () => 1000, timezone: 'UTC', log: () => {} });
  const browser = await desk.proposeBrowserSubmit({ url: 'https://booking.example/confirm', action: { selector: '#confirm', description: 'Book exactly this dinner', arguments: ['approved'] },
    binding: { account: 'owner@example.test', total: '50', audience: 'dinner restaurant' }, steps: ['Review dinner'], request: { url: 'https://booking.example/submit', method: 'POST', fields: ['time', 'people'] }, approvalExpiresAt: 2000 });
  const mcp = await desk.proposeMcpCall({ server: 'owner-workspace', tool: 'create_issue', args: { audience: ['owner@example.test'], body: 'Exactly reviewed content' } });
  const unsafe = await desk.proposeMcpCall({ server: 'owner-workspace', tool: 'authenticated_call', args: { headers: { Authorization: 'Bearer private-secret-value' } } });
  const unsafeBrowser = await desk.proposeBrowserSubmit({ url: 'https://booking.example/confirm', action: { selector: '#submit', description: 'Private credentials' }, binding: { password: 'browser-private-secret' }, steps: [] });
  const reviews = await desk.workApprovals(1000);
  expect(reviews.find(item => item.id === browser)).toMatchObject({ review: { kind: 'browser_submit', url: 'https://booking.example/confirm', binding: { total: '50' }, expires_at: 2000 }, actions: ['approve', 'deny', 'edit'] });
  expect(reviews.find(item => item.id === mcp)).toMatchObject({ review: { kind: 'mcp_call', server: 'owner-workspace', tool: 'create_issue', args: { body: 'Exactly reviewed content' }, expires_at: 43_201_000 }, actions: ['approve', 'deny', 'edit'] });
  expect(reviews.find(item => item.id === unsafe)).toMatchObject({ review: null, actions: [] }); expect(JSON.stringify(reviews)).not.toContain('private-secret-value');
  expect(reviews.find(item => item.id === unsafeBrowser)).toMatchObject({ review: null, actions: [] });
  expect(JSON.stringify(reviews)).not.toContain('browser-private-secret'); expect(cards.join('')).not.toContain('private-secret-value'); expect(cards.join('')).not.toContain('browser-private-secret');
  expect((await desk.decide(unsafeBrowser, 'a', 'forged-unsafe-button')).toast).toBe('Already handled.');
  expect((await desk.workApprovals(2001)).find(item => item.id === browser)?.actions).toEqual([]);
}));
it('native Work readback settles a sent email from actual Message-ID evidence without calling its send adapter again', async () => journey('work-native-email-readback', async state => {
  let writes = 0, found = false;
  const effects = ownerEffectLedger(state.storage, () => 1000);
  const messageId = '<native-review@waldo>', raw = 'Exact approved MIME';
  const client = { account: { connection_id: 'account-id', email: 'owner@example.test' }, sendRaw: async () => { writes++; throw Error('ACK lost'); },
    findSentByMessageId: async () => found ? { message_id: 'provider-readback-id', thread_id: 'thread', rfc822_message_id: messageId, label_ids: ['SENT'] } : false } as unknown as import('../src/connectors/google').GoogleClient;
  const desk = approvalDesk(state.storage.sql, { owner: 1, effects, effectOwnerRef: 'canonical-owner', google: async () => client, call: async () => ({}), newId: () => 'mail', now: () => 1000, timezone: 'UTC', log: () => {} });
  const id = await desk.proposeSendEmail({ account: 'owner@example.test', to: ['recipient@example.test'], subject: 'Exact subject', body: 'Exact body', raw, digest: await (await import('../src/connectors/google')).sha256Hex(raw), message_id: messageId });
  expect((await desk.decide(id, 'a', 'fixture')).toast).toBe('Outcome unknown'); found = true;
  const record = effects.get(`approval:${id}:apply`)!;
  expect(await desk.reconcileEffect(record, async () => {})).toMatchObject({ status: 'done', receipt: { provider_id: 'provider-readback-id' } });
  expect(writes).toBe(1); expect(effects.get(record.operationId)?.state).toBe('done');
  expect(state.storage.sql.exec<{status:string}>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('done');
}));
