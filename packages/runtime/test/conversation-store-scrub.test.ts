import { describe, expect, it } from 'vitest';
import { durableConversationStore, scrubConversationHistory } from '../src/channels/conversation-store';
import type { ConversationEntry } from '@waldo/contracts';

const entry = (id: string, modelPayload: string, appPayload: string): ConversationEntry => ({
  id, ownerId: 'o', chatId: 'c', parentId: null, threadAnchorId: null, surface: 'telegram',
  modelPayload, appPayload, modelProjection: { mode: 'include' },
});

const fakeStorage = (seed: Record<string, unknown>) => {
  const data = new Map(Object.entries(seed));
  return {
    data,
    get: async <T>(k: string) => data.get(k) as T | undefined,
    list: async <T>({ prefix }: { prefix: string }) => new Map([...data].filter(([k]) => k.startsWith(prefix)) as [string, T][]),
    put: async (rows: Record<string, unknown> | string, value?: unknown) => {
      if (typeof rows === 'string') data.set(rows, value); else for (const [k, v] of Object.entries(rows)) data.set(k, v);
    },
  };
};

describe('history scrub (S1)', () => {
  it('redacts secret URLs already stored in history, once', async () => {
    const storage = fakeStorage({
      'conv:0000000001': entry('a', 'use https://accounts.google.com/o/oauth2/v2/auth?state=x', 'same https://accounts.google.com/o/oauth2/v2/auth?state=x'),
      'conv:0000000002': entry('b', 'totally fine', 'also fine'),
    });
    expect(await scrubConversationHistory(storage as never)).toBe(1);
    const a = storage.data.get('conv:0000000001') as ConversationEntry;
    expect(a.modelPayload).toBe('use [link removed]');
    expect(a.appPayload).toBe('same [link removed]');
    expect((storage.data.get('conv:0000000002') as ConversationEntry).modelPayload).toBe('totally fine');
    expect(await scrubConversationHistory(storage as never)).toBe(0);
  });
});

describe('store write scrub', () => {
  it('never persists a secret URL on save', async () => {
    const storage = fakeStorage({});
    const store = durableConversationStore(storage as never);
    await store.save([entry('a', 'https://accounts.google.com/o/oauth2/v2/auth?state=x', 'ok')], 'a');
    const saved = storage.data.get('conv:0000000000') as ConversationEntry;
    expect(saved.modelPayload).toBe('[link removed]');
    expect(saved.appPayload).toBe('ok');
  });
});
