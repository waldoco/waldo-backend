import type { ConversationEntry, ConversationTree } from '@waldo/contracts';

export type ConversationStore = Readonly<{
  load(): Promise<Readonly<{ entries: readonly ConversationEntry[]; leafId: string | null }>>;
  save(entries: readonly ConversationEntry[], leafId: string): Promise<void>;
}>;

type KeyValueStorage = Pick<DurableObjectStorage, 'get' | 'list' | 'put'>;

const entryKey = (seq: number) => `conv:${String(seq).padStart(10, '0')}`;

export const durableConversationStore = (storage: KeyValueStorage): ConversationStore => ({
  async load() {
    const rows = await storage.list<ConversationEntry>({ prefix: 'conv:' });
    return { entries: [...rows.values()], leafId: (await storage.get<string>('conv-leaf')) ?? null };
  },
  async save(entries, leafId) {
    const count = (await storage.get<number>('conv-count')) ?? 0;
    await storage.put<unknown>({
      ...Object.fromEntries(entries.map((entry, index) => [entryKey(count + index), entry])),
      'conv-count': count + entries.length,
      'conv-leaf': leafId,
    });
  },
});

export const restoreConversation = async (tree: ConversationTree, store: ConversationStore): Promise<string | null> => {
  const { entries, leafId } = await store.load();
  for (const entry of entries) tree.append(entry);
  return leafId;
};
