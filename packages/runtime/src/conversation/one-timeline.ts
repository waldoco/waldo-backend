import { conversationModelMessages, type ConversationEntry, type ConversationModelMessage } from '@waldo/contracts';
import { surfaceLabelled } from './compaction';
import { windowModelMessages } from './window';

// One owner timeline across surfaces: with the switch on, the owner's WhatsApp turns read and write the same chain as their app
// chat, each row keeping the surface it was written on.
export const oneTimelineEnabled = (env: Readonly<{ WALDO_ONE_TIMELINE?: string }>): boolean => env.WALDO_ONE_TIMELINE === '1';

// The cutover is forward-only. The owner's chat chains stay stored as they are, and what they hold past the carried mark reaches
// the timeline through the next summary of the owner's own chain: the messages the owner wrote in their own words, labelled
// with their surface, newest kept within the budget. Waldo's replies, and owner messages that carried someone else's words or
// were stored before inputs were stamped, are left out: what is carried counts as the owner's words for the summary's health
// floor. The mark is the key of the last legacy row carried, so rows a chat chain gains while its turns are off the
// timeline are carried when they rejoin. unchanged() and mark() run inside the commit that writes the summary, so the mark
// moves exactly when the summary lands, and a carried row a forget rewrote meanwhile stops it.
export type TimelineSeed = Readonly<{
  read(): Readonly<{ messages: readonly ConversationModelMessage[]; rows: number }> | null;
  unchanged(): boolean;
  mark(): void;
}>;
export const TIMELINE_CARRIED_KEY = 'one_timeline_carried_v1';
type Kv = Pick<DurableObjectStorage['kv'], 'get' | 'put' | 'list'>;
export const timelineSeed = (kv: Kv, chatIds: () => readonly string[], budgetTokens: number): TimelineSeed => {
  let seen: Readonly<{ rows: string; last: string; ids: string }> | null = null;
  const since = (ids: readonly string[]) => {
    const after = kv.get<string>(TIMELINE_CARRIED_KEY);
    const listed = [...kv.list<ConversationEntry>({ prefix: 'conv:', ...(after ? { startAfter: after } : {}) })];
    const rows = listed.map(([, entry]) => entry)
      .filter(entry => ids.includes(entry.chatId) && entry.role === 'user' && entry.inputOrigin === 'owner' && entry.ownerWordsOnly === true);
    return { rows, last: listed.at(-1)?.[0] };
  };
  return {
    read() {
      seen = null;
      const ids = chatIds();
      if (!ids.length) return null;
      const { rows, last } = since(ids);
      if (!last) return null;
      const messages = windowModelMessages(conversationModelMessages(rows.map(surfaceLabelled)), budgetTokens).messages;
      // Nothing to carry up to here: the mark moves on, so the next read starts after it.
      if (!messages.length) { kv.put(TIMELINE_CARRIED_KEY, last); return null; }
      seen = { rows: JSON.stringify(rows), last, ids: JSON.stringify(ids) };
      return { messages, rows: rows.length };
    },
    unchanged() {
      const ids = chatIds();
      return seen !== null && JSON.stringify(ids) === seen.ids && JSON.stringify(since(ids).rows) === seen.rows;
    },
    mark() { if (seen) kv.put(TIMELINE_CARRIED_KEY, seen.last); },
  };
};
