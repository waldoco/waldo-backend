import type { ConversationEntry } from '@waldo/contracts';
import type { ConversationStore } from '../channels/conversation-store';
import type { RunEffectScope } from '../channels/run-effect-scope';
import type { OwnerContextCapability } from '../context-composer/owner-turn';
import { stableJson } from '../context-composer/canonical';
import { redactSecretUrls } from '../channels/egress-guard';
import { supersededCompaction } from './compaction';

export type CanonicalHistoryStorage = Pick<DurableObjectStorage, 'get' | 'list' | 'put'> & {
  kv?: Pick<DurableObjectStorage['kv'], 'get' | 'put' | 'list'>;
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
export type CanonicalShapeCheck = 'id' | 'chat' | 'surface' | 'payload' | 'parent' | 'anchor' | 'projection' | 'role' | 'input_origin' | 'covers';
export const shapeFault = (entry: ConversationEntry): CanonicalShapeCheck | null => {
  if (!entry.id) return 'id';
  if (!entry.chatId) return 'chat';
  if (!entry.surface) return 'surface';
  if (typeof entry.modelPayload !== 'string' || typeof entry.appPayload !== 'string') return 'payload';
  if (!(entry.parentId === null || typeof entry.parentId === 'string')) return 'parent';
  if (!(entry.threadAnchorId === null || typeof entry.threadAnchorId === 'string')) return 'anchor';
  if (!entry.modelProjection || !['include', 'omit', 'replace'].includes(entry.modelProjection.mode)
    || (entry.modelProjection.mode === 'replace' && typeof entry.modelProjection.payload !== 'string')) return 'projection';
  if (!['user', 'assistant', 'compaction'].includes(entry.role ?? '')) return 'role';
  if (entry.role === 'user' && !['owner', 'machine'].includes(entry.inputOrigin ?? '')) return 'input_origin';
  if (entry.role === 'compaction' && !(entry.appPayload === '' && typeof entry.covers?.from_id === 'string' && typeof entry.covers.to_id === 'string' && Number.isInteger(entry.covers.rows) && entry.covers.rows >= 1)) return 'covers';
  return null;
};
export type CanonicalSkip = Readonly<{ count: number; unwitnessed: number }>;
// What a read left out: rows per failed check, loaded rows whose stored parent was left out, and whether the stored leaf was.
export type CanonicalSkipped = Readonly<{ checks: Readonly<Partial<Record<CanonicalShapeCheck, CanonicalSkip>>>; orphans: number; leaf: boolean }>;
export type CanonicalHistoryRead = Readonly<{ entries: readonly ConversationEntry[]; leafId: string | null; skipped: CanonicalSkipped }>;

// The fixed code for each canonical-history fault. A Map, so an error message can never select an inherited member.
const FAULT_CODES = new Map([
  ['canonical history owner mismatch', 'history_owner'], ['canonical history entry invalid', 'history_invalid'],
  ['canonical history witness mismatch', 'history_witness'], ['canonical history leaf mismatch', 'history_leaf'],
  ['canonical history input conflict', 'history_conflict'],
]);
export const canonicalHistoryFault = (error: unknown): string | null => error instanceof Error ? FAULT_CODES.get(error.message) ?? null : null;
// Log lines for rows a read left out: fixed codes and counts, never an id or a row's text.
export const skippedRowLines = (hop: string, skipped: CanonicalSkipped) => Object.entries(skipped.checks).map(([check, tally]) =>
  ({ hop, ok: true, code: 'history_rows_skipped', check, count: tally!.count, unwitnessed: tally!.unwitnessed, orphans: skipped.orphans, leaf: skipped.leaf }));

// A thread's history is its own chain under the owner's prefix (thread:<thread id>:); main's is the prefix itself.
export function canonicalOwnerConversationStore(storage: CanonicalHistoryStorage, context: Pick<OwnerContextCapability, 'invocation' | 'assertCurrent'>, onSkipped?: (skipped: CanonicalSkipped) => void, thread?: string): ConversationStore & Readonly<{ readForDisplay(): Promise<CanonicalHistoryRead> }> {
  const principal = context.invocation.verified_authority.principal_ref;
  const tenant = context.invocation.verified_authority.tenant_ref;
  const prefix = `canonical-owner-v1:${principal}:${tenant}:${thread ? `thread:${thread}:` : ''}`;
  const witnessKey = (id: string) => `${prefix}witness:${id}`;
  const validate = (entry: ConversationEntry) => {
    if (!entry || entry.ownerId !== principal) throw new Error('canonical history owner mismatch');
    if (shapeFault(entry) !== null) throw new Error('canonical history entry invalid');
    return entry;
  };
  const witness = (entry: ConversationEntry): Witness => ({ lineage: 'canonical_v1', principal_ref: principal, tenant_ref: tenant, entry });
  const matches = (receipt: Witness, entry: ConversationEntry) => receipt.lineage === 'canonical_v1' && receipt.principal_ref === principal
    && receipt.tenant_ref === tenant && stableJson(receipt.entry) === stableJson(entry);
  // From the last read: ids it left out, which no new row may take, and each row it re-linked, which is saved back as stored.
  let leftOut: ReadonlySet<string> = new Set();
  let relinked: ReadonlyMap<string, Readonly<{ stored: ConversationEntry; loaded: ConversationEntry }>> = new Map();
  // A row that fails the shape check is left out and counted instead of failing the read, whether its witness matches or is
  // absent: it never loads as context. A witness that differs, an owner mismatch, a duplicate id, and any shape-valid row
  // without its exact witness stay fatal. For a turn, a row whose parent was left out hangs on the nearest loaded row above
  // it, in memory only; the page shows each row with its stored parent.
  const read = async (relink: boolean): Promise<CanonicalHistoryRead> => {
    await context.assertCurrent();
    const rows = await storage.list<ConversationEntry>({ prefix: `${prefix}conv:` });
    const entries: ConversationEntry[] = [];
    const ids = new Set<string>(), seen = new Set<string>(), left = new Map<string, string | null>();
    const checks: Partial<Record<CanonicalShapeCheck, { count: number; unwitnessed: number }>> = {};
    for (const entry of rows.values()) {
      if (!entry || entry.ownerId !== principal) throw new Error('canonical history owner mismatch');
      const fault = shapeFault(entry);
      const receipt = await storage.get<Witness>(witnessKey(entry.id));
      if (seen.has(entry.id)) throw new Error('canonical history witness mismatch');
      seen.add(entry.id);
      if (fault !== null) {
        // stableJson refuses undefined values, which a shape-faulted row may hold; plain JSON equality decides a row that never loads.
        if (receipt && (receipt.lineage !== 'canonical_v1' || receipt.principal_ref !== principal || receipt.tenant_ref !== tenant
          || JSON.stringify(receipt.entry) !== JSON.stringify(entry))) throw new Error('canonical history witness mismatch');
        const tally = checks[fault] ??= { count: 0, unwitnessed: 0 };
        tally.count += 1; if (!receipt) tally.unwitnessed += 1;
        left.set(entry.id, typeof entry.parentId === 'string' ? entry.parentId : null); continue;
      }
      if (!receipt || receipt.lineage !== 'canonical_v1' || receipt.principal_ref !== principal || receipt.tenant_ref !== tenant
        || stableJson(receipt.entry) !== stableJson(entry)) throw new Error('canonical history witness mismatch');
      ids.add(entry.id); entries.push(entry);
    }
    const storedLeaf = (await storage.get<string>(`${prefix}leaf`)) ?? null;
    if (storedLeaf !== null && !ids.has(storedLeaf) && !left.has(storedLeaf)) throw new Error('canonical history leaf mismatch');
    await context.assertCurrent();
    // The nearest loaded row above a left-out one. A loop among left-out rows, or a parent that is not loaded, ends at no parent.
    const above = (id: string): string | null => {
      const walked = new Set<string>();
      let current: string | null = id;
      while (current !== null && left.has(current)) {
        if (walked.has(current)) return null;
        walked.add(current); current = left.get(current) ?? null;
      }
      return current !== null && ids.has(current) ? current : null;
    };
    const orphaned = (entry: ConversationEntry) => entry.parentId !== null && left.has(entry.parentId);
    const moved = new Map<string, Readonly<{ stored: ConversationEntry; loaded: ConversationEntry }>>();
    // One store holds every chain of this owner (the app chat and each iMessage chat). An older build could hang a row
    // under another chain's row; for a turn that row hangs on the last earlier row of its own chain instead, in memory only.
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const chainLeaves = new Map<string, string>();
    const loaded = relink ? entries.map(entry => {
      let parentId = orphaned(entry) ? above(entry.parentId!) : entry.parentId;
      if (parentId !== null && byId.get(parentId)?.chatId !== entry.chatId) parentId = chainLeaves.get(entry.chatId) ?? null;
      if (entry.role !== 'compaction') chainLeaves.set(entry.chatId, entry.id);
      if (parentId === entry.parentId) return entry;
      const linked = { ...entry, parentId };
      moved.set(entry.id, { stored: entry, loaded: linked });
      return linked;
    }) : entries;
    leftOut = new Set(left.keys()); relinked = moved;
    const skipped = { checks, orphans: entries.filter(orphaned).length, leaf: storedLeaf !== null && left.has(storedLeaf) };
    return { entries: loaded, leafId: storedLeaf !== null && left.has(storedLeaf) ? above(storedLeaf) : storedLeaf, skipped };
  };
  const asStored = (entry: ConversationEntry) => {
    const moved = relinked.get(entry.id);
    return moved && stableJson(entry) === stableJson(moved.loaded) ? moved.stored : entry;
  };
  // New rows go after both the stored count and the last stored row. An older build could leave rows the count
  // does not cover, and a write at the count would then replace any stored row at or past it.
  const nextSlot = (count: number, last: string | undefined) => {
    if (last === undefined) return count;
    const slot = last.slice(`${prefix}conv:`.length);
    if (!/^\d{10}$/.test(slot)) throw new Error('canonical history entry invalid');
    return Math.max(count, Number(slot) + 1);
  };
  const lastSlot = { prefix: `${prefix}conv:`, reverse: true, limit: 1 } as const;
  const store: ConversationStore & Readonly<{ readForDisplay(): Promise<CanonicalHistoryRead> }> = {
    async load() {
      const { entries, leafId, skipped } = await read(true);
      if (Object.keys(skipped.checks).length > 0) onSkipped?.(skipped);
      return { entries, leafId };
    },
    readForDisplay: () => read(false),
    save(rawEntries, leafId, scope) { return serialize(storage, async () => {
      await context.assertCurrent();
      const checked = rawEntries.map(entry => scrub(validate(asStored(entry))));
      if (checked.some(entry => leftOut.has(entry.id))) throw new Error('canonical history input conflict');
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
          const [last] = storage.kv!.list(lastSlot);
          const count = nextSlot(storage.kv!.get<number>(`${prefix}count`) ?? 0, last?.[0]);
          for (const [key, value] of Object.entries(commit(count, fresh))) storage.kv!.put(key, value);
        });
      } else {
        const [last] = (await storage.list(lastSlot)).keys();
        await storage.put(commit(nextSlot((await storage.get<number>(`${prefix}count`)) ?? 0, last), entries));
      }
    }); },
    persistOwnerInput: async (entry, scope) => { await store.save([entry], entry.id, scope); },
    // The compaction row goes in at the next slot and the row it supersedes is rewritten in place, with both witnesses, in
    // one write that never touches `${prefix}leaf`: a turn that landed while the summary was in flight keeps its leaf, and a
    // crash cannot leave two live summaries. A row already witnessed under this id is the same span again, and a no-op.
    appendCompaction(row, supersededId, scope) { return serialize(storage, async () => {
      await context.assertCurrent();
      const entry = scrub(validate(row));
      if (entry.role !== 'compaction') throw new Error('canonical history entry invalid');
      const previous = supersededId;
      const writes = (count: number, prior: Readonly<{ key: string; entry: ConversationEntry }> | null) => {
        const out: Record<string, unknown> = { [`${prefix}count`]: count + 1, [`${prefix}conv:${String(count).padStart(10, '0')}`]: entry, [witnessKey(entry.id)]: witness(entry) };
        if (prior) { const next = validate(supersededCompaction(prior.entry)); out[prior.key] = next; out[witnessKey(next.id)] = witness(next); }
        return out;
      };
      if (scope) {
        if (!storage.kv) throw new Error('fenced canonical history unavailable');
        scope.commit(() => {
          if (storage.kv!.get<Witness>(witnessKey(entry.id))) return;
          const prior = previous === null ? null : [...storage.kv!.list<ConversationEntry>({ prefix: `${prefix}conv:` })].map(([key, value]) => ({ key, entry: value })).find((row) => row.entry.id === previous) ?? null;
          const [last] = storage.kv!.list(lastSlot);
          const count = nextSlot(storage.kv!.get<number>(`${prefix}count`) ?? 0, last?.[0]);
          for (const [key, value] of Object.entries(writes(count, prior))) storage.kv!.put(key, value);
        });
      } else {
        if (await storage.get<Witness>(witnessKey(entry.id))) return;
        const prior = previous === null ? null : [...(await storage.list<ConversationEntry>({ prefix: `${prefix}conv:` }))].map(([key, value]) => ({ key, entry: value })).find((row) => row.entry.id === previous) ?? null;
        const [last] = (await storage.list(lastSlot)).keys();
        await storage.put(writes(nextSlot((await storage.get<number>(`${prefix}count`)) ?? 0, last), prior));
      }
    }); },
    compactionAttempt: async (chainRef) => (await storage.get<number>(`${prefix}compaction-attempt:${chainRef}`)) ?? null,
    async noteCompactionAttempt(chainRef, at, scope) {
      const key = `${prefix}compaction-attempt:${chainRef}`;
      if (scope) { if (!storage.kv) throw new Error('fenced canonical history unavailable'); scope.commit(() => storage.kv!.put(key, at)); }
      else await storage.put(key, at);
    },
  };
  return store;
}

