import { describe, expect, it } from 'vitest';
import { exportConversation } from './conversation-export';
import type { ConversationEntry } from './conversation-entry';

const entry = (overrides: Partial<ConversationEntry> = {}): ConversationEntry => ({
  id: 'root', ownerId: 'owner-a', chatId: 'chat-a', parentId: null, threadAnchorId: null,
  surface: 'app', modelPayload: 'private model context', appPayload: 'visible root',
  modelProjection: { mode: 'include' }, ...overrides,
});

describe('exportConversation', () => {
  it('exports only the selected leaf ancestry and app-visible projection', () => {
    const exported = exportConversation({
      authenticatedOwnerId: 'owner-a', chatId: 'chat-a', leafId: 'branch', generatedAt: 5,
      entries: [
        entry(),
        entry({ id: 'main', parentId: 'root', appPayload: 'main' }),
        entry({ id: 'branch', parentId: 'root', threadAnchorId: 'root', surface: 'telegram', appPayload: 'branch', modelPayload: 'hidden raw' }),
      ],
    });
    expect(exported.entries.map((item) => item.id)).toEqual(['root', 'branch']);
    expect(exported.entries).toEqual([
      { id: 'root', parentId: null, threadAnchorId: null, surface: 'app', appPayload: 'visible root' },
      { id: 'branch', parentId: 'root', threadAnchorId: 'root', surface: 'telegram', appPayload: 'branch' },
    ]);
    expect(JSON.stringify(exported)).not.toContain('private model context');
    expect(JSON.stringify(exported)).not.toContain('hidden raw');
    expect(JSON.stringify(exported)).not.toContain('modelProjection');
  });

  it('fails closed on cross-owner, cross-chat and missing-leaf exports', () => {
    const base = { authenticatedOwnerId: 'owner-a', chatId: 'chat-a', leafId: 'root', generatedAt: 5 };
    expect(() => exportConversation({ ...base, entries: [entry({ ownerId: 'owner-b' })] })).toThrow('boundary mismatch');
    expect(() => exportConversation({ ...base, entries: [entry({ chatId: 'chat-b' })] })).toThrow('boundary mismatch');
    expect(() => exportConversation({ ...base, leafId: 'missing', entries: [entry()] })).toThrow('leaf not found');
  });

  it('returns an immutable point-in-time export', () => {
    const source = entry();
    const exported = exportConversation({ authenticatedOwnerId: 'owner-a', chatId: 'chat-a', leafId: 'root', generatedAt: 5, entries: [source] });
    (source as { appPayload: string }).appPayload = 'mutated';
    expect(exported.entries[0]?.appPayload).toBe('visible root');
    expect(Object.isFrozen(exported)).toBe(true);
    expect(Object.isFrozen(exported.entries)).toBe(true);
    expect(Object.isFrozen(exported.entries[0])).toBe(true);
  });
});
