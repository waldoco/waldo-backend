import { describe, expect, it } from 'vitest';
import { ConversationTree, type ConversationEntry } from '@waldo/contracts';
import { durableConversationStore, restoreConversation } from '../src/channels/conversation-store';

const memoryStorage = () => {
  const data = new Map<string, unknown>();
  return {
    get: async (key: string) => data.get(key),
    put: async (entries: Record<string, unknown>) => { for (const [key, value] of Object.entries(entries)) data.set(key, value); },
    list: async ({ prefix }: { prefix: string }) => new Map([...data].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))),
  } as unknown as DurableObjectStorage;
};

const entry = (id: string, parentId: string | null, text: string): ConversationEntry => ({
  id, ownerId: 'owner', chatId: 'telegram-1', parentId, threadAnchorId: null,
  surface: 'telegram', modelPayload: text, appPayload: text, modelProjection: { mode: 'include' },
});

describe('durableConversationStore', () => {
  it('restores the whole conversation into a fresh tree after eviction', async () => {
    const storage = memoryStorage();
    const before = durableConversationStore(storage);
    await before.save([entry('u1', null, 'hi'), entry('a1', 'u1', 'hello')], 'a1');
    await before.save([entry('u2', 'a1', 'plans?'), entry('a2', 'u2', 'gym at 6')], 'a2');

    const tree = new ConversationTree();
    const leaf = await restoreConversation(tree, durableConversationStore(storage));

    expect(leaf).toBe('a2');
    expect(tree.modelContext('a2')).toEqual(['hi', 'hello', 'plans?', 'gym at 6']);
  });

  it('starts empty when nothing was saved', async () => {
    const tree = new ConversationTree();
    expect(await restoreConversation(tree, durableConversationStore(memoryStorage()))).toBeNull();
  });
});
