import type { BrowserSubmitProposal } from './approvals';
import { readTaskSourceSnapshot, type TaskSourceSnapshot } from './task-source-scope';
const KEY = 'browser_owner_task_source_v1';
const REVOKED = 'browser_owner_task_revoked_v1';
type Witness = Readonly<{ taskRef: string; proposalId: string; scopeDigest: string; ownerKey: string; revoked: unknown; snapshot: TaskSourceSnapshot | null }>;
// Only authenticated dispatcher code captures this witness. Approval execution
// reads current durable scope, rather than retaining a completed turn's closure.
export function browserTaskSourceCustody(sql: SqlStorage, kv: Pick<DurableObjectStorage['kv'], 'get' | 'put'>,
  currentOwnerKey: () => Promise<string>) {
  const allows = (snapshot: TaskSourceSnapshot) => snapshot.ready && (snapshot.sources.includes('browser') || snapshot.sources.includes('web'));
  // A canonical task that allowed browser or web sources when the card was issued must still allow them at approval.
  // Run-owned public reads have no canonical task; they keep the owner and revoke fences only.
  const taskSnapshot = (ownerKey: string) => { const snapshot = readTaskSourceSnapshot(sql, ownerKey); return allows(snapshot) ? snapshot : null; };
  return {
    capture(payload: BrowserSubmitProposal, ownerKey: string) {
      if (!payload.continuation || !ownerKey) throw Error('browser task source unavailable');
      kv.put(KEY, { ...payload.continuation, ownerKey, revoked: kv.get(REVOKED) ?? null, snapshot: taskSnapshot(ownerKey) } satisfies Witness);
    },
    guard(payload: BrowserSubmitProposal): () => Promise<void> {
      const witness = kv.get<Witness>(KEY), reference = payload.continuation;
      if (!witness || !reference || witness.taskRef !== reference.taskRef || witness.proposalId !== reference.proposalId
        || witness.scopeDigest !== reference.scopeDigest) throw Error('browser task source unavailable');
      return async () => {
        const unchanged = () => JSON.stringify(kv.get(KEY)) === JSON.stringify(witness) && (kv.get(REVOKED) ?? null) === witness.revoked;
        if (!unchanged()) throw Error('browser task source changed');
        const ownerKey = await currentOwnerKey();
        // Re-read after the await: the witness or revoke marker may have changed while the owner was resolved.
        if (ownerKey !== witness.ownerKey || !unchanged()) throw Error('browser task source changed');
        if (witness.snapshot) {
          const current = readTaskSourceSnapshot(sql, witness.ownerKey);
          if (!allows(current) || current.taskId !== witness.snapshot.taskId || current.revision !== witness.snapshot.revision) throw Error('browser task source changed');
        }
      };
    },
  };
}
