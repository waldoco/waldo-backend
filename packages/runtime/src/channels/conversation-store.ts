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

// Forget support: redact forgotten claim text from the persisted rolling window in place.
// Entries keep their keys, order, conv-count and conv-leaf, so unrelated history and the tree
// structure are untouched. Matching is case-insensitive literal text (same coverage as the sql
// stores' LIKE checks): a paraphrase of the forgotten fact in hot context is NOT caught - the
// forget barrier covers model behavior for those. The returned counts are all a trace may log.
export const redactConversationEntries = async (
  storage: KeyValueStorage,
  texts: readonly string[],
  marker: string,
): Promise<Readonly<{ rewritten: number; remaining: number }>> => {
  const needles = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
  if (needles.length === 0) return { rewritten: 0, remaining: 0 };
  const patterns = needles.map((needle) => new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  const rows = await storage.list<ConversationEntry>({ prefix: 'conv:' });
  let rewritten = 0;
  for (const [key, entry] of rows) {
    let model = entry.modelPayload;
    let app = entry.appPayload;
    for (const pattern of patterns) {
      model = model.replace(pattern, marker);
      app = app.replace(pattern, marker);
    }
    if (model !== entry.modelPayload || app !== entry.appPayload) {
      await storage.put(key, { ...entry, modelPayload: model, appPayload: app });
      rewritten += 1;
    }
  }
  const after = rewritten > 0 ? await storage.list<ConversationEntry>({ prefix: 'conv:' }) : rows;
  let remaining = 0;
  for (const [, entry] of after) {
    const hay = `${entry.modelPayload}\n${entry.appPayload}`.toLowerCase();
    if (needles.some((needle) => hay.includes(needle.toLowerCase()))) remaining += 1;
  }
  return { rewritten, remaining };
};
