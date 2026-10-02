import type { RunEffectScope } from './run-effect-scope';
import { literalTextRedactor, redactConversationEntry, type ConversationEntry, type ConversationTree } from '@waldo/contracts';
import { redactSecretUrls } from './egress-guard';

export type ConversationStore = Readonly<{
  load(): Promise<Readonly<{ entries: readonly ConversationEntry[]; leafId: string | null }>>;
  save(entries: readonly ConversationEntry[], leafId: string, scope?: RunEffectScope): Promise<void>;
}>;

type KeyValueStorage = Pick<DurableObjectStorage, 'get' | 'list' | 'put'> & Partial<Pick<DurableObjectStorage, 'kv'>>;

const entryKey = (seq: number) => `conv:${String(seq).padStart(10, '0')}`;

export const durableConversationStore = (storage: KeyValueStorage): ConversationStore => ({
  async load() {
    const rows = await storage.list<ConversationEntry>({ prefix: 'conv:' });
    return { entries: [...rows.values()], leafId: (await storage.get<string>('conv-leaf')) ?? null };
  },
  async save(entries, leafId, scope) {
    const count = (await storage.get<number>('conv-count')) ?? 0;
    const scrubbed = entries.map((entry) => {
      const model = redactSecretUrls(entry.modelPayload);
      const app = redactSecretUrls(entry.appPayload);
      return model.count + app.count > 0 ? { ...entry, modelPayload: model.text, appPayload: app.text } : entry;
    });
    const writes = {
      ...Object.fromEntries(scrubbed.map((entry, index) => [entryKey(count + index), entry])),
      'conv-count': count + entries.length,
      'conv-leaf': leafId,
    };
    if (scope) { if (!storage.kv) throw new Error('fenced synchronous history store unavailable'); scope.commit(() => { for (const [key, value] of Object.entries(writes)) storage.kv!.put(key, value); }); }
    else await storage.put<unknown>(writes);
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
  scope?: RunEffectScope,
): Promise<Readonly<{ rewritten: number; remaining: number }>> => {
  const needles = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
  if (needles.length === 0) return { rewritten: 0, remaining: 0 };
  const redact = literalTextRedactor(needles, marker);
  const rows = await storage.list<ConversationEntry>({ prefix: 'conv:' });
  let rewritten = 0;
  for (const [key, entry] of rows) {
    const rewrittenEntry = redactConversationEntry(entry, redact);
    if (JSON.stringify(rewrittenEntry) !== JSON.stringify(entry)) {
      if (scope) { if (!storage.kv) throw new Error('fenced redaction store unavailable'); scope.commit(() => storage.kv!.put(key, rewrittenEntry)); }
      else await storage.put(key, rewrittenEntry);
      rewritten += 1;
    }
  }
  const after = rewritten > 0 ? await storage.list<ConversationEntry>({ prefix: 'conv:' }) : rows;
  let remaining = 0;
  for (const [, entry] of after) {
    const hay = `${entry.modelPayload}\n${entry.appPayload}\n${entry.modelProjection.mode === 'replace' ? entry.modelProjection.payload : ''}`.toLowerCase();
    if (needles.some((needle) => hay.includes(needle.toLowerCase()))) remaining += 1;
  }
  return { rewritten, remaining };
};
