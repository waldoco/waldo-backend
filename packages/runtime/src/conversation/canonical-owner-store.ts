import type { ConversationEntry } from '@waldo/contracts';
import type { ConversationStore } from '../channels/conversation-store';
import type { RunEffectScope } from '../channels/run-effect-scope';
import type { OwnerContextCapability } from '../context-composer/owner-turn';
import { stableJson } from '../context-composer/canonical';

export type CanonicalHistoryStorage = Pick<DurableObjectStorage, 'get' | 'list' | 'put'> & {
  kv?: Pick<DurableObjectStorage['kv'], 'get' | 'put'>;
};
type Witness = Readonly<{ lineage: 'canonical_v1'; principal_ref: string; tenant_ref: string; entry: ConversationEntry }>;

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
    async save(rawEntries, leafId, scope) {
      await context.assertCurrent();
      const checked = rawEntries.map(validate);
      if (new Set(checked.map(entry => entry.id)).size !== checked.length) throw new Error('canonical history duplicate input');
      const entries: ConversationEntry[] = [];
      for (const entry of checked) {
        const existing = await storage.get<Witness>(witnessKey(entry.id));
        if (existing && stableJson(existing.entry) !== stableJson(entry)) throw new Error('canonical history input conflict');
        if (!existing) entries.push(entry);
      }
      const receipts = entries.map(witness);
      if (!checked.some(entry => entry.id === leafId) && !(await storage.get<Witness>(witnessKey(leafId)))) throw new Error('canonical history leaf mismatch');
      await context.assertCurrent();
      const commit = (count: number) => {
        const writes: Record<string, unknown> = { [`${prefix}count`]: count + entries.length, [`${prefix}leaf`]: leafId };
        entries.forEach((entry, index) => {
          writes[`${prefix}conv:${String(count + index).padStart(10, '0')}`] = entry;
          writes[witnessKey(entry.id)] = receipts[index];
        });
        return writes;
      };
      if (scope) {
        if (!storage.kv) throw new Error('fenced canonical history unavailable');
        scope.commit(() => {
          const count = storage.kv!.get<number>(`${prefix}count`) ?? 0;
          for (const [key, value] of Object.entries(commit(count))) storage.kv!.put(key, value);
        });
      } else await storage.put(commit((await storage.get<number>(`${prefix}count`)) ?? 0));
    },
    persistOwnerInput: async (entry, scope) => { await store.save([entry], entry.id, scope); },
  };
  return store;
}
