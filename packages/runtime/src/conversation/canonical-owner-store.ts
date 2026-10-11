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
// The entry-shape checks, named so a skipped row can say which one it failed and nothing else.
export type CanonicalShapeCheck = 'id' | 'chat' | 'surface' | 'payload' | 'parent' | 'anchor' | 'projection' | 'role' | 'input_origin';
const shapeFault = (entry: ConversationEntry): CanonicalShapeCheck | null => {
  if (!entry.id) return 'id';
  if (!entry.chatId) return 'chat';
  if (!entry.surface) return 'surface';
  if (typeof entry.modelPayload !== 'string' || typeof entry.appPayload !== 'string') return 'payload';
  if (!(entry.parentId === null || typeof entry.parentId === 'string')) return 'parent';
  if (!(entry.threadAnchorId === null || typeof entry.threadAnchorId === 'string')) return 'anchor';
  if (!entry.modelProjection || !['include', 'omit', 'replace'].includes(entry.modelProjection.mode)
    || (entry.modelProjection.mode === 'replace' && typeof entry.modelProjection.payload !== 'string')) return 'projection';
  if (!['user', 'assistant'].includes(entry.role ?? '')) return 'role';
  if (entry.role === 'user' && !['owner', 'machine'].includes(entry.inputOrigin ?? '')) return 'input_origin';
  return null;
};
export type CanonicalHistoryRead = Readonly<{ entries: readonly ConversationEntry[]; leafId: string | null; skipped: Readonly<Partial<Record<CanonicalShapeCheck, number>>> }>;

export function canonicalOwnerConversationStore(storage: CanonicalHistoryStorage, context: Pick<OwnerContextCapability, 'invocation' | 'assertCurrent'>): ConversationStore & Readonly<{ readForDisplay(): Promise<CanonicalHistoryRead> }> {
  const principal = context.invocation.verified_authority.principal_ref;
  const tenant = context.invocation.verified_authority.tenant_ref;
  const prefix = `canonical-owner-v1:${principal}:${tenant}:`;
  const witnessKey = (id: string) => `${prefix}witness:${id}`;
  const validate = (entry: ConversationEntry) => {
    if (!entry || entry.ownerId !== principal) throw new Error('canonical history owner mismatch');
    if (shapeFault(entry) !== null) throw new Error('canonical history entry invalid');
    return entry;
  };
  const witness = (entry: ConversationEntry): Witness => ({ lineage: 'canonical_v1', principal_ref: principal, tenant_ref: tenant, entry });
  const matches = (receipt: Witness, entry: ConversationEntry) => receipt.lineage === 'canonical_v1' && receipt.principal_ref === principal
    && receipt.tenant_ref === tenant && stableJson(receipt.entry) === stableJson(entry);
  // Strict for turns. For display, a row that matches its own witness but fails the shape check is left out and
  // counted instead of failing the read: it can still never load as owner input. Owner, witness and duplicate faults stay fatal.
  const read = async (skipShapeFaults: boolean): Promise<CanonicalHistoryRead> => {
    await context.assertCurrent();
    const rows = await storage.list<ConversationEntry>({ prefix: `${prefix}conv:` });
    const entries: ConversationEntry[] = [];
    const ids = new Set<string>(), seen = new Set<string>(), left = new Set<string>();
    const skipped: Partial<Record<CanonicalShapeCheck, number>> = {};
    for (const entry of rows.values()) {
      if (!entry || entry.ownerId !== principal) throw new Error('canonical history owner mismatch');
      const fault = shapeFault(entry);
      if (fault !== null && !skipShapeFaults) throw new Error('canonical history entry invalid');
      const receipt = await storage.get<Witness>(witnessKey(entry.id));
      // stableJson refuses undefined values, which a shape-faulted row may hold; such a row never loads, so plain JSON equality decides it.
      if (!receipt || receipt.lineage !== 'canonical_v1' || receipt.principal_ref !== principal || receipt.tenant_ref !== tenant
        || (fault === null ? stableJson(receipt.entry) !== stableJson(entry) : JSON.stringify(receipt.entry) !== JSON.stringify(entry))
        || seen.has(entry.id)) throw new Error('canonical history witness mismatch');
      seen.add(entry.id);
      if (fault !== null) { skipped[fault] = (skipped[fault] ?? 0) + 1; left.add(entry.id); continue; }
      ids.add(entry.id); entries.push(entry);
    }
    const leafId = (await storage.get<string>(`${prefix}leaf`)) ?? null;
    if (leafId !== null && !ids.has(leafId) && !left.has(leafId)) throw new Error('canonical history leaf mismatch');
    await context.assertCurrent();
    return { entries, leafId: leafId !== null && left.has(leafId) ? null : leafId, skipped };
  };
  const store: ConversationStore & Readonly<{ readForDisplay(): Promise<CanonicalHistoryRead> }> = {
    async load() { const { entries, leafId } = await read(false); return { entries, leafId }; },
    readForDisplay: () => read(true),
    save(rawEntries, leafId, scope) { return serialize(storage, async () => {
      await context.assertCurrent();
      const checked = rawEntries.map(entry => scrub(validate(entry)));
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

