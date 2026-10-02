import { describe, expect, it } from 'vitest';
import { ConversationTree, literalJsonTextRedactor, type ConversationEntry } from './conversation-entry';

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
  it('redacts every retained payload and replacement projection while preserving topology and frozen roles', () => {
    const tree = new ConversationTree();
    const needle = 'Synthetic [blue] "note" $&';
    tree.append(entry({ modelPayload: needle, appPayload: needle.toUpperCase(), role: 'user' }));
    tree.append(entry({ id: 'leaf', parentId: 'root', threadAnchorId: 'root', role: 'assistant', modelPayload: 'unrelated', appPayload: 'unrelated', modelProjection: { mode: 'replace', payload: `${needle}; unrelated` } }));
    tree.redact([needle], '[forgotten]');
    expect(tree.modelContext('leaf')).toEqual([{ role: 'user', content: '[forgotten]' }, { role: 'assistant', content: '[forgotten]; unrelated' }]);
    expect(tree.appContext('leaf')).toEqual(['[forgotten]', 'unrelated']);
    expect(tree.get('leaf')).toMatchObject({ id: 'leaf', parentId: 'root', threadAnchorId: 'root', role: 'assistant' });
    expect(Object.isFrozen(tree.get('leaf'))).toBe(true);
    expect(Object.isFrozen(tree.get('leaf')!.modelProjection)).toBe(true);
  });

  it('redacts escaped JSON string values and capped/budget-suffixed copies with literal metacharacters', () => {
    const needle = 'Synthetic "blue" [origami]';
    const redact = literalJsonTextRedactor([needle], '[forgotten]');
    const body = JSON.stringify({ data: { text: needle, unrelated: 'amber' } });
    expect(JSON.parse(redact(body))).toEqual({ data: { text: '[forgotten]', unrelated: 'amber' } });
    expect(JSON.parse(redact(JSON.stringify({ [needle]: 'unrelated' })))).toEqual({ '[forgotten]': 'unrelated' });
    expect(redact(body + '\n[budget: fixture]')).toBe(JSON.stringify({ data: { text: '[forgotten]', unrelated: 'amber' } }) + '\n[budget: fixture]');
    expect(redact(body.slice(0, -1) + '...')).not.toContain(JSON.stringify(needle).slice(1, -1));
  });

  it('preserves argument keys and typed result authority, failing closed on protected-key collisions', () => {
    const argument = literalJsonTextRedactor(['id'], '[forgotten]', 'arguments');
    expect(() => argument(JSON.stringify({ id: 'unrelated' }))).toThrow('cannot be safely sanitised');
    const result = literalJsonTextRedactor(['source_taint'], '[forgotten]', 'tool_result');
    expect(() => result(JSON.stringify({ ok: true, data: 'unrelated', source_taint: 'external' }))).toThrow('cannot be safely sanitised');
    const data = literalJsonTextRedactor(['private fixture'], '[forgotten]', 'tool_result');
    expect(JSON.parse(data(JSON.stringify({ ok: true, data: { 'private fixture': 'unrelated' }, source_taint: 'external' })))).toEqual({ ok: true, data: { '[forgotten]': 'unrelated' }, source_taint: 'external' });
    expect(() => literalJsonTextRedactor(['private fixture'], '[forgotten]')(JSON.stringify({ 'private fixture': 'a', '[forgotten]': 'b' }))).toThrow('cannot be safely sanitised');
    expect(() => data('{"ok":true,"data":{"text":"private fixture"}...')).toThrow('cannot be safely sanitised');
    expect(data('Plain private fixture summary')).toBe('Plain [forgotten] summary');
  });

});

it('preserves exact tool argument bytes when forgetting changes no content', () => {
  const original = '{\n  "path": "notes/fixture.txt", "text": "\\u0939"\n}';
  for (const texts of [[], ['unrelated forgotten text']]) {
    expect(literalJsonTextRedactor(texts, '[forgotten]', 'arguments')(original)).toBe(original);
  }
});
