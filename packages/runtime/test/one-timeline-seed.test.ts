import { expect, it } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';
import { TIMELINE_CARRIED_KEY, TIMELINE_CARRIED_ROWS_KEY, timelineSeed } from '../src/conversation/one-timeline';

const row = (id: string, role: 'user' | 'assistant', text: string, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({ id, ownerId: 'o', chatId: 'whatsapp-1555', parentId: null,
  threadAnchorId: null, surface: 'whatsapp', modelPayload: text, appPayload: text, modelProjection: { mode: 'include' }, role,
  ...(role === 'user' ? { inputOrigin: 'owner' as const, ownerWordsOnly: true as const } : {}), ...extra });
// The object's kv, holding the legacy chain as conv: rows in key order.
const kvOf = (rows: readonly ConversationEntry[] = []) => {
  const map = new Map<string, unknown>();
  const append = (entry: ConversationEntry) => map.set(`conv:${String([...map.keys()].filter(key => key.startsWith('conv:')).length).padStart(10, '0')}`, entry);
  rows.forEach(append);
  return { map, append, get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); },
    list: <T>({ prefix, startAfter }: { prefix?: string; startAfter?: string } = {}) => [...map].filter(([key]) => key.startsWith(prefix ?? '') && (startAfter === undefined || key > startAfter))
      .sort(([a], [b]) => a.localeCompare(b)) as [string, T][] };
};
const chat = () => ['whatsapp-1555'];
const texts = (read: ReturnType<ReturnType<typeof timelineSeed>['read']>) => read?.messages.map(message => message.content);

it('carries what the owner wrote in their own words, labelled with their surface, and nothing else', () => {
  const read = timelineSeed(kvOf([
    row('1', 'user', 'My gym is at 7.'), row('1-reply', 'assistant', 'Noted.'),
    row('brief', 'user', '[Scheduled card "The Daily Brief"] transcript and health logs', { inputOrigin: 'machine', ownerWordsOnly: undefined }),
    row('fwd', 'user', 'Your HRV this morning: 38 ms.', { ownerWordsOnly: undefined }),
    row('t1', 'user', 'From another chat.', { chatId: 'telegram-9', surface: 'telegram' }),
  ]) as never, chat, 10_000).read();
  expect(texts(read)).toEqual(['[on WhatsApp] My gym is at 7.']);
  expect(read?.rows).toBe(1);
});

it('the mark is the last legacy row carried: what the chain gains later is carried next, and nothing twice', () => {
  const kv = kvOf([row('1', 'user', 'My gym is at 7.')]);
  const seed = timelineSeed(kv as never, chat, 10_000);
  expect(texts(seed.read())).toEqual(['[on WhatsApp] My gym is at 7.']);
  seed.mark('owner:o');
  expect(kv.map.get(TIMELINE_CARRIED_KEY)).toBe('conv:0000000000');
  expect(kv.map.get(TIMELINE_CARRIED_ROWS_KEY)).toEqual({ 'owner:o': ['conv:0000000000'] });
  expect(seed.read()).toBeNull();
  kv.append(row('2', 'user', 'My dentist is on Tuesday.'));
  expect(texts(seed.read())).toEqual(['[on WhatsApp] My dentist is on Tuesday.']);
});

it('with nothing to carry the mark moves on, and with no number on the timeline nothing is read or marked', () => {
  const kv = kvOf([row('1-reply', 'assistant', 'Noted.'), row('fwd', 'user', 'Forwarded.', { ownerWordsOnly: undefined })]);
  expect(timelineSeed(kv as never, chat, 10_000).read()).toBeNull();
  expect(kv.map.get(TIMELINE_CARRIED_KEY)).toBe('conv:0000000001');
  const off = kvOf([row('1', 'user', 'Hi.')]);
  expect(timelineSeed(off as never, () => [], 10_000).read()).toBeNull();
  expect(off.map.get(TIMELINE_CARRIED_KEY)).toBeUndefined();
});

it('tells the commit whether the rows it carried are still stored as read, and still on the timeline', () => {
  const kv = kvOf([row('1', 'user', 'My sister Priya lands Thursday.')]);
  let on = true;
  const seed = timelineSeed(kv as never, () => on ? ['whatsapp-1555'] : [], 10_000);
  expect(seed.unchanged()).toBe(false);
  seed.read();
  expect(seed.unchanged()).toBe(true);
  on = false;
  expect(seed.unchanged()).toBe(false);
  on = true;
  kv.put('conv:0000000000', row('1', 'user', 'My sister [forgotten] lands Thursday.'));
  expect(seed.unchanged()).toBe(false);
});

it('keeps the newest of a long chain within its budget', () => {
  const long = Array.from({ length: 400 }, (_, index) => row(`r${index}`, 'user', `message ${index} ${'x'.repeat(400)}`));
  const read = timelineSeed(kvOf(long) as never, chat, 2_000).read();
  expect(read!.messages.length).toBeLessThan(400);
  expect(read!.messages.at(-1)!.content).toContain('message 399');
});

it('carries every chat on the timeline under one mark, each labelled with its surface', () => {
  const kv = kvOf([row('1', 'user', 'My gym is at 7.'), row('t1', 'user', 'My flight lands at 9.', { chatId: 'telegram-7', surface: 'telegram' })]);
  const seed = timelineSeed(kv as never, () => ['whatsapp-1555', 'telegram-7'], 10_000);
  expect(texts(seed.read())).toEqual(['[on WhatsApp] My gym is at 7.', '[on Telegram] My flight lands at 9.']);
  seed.mark('owner:o');
  expect(kv.map.get(TIMELINE_CARRIED_ROWS_KEY)).toEqual({ 'owner:o': ['conv:0000000000', 'conv:0000000001'] });
  expect(seed.read()).toBeNull();
});
