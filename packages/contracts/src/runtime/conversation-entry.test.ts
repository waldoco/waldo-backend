import { describe, expect, it } from 'vitest';
import { ConversationTree, type ConversationEntry } from './conversation-entry';

const entry = (overrides: Partial<ConversationEntry> = {}): ConversationEntry => ({
  id: 'root', ownerId: 'owner-a', chatId: 'chat-a', parentId: null,
  threadAnchorId: null, surface: 'app', modelPayload: 'model:root',
  appPayload: 'app:root', modelProjection: { mode: 'include' }, ...overrides,
});

describe('ConversationTree', () => {
  it('builds context from the active leaf ancestry instead of siblings', () => {
    const tree = new ConversationTree();
    tree.append(entry());
    tree.append(entry({ id: 'main', parentId: 'root', modelPayload: 'main', appPayload: 'main' }));
    tree.append(entry({ id: 'branch', parentId: 'root', threadAnchorId: 'root', modelPayload: 'branch', appPayload: 'branch' }));
    expect(tree.modelContext('branch')).toEqual([{ role: 'user', content: 'model:root' }, { role: 'user', content: 'branch' }]);
    expect(tree.appContext('main')).toEqual(['app:root', 'main']);
  });

  it('preserves typed user/assistant turns, derives legacy roles, and keeps roles through omit/replace projections', () => {
    const tree = new ConversationTree();
    tree.append(entry({ id: 'u1', role: 'user' }));
    tree.append(entry({ id: 'u1-reply', parentId: 'u1', role: 'assistant', modelPayload: 'waldo answer' }));
    tree.append(entry({ id: 'u2', parentId: 'u1-reply', role: 'user', modelPayload: 'next question' }));
    // legacy row without a stamped role: the -reply id convention marks the assistant turn
    tree.append(entry({ id: 'u2-reply', parentId: 'u2', modelPayload: 'legacy answer' }));
    tree.append(entry({ id: 'u3', parentId: 'u2-reply', role: 'user', modelPayload: 'hidden note', modelProjection: { mode: 'omit' } }));
    tree.append(entry({ id: 'u4', parentId: 'u3', role: 'user', modelPayload: 'raw secret', modelProjection: { mode: 'replace', payload: 'summarised' } }));
    expect(tree.modelContext('u4')).toEqual([
      { role: 'user', content: 'model:root' },
      { role: 'assistant', content: 'waldo answer' },
      { role: 'user', content: 'next question' },
      { role: 'assistant', content: 'legacy answer' },
      { role: 'user', content: 'summarised' },
    ]);
  });

  it('keeps model and app payload projections separate', () => {
    const tree = new ConversationTree();
    tree.append(entry());
    tree.append(entry({ id: 'hidden', parentId: 'root', modelPayload: 'secret', appPayload: 'visible', modelProjection: { mode: 'omit' } }));
    tree.append(entry({ id: 'replaced', parentId: 'hidden', modelPayload: 'raw', appPayload: 'raw-visible', modelProjection: { mode: 'replace', payload: 'summary' } }));
    expect(tree.modelContext('replaced')).toEqual([{ role: 'user', content: 'model:root' }, { role: 'user', content: 'summary' }]);
    expect(tree.appContext('replaced')).toEqual(['app:root', 'visible', 'raw-visible']);
  });

  it('rejects duplicates, missing parents and cross-owner or cross-chat parents', () => {
    const tree = new ConversationTree();
    tree.append(entry());
    expect(() => tree.append(entry())).toThrow('already exists');
    expect(() => tree.append(entry({ id: 'missing', parentId: 'nope' }))).toThrow('parent not found');
    expect(() => tree.append(entry({ id: 'owner-b', ownerId: 'owner-b', parentId: 'root' }))).toThrow('boundary mismatch');
    expect(() => tree.append(entry({ id: 'chat-b', chatId: 'chat-b', parentId: 'root' }))).toThrow('boundary mismatch');
  });

  it('requires a thread anchor to be an ancestor in the same owner chat', () => {
    const tree = new ConversationTree();
    tree.append(entry());
    tree.append(entry({ id: 'sibling', parentId: 'root' }));
    expect(() => tree.append(entry({ id: 'bad', parentId: 'root', threadAnchorId: 'sibling' }))).toThrow('must be an ancestor');
    expect(() => tree.append(entry({ id: 'bad-root', threadAnchorId: 'root' }))).toThrow('root cannot have');
  });

  it('copies and freezes appended entries so caller mutation cannot rewrite history', () => {
    const source = entry();
    const tree = new ConversationTree();
    tree.append(source);
    (source as { modelPayload: string }).modelPayload = 'mutated';
    expect(tree.get('root')?.modelPayload).toBe('model:root');
    expect(Object.isFrozen(tree.get('root'))).toBe(true);
  });
});
