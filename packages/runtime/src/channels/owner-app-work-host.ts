import type { AppWorkApprovalIntentV1, AppWorkFileV1 } from '../../../contracts/src/app/work';
import { appWork, type AppWorkAppliedControl, type AppWorkCanonicalUnit, type AppWorkRun, type AppWorkHost } from './app-work';
import { ownerWorkControl, type OwnerWorkControlHost } from './owner-work-control';
import { MAX_RUN_ROWS, type RunBook } from './background-runs';
import type { ResponsibilityBook } from './responsibilities';
import type { ApprovalDesk } from './approvals';
import type { OwnerEffectLedger } from './owner-effect-ledger';
import { sha256Hex } from '../connectors/google';

export type OwnerAppWorkExecution = Pick<OwnerWorkControlHost,
  'checkpoint' | 'assertCheckpoint' | 'fenceRun' | 'cancel' | 'reconcile' | 'admitContinuation' | 'publishedContinuation'> & Readonly<{ flushAdmissions?(): void }>;
export type OwnerAppWorkOptions = Readonly<{
  accountRef: string; principalRef: string; sessionRef: string;
  storage: DurableObjectStorage; now(): number; sourceRevision(): number; assertCurrent(): Promise<void>;
  books: Readonly<{
    responsibilities: Pick<ResponsibilityBook, 'all' | 'get' | 'items'>;
    runs: Pick<RunBook, 'list'>; effects: OwnerEffectLedger; desk: ApprovalDesk;
    canonicalWorkUnits(): Promise<readonly AppWorkCanonicalUnit[]>;
    inboxRuns?(): Promise<readonly AppWorkRun[]>;
    files(): Promise<readonly AppWorkFileV1[]>;
  }>;
  execution: OwnerAppWorkExecution;
  browser: AppWorkHost['browser'];
}>;
type FrozenApproval = { status: string; payload_json: string; proposal_digest: string | null };
const actionCode = { approve: 'a', deny: 's', edit: 'e', undo: 'u' } as const;
const completedStatus = { approve: 'done', deny: 'skipped', edit: 'changing', undo: 'undone' } as const;

// Composition only: canonical books own work, decisions and effects. This adapter
// never turns an audit run or a UI status into an execution checkpoint or authority.
export function ownerAppWorkHost(options: OwnerAppWorkOptions) {
  const commit = <T>(change: () => T): T => options.storage.transactionSync(change);
  const controls = ownerWorkControl({ ...options.execution, storage: options.storage,
    now: options.now, sourceRevision: options.sourceRevision, assertCurrent: options.assertCurrent, commit });
  const decide = async (intent: AppWorkApprovalIntentV1, suppliedGuard: () => Promise<void>): Promise<AppWorkAppliedControl> => {
    const current = async () => { await options.assertCurrent(); await suppliedGuard(); };
    await current();
    const frozen = options.storage.sql.exec<FrozenApproval>('SELECT status,payload_json,proposal_digest FROM ledger WHERE id = ?', intent.approval_id).toArray()[0];
    if (!frozen || await sha256Hex(frozen.payload_json) !== intent.proposal_digest) throw new Error('Approval proposal changed');
    await current();
    if (options.sourceRevision() !== intent.expected_source_revision) throw new Error('Approval source changed');
    const shown = await options.books.desk.workApprovals(options.now(), current);
    await current();
    const proposal = shown.find(row => row.id === intent.approval_id);
    if (!proposal || proposal.proposal_digest !== intent.proposal_digest || !proposal.actions.includes(intent.action)) throw new Error('Approval decision changed');
    const outcome = await options.books.desk.decide(intent.approval_id, actionCode[intent.action], `work:${intent.operation_id}`, current, intent.proposal_digest);
    await current();
    const row = options.storage.sql.exec<FrozenApproval>('SELECT status,payload_json,proposal_digest FROM ledger WHERE id = ?', intent.approval_id).toArray()[0];
    if (!row || row.payload_json !== frozen.payload_json) throw new Error('Approval changed during decision');
    const payload = JSON.parse(row.payload_json) as { operation_ref?: unknown };
    const operationRef = typeof payload.operation_ref === 'string' ? payload.operation_ref : `approval:${intent.approval_id}`;
    const effect = options.books.effects.get(`${operationRef}:${intent.action === 'undo' ? 'undo' : 'apply'}`);
    const terminal = row.status === completedStatus[intent.action];
    const rejected = ['rejected', 'stale', 'expired', 'failed'].includes(row.status);
    const physical = intent.action === 'approve' || intent.action === 'undo';
    const verified = effect?.state === 'done';
    return {
      state: rejected ? 'rejected' : terminal && (!physical || verified) ? 'recorded' : 'unconfirmed', revision: null,
      cancellation: 'not_requested', external_effects: rejected || !physical ? 'none_recorded' : verified ? 'verified' : 'unresolved',
      message: outcome.message, evidence_refs: [`approval:${intent.approval_id}`, ...(effect ? [effect.operationId] : [])],
    };
  };
  const adapter = appWork({ accountRef: options.accountRef, principalRef: options.principalRef, sessionRef: options.sessionRef,
    storage: options.storage, commit, now: options.now, assertCurrent: options.assertCurrent, sourceRevision: options.sourceRevision,
    responsibilities: options.books.responsibilities, canonicalWorkUnits: options.books.canonicalWorkUnits,
    runs: async () => {
      await options.assertCurrent();
      const retainedAudit: AppWorkRun[] = options.books.runs.list(MAX_RUN_ROWS).map(run => ({ id: run.id, kind: run.kind, status: run.status,
        summary: run.summary, parent_id: run.parent_id, started: new Date(run.started_at).toISOString(), ended: run.ended_at === null ? null : new Date(run.ended_at).toISOString() }));
      const actualInbox = options.books.inboxRuns ? await options.books.inboxRuns() : [];
      await options.assertCurrent();
      // An exact inbox ID is operational state; audit rows cannot replace it or
      // contribute a second retained-record count for the same physical run.
      const byId = new Map(retainedAudit.map(run => [run.id, run]));
      const inboxIds = new Set<string>();
      for (const run of actualInbox) {
        if (inboxIds.has(run.id)) throw new Error('Duplicate actual inbox run');
        inboxIds.add(run.id); byId.set(run.id, run);
      }
      return [...byId.values()];
    },
    effects: () => [...options.storage.kv.list<NonNullable<ReturnType<OwnerEffectLedger['get']>>>({ prefix: 'owner:effect:' })].map(([, record]) => record),
    approvals: () => options.books.desk.workApprovals(options.now(), options.assertCurrent), files: options.books.files,
    controls: controls.read, control: async (intent, guard) => { const result = await controls.control(intent, guard); options.execution.flushAdmissions?.(); return result; }, decide, browser: options.browser });
  return { ...adapter, controls };
}
