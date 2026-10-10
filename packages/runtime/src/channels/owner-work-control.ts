import type { AppWorkControlV1, AppWorkIntentV1 } from '../../../contracts/src/app/work';
import type { AppWorkAppliedControl } from './app-work';
import { ClosedRunError } from './run-effect-scope';
import { stableJson } from '../context-composer/canonical';

export type OwnerWorkCheckpoint = Readonly<{
  work_ref: string; revision: number; run_id: string; conversation_ref: string;
  checkpoint_ref: string; source_revision: number;
  state: 'queued' | 'running' | 'completed' | 'interrupted' | 'revoked';
  effect_refs: readonly string[]; resumable: boolean;
}>;
export type OwnerWorkReadback = Readonly<{
  fenced: boolean; unresolved_effect_refs: readonly string[]; evidence_refs: readonly string[];
}>;
export type OwnerWorkControlHost = Readonly<{
  storage: Pick<DurableObjectStorage, 'kv'>;
  now(): number; sourceRevision(): number; assertCurrent(): Promise<void>;
  commit<T>(change: () => T): T;
  checkpoint(workRef: string): OwnerWorkCheckpoint | null;
  // This must inspect the canonical aggregate/lease, owner and source witnesses.
  // A cached UI/run row cannot satisfy this check.
  assertCheckpoint(checkpoint: OwnerWorkCheckpoint): Promise<void>;
  // Runs inside commit, closes the matched physical scope and signals its turn
  // control. It must never abort a different task merely because it is active.
  fenceRun(runId: string, action: 'pause' | 'stop'): void;
  // Cancel is the existing common execution cancellation path, not rollback.
  cancel(checkpoint: OwnerWorkCheckpoint, operationId: string, assertCurrent: () => Promise<void>): Promise<OwnerWorkReadback>;
  // Read provider/common-ledger evidence only. No dispatch or retry is allowed.
  reconcile(checkpoint: OwnerWorkCheckpoint, assertCurrent: () => Promise<void>): Promise<OwnerWorkReadback>;
  // Reserves a new owner inbox admission with fresh owner/source/session fences.
  // Its drain starts after this call settles and assertRunnable admits that run.
  admitContinuation(checkpoint: OwnerWorkCheckpoint, operationId: string, assertCurrent: () => Promise<void>): Promise<Readonly<{ admitted: true; run_id: string; evidence_refs: readonly string[] }>>;
  // Synchronous final-publication hook inside the same control transaction.
  // Transfers existing request custody; never admits or dispatches execution.
  publishedContinuation?(workRef: string, newRunId: string, predecessor: OwnerWorkCheckpoint): void;
}>;
type Hold = {
  mode: 'pause_pending' | 'paused' | 'stop_pending' | 'stopped' | 'resume_pending' | 'active';
  generation: number; checkpoint: OwnerWorkCheckpoint; current_run: string;
  unresolved_effect_refs: readonly string[]; evidence_refs: readonly string[];
};
type Operation = { fingerprint: string; result: AppWorkAppliedControl };
const unavailable: AppWorkControlV1 = { state: 'unavailable', revision: 0, allowed: [], unresolved_effects: 0 };
const unknown = (revision: number): AppWorkAppliedControl => ({ state: 'unconfirmed', revision, cancellation: 'unconfirmed', external_effects: 'unresolved', message: 'Execution control is pending reconciliation. This request will not dispatch again.', evidence_refs: [] });

// The owning scheduler consults this control record before provider/tool I/O. It
// contains continuation custody and fences only; canonical tasks, approvals,
// effect outcomes and conversation history stay in their existing books.
export function ownerWorkControl(host: OwnerWorkControlHost) {
  const holdKey = (ref: string) => `owner:work-control.v1:${ref}`;
  const operationKey = (id: string) => `owner:work-control.operation.v1:${id}`;
  const hold = (ref: string) => host.storage.kv.get<Hold>(holdKey(ref));
  const currentRevision = (checkpoint: OwnerWorkCheckpoint, row?: Hold) => checkpoint.revision + (row?.generation ?? 0);
  const read = (workRef: string): AppWorkControlV1 => {
    const checkpoint = host.checkpoint(workRef), row = hold(workRef);
    if (!checkpoint) return { ...unavailable };
    const revision = currentRevision(checkpoint, row), unresolved = row?.unresolved_effect_refs.length ?? 0;
    if (!row || row.mode === 'active') return {
      state: checkpoint.state === 'revoked' ? 'stopped' : 'active', revision,
      allowed: checkpoint.state === 'queued' || checkpoint.state === 'running' ? ['pause', 'stop', 'reconcile'] : checkpoint.state === 'interrupted' ? ['reconcile'] : [], unresolved_effects: unresolved,
    };
    if (row.mode === 'paused') return { state: 'paused', revision, allowed: checkpoint.resumable && unresolved === 0 ? ['resume', 'stop', 'reconcile'] : ['stop', 'reconcile'], unresolved_effects: unresolved };
    if (row.mode === 'stopped') return { state: 'stopped', revision, allowed: ['reconcile'], unresolved_effects: unresolved };
    // A pending cancellation has already closed local dispatch but carries no
    // claim that the remote executor or previous effects have settled.
    return { state: 'unavailable', revision, allowed: ['reconcile'], unresolved_effects: unresolved };
  };
  const result = (row: Hold, revision: number, message: string): AppWorkAppliedControl => ({
    state: 'recorded', revision, cancellation: row.mode === 'active' ? 'not_requested' : 'fenced',
    external_effects: row.unresolved_effect_refs.length ? 'unresolved' : row.checkpoint.effect_refs.length ? 'verified' : 'none_recorded', message, evidence_refs: [...row.evidence_refs],
  });
  return {
    read,
    // Root composes this local guard with the common lease/session/source guard.
    // A paused old run is closed even after process eviction; a fresh resumed
    // run cannot inherit its predecessor's authority.
    assertRunnable(workRef: string, runId: string) {
      const row = hold(workRef);
      if (row && (row.mode !== 'active' || row.current_run !== runId)) throw new ClosedRunError();
    },
    async control(intent: AppWorkIntentV1, suppliedGuard = host.assertCurrent): Promise<AppWorkAppliedControl> {
      const assertCurrent = async () => { await host.assertCurrent(); await suppliedGuard(); };
      await assertCurrent();
      const fingerprint = stableJson(intent), prior = host.storage.kv.get<Operation>(operationKey(intent.operation_id));
      if (prior) { if (prior.fingerprint !== fingerprint) throw new Error('work operation conflict'); return structuredClone(prior.result); }
      const checkpoint = host.checkpoint(intent.work_ref), before = read(intent.work_ref);
      if (!checkpoint || before.revision !== intent.expected_revision || !before.allowed.includes(intent.action) || host.sourceRevision() !== intent.expected_source_revision) throw new Error('work checkpoint changed');
      await host.assertCheckpoint(checkpoint); await assertCurrent();
      const recordedBefore = hold(intent.work_ref);
      let row: Hold = structuredClone(recordedBefore ?? { mode: 'active', generation: 0, checkpoint, current_run: checkpoint.run_id, unresolved_effect_refs: checkpoint.effect_refs, evidence_refs: [] });
      const pending = unknown(before.revision + 1);
      host.commit(() => {
        const fresh = host.checkpoint(intent.work_ref), freshControl = read(intent.work_ref);
        if (!fresh || stableJson(fresh) !== stableJson(checkpoint) || freshControl.revision !== intent.expected_revision || host.sourceRevision() !== intent.expected_source_revision || host.storage.kv.get(operationKey(intent.operation_id))) throw new Error('work checkpoint changed');
        if (intent.action === 'pause' || intent.action === 'stop') {
          row.mode = intent.action === 'pause' ? 'pause_pending' : 'stop_pending';
          row.checkpoint = checkpoint; row.current_run = checkpoint.run_id;
          row.unresolved_effect_refs = [...checkpoint.effect_refs];
          host.fenceRun(checkpoint.run_id, intent.action);
        } else if (intent.action === 'resume') row.mode = 'resume_pending';
        row.generation++;
        host.storage.kv.put(holdKey(intent.work_ref), row);
        host.storage.kv.put(operationKey(intent.operation_id), { fingerprint, result: pending } satisfies Operation);
      });
      try {
        let applied: AppWorkAppliedControl;
        if (intent.action === 'pause' || intent.action === 'stop') {
          const readback = await host.cancel(checkpoint, intent.operation_id, assertCurrent); await assertCurrent();
          if (!readback.fenced) return pending;
          row.mode = intent.action === 'pause' ? 'paused' : 'stopped'; row.unresolved_effect_refs = [...readback.unresolved_effect_refs]; row.evidence_refs = [...readback.evidence_refs];
          applied = result(row, currentRevision(host.checkpoint(intent.work_ref) ?? checkpoint, row), intent.action === 'pause'
            ? 'Current execution was fenced and its continuation checkpoint retained. Earlier external effects retain their own receipts.'
            : 'Current execution was fenced. Earlier external effects were not rolled back.');
        } else if (intent.action === 'resume') {
          // Even a previously settled pause is read back immediately before a
          // new admission; revoked sources or newly discovered uncertainty hold it.
          const readback = await host.reconcile(row.checkpoint, assertCurrent); await assertCurrent();
          if (!readback.fenced || readback.unresolved_effect_refs.length) {
            row.mode = 'paused'; row.unresolved_effect_refs = [...readback.unresolved_effect_refs]; row.evidence_refs = [...readback.evidence_refs];
            applied = { ...result(row, currentRevision(checkpoint, row), 'Resume was rejected until the earlier execution and effects are reconciled.'), state: 'rejected' };
          } else {
            const admitted = await host.admitContinuation(row.checkpoint, intent.operation_id, assertCurrent); await assertCurrent();
            if (!admitted.admitted || !admitted.run_id || admitted.run_id === row.checkpoint.run_id) return pending;
            row.mode = 'active'; row.current_run = admitted.run_id; row.unresolved_effect_refs = []; row.evidence_refs = [...readback.evidence_refs, ...admitted.evidence_refs];
            applied = result(row, currentRevision(checkpoint, row), 'A fresh owner continuation was admitted. Completion and external effects remain separate.');
          }
        } else {
          const readback = await host.reconcile(row.checkpoint, assertCurrent); await assertCurrent();
          row.unresolved_effect_refs = [...readback.unresolved_effect_refs]; row.evidence_refs = [...readback.evidence_refs];
          if (!readback.fenced && row.mode !== 'active' || readback.unresolved_effect_refs.length) applied = { ...pending, evidence_refs: [...readback.evidence_refs] };
          else {
            if (row.mode === 'pause_pending' || row.mode === 'resume_pending') row.mode = 'paused';
            if (row.mode === 'stop_pending') row.mode = 'stopped';
            applied = result(row, currentRevision(checkpoint, row), 'Existing execution and effect evidence was read back. No effect was retried.');
          }
        }
        await assertCurrent();
        host.commit(() => {
          const current = hold(intent.work_ref);
          if (!current || current.generation !== row.generation) throw new Error('work control superseded');
          host.storage.kv.put(holdKey(intent.work_ref), row);
          host.storage.kv.put(operationKey(intent.operation_id), { fingerprint, result: applied } satisfies Operation);
          if (intent.action === 'resume' && row.mode === 'active') host.publishedContinuation?.(intent.work_ref, row.current_run, row.checkpoint);
        });
        return applied;
      } catch { return pending; }
    },
  };
}
