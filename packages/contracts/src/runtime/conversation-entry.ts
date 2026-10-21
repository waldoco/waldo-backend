export type ConversationSurface = 'app' | 'telegram' | 'cli' | (string & {});

export type ConversationProjection =
  | Readonly<{ mode: 'include' }>
  | Readonly<{ mode: 'omit' }>
  | Readonly<{ mode: 'replace'; payload: string }>;

export type ConversationRole = 'user' | 'assistant';

export type ConversationModelMessage = Readonly<{ role: ConversationRole; content: string }>;

// A compaction row summarises the span of original rows it covers, for the model's view only. Its role lives on the
// entry alone: a model message never carries it, so no provider adapter can receive it on the wire.
export type ConversationEntryRole = ConversationRole | 'compaction';
export type ConversationCovers = Readonly<{ from_id: string; to_id: string; rows: number }>;

export type ConversationEntry = Readonly<{
  id: string;
  ownerId: string;
  chatId: string;
  parentId: string | null;
  threadAnchorId: string | null;
  surface: ConversationSurface;
  modelPayload: string;
  appPayload: string;
  modelProjection: ConversationProjection;
  // Stamped by the conversation path that appends the entry. Optional only for rows stored
  // before the seam existed; modelContext derives those from the assistant-entry id convention.
  role?: ConversationEntryRole;
  // The original rows a compaction row carries, directly or through the summary it superseded: the first and last row
  // ids on the chain and how many rows that is. Kept when the row is superseded or omitted, so a forget can find the span.
  covers?: ConversationCovers;
  // Canonical owner-history ingress evidence; older rows remain unstamped.
  inputOrigin?: 'owner' | 'machine';
  // Epoch ms when the path that appends the entry made it. Rows stored before the time was kept have none.
  createdAt?: number;
  // A row Waldo writes about one of the owner's app messages rather than in reply to it: that message's id, and what became of it.
  operation?: Readonly<{ id: string; state: 'interrupted' }>;
  // The turn's effect receipts, typed. `line` is the text form appended to appPayload, so a surface that shows
  // only text still shows it.
  receipt?: ConversationReceipt;
}>;

export type ConversationReceipt = Readonly<{
  line: string;
  items: readonly Readonly<{ kind: string; target: string | null; outcome: 'accepted' | 'failed' | 'unconfirmed'; via_task: boolean; at: number; digest: string | null }>[];
  more: number;
}>;

// Privacy redaction uses literal text only; it never decides what the owner meant.
export const literalTextRedactor = (texts: readonly string[], marker: string): ((value: string) => string) => {
  const patterns = [...new Set(texts.map(text => text.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(text => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  return value => patterns.reduce((text, pattern) => text.replace(pattern, () => marker), value);
};

// Protocol wrappers are preserved; arbitrary data keys are only data.
export const literalJsonTextRedactor = (
  texts: readonly string[], marker: string, mode: 'data' | 'arguments' | 'tool_result' = 'data',
): ((value: string) => string) => {
  if (texts.every(text => !text.trim())) return value => value;
  const redact = literalTextRedactor(texts, marker);
  const encode = (text: string) => JSON.stringify(text).slice(1, -1);
  const escaped = literalTextRedactor(texts.map(encode), encode(marker));
  const failure = () => { throw new Error('forget JSON context cannot be safely sanitised'); };
  const visit = (item: unknown, preserveKeys = false): unknown => {
    if (typeof item === 'string') return redact(item);
    if (Array.isArray(item)) return item.map(child => visit(child, preserveKeys));
    if (item === null || typeof item !== 'object') return item;
    const seen = new Set<string>();
    return Object.fromEntries(Object.entries(item).map(([key, child]) => {
      const clean = redact(key);
      if ((preserveKeys && clean !== key) || seen.has(clean)) return failure();
      seen.add(clean);
      return [preserveKeys ? key : clean, visit(child, preserveKeys)];
    }));
  };
  return value => {
    const split = mode === 'tool_result' ? value.indexOf('\n[budget:') : -1;
    const body = split < 0 ? value : value.slice(0, split);
    const suffix = split < 0 ? '' : value.slice(split);
    let parsed: unknown;
    try { parsed = JSON.parse(body) as unknown; }
    catch {
      const clean = escaped(redact(value));
      if (clean !== value && (mode === 'arguments' || (mode === 'tool_result' && /^[\s]*[\[{]/.test(body)))) return failure();
      return clean;
    }
    if (mode === 'tool_result') {
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        if (JSON.stringify(visit(parsed)) !== JSON.stringify(parsed)) return failure();
        return value;
      }
      const result = Object.fromEntries(Object.entries(parsed).map(([key, item]) => {
        if (redact(key) !== key) return failure();
        return [key, key === 'data' ? visit(item) : key === 'error' ? visit(item, true) : item];
      }));
      return JSON.stringify(result) + suffix;
    }
    return JSON.stringify(visit(parsed, mode === 'arguments')) + suffix;
  };
};

export const COMPACTION_SUMMARY_CLOSE = '[End of summary.]';
export const compactionSummaryOpen = (rows: number): string => `[Waldo's summary of ${rows} earlier messages in this conversation; not the owner's words:]`;
// The model sees a compaction row as one user message that names itself as a summary, so nothing grounds on it as the
// owner's own words. The labels are part of the record, not of any one renderer.
export const compactionMessage = (entry: ConversationEntry, text: string = entry.modelPayload): ConversationModelMessage =>
  ({ role: 'user', content: `${compactionSummaryOpen(entry.covers?.rows ?? 0)}\n${text}\n${COMPACTION_SUMMARY_CLOSE}` });

// The model's view of rows in chain order: each row's projection, with a compaction row rendered as its labelled summary.
export const conversationModelMessages = (entries: readonly ConversationEntry[]): readonly ConversationModelMessage[] => entries.flatMap((entry) => {
  const role = entry.role ?? (entry.id.endsWith('-reply') ? 'assistant' : 'user');
  const projected = entry.modelProjection.mode === 'omit' ? null : entry.modelProjection.mode === 'replace' ? entry.modelProjection.payload : entry.modelPayload;
  if (projected === null) return [];
  return [role === 'compaction' ? compactionMessage(entry, projected) : { role, content: projected }];
});

export const redactConversationEntry = (entry: ConversationEntry, redact: (value: string) => string): ConversationEntry => ({
  ...entry,
  modelPayload: redact(entry.modelPayload), appPayload: redact(entry.appPayload),
  modelProjection: entry.modelProjection.mode === 'replace'
    ? { mode: 'replace', payload: redact(entry.modelProjection.payload) } : entry.modelProjection,
  ...(entry.receipt ? { receipt: { ...entry.receipt, line: redact(entry.receipt.line),
    items: entry.receipt.items.map(item => (item.target === null ? item : { ...item, target: redact(item.target) })) } } : {}),
});

export class ConversationTree {
  private readonly entries = new Map<string, ConversationEntry>();

  append(entry: ConversationEntry): void {
    if (this.entries.has(entry.id)) throw new Error('conversation entry already exists');
    if (entry.parentId === entry.id) throw new Error('conversation entry cannot parent itself');
    const parent = entry.parentId === null ? undefined : this.entries.get(entry.parentId);
    if (entry.parentId !== null && !parent) throw new Error('conversation parent not found');
    if (parent && (
      parent.ownerId !== entry.ownerId ||
      parent.chatId !== entry.chatId
    )) throw new Error('conversation parent boundary mismatch');
    if (entry.parentId === null && entry.threadAnchorId !== null) {
      throw new Error('conversation root cannot have a thread anchor');
    }
    if (entry.threadAnchorId !== null) {
      const anchor = this.entries.get(entry.threadAnchorId);
      if (!anchor || anchor.ownerId !== entry.ownerId || anchor.chatId !== entry.chatId) {
        throw new Error('conversation thread anchor boundary mismatch');
      }
      if (!this.ancestorIds(entry.parentId).includes(entry.threadAnchorId)) {
        throw new Error('conversation thread anchor must be an ancestor');
      }
    }
    this.entries.set(entry.id, Object.freeze({
      ...entry,
      modelProjection: Object.freeze({ ...entry.modelProjection }),
    }));
  }

  redact(texts: readonly string[], marker: string): void {
    const redact = literalTextRedactor(texts, marker);
    for (const [id, entry] of this.entries) {
      const clean = redactConversationEntry(entry, redact);
      this.entries.set(id, Object.freeze({ ...clean, modelProjection: Object.freeze({ ...clean.modelProjection }) }));
    }
  }

  get(id: string): ConversationEntry | undefined {
    return this.entries.get(id);
  }

  path(leafId: string): readonly ConversationEntry[] {
    const leaf = this.entries.get(leafId);
    if (!leaf) throw new Error('conversation leaf not found');
    const path: ConversationEntry[] = [];
    let current: ConversationEntry | undefined = leaf;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.id)) throw new Error('conversation cycle detected');
      seen.add(current.id);
      path.push(current);
      current = current.parentId === null ? undefined : this.entries.get(current.parentId);
      if (!current && path.at(-1)?.parentId !== null) throw new Error('conversation parent not found');
    }
    return path.reverse();
  }

  modelContext(leafId: string): readonly ConversationModelMessage[] {
    return conversationModelMessages(this.path(leafId));
  }

  // The owner's transcript never carries a compaction row.
  appContext(leafId: string): readonly string[] {
    return this.path(leafId).filter((entry) => entry.role !== 'compaction').map((entry) => entry.appPayload);
  }

  // Every row the tree holds, in no order; a reader that needs the chain walks path().
  values(): IterableIterator<ConversationEntry> {
    return this.entries.values();
  }

  // Rewrites one row in place (a compaction row superseded by a newer one); its id and links never change.
  replace(entry: ConversationEntry): void {
    const current = this.entries.get(entry.id);
    if (!current) throw new Error('conversation entry not found');
    if (current.parentId !== entry.parentId || current.threadAnchorId !== entry.threadAnchorId) throw new Error('conversation entry links cannot change');
    this.entries.set(entry.id, Object.freeze({ ...entry, modelProjection: Object.freeze({ ...entry.modelProjection }) }));
  }

  private ancestorIds(parentId: string | null): string[] {
    if (parentId === null) return [];
    return this.path(parentId).map((entry) => entry.id);
  }
}
