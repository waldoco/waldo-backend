import { describe, expect, it } from 'vitest';
import { ConversationTree, type ConversationEntry } from '@waldo/contracts';
import { redactConversationEntries } from '../src/channels/conversation-store';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { COMPACTION, COMPACTION_SUPERSEDED_MARKER, compactionPlan, compactionRow } from '../src/conversation/compaction';

const PRINCIPAL = 'prn_10000000000000000000000000000001', TENANT = 'tnt_1';
const memoryStorage = () => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key: string) => data.get(key),
    put: async (entries: Record<string, unknown> | string, value?: unknown) => { if (typeof entries === 'string') data.set(entries, value); else for (const [key, item] of Object.entries(entries)) data.set(key, item); },
    list: async ({ prefix, reverse, limit }: { prefix: string; reverse?: boolean; limit?: number }) => {
      const rows = [...data].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      if (reverse) rows.reverse();
      return new Map(limit ? rows.slice(0, limit) : rows);
    },
  } as unknown as DurableObjectStorage & { data: Map<string, unknown> };
};
const context = { invocation: { verified_authority: { principal_ref: PRINCIPAL, tenant_ref: TENANT } } as never, assertCurrent: async () => undefined };
const row = (id: string, parentId: string | null, role: 'user' | 'assistant', text: string, createdAt: number): ConversationEntry => ({
  id, ownerId: PRINCIPAL, chatId: 'owner', parentId, threadAnchorId: null, surface: 'app', modelPayload: text, appPayload: text,
  modelProjection: { mode: 'include' }, role, ...(role === 'user' ? { inputOrigin: 'owner' as const } : {}), createdAt,
});
const PREFIX = `canonical-owner-v1:${PRINCIPAL}:${TENANT}:`;
const settings = { ...COMPACTION, budgetTokens: 120 };

const seeded = async (rounds: number) => {
  const storage = memoryStorage();
  const store = canonicalOwnerConversationStore(storage, context);
  const tree = new ConversationTree();
  let parent: string | null = null;
  for (let round = 1; round <= rounds; round += 1) {
    const user = row(`u${round}`, parent, 'user', `question ${round}: ${round === 2 ? 'the locker code is 4417 ' : ''}${'q'.repeat(90)}`, round * 10);
    const reply = row(`a${round}`, `u${round}`, 'assistant', `answer ${round} ${'a'.repeat(90)}`, round * 10 + 1);
    await store.save([user, reply], reply.id);
    tree.append(user); tree.append(reply);
    parent = reply.id;
  }
  return { storage, store, tree, leaf: `a${rounds}` };
};

describe('canonical store compaction rows', () => {
  it('appends the row and its witness without moving the leaf, supersedes the previous summary in the same write, and ignores a repeat', async () => {
    const { storage, store, tree, leaf } = await seeded(6);
    const first = compactionRow(compactionPlan(tree, leaf, null, settings)!, 'The owner prefers tea.', PRINCIPAL, 99);
    await store.appendCompaction!(first, null);
    expect(storage.data.get(`${PREFIX}leaf`)).toBe(leaf);
    const loaded = await store.load();
    expect(loaded.leafId).toBe(leaf);
    expect(loaded.entries.find((entry) => entry.id === first.id)).toEqual(first);
    // the same span again is a no-op, not a second row
    await store.appendCompaction!({ ...first, modelPayload: 'another wording' }, null);
    expect((await store.load()).entries.filter((entry) => entry.role === 'compaction')).toHaveLength(1);
    // a later summary supersedes the first: marker, omitted, covers kept, both witnesses valid, leaf untouched
    tree.append(first);
    tree.append(row('u7', 'a6', 'user', `question 7 ${'q'.repeat(90)}`, 70)); tree.append(row('a7', 'u7', 'assistant', `answer 7 ${'a'.repeat(90)}`, 71));
    await store.save([tree.get('u7')!, tree.get('a7')!], 'a7');
    const second = compactionRow(compactionPlan(tree, 'a7', first, settings)!, 'Tea, and a dentist on Friday.', PRINCIPAL, 100);
    await store.appendCompaction!(second, first.id);
    const after = await store.load();
    expect(after.leafId).toBe('a7');
    expect(after.entries.find((entry) => entry.id === first.id)).toMatchObject({ modelPayload: COMPACTION_SUPERSEDED_MARKER, modelProjection: { mode: 'omit' }, covers: first.covers });
    expect(after.entries.find((entry) => entry.id === second.id)).toEqual(second);
    expect(await store.compactionAttempt!('owner')).toBeNull();
    await store.noteCompactionAttempt!('owner', 12_345);
    expect(await store.compactionAttempt!('owner')).toBe(12_345);
  });

  it('refuses a compaction row without covers, as a shape fault, and a transcript read leaves it out', async () => {
    const { store, tree, leaf } = await seeded(3);
    const bad = { ...compactionRow(compactionPlan(tree, leaf, null, settings)!, 'summary', PRINCIPAL, 99), covers: undefined };
    await expect(store.appendCompaction!(bad, null)).rejects.toThrow('canonical history entry invalid');
  });

  it('a forget whose topic sits inside the span supersedes the summary and its witness together, keeping covers', async () => {
    const { storage, store, tree, leaf } = await seeded(6);
    const first = compactionRow(compactionPlan(tree, leaf, null, settings, 10_000)!, 'The owner keeps things in a locker.', PRINCIPAL, 99);
    await store.appendCompaction!(first, null);
    expect(first.covers).toEqual({ from_id: 'u1', to_id: 'a5', rows: 10 });
    const result = await redactConversationEntries(storage, ['4417'], '[forgotten]');
    expect(result.remaining).toBe(0);
    const after = await store.load();
    const summary = after.entries.find((entry) => entry.id === first.id)!;
    expect(summary).toMatchObject({ modelPayload: COMPACTION_SUPERSEDED_MARKER, modelProjection: { mode: 'omit' }, covers: first.covers });
    expect(after.entries.find((entry) => entry.id === 'u2')!.modelPayload).toContain('[forgotten]');
    // a topic outside every span leaves the summary alone
    const second = compactionRow({ ...compactionPlan(tree, leaf, null, settings)!, covers: { from_id: 'u4', to_id: 'a5', rows: 4 } }, 'Later summary.', PRINCIPAL, 100);
    await store.appendCompaction!({ ...second, id: 'a5-compaction-later' }, null);
    await redactConversationEntries(storage, ['question 1:'], '[forgotten]');
    expect((await store.load()).entries.find((entry) => entry.id === 'a5-compaction-later')).toMatchObject({ modelPayload: 'Later summary.', modelProjection: { mode: 'include' } });
  });
});
