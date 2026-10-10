import { retainOwnerConversationEntries } from '../channels/owner-turn-response';
import type { ConversationEntry } from '@waldo/contracts';
import type { ConversationStore } from '../channels/conversation-store';
import type { RunEffectScope } from '../channels/run-effect-scope';
import type { OwnerContextCapability } from '../context-composer/owner-turn';
import { stableJson } from '../context-composer/canonical';
import { redactSecretUrls } from '../channels/egress-guard';

export type CanonicalHistoryStorage = Pick<DurableObjectStorage, 'get' | 'list' | 'put'> & {
  kv?: Pick<DurableObjectStorage['kv'], 'get' | 'put'>;
};
type Witness = Readonly<{ lineage: 'canonical_v1'; principal_ref: string; tenant_ref: string; entry: ConversationEntry }>;
const writesInProgress = new WeakMap<object, Promise<unknown>>();
const serialize = <T>(storage: object, work: () => Promise<T>): Promise<T> => {
  const result = (writesInProgress.get(storage) ?? Promise.resolve()).catch(() => undefined).then(work);
  writesInProgress.set(storage, result);
  return result;
};
const scrub = (entry: ConversationEntry): ConversationEntry => ({ ...entry,
  modelPayload: redactSecretUrls(entry.modelPayload).text, appPayload: redactSecretUrls(entry.appPayload).text,
  modelProjection: entry.modelProjection.mode === 'replace' ? { mode: 'replace', payload: redactSecretUrls(entry.modelProjection.payload).text } : entry.modelProjection,
});

// Canonical history has independent custody. Legacy conv:* rows are neither deleted
// nor reclassified as authenticated owner input; only matching row+witness pairs load.
export function canonicalOwnerConversationStore(storage: CanonicalHistoryStorage, context: Pick<OwnerContextCapability, 'invocation' | 'assertCurrent'>): ConversationStore {
  const principal = context.invocation.verified_authority.principal_ref;
  const tenant = context.invocation.verified_authority.tenant_ref;
  const prefix = `canonical-owner-v1:${principal}:${tenant}:`;
  const witnessKey = (id: string) => `${prefix}witness:${id}`;
  const validate = (entry: ConversationEntry) => {
    if (!entry || entry.ownerId !== principal) throw new Error('canonical history owner mismatch');
    if (!entry.id || !entry.chatId || !entry.surface || typeof entry.modelPayload !== 'string' || typeof entry.appPayload !== 'string'
      || !(entry.parentId === null || typeof entry.parentId === 'string') || !(entry.threadAnchorId === null || typeof entry.threadAnchorId === 'string')
      || !entry.modelProjection || !['include', 'omit', 'replace'].includes(entry.modelProjection.mode)
      || (entry.modelProjection.mode === 'replace' && typeof entry.modelProjection.payload !== 'string')
      || !['user', 'assistant'].includes(entry.role ?? '')
      || (entry.role === 'user' && !['owner', 'machine'].includes(entry.inputOrigin ?? ''))) throw new Error('canonical history entry invalid');
    return entry;
  };
  const witness = (entry: ConversationEntry): Witness => ({ lineage: 'canonical_v1', principal_ref: principal, tenant_ref: tenant, entry });
  const matches = (receipt: Witness, entry: ConversationEntry) => receipt.lineage === 'canonical_v1' && receipt.principal_ref === principal
    && receipt.tenant_ref === tenant && stableJson(receipt.entry) === stableJson(entry);
  const store: ConversationStore = {
    async load() {
      await context.assertCurrent();
      const rows = await storage.list<ConversationEntry>({ prefix: `${prefix}conv:` });
      const entries: ConversationEntry[] = [];
      const ids = new Set<string>();
      for (const raw of rows.values()) {
        const entry = validate(raw);
        const receipt = await storage.get<Witness>(witnessKey(entry.id));
        if (!receipt || receipt.lineage !== 'canonical_v1' || receipt.principal_ref !== principal || receipt.tenant_ref !== tenant
          || stableJson(receipt.entry) !== stableJson(entry)
          || ids.has(entry.id)) throw new Error('canonical history witness mismatch');
        ids.add(entry.id); entries.push(entry);
      }
      const leafId = (await storage.get<string>(`${prefix}leaf`)) ?? null;
      if (leafId !== null && !ids.has(leafId)) throw new Error('canonical history leaf mismatch');
      await context.assertCurrent();
      return { entries, leafId };
    },
    save(rawEntries, leafId, scope, responseRetention) { return serialize(storage, async () => {
      await context.assertCurrent();
      const checked = retainOwnerConversationEntries(rawEntries, responseRetention).map(entry => scrub(validate(entry)));
      if (new Set(checked.map(entry => entry.id)).size !== checked.length) throw new Error('canonical history duplicate input');
      const entries: ConversationEntry[] = [];
      for (const entry of checked) {
        const existing = await storage.get<Witness>(witnessKey(entry.id));
        if (existing && !matches(existing, entry)) throw new Error('canonical history input conflict');
        if (!existing) entries.push(entry);
      }
      const previousLeaf = await storage.get<Witness>(witnessKey(leafId));
      if (!checked.some(entry => entry.id === leafId) && (!previousLeaf || !matches(previousLeaf, validate(previousLeaf.entry)))) throw new Error('canonical history leaf mismatch');
      await context.assertCurrent();
      const commit = (count: number, fresh: readonly ConversationEntry[]) => {
        const writes: Record<string, unknown> = { [`${prefix}count`]: count + fresh.length, [`${prefix}leaf`]: leafId };
        fresh.forEach((entry, index) => {
          writes[`${prefix}conv:${String(count + index).padStart(10, '0')}`] = entry;
          writes[witnessKey(entry.id)] = witness(entry);
        });
        return writes;
      };
      if (scope) {
        if (!storage.kv) throw new Error('fenced canonical history unavailable');
        scope.commit(() => {
          // Async authority reads can overlap another turn. Recheck exact custody inside
          // the host transaction so a concurrent retry cannot publish a second row.
          const fresh = checked.filter(entry => {
            const receipt = storage.kv!.get<Witness>(witnessKey(entry.id));
            if (receipt && !matches(receipt, entry)) throw new Error('canonical history input conflict');
            return !receipt;
          });
          if (!checked.some(entry => entry.id === leafId)) {
            const leaf = storage.kv!.get<Witness>(witnessKey(leafId));
            if (!leaf || !matches(leaf, validate(leaf.entry))) throw new Error('canonical history leaf mismatch');
          }
          const count = storage.kv!.get<number>(`${prefix}count`) ?? 0;
          for (const [key, value] of Object.entries(commit(count, fresh))) storage.kv!.put(key, value);
        });
      } else await storage.put(commit((await storage.get<number>(`${prefix}count`)) ?? 0, entries));
    }); },
    persistOwnerInput: async (entry, scope) => { await store.save([entry], entry.id, scope); },
  };
  return store;
}

// Called only within the authenticated host's current local operation transaction.
// Remove the exact conversation's witnessed custody; unrelated and legacy rows remain.
export function eraseCanonicalOwnerConversation(storage: Pick<DurableObjectStorage, 'kv'>, context: Pick<OwnerContextCapability, 'invocation'>, conversationRef: string): number {
  const { principal_ref: principal, tenant_ref: tenant } = context.invocation.verified_authority;
  const prefix = `canonical-owner-v1:${principal}:${tenant}:`;
  const rows = [...storage.kv.list<ConversationEntry>({ prefix: `${prefix}conv:` })];
  const removed: [string, ConversationEntry][] = [];
  for (const [key, entry] of rows) {
    const receipt = storage.kv.get<Witness>(`${prefix}witness:${entry.id}`);
    if (entry.ownerId !== principal || !receipt || receipt.lineage !== 'canonical_v1' || receipt.principal_ref !== principal
      || receipt.tenant_ref !== tenant || stableJson(entry) !== stableJson(receipt.entry)) throw new Error('canonical history witness mismatch');
    if (entry.chatId === conversationRef) removed.push([key, entry]);
  }
  for (const [key, entry] of removed) { storage.kv.delete(key); storage.kv.delete(`${prefix}witness:${entry.id}`); }
  const remaining = rows.filter(([, entry]) => entry.chatId !== conversationRef);
  if (removed.some(([, entry]) => entry.id === storage.kv.get<string>(`${prefix}leaf`))) {
    if (remaining.length) storage.kv.put(`${prefix}leaf`, remaining.at(-1)![1].id); else storage.kv.delete(`${prefix}leaf`);
  }
  return removed.length;
}
