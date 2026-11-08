import { expect, it } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';
import { TIMELINE_SEEDED_KEY, timelineSeed } from '../src/conversation/one-timeline';

const row = (id: string, role: 'user' | 'assistant', text: string, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({ id, ownerId: 'o', chatId: 'whatsapp-1555', parentId: null,
  threadAnchorId: null, surface: 'whatsapp', modelPayload: text, appPayload: text, modelProjection: { mode: 'include' }, role, ...extra });
const kvOf = () => { const map = new Map<string, unknown>(); return { map, get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); } }; };
const legacyOf = (entries: readonly ConversationEntry[]) => ({ load: async () => ({ entries, leafId: entries.at(-1)?.id ?? null }) });

it('carries the owner\'s exchange and a job\'s reply, never a job\'s prompt or another chat\'s rows', async () => {
  const seed = timelineSeed(kvOf(), legacyOf([
    row('1', 'user', 'My gym is at 7.', { inputOrigin: 'owner' }), row('1-reply', 'assistant', 'Noted.'),
    row('brief', 'user', '[Scheduled card "The Daily Brief"] transcript and health logs', { inputOrigin: 'machine' }), row('brief-reply', 'assistant', 'Clear morning.'),
    row('t1', 'user', 'From Telegram.', { chatId: 'telegram-9' }),
  ]), () => 'whatsapp-1555', 10_000);
  const read = await seed.read();
  expect(read?.messages.map(message => message.content)).toEqual(['My gym is at 7.', 'Noted.', 'Clear morning.']);
  expect(read?.rows).toBe(3);
});

it('reads nothing once the chain is carried, with no bound number, or with no rows', async () => {
  const kv = kvOf();
  const seed = timelineSeed(kv, legacyOf([row('1', 'user', 'Hi.')]), () => 'whatsapp-1555', 10_000);
  expect(await seed.read()).not.toBeNull();
  seed.done();
  expect(kv.map.get(TIMELINE_SEEDED_KEY)).toBe(true);
  expect(await seed.read()).toBeNull();
  expect(await timelineSeed(kvOf(), legacyOf([row('1', 'user', 'Hi.')]), () => undefined, 10_000).read()).toBeNull();
  expect(await timelineSeed(kvOf(), legacyOf([]), () => 'whatsapp-1555', 10_000).read()).toBeNull();
});

it('keeps the newest of a long chain within its budget', async () => {
  const long = Array.from({ length: 400 }, (_, index) => row(`r${index}`, index % 2 ? 'assistant' : 'user', `message ${index} ${'x'.repeat(400)}`));
  const read = await timelineSeed(kvOf(), legacyOf(long), () => 'whatsapp-1555', 2_000).read();
  expect(read!.messages.length).toBeLessThan(400);
  expect(read!.messages.at(-1)!.content).toContain('message 399');
});
