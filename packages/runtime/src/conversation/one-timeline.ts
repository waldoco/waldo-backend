import { conversationModelMessages, type ConversationEntry, type ConversationModelMessage } from '@waldo/contracts';
import { surfaceLabelled } from './compaction';
import { windowModelMessages } from './window';

// One owner timeline across surfaces: with the switch on, the owner's WhatsApp turns read and write the same chain as their app
// chat, each row keeping the surface it was written on.
export const oneTimelineEnabled = (env: Readonly<{ WALDO_ONE_TIMELINE?: string }>): boolean => env.WALDO_ONE_TIMELINE === '1';

// The cutover is forward-only. The owner's WhatsApp chain from before stays stored as it is, and reaches the timeline once, through
// the next summary of the owner's own chain: the owner's own words in it, labelled with their surface, newest kept within the
// budget. Waldo's replies are left out. The owner's words are what must not be lost, and a reply can carry a relayed reading
// the summary's health floor would refuse every time. unchanged() and mark() run inside the commit that writes the summary, so
// the carry is marked exactly when the summary lands, and a legacy row a forget rewrote meanwhile stops it.
export type TimelineSeed = Readonly<{
  read(): Readonly<{ messages: readonly ConversationModelMessage[]; rows: number }> | null;
  unchanged(): boolean;
  mark(): void;
}>;
export const TIMELINE_SEEDED_KEY = 'one_timeline_seeded_v1';
export const timelineSeed = (kv: Pick<DurableObjectStorage['kv'], 'get' | 'put' | 'list'>, chatId: () => string | undefined, budgetTokens: number): TimelineSeed => {
  let seen: string | null = null;
  const ownerRows = (id: string) => [...kv.list<ConversationEntry>({ prefix: 'conv:' })].map(([, entry]) => entry)
    .filter(entry => entry.chatId === id && entry.role === 'user' && entry.inputOrigin === 'owner');
  return {
    read() {
      const id = chatId();
      if (!id || kv.get<boolean>(TIMELINE_SEEDED_KEY)) return null;
      const rows = ownerRows(id);
      seen = JSON.stringify(rows);
      const messages = windowModelMessages(conversationModelMessages(rows.map(surfaceLabelled)), budgetTokens).messages;
      return messages.length ? { messages, rows: rows.length } : null;
    },
    unchanged() { const id = chatId(); return seen !== null && id !== undefined && JSON.stringify(ownerRows(id)) === seen; },
    mark() { kv.put(TIMELINE_SEEDED_KEY, true); },
  };
};
