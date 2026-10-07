import type { RunEffectScope } from './run-effect-scope';
import { literalTextRedactor, redactConversationEntry, type ConversationEntry, type ConversationTree } from '@waldo/contracts';
import { redactSecretUrls } from './egress-guard';
import { hidesTopic } from '../memory/forget-guard';
import { asciiLiteralIncludes, forgetSourceBatch, type ForgetSource, type ForgetBatch } from '../memory/selective-forget';

export type ConversationStore = Readonly<{
  load(): Promise<Readonly<{ entries: readonly ConversationEntry[]; leafId: string | null }>>;
  save(entries: readonly ConversationEntry[], leafId: string, scope?: RunEffectScope): Promise<void>;
  persistOwnerInput?(entry: ConversationEntry, scope: RunEffectScope): Promise<void>;
  forgetSources?(topic: string): Promise<{ sources: ForgetSource[]; incomplete: boolean }>;
  forgetSourceBatch?(topic: string): Promise<ForgetBatch>;
  forgetSourceBatchCurrent?(topic: string): ForgetBatch | null;
  forgetSourcesCurrent?(topic: string): { sources: ForgetSource[]; incomplete: boolean } | null;
}>;

type KeyValueStorage = Pick<DurableObjectStorage, 'get' | 'list' | 'put'> & { kv?: Pick<DurableObjectStorage['kv'], 'put'> & Partial<Pick<DurableObjectStorage['kv'], 'list'>> };

const entryKey = (seq: number) => `conv:${String(seq).padStart(10, '0')}`;

export const durableConversationStore = (storage: KeyValueStorage): ConversationStore => ({
  async forgetSourceBatch(topic) {
    const all = await this.forgetSources!(topic);
    const batch = forgetSourceBatch(topic, all.sources);
    return { ...batch, incomplete: batch.incomplete || all.incomplete };
  },
  forgetSourceBatchCurrent(topic) {
    const all = this.forgetSourcesCurrent!(topic);
    if (!all) return null;
    const batch = forgetSourceBatch(topic, all.sources);
    return { ...batch, incomplete: batch.incomplete || all.incomplete };
  },
  forgetSources: topic => conversationForgetSources(storage, topic),
  forgetSourcesCurrent: topic => storage.kv?.list ? conversationForgetSourcesCurrent(storage.kv as Pick<DurableObjectStorage['kv'], 'list'>, topic) : null,
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
// Admitted-owner history lives under canonical-owner-v1:<principal>:<tenant>: as conv:* rows plus a witness:<id> copy of each
// entry (owner-canonical-history.ts). load() requires row and witness to be identical, so both are rewritten together.
const CANONICAL_PREFIX = 'canonical-owner-v1:';
type Witness = { entry: ConversationEntry } & Record<string, unknown>;
// Row kind from the key structure, not substring luck: canonical-owner-v1:<principal>:<tenant>:(conv|witness):<rest>.
const canonicalKind = (key: string): 'conv' | 'witness' | null => {
  if (!key.startsWith(CANONICAL_PREFIX)) return null;
  const kind = key.slice(CANONICAL_PREFIX.length).split(':')[2];
  return kind === 'conv' || kind === 'witness' ? kind : null;
};
type ExpectedForgetOwner = Readonly<{ principal_ref: string; tenant_ref: string }>;
export const conversationForgetSources = async (storage: KeyValueStorage, topic: string, expected?: ExpectedForgetOwner) =>
  conversationSourcesFromRows(await storage.list<ConversationEntry>({ prefix: 'conv:' }), await storage.list<ConversationEntry | Witness>({ prefix: CANONICAL_PREFIX }), topic, expected);
export const conversationForgetSourcesCurrent = (storage: Pick<DurableObjectStorage['kv'], 'list'>, topic: string, expected?: ExpectedForgetOwner) =>
  conversationSourcesFromRows(new Map(storage.list<ConversationEntry>({ prefix: 'conv:' })), new Map(storage.list<ConversationEntry | Witness>({ prefix: CANONICAL_PREFIX })), topic, expected);
// Conversation payloads are plain text that nothing JSON-decodes, so a backslash in prose (a Windows path, code) hides nothing. Only a JSON-shaped payload (starts with { [ or a quote, or decodes as JSON) can carry an escaped topic, so only those take the hidden-escape guard; prose gets the literal match.
const jsonShaped = (text: string): boolean => {
  const head = text.trimStart()[0];
  if (head === '{' || head === '[' || head === '"') return true;
  try { JSON.parse(text); return true; } catch { return false; }
};
const conversationHides = (text: string, topic: string): boolean => jsonShaped(text) && hidesTopic(text, topic);
const conversationSourcesFromRows = (legacy: Map<string, ConversationEntry>, canonical: Map<string, ConversationEntry | Witness>, topic: string, expected?: ExpectedForgetOwner): { sources: ForgetSource[]; incomplete: boolean } => {
  const sources: ForgetSource[] = [];
  let incomplete = false;
  const expectedPrefix = expected ? `${CANONICAL_PREFIX}${expected.principal_ref}:${expected.tenant_ref}:` : null;
  const ownEntries = new Map<string, ConversationEntry | null>();
  if (expectedPrefix) for (const [key, value] of canonical) if (key.startsWith(expectedPrefix) && canonicalKind(key) === 'conv') {
    const entry = value as ConversationEntry;
    ownEntries.set(entry.id, ownEntries.has(entry.id) ? null : entry);
  }
  const verified = (key: string, entry: ConversationEntry) => {
    if (!expected || !expectedPrefix) return true;
    if (!key.startsWith(expectedPrefix) || entry.ownerId !== expected.principal_ref) return false;
    const witness = canonical.get(`${expectedPrefix}witness:${entry.id}`) as Witness | undefined;
    if (!witness || witness.lineage !== 'canonical_v1' || witness.principal_ref !== expected.principal_ref || witness.tenant_ref !== expected.tenant_ref || JSON.stringify(witness.entry) !== JSON.stringify(entry)) return false;
    return JSON.stringify(ownEntries.get(entry.id)) === JSON.stringify(entry);
  };
  const add = (key: string, entry: ConversationEntry) => {
    const fields = [['model', entry.modelPayload], ['app', entry.appPayload], ...(entry.modelProjection.mode === 'replace' ? [['replace', entry.modelProjection.payload]] : [])] as const;
    // Shared safety line: a hiding escape can spell the topic where asciiLiteralIncludes cannot see it, so the entry is held, never read as clean.
    if (fields.some(([, text]) => conversationHides(text, topic))) incomplete = true;
    for (const [field, text] of fields) if (asciiLiteralIncludes(text, topic)) {
      if (!verified(key, entry)) { incomplete = true; continue; }
      sources.push({ ref: `conversation:${key}:${field}`, text });
    }
  };
  for (const [key, entry] of legacy) add(key, entry);
  for (const [key, value] of canonical) {
    if (canonicalKind(key) === 'conv') add(key, value as ConversationEntry);
    else if (canonicalKind(key) === 'witness') add(key, (value as Witness).entry);
  }
  return { sources, incomplete };
};
const entryText = (entry: ConversationEntry): string => `${entry.modelPayload}\n${entry.appPayload}\n${entry.modelProjection.mode === 'replace' ? entry.modelProjection.payload : ''}`.toLowerCase();

export const redactConversationEntries = async (
  storage: KeyValueStorage,
  texts: readonly string[],
  marker: string,
  scope?: RunEffectScope,
): Promise<Readonly<{ rewritten: number; remaining: number }>> => {
  const needles = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
  if (needles.length === 0) return { rewritten: 0, remaining: 0 };
  const redact = literalTextRedactor(needles, marker);
  const legacy = await storage.list<ConversationEntry>({ prefix: 'conv:' });
  const canonical = await storage.list<ConversationEntry | Witness>({ prefix: CANONICAL_PREFIX });
  const writes: Record<string, unknown> = {};
  let rewritten = 0;
  for (const [key, entry] of legacy) {
    const next = redactConversationEntry(entry, redact);
    if (JSON.stringify(next) !== JSON.stringify(entry)) { writes[key] = next; rewritten += 1; }
  }
  for (const [key, value] of canonical) {
    if (canonicalKind(key) === 'conv') {
      const entry = value as ConversationEntry;
      const next = redactConversationEntry(entry, redact);
      if (JSON.stringify(next) !== JSON.stringify(entry)) { writes[key] = next; rewritten += 1; }
    } else if (canonicalKind(key) === 'witness') {
      const witness = value as Witness;
      if (!witness?.entry) continue;
      const next = redactConversationEntry(witness.entry, redact);
      if (JSON.stringify(next) !== JSON.stringify(witness.entry)) writes[key] = { ...witness, entry: next };
    }
  }
  if (Object.keys(writes).length > 0) {
    if (scope) { if (!storage.kv) throw new Error('fenced redaction store unavailable'); scope.commit(() => { for (const [key, value] of Object.entries(writes)) storage.kv!.put(key, value); }); }
    else {
      // Durable Object put takes at most 128 keys, and a failure between puts must never leave a redacted canonical row next to
      // an old-text witness (load() throws on a mismatch). So a conv row and its witness are one unit and always share a put;
      // units are packed up to 100 keys; legacy rows stand alone.
      const units: string[][] = [];
      const taken = new Set<string>();
      for (const [key, value] of Object.entries(writes)) {
        if (taken.has(key)) continue;
        const unit = [key];
        if (canonicalKind(key) === 'conv') {
          const witnessKey = `${key.split(':').slice(0, 3).join(':')}:witness:${(value as ConversationEntry).id}`;
          if (witnessKey in writes) unit.push(witnessKey);
        }
        for (const k of unit) taken.add(k);
        units.push(unit);
      }
      let chunk: string[] = [];
      const flush = async () => { if (chunk.length) await storage.put(Object.fromEntries(chunk.map((k) => [k, writes[k]]))); chunk = []; };
      for (const unit of units) {
        if (chunk.length + unit.length > 100) await flush();
        chunk.push(...unit);
      }
      await flush();
    }
  }
  const hit = (entry: ConversationEntry): boolean => needles.some((needle) => entryText(entry).includes(needle.toLowerCase()) || [entry.modelPayload, entry.appPayload, ...(entry.modelProjection.mode === 'replace' ? [entry.modelProjection.payload] : [])].some(text => conversationHides(text, needle)));
  const afterLegacy = rewritten > 0 ? await storage.list<ConversationEntry>({ prefix: 'conv:' }) : legacy;
  const afterCanonical = Object.keys(writes).length > 0 ? await storage.list<ConversationEntry | Witness>({ prefix: CANONICAL_PREFIX }) : canonical;
  let remaining = 0;
  for (const [, entry] of afterLegacy) if (hit(entry)) remaining += 1;
  for (const [key, value] of afterCanonical) {
    if (canonicalKind(key) === 'conv' && hit(value as ConversationEntry)) remaining += 1;
    else if (canonicalKind(key) === 'witness' && (value as Witness)?.entry && hit((value as Witness).entry)) remaining += 1;
  }
  return { rewritten, remaining };
};
