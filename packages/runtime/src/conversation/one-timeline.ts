import { conversationModelMessages, type ConversationModelMessage } from '@waldo/contracts';
import type { ConversationStore } from '../channels/conversation-store';
import type { RunEffectScope } from '../channels/run-effect-scope';
import { windowModelMessages } from './window';

// One owner timeline across surfaces: with the switch on, the owner's WhatsApp turns read and write the same chain as their app
// chat, each row keeping the surface it was written on.
export const oneTimelineEnabled = (env: Readonly<{ WALDO_ONE_TIMELINE?: string }>): boolean => env.WALDO_ONE_TIMELINE === '1';

// The cutover is forward-only. The owner's WhatsApp chain from before stays stored as it is, and reaches the timeline once,
// through the next summary of the owner's chain: its model view, cut to the given budget, newest kept.
export type TimelineSeed = Readonly<{
  read(): Promise<Readonly<{ messages: readonly ConversationModelMessage[]; rows: number }> | null>;
  done(scope?: RunEffectScope): void;
}>;
export const TIMELINE_SEEDED_KEY = 'one_timeline_seeded_v1';
export const timelineSeed = (kv: Pick<DurableObjectStorage['kv'], 'get' | 'put'>, legacy: Pick<ConversationStore, 'load'>, chatId: () => string | undefined,
  budgetTokens: number): TimelineSeed => ({
  async read() {
    const id = chatId();
    if (!id || kv.get<boolean>(TIMELINE_SEEDED_KEY)) return null;
    // A job's request row is its working material, not the owner's conversation: its reply is carried, its prompt is not.
    const chain = (await legacy.load()).entries.filter(entry => entry.chatId === id && !(entry.role === 'user' && entry.inputOrigin === 'machine'));
    const messages = windowModelMessages(conversationModelMessages(chain), budgetTokens).messages;
    return messages.length ? { messages, rows: chain.length } : null;
  },
  done(scope) { const mark = () => kv.put(TIMELINE_SEEDED_KEY, true); if (scope) scope.commit(mark); else mark(); },
});
