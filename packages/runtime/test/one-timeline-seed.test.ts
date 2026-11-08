import { expect, it } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';
import { TIMELINE_SEEDED_KEY, timelineSeed } from '../src/conversation/one-timeline';

const row = (id: string, role: 'user' | 'assistant', text: string, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({ id, ownerId: 'o', chatId: 'whatsapp-1555', parentId: null,
  threadAnchorId: null, surface: 'whatsapp', modelPayload: text, appPayload: text, modelProjection: { mode: 'include' }, role, ...(role === 'user' ? { inputOrigin: 'owner' as const } : {}), ...extra });
// The object's kv, holding the legacy chain as conv: rows in key order.
const kvOf = (rows: readonly ConversationEntry[] = []) => {
  const map = new Map<string, unknown>(rows.map((entry, index) => [`conv:${String(index).padStart(10, '0')}`, entry]));
  return { map, get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); },
    list: <T>({ prefix }: { prefix?: string } = {}) => [...map].filter(([key]) => key.startsWith(prefix ?? '')).sort(([a], [b]) => a.localeCompare(b)) as [string, T][] };
};
const chat = () => 'whatsapp-1555';

it('carries the owner\'s own words, labelled with their surface, and nothing of Waldo\'s replies, a job\'s prompt or another chat', () => {
  const read = timelineSeed(kvOf([
    row('1', 'user', 'My gym is at 7.'), row('1-reply', 'assistant', 'Noted.'),
    row('brief', 'user', '[Scheduled card "The Daily Brief"] transcript and health logs', { inputOrigin: 'machine' }), row('brief-reply', 'assistant', 'Clear morning.'),
    row('t1', 'user', 'From Telegram.', { chatId: 'telegram-9', surface: 'telegram' }),
  ]) as never, chat, 10_000).read();
  expect(read?.messages.map(message => message.content)).toEqual(['[on WhatsApp] My gym is at 7.']);
  expect(read?.rows).toBe(1);
});

it('reads nothing once marked carried, with no bound number, or with no owner rows', () => {
  const kv = kvOf([row('1', 'user', 'Hi.')]);
  const seed = timelineSeed(kv as never, chat, 10_000);
  expect(seed.read()).not.toBeNull();
  seed.mark();
  expect(kv.map.get(TIMELINE_SEEDED_KEY)).toBe(true);
  expect(seed.read()).toBeNull();
  expect(timelineSeed(kvOf([row('1', 'user', 'Hi.')]) as never, () => undefined, 10_000).read()).toBeNull();
  expect(timelineSeed(kvOf([row('1-reply', 'assistant', 'Noted.')]) as never, chat, 10_000).read()).toBeNull();
});

it('tells the commit whether the rows it carried are still stored as read', () => {
  const kv = kvOf([row('1', 'user', 'My sister Priya lands Thursday.')]);
  const seed = timelineSeed(kv as never, chat, 10_000);
  expect(seed.unchanged()).toBe(false);
  seed.read();
  expect(seed.unchanged()).toBe(true);
  kv.put('conv:0000000000', row('1', 'user', 'My sister [forgotten] lands Thursday.'));
  expect(seed.unchanged()).toBe(false);
});

it('keeps the newest of a long chain within its budget', () => {
  const long = Array.from({ length: 400 }, (_, index) => row(`r${index}`, 'user', `message ${index} ${'x'.repeat(400)}`));
  const read = timelineSeed(kvOf(long) as never, chat, 2_000).read();
  expect(read!.messages.length).toBeLessThan(400);
  expect(read!.messages.at(-1)!.content).toContain('message 399');
});
