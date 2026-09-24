import type { ConversationEntry, ConversationTree } from '@waldo/contracts';
import { redactSecretUrls } from './egress-guard';

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
    const scrubbed = entries.map((entry) => {
      const model = redactSecretUrls(entry.modelPayload);
      const app = redactSecretUrls(entry.appPayload);
      return model.count + app.count > 0 ? { ...entry, modelPayload: model.text, appPayload: app.text } : entry;
    });
    await storage.put<unknown>({
      ...Object.fromEntries(scrubbed.map((entry, index) => [entryKey(count + index), entry])),
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

// One-time scrub of history written before the egress guard existed (CONNECT_FLOW_DESIGN S1).
// Gated on a storage flag so it runs once per DO. Returns the number of entries rewritten.
export const scrubConversationHistory = async (storage: KeyValueStorage): Promise<number> => {
  if (await storage.get<boolean>('scrub:v1')) return 0;
  const rows = await storage.list<ConversationEntry>({ prefix: 'conv:' });
  const writes: Record<string, ConversationEntry> = {};
  for (const [key, entry] of rows) {
    const model = redactSecretUrls(entry.modelPayload);
    const app = redactSecretUrls(entry.appPayload);
    if (model.count + app.count > 0) writes[key] = { ...entry, modelPayload: model.text, appPayload: app.text };
  }
  if (Object.keys(writes).length > 0) await storage.put(writes);
  await storage.put('scrub:v1', true);
  return Object.keys(writes).length;
};
