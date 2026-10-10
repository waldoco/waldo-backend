import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { appWork, type AppWorkHost } from '../src/channels/app-work';
import { ownerWorkControl, type OwnerWorkCheckpoint } from '../src/channels/owner-work-control';
import { responsibilityBook } from '../src/channels/responsibilities';
import { ClosedRunError } from '../src/channels/run-effect-scope';
import { taskSourceFetch } from '../src/tools/task-source-io';
import { googleHandlers } from '../src/tools/live/google';
import { ownerAppWorkHost } from '../src/channels/owner-app-work-host';
import { runBook } from '../src/channels/background-runs';
import { approvalDesk } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { appDeliveryJournal } from '../src/channels/app-delivery';

const accountRef = `acct_${'a'.repeat(64)}`;
const journey = async (name: string, run: (state: DurableObjectState) => Promise<void>) => runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => run(state));
const fixture = (state: DurableObjectState, count = 1) => {
  let now = 1_000, sequence = 0, source = 1, revoked = false, mismatch = false, cancelled = 0, continued = 0, unresolved: string[] = [];
  const assertCurrent = async () => { if (revoked) throw new ClosedRunError(); };
  const book = responsibilityBook(state.storage.sql, { newId: () => String(++sequence), now: () => now });
  for (let n = 0; n < count; n++) book.track({ title: `Actual task ${n}`, intent: `Goal ${n}`, items: [], next_check_at: null }, `owner-turn-${n}`);
  const checkpoints = new Map<string, OwnerWorkCheckpoint>(book.all().map(row => [`responsibility:${row.id}`, { work_ref: `responsibility:${row.id}`, revision: row.revision, run_id: `initial-${row.id}`, conversation_ref: 'owner:conversation', checkpoint_ref: `checkpoint:${row.id}`, source_revision: source, state: 'running', effect_refs: [], resumable: true }]));
  const fenced = new Set<string>();
  const controls = ownerWorkControl({ storage: state.storage, now: () => now, sourceRevision: () => source, assertCurrent,
    commit: work => state.storage.transactionSync(work), checkpoint: ref => checkpoints.get(ref) ?? null,
    assertCheckpoint: async checkpoint => { await assertCurrent(); if (checkpoints.get(checkpoint.work_ref)?.checkpoint_ref !== checkpoint.checkpoint_ref || checkpoint.source_revision !== source) throw new ClosedRunError(); },
    fenceRun: id => { fenced.add(id); }, cancel: async (_checkpoint, _operation, guard) => { await guard(); cancelled++; return { fenced: true, unresolved_effect_refs: unresolved, evidence_refs: ['actual-cancellation-readback'] }; },
    reconcile: async (_checkpoint, guard) => { await guard(); return { fenced: true, unresolved_effect_refs: unresolved, evidence_refs: ['actual-readback'] }; },
    admitContinuation: async (_checkpoint, _operation, guard) => { await guard(); continued++; return { admitted: true, run_id: `fresh-${continued}`, evidence_refs: [`fresh-admission-${continued}`] }; },
  });
  const host: AppWorkHost = { accountRef, principalRef: 'canonical-owner', sessionRef: 'new-app-session', storage: state.storage,
    commit: work => state.storage.transactionSync(work), now: () => now, assertCurrent, sourceRevision: () => source, responsibilities: book,
    canonicalWorkUnits: async () => [{ id: 'canonical-unit', ownerId: mismatch ? 'another-owner' : 'canonical-owner', outcomeId: 'canonical-outcome', revision: 2, responsibility: 'Actual canonical work', state: 'open', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' }],
    runs: async () => [{ id: 'background-audit', kind: 'delegate_task', status: 'failed', summary: 'Worker unavailable', parent_id: null, started: '2026-10-10T00:00:00Z', ended: '2026-10-10T00:01:00Z' }],
    effects: () => [], approvals: async () => [], files: async () => [], controls: controls.read, control: controls.control,
    decide: async () => { throw Error('no proposal'); }, browser: { state: async () => undefined, open: async () => { throw Error('no handoff'); }, resume: async () => { throw Error('no handoff'); }, revoke: async () => { throw Error('no handoff'); } },
  };
  return { host, book, controls, checkpoints, fenced, get cancelled() { return cancelled; }, get continued() { return continued; }, setUnresolved: (refs: string[]) => { unresolved = refs; }, revoke: () => { revoked = true; }, changeSource: () => { source++; }, wrongOwner: (value = true) => { mismatch = value; }, expire: () => { now += 300_001; } };
};
const post = (path: string, value: unknown) => new Request(`https://waldo.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const json = async (response: Response | null) => { expect(response).not.toBeNull(); return response!.json() as Promise<any>; };
const intentFor = (projection: any, task: any, action = 'pause', operation = 'operation_pause') => ({ operation_id: operation, work_ref: task.work_ref, action, expected_revision: task.controls.revision, expected_source_revision: projection.source_revision, projection_revision: projection.revision });

describe('app-only canonical owner Work adapter', () => {
  it('uses complete owner records and real status counters; a later page remains actionable after restart', async () => journey('work-paged-owner', async state => {
    const f = fixture(state, 55), first = appWork(f.host);
    const page = await json(await first.request(new Request('https://waldo.test/app/v1/work?kind=responsibility&limit=20')));
    expect(page.tasks).toHaveLength(20); expect(page.counts).toMatchObject({ scope: 'retained_owner_records', total: 57, by_kind: { responsibility: 55, work_unit: 1, run: 1 } });
    expect(page.counts.by_status).toContainEqual({ kind: 'run', status: 'failed', count: 1 });
    const later = await json(await first.request(new Request(`https://waldo.test/app/v1/work?kind=responsibility&limit=20&cursor=${encodeURIComponent(page.next_cursor)}`)));
    const task = later.tasks[0], intent = intentFor(later, task);
    const result = await json(await appWork(f.host).request(post('/app/v1/work/operations', intent)));
    expect(result.receipt).toMatchObject({ state: 'recorded', cancellation: 'fenced', external_effects: 'none_recorded' });
    expect(f.cancelled).toBe(1); expect(f.fenced.has(f.checkpoints.get(task.work_ref)!.run_id)).toBe(true);
    const duplicate = await json(await appWork(f.host).request(post('/app/v1/work/operations', intent)));
    expect(duplicate.duplicate).toBe(true); expect(f.cancelled).toBe(1);
    expect(state.storage.kv.get<any[]>(`app:work.v1:${accountRef}:projections`)?.every(witness => !JSON.stringify(witness).includes('Actual task'))).toBe(true);
  }));
  it('permits detail controls, fences the paused run and admits a new continuation only after reconciliation', async () => journey('work-detail-resume', async state => {
    const f = fixture(state), ref = `responsibility:${f.book.all()[0]!.id}`;
    const first = await json(await appWork(f.host).request(new Request(`https://waldo.test/app/v1/work/tasks/${encodeURIComponent(ref)}`)));
    const stoppedRun = f.checkpoints.get(ref)!.run_id;
    const paused = await json(await appWork(f.host).request(post('/app/v1/work/operations', intentFor(first, first.task))));
    expect(paused.receipt.state).toBe('recorded'); expect(() => f.controls.assertRunnable(ref, stoppedRun)).toThrow(ClosedRunError);
    const second = await json(await appWork(f.host).request(new Request(`https://waldo.test/app/v1/work/tasks/${encodeURIComponent(ref)}`)));
    const resumed = await json(await appWork(f.host).request(post('/app/v1/work/operations', intentFor(second, second.task, 'resume', 'operation_resume'))));
    expect(resumed.receipt).toMatchObject({ state: 'recorded', cancellation: 'not_requested' }); expect(f.continued).toBe(1);
    expect(() => f.controls.assertRunnable(ref, 'fresh-1')).not.toThrow(); expect(() => f.controls.assertRunnable(ref, stoppedRun)).toThrow(ClosedRunError);
  }));
  it('retains unknown effects and prevents continuation while they remain unresolved', async () => journey('work-unknown-effect', async state => {
    const f = fixture(state), ref = `responsibility:${f.book.all()[0]!.id}`; f.setUnresolved(['unknown-provider-effect']);
    const projection = await appWork(f.host).projection(), task = projection.tasks.find(task => task.work_ref === ref)!;
    const paused = await json(await appWork(f.host).request(post('/app/v1/work/operations', intentFor(projection, task))));
    expect(paused.receipt).toMatchObject({ state: 'recorded', cancellation: 'fenced', external_effects: 'unresolved' });
    expect(f.controls.read(ref).allowed).not.toContain('resume'); expect(f.continued).toBe(0);
  }));
  it('rejects another owner, stale source, expired page and a projection issued to another session before operation custody', async () => journey('work-owner-source-fences', async state => {
    const f = fixture(state); f.wrongOwner(); expect((await appWork(f.host).request(new Request('https://waldo.test/app/v1/work')))!.status).toBe(503);
    f.wrongOwner(false); const g = f, projection = await appWork(g.host).projection(), task = projection.tasks.find(task => task.kind === 'responsibility')!;
    const intent = intentFor(projection, task); g.changeSource(); expect((await appWork(g.host).request(post('/app/v1/work/operations', intent)))!.status).toBe(409); expect(g.cancelled).toBe(0);
    const fresh = await appWork(g.host).projection(), currentTask = fresh.tasks.find(task => task.kind === 'responsibility')!;
    expect((await appWork({ ...g.host, sessionRef: 'other-session' }).request(post('/app/v1/work/operations', intentFor(fresh, currentTask))))!.status).toBe(409);
    g.expire(); expect((await appWork(g.host).request(post('/app/v1/work/operations', intentFor(fresh, currentTask))))!.status).toBe(409);
    expect([...state.storage.kv.list({ prefix: `app:work.v1:${accountRef}:operation:` })]).toHaveLength(0);
  }));
  it('composes native approval with the canonical desk, actual app inbox custody and the existing effect ledger', async () => journey('work-native-decision', async state => {
    const f = fixture(state), journal = appDeliveryJournal(state.storage, () => 'original-app-turn', 1), effects = ownerEffectLedger(state.storage, () => 1000);
    let sequence = 0;
    const desk = approvalDesk(state.storage.sql, { owner: 1, effectOwnerRef: 'canonical-owner', effects, google: async () => null,
      call: journal.call, newId: () => String(++sequence), now: () => 1000, timezone: 'UTC', log: () => {},
      sendMessage: async proposal => { const receipt = await journal.call('sendMessage', { chat_id: 1, text: proposal.content }) as { message_id: number }; return { provider_id: `app-inbox:${receipt.message_id}` }; } });
    const id = await desk.proposeSendMessage({ channel: 'app', content: 'Exact owner-approved words', idempotency_key: 'exact-native-send' });
    const make = () => ownerAppWorkHost({ accountRef, principalRef: 'canonical-owner', sessionRef: 'new-app-session', storage: state.storage,
      now: f.host.now, sourceRevision: f.host.sourceRevision, assertCurrent: f.host.assertCurrent,
      books: { responsibilities: f.book, runs: runBook(state.storage.sql, { timezone: 'UTC', now: () => new Date(1000) }, () => 'actual-run'), effects, desk, canonicalWorkUnits: f.host.canonicalWorkUnits, files: f.host.files },
      execution: { checkpoint: () => null, assertCheckpoint: async () => {}, fenceRun: () => {}, cancel: async () => { throw Error('unavailable'); }, reconcile: async () => { throw Error('unavailable'); }, admitContinuation: async () => { throw Error('unavailable'); } }, browser: f.host.browser });
    const projection = await make().projection(), review = projection.approvals.find(proposal => proposal.id === id)!;
    expect(review).toMatchObject({ review: { kind: 'message_send', channel: 'app', content: 'Exact owner-approved words' }, actions: ['approve', 'deny', 'edit'] });
    const intent = { operation_id: 'native_approval', approval_id: id, action: 'approve', proposal_digest: review.proposal_digest, expected_source_revision: projection.source_revision, projection_revision: projection.revision };
    const result = await json(await make().request(post('/app/v1/work/approvals', intent)));
    expect(result.receipt).toMatchObject({ state: 'recorded', external_effects: 'verified' }); expect(effects.get(`approval:${id}:apply`)).toMatchObject({ owner_ref: 'canonical-owner', state: 'done', receipt: { provider_id: 'app-inbox:2' } });
    expect(journal.messages().filter(message => message.text === 'Exact owner-approved words')).toHaveLength(1);
    expect((await json(await make().request(post('/app/v1/work/approvals', intent)))).duplicate).toBe(true); expect(journal.messages()).toHaveLength(2);
  }));
  it('authorizes a complete long native review without relying on a transport card approval button', async () => journey('work-native-long-review', async state => {
    const f = fixture(state), journal = appDeliveryJournal(state.storage, () => 'owner-native-long-turn', 1), effects = ownerEffectLedger(state.storage, () => 1000);
    let sequence = 0, dispatches = 0;
    const content = `Exact long reviewed content: ${'owner words '.repeat(400)}`;
    const desk = approvalDesk(state.storage.sql, { owner: 1, effectOwnerRef: 'canonical-owner', effects, google: async () => null,
      call: journal.call, newId: () => String(++sequence), now: () => 1000, timezone: 'UTC', log: () => {},
      sendMessage: async proposal => { expect(proposal.content).toBe(content); dispatches++; return { provider_id: 'actual-native-message-receipt' }; } });
    const id = await desk.proposeSendMessage({ channel: 'app', content, idempotency_key: 'native-long-send' });
    expect(desk.pending(1000).find(row => row.id === id)?.state).toBe('review_only');
    expect((await desk.decide(id, 'a', 'forged-transport-button')).toast).toBe('Already handled.'); expect(dispatches).toBe(0);
    const host = () => ownerAppWorkHost({ accountRef, principalRef: 'canonical-owner', sessionRef: 'native-owner-session', storage: state.storage,
      now: f.host.now, sourceRevision: f.host.sourceRevision, assertCurrent: f.host.assertCurrent,
      books: { responsibilities: f.book, runs: runBook(state.storage.sql, { timezone: 'UTC', now: () => new Date(1000) }, () => 'long-review-audit'), effects, desk, canonicalWorkUnits: f.host.canonicalWorkUnits, files: f.host.files },
      execution: { checkpoint: () => null, assertCheckpoint: async () => {}, fenceRun: () => {}, cancel: async () => { throw Error('unavailable'); }, reconcile: async () => { throw Error('unavailable'); }, admitContinuation: async () => { throw Error('unavailable'); } }, browser: f.host.browser });
    const projection = await host().projection(), review = projection.approvals.find(row => row.id === id)!;
    expect(review).toMatchObject({ state: 'review_only', review: { kind: 'message_send', content }, actions: ['approve', 'deny', 'edit'] });
    const intent = { operation_id: 'native_long_approval', approval_id: id, action: 'approve', proposal_digest: review.proposal_digest,
      expected_source_revision: projection.source_revision, projection_revision: projection.revision };
    await expect(desk.decide(id, 'a', 'bad-native-digest', async () => {}, 'f'.repeat(64))).rejects.toThrow('Native approval review changed'); expect(dispatches).toBe(0);
    expect((await json(await host().request(post('/app/v1/work/approvals', intent)))).receipt).toMatchObject({ state: 'recorded', external_effects: 'verified' });
    expect(dispatches).toBe(1); expect(effects.get(`approval:${id}:apply`)?.state).toBe('done');
  }));
  it('does not relabel audit rows as controllable execution or turn source-unavailable into completion', async () => journey('work-audit-unavailable', async state => {
    const f = fixture(state), projection = await appWork(f.host).projection();
    expect(projection.tasks.find(task => task.kind === 'run')).toMatchObject({ status: 'failed', controls: { state: 'unavailable', allowed: [] } });
    const broken = appWork({ ...f.host, canonicalWorkUnits: async () => { throw Error('canonical source unavailable'); } });
    expect((await broken.request(new Request('https://waldo.test/app/v1/work')))!.status).toBe(503);
    f.revoke(); expect((await appWork(f.host).request(new Request('https://waldo.test/app/v1/work')))!.status).toBe(503);
  }));
});

describe('Work operation currentness and generation', () => {
  it('keeps a newer reconciliation when an older cancellation settles late', async () => journey('work-control-generation', async state => {
    const base: OwnerWorkCheckpoint = { work_ref: 'responsibility:race', revision: 1, run_id: 'original-run', conversation_ref: 'owner:conversation', checkpoint_ref: 'canonical-checkpoint', source_revision: 1, state: 'running', effect_refs: [], resumable: true };
    let release!: (value: any) => void, began!: () => void; const begun = new Promise<void>(resolve => { began = resolve; });
    const controls = ownerWorkControl({ storage: state.storage, now: () => 1000, sourceRevision: () => 1, assertCurrent: async () => {}, commit: work => state.storage.transactionSync(work), checkpoint: () => base,
      assertCheckpoint: async () => {}, fenceRun: () => {}, cancel: async () => { began(); return new Promise(resolve => { release = resolve; }); }, reconcile: async () => ({ fenced: true, unresolved_effect_refs: [], evidence_refs: ['newer-reconciliation'] }), admitContinuation: async () => ({ admitted: true, run_id: 'fresh', evidence_refs: [] }) });
    const original = { operation_id: 'operation_pause', work_ref: base.work_ref, action: 'pause' as const, expected_revision: 1, expected_source_revision: 1, projection_revision: 'a'.repeat(64) };
    const pending = controls.control(original); await begun;
    const newer = await controls.control({ ...original, operation_id: 'operation_reconcile', action: 'reconcile', expected_revision: controls.read(base.work_ref).revision });
    expect(newer.state).toBe('recorded'); release({ fenced: true, unresolved_effect_refs: ['late-obsolete-effect'], evidence_refs: ['obsolete-readback'] });
    expect((await pending).state).toBe('unconfirmed'); expect(controls.read(base.work_ref)).toMatchObject({ state: 'paused', unresolved_effects: 0, allowed: ['resume', 'stop', 'reconcile'] });
  }));
  it('rechecks immediately after a fetch response and never exposes the revoked response', async () => {
    let revoked = false, calls = 0;
    const fetcher = taskSourceFetch(async () => { if (revoked) throw new ClosedRunError(); }, (async () => { calls++; revoked = true; return Response.json({ private: 'provider-data' }); }) as typeof fetch);
    await expect(fetcher('https://provider.test/source')).rejects.toThrow(ClosedRunError); expect(calls).toBe(1);
  });
  it('forwards the exact current-source guard from the calendar tool to the common approval desk', async () => {
    const seen: unknown[][] = [], guard = async () => {};
    const handler = googleHandlers({ client: async () => ({ account: { connection_id: 'connection', email: 'owner@example.test' } }) as never },
      { propose: async (...args) => { seen.push(args); return 'proposal'; }, proposeSendEmail: async () => 'email', record: () => {} }, { timezone: 'UTC', now: () => new Date('2026-10-10T00:00:00Z') }).find(handler => handler.name === 'propose_calendar_change')!;
    const result = await handler.handle(handler.schema.parse({ action: 'create', title: 'Focus', start: '2026-10-12T10:00:00Z', end: '2026-10-12T11:00:00Z', reason: 'Owner asked' }), { authenticatedUserId: 'app-only-owner', turnId: 'turn', toolCallId: 'call', assertTaskSourceCurrent: guard } as never);
    expect(result).toMatchObject({ ok: true }); expect(seen[0]![3]).toBe(guard);
  });
});
