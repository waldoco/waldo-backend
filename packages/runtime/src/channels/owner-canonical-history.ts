import { redactSecretUrls } from './egress-guard';
import type { ConversationEntry } from '@waldo/contracts';
import { conversationForgetSources, conversationForgetSourcesCurrent, durableConversationStore, type ConversationStore } from './conversation-store';
import type { OwnerResponderBinding } from './owner-turn';

// A fresh labelled namespace. Legacy conv:* bytes are never read or rewritten here.
export function ownerCanonicalHistory(storage: DurableObjectStorage, admission: OwnerResponderBinding['admission'], adapter: OwnerResponderBinding['adapter']): ConversationStore {
  const { principal_ref, tenant_ref } = admission.invocation.verified_authority;
  const prefix = `canonical-owner-v1:${principal_ref}:${tenant_ref}:`;
  const mapped = {
    get: async <T>(key: string) => {
      await adapter.assertCurrent();
      const value = await storage.get<T>(prefix + key);
      await adapter.assertCurrent();
      return value;
    },
    list: async <T>(options: { prefix: string }) => new Map([...(await storage.list<T>({ prefix: prefix + options.prefix })).entries()].map(([key, value]) => [key.slice(prefix.length), value])),
    put: async (writes: Record<string, unknown>) => storage.put(Object.fromEntries(Object.entries(writes).map(([key, value]) => [prefix + key, value]))),
    kv: { put: (key: string, value: unknown) => {
      storage.kv.put(prefix + key, value);
      if (key.startsWith('conv:')) {
        const entry = value as ConversationEntry;
        storage.kv.put(prefix + 'witness:' + entry.id, { lineage: 'canonical_v1', principal_ref, tenant_ref, entry });
        storage.kv.put(prefix + 'lineage', { lineage: 'canonical_v1', principal_ref, tenant_ref });
      }
    } },
  };
  const witnessCurrent = (entry: ConversationEntry) => {
    const row = storage.kv.get<{ lineage: string; principal_ref: string; tenant_ref: string; entry: ConversationEntry }>(prefix + 'witness:' + entry.id);
    const matches = [...storage.kv.list<ConversationEntry>({ prefix: prefix + 'conv:' })].filter(([, saved]) => saved.id === entry.id);
    if (!row && !matches.length) return false;
    if (!row || matches.length !== 1 || row.lineage !== 'canonical_v1' || row.principal_ref !== principal_ref || row.tenant_ref !== tenant_ref
      || JSON.stringify(row.entry) !== JSON.stringify(matches[0]![1]) || JSON.stringify(row.entry) !== JSON.stringify(entry)) throw Error('canonical original input conflict');
    return true;
  };
  const base = durableConversationStore(mapped as Parameters<typeof durableConversationStore>[0]);
  return {
    forgetSourcesCurrent: topic => conversationForgetSourcesCurrent(storage.kv, topic, { principal_ref, tenant_ref }),
    async forgetSources(topic) {
      await adapter.assertCurrent();
      const sources = await conversationForgetSources(storage, topic, { principal_ref, tenant_ref });
      await adapter.assertCurrent();
      return sources;
    },
    async load() {
      await adapter.assertCurrent();
      const loaded = await base.load();
      const witness = await storage.get<{ lineage: 'canonical_v1'; principal_ref: string; tenant_ref: string }>(prefix + 'lineage');
      if (loaded.entries.length && !witness) throw new Error('canonical history witness missing');
      const label = witness ?? { lineage: 'canonical_v1' as const, principal_ref, tenant_ref };
      const rows = await storage.list<{ lineage: 'canonical_v1'; principal_ref: string; tenant_ref: string; entry: ConversationEntry }>({ prefix: prefix + 'witness:' });
      const entries = await adapter.readCanonicalHistory(async () => ({ ...label, entries: loaded.entries.map(entry => {
        const row = rows.get(prefix + 'witness:' + entry.id);
        if (!row || JSON.stringify(row.entry) !== JSON.stringify(entry)) throw new Error('canonical history row mismatch');
        return row;
      }) }));
      if (loaded.leafId !== null && !entries.some(entry => entry.id === loaded.leafId)) throw new Error('canonical history leaf mismatch');
      return { entries, leafId: loaded.leafId };
    },
    async persistOwnerInput(entry, scope) {
      await adapter.assertCurrent();
      if (entry.ownerId !== principal_ref || entry.role !== 'user' || entry.modelProjection.mode !== 'include' || entry.modelPayload !== entry.appPayload) throw Error('canonical original input rejected');
      // Existing forget-covered conv/witness rows, not another readable cache.
      // Preserve the successful leaf; a proposal alone is not a published turn.
      const model = redactSecretUrls(entry.modelPayload), app = redactSecretUrls(entry.appPayload);
      if (model.count || app.count) throw Error('canonical original input secret URL rejected');
      scope.commit(() => storage.transactionSync(() => {
        if (witnessCurrent(entry)) return;
        const count = storage.kv.get<number>(prefix + 'conv-count') ?? 0;
        if (!Number.isSafeInteger(count) || count < 0) throw Error('canonical original input counter rejected');
        mapped.kv.put(`conv:${String(count).padStart(10, '0')}`, entry);
        mapped.kv.put('conv-count', count + 1);
      }));
      await adapter.assertCurrent();
    },
    async save(entries, leafId, scope) {
      if (!scope) throw new Error('canonical history requires run fence');
      await adapter.assertCurrent();
      if (entries.some(entry => entry.ownerId !== principal_ref)) throw new Error('canonical history owner mismatch');
      // Base store scrubs URLs and writes bytes and witnesses in the same run-fenced commit.
      const scrubbed = entries.map(entry => {
        const model = redactSecretUrls(entry.modelPayload), app = redactSecretUrls(entry.appPayload);
        return model.count || app.count ? { ...entry, modelPayload: model.text, appPayload: app.text } : entry;
      });
      scope.commit(() => storage.transactionSync(() => {
        const missing = scrubbed.filter(entry => !witnessCurrent(entry));
        const count = storage.kv.get<number>(prefix + 'conv-count') ?? 0;
        if (!Number.isSafeInteger(count) || count < 0) throw Error('canonical original input counter rejected');
        missing.forEach((entry, index) => mapped.kv.put(`conv:${String(count + index).padStart(10, '0')}`, entry));
        mapped.kv.put('conv-count', count + missing.length);
        mapped.kv.put('conv-leaf', leafId);
      }));
      await adapter.assertCurrent();
    },
  };
}
