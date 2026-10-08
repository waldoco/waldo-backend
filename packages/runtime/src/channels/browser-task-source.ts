import type { BrowserSubmitProposal } from './approvals';
const KEY = 'browser_owner_task_source_v1';
const REVOKED = 'browser_owner_task_revoked_v1';
type Witness = Readonly<{ taskRef: string; proposalId: string; scopeDigest: string; ownerKey: string; revoked: unknown }>;
// Only authenticated dispatcher code captures this witness. Approval execution
// reads current durable scope, rather than retaining a completed turn's closure.
export function browserTaskSourceCustody(_sql: SqlStorage, kv: Pick<DurableObjectStorage['kv'], 'get' | 'put'>,
  currentOwnerKey: () => Promise<string>) {
  return {
    capture(payload: BrowserSubmitProposal, ownerKey: string) {
      if (!payload.continuation || !ownerKey) throw Error('browser task source unavailable');
      kv.put(KEY, { ...payload.continuation, ownerKey, revoked: kv.get(REVOKED) ?? null } satisfies Witness);
    },
    guard(payload: BrowserSubmitProposal): () => Promise<void> {
      const witness = kv.get<Witness>(KEY), reference = payload.continuation;
      if (!witness || !reference || witness.taskRef !== reference.taskRef || witness.proposalId !== reference.proposalId
        || witness.scopeDigest !== reference.scopeDigest) throw Error('browser task source unavailable');
      return async () => {
        if (JSON.stringify(kv.get(KEY)) !== JSON.stringify(witness)
          || await currentOwnerKey() !== witness.ownerKey || (kv.get(REVOKED) ?? null) !== witness.revoked) throw Error('browser task source changed');
      };
    },
  };
}
