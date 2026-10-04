import type { BrowserSubmitProposal } from './approvals';
import { readTaskSourceSnapshot, type TaskSourceSnapshot } from './task-source-scope';
const KEY = 'browser_owner_task_source_v1';
type Witness = Readonly<{ taskRef: string; proposalId: string; scopeDigest: string; ownerKey: string; snapshot: TaskSourceSnapshot }>;
// Only authenticated dispatcher code captures this witness. Approval execution
// reads current durable scope, rather than retaining a completed turn's closure.
export function browserTaskSourceCustody(sql: SqlStorage, kv: Pick<DurableObjectStorage['kv'], 'get' | 'put'>) {
  const matches = (expected: TaskSourceSnapshot, current: TaskSourceSnapshot) => current.ready && (current.sources.includes('browser') || current.sources.includes('web'))
    && current.taskId === expected.taskId && current.revision === expected.revision;
  return {
    capture(payload: BrowserSubmitProposal, ownerKey: string) {
      if (!payload.continuation) throw Error('browser task source unavailable');
      const snapshot = readTaskSourceSnapshot(sql, ownerKey);
      if (!matches(snapshot, snapshot)) throw Error('browser task source unavailable');
      kv.put(KEY, { ...payload.continuation, ownerKey, snapshot } satisfies Witness);
    },
    guard(payload: BrowserSubmitProposal): () => Promise<void> {
      const witness = kv.get<Witness>(KEY), reference = payload.continuation;
      if (!witness || !reference || witness.taskRef !== reference.taskRef || witness.proposalId !== reference.proposalId
        || witness.scopeDigest !== reference.scopeDigest) throw Error('browser task source unavailable');
      return async () => {
        if (JSON.stringify(kv.get(KEY)) !== JSON.stringify(witness)
          || !matches(witness.snapshot, readTaskSourceSnapshot(sql, witness.ownerKey))) throw Error('browser task source changed');
      };
    },
  };
}
