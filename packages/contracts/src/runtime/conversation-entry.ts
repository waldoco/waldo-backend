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
