export type ConversationSurface = 'app' | 'telegram' | 'cli' | (string & {});

export type ConversationProjection =
  | Readonly<{ mode: 'include' }>
  | Readonly<{ mode: 'omit' }>
  | Readonly<{ mode: 'replace'; payload: string }>;

export type ConversationRole = 'user' | 'assistant';

export type ConversationModelMessage = Readonly<{ role: ConversationRole; content: string }>;

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
  role?: ConversationRole;
}>;

// Privacy redaction uses literal text only; it never decides what the owner meant.
export const literalTextRedactor = (texts: readonly string[], marker: string): ((value: string) => string) => {
  const patterns = [...new Set(texts.map(text => text.trim()).filter(Boolean))]
    .map(text => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  return value => patterns.reduce((text, pattern) => text.replace(pattern, () => marker), value);
};

// Protocol wrappers are preserved; arbitrary data keys are only data.
export const literalJsonTextRedactor = (
  texts: readonly string[], marker: string, mode: 'data' | 'arguments' | 'tool_result' = 'data',
): ((value: string) => string) => {
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

export const redactConversationEntry = (entry: ConversationEntry, redact: (value: string) => string): ConversationEntry => ({
  ...entry,
  modelPayload: redact(entry.modelPayload), appPayload: redact(entry.appPayload),
  modelProjection: entry.modelProjection.mode === 'replace'
    ? { mode: 'replace', payload: redact(entry.modelProjection.payload) } : entry.modelProjection,
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
    return this.path(leafId).flatMap((entry) => {
      const role = entry.role ?? (entry.id.endsWith('-reply') ? 'assistant' : 'user');
      switch (entry.modelProjection.mode) {
        case 'include': return [{ role, content: entry.modelPayload }];
        case 'omit': return [];
        case 'replace': return [{ role, content: entry.modelProjection.payload }];
      }
    });
  }

  appContext(leafId: string): readonly string[] {
    return this.path(leafId).map((entry) => entry.appPayload);
  }

  private ancestorIds(parentId: string | null): string[] {
    if (parentId === null) return [];
    return this.path(parentId).map((entry) => entry.id);
  }
}
