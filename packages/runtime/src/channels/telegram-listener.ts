import type { TelegramInboundTurn, TelegramPollingAdapter } from './telegram-polling';

export type TelegramOwnerApi = Readonly<{
  setMessageReaction(request: Readonly<{ chat_id: number; message_id: number; reaction: readonly Readonly<{ type: 'emoji'; emoji: string }>[] }>): Promise<unknown>;
  sendChatAction(request: Readonly<{ chat_id: number; action: 'typing' }>): Promise<unknown>;
  sendMessage(request: Readonly<{ chat_id: number; text: string }>): Promise<unknown>;
}>;

export type TelegramOwnerListenerOptions = Readonly<{
  ownerTelegramId: number;
  api: TelegramOwnerApi;
  respond(turn: TelegramInboundTurn): Promise<string>;
  saveOffset(offset: number): Promise<void>;
  progressAfterMs?: number;
  typingEveryMs?: number;
  ackEmoji?: string;
  progressText?: string;
  failureText?: string;
}>;

export type TelegramTurnOutcome = 'answered' | 'failed' | 'ignored';

export class TelegramOwnerListener {
  constructor(private readonly options: TelegramOwnerListenerOptions) {
    if (!Number.isSafeInteger(options.ownerTelegramId) || options.ownerTelegramId <= 0) {
      throw new Error('telegram owner id is invalid');
    }
  }

  async pollOnce(adapter: TelegramPollingAdapter, timeout = 25): Promise<readonly TelegramTurnOutcome[]> {
    const polled = await adapter.poll(timeout);
    const outcomes: TelegramTurnOutcome[] = [];
    for (const turn of polled.accepted) outcomes.push(await this.handle(turn));
    await this.options.saveOffset(polled.nextOffset);
    return outcomes;
  }

  async handle(turn: TelegramInboundTurn): Promise<TelegramTurnOutcome> {
    const owner = this.options.ownerTelegramId;
    if (turn.senderId !== owner || turn.chatId !== owner) return 'ignored';
    const { api } = this.options;
    const chat_id = turn.chatId;
    if (turn.messageId !== null) {
      await api.setMessageReaction({ chat_id, message_id: turn.messageId, reaction: [{ type: 'emoji', emoji: this.options.ackEmoji ?? '👀' }] }).catch(() => undefined);
    }
    const typing = () => api.sendChatAction({ chat_id, action: 'typing' }).catch(() => undefined);
    await typing();
    const typingTimer = setInterval(typing, this.options.typingEveryMs ?? 4_000);
    const progressTimer = setTimeout(() => {
      void api.sendMessage({ chat_id, text: this.options.progressText ?? 'On it - still working on this, reply coming shortly.' }).catch(() => undefined);
    }, this.options.progressAfterMs ?? 8_000);
    try {
      const text = (await this.options.respond(turn)).trim();
      if (text.length === 0) throw new Error('empty reply');
      clearTimeout(progressTimer);
      await api.sendMessage({ chat_id, text });
      return 'answered';
    } catch {
      clearTimeout(progressTimer);
      await api.sendMessage({ chat_id, text: this.options.failureText ?? 'Sorry - I hit a problem answering that. Please try again in a moment.' }).catch(() => undefined);
      return 'failed';
    } finally {
      clearInterval(typingTimer);
    }
  }
}
