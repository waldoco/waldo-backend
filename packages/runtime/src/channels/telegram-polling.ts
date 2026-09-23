import { telegramMessageUpdateSchema, telegramUnsupportedMessageSchema, type TelegramMessageUpdate } from '@waldo/contracts';

export type TelegramPollingClient = Readonly<{
  getUpdates(request: Readonly<{ offset: number; timeout: number }>): Promise<readonly unknown[]>;
}>;

export type TelegramInboundTurn = Readonly<{
  updateId: number;
  messageId: number | null;
  senderId: number;
  chatId: number;
  text: string;
}>;

export type TelegramUnsupportedTurn = Omit<TelegramInboundTurn, 'text'>;

export type TelegramPollResult = Readonly<{
  nextOffset: number;
  accepted: readonly TelegramInboundTurn[];
  unsupported: readonly TelegramUnsupportedTurn[];
  dropped: number;
}>;

export class TelegramPollingAdapter {
  private nextOffset: number;

  constructor(
    private readonly client: TelegramPollingClient,
    initialOffset = 0,
  ) {
    if (!Number.isSafeInteger(initialOffset) || initialOffset < 0) {
      throw new Error('telegram poll offset must be a non-negative safe integer');
    }
    this.nextOffset = initialOffset;
  }

  offset(): number { return this.nextOffset; }

  async poll(timeout = 25): Promise<TelegramPollResult> {
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 50) {
      throw new Error('telegram poll timeout is invalid');
    }
    const updates = await this.client.getUpdates({ offset: this.nextOffset, timeout });
    const accepted: TelegramInboundTurn[] = [];
    const unsupported: TelegramUnsupportedTurn[] = [];
    let dropped = 0;
    let highest = this.nextOffset - 1;
    for (const raw of updates) {
      const updateId = this.updateId(raw);
      if (updateId === null || updateId < this.nextOffset) {
        dropped += 1;
        continue;
      }
      highest = Math.max(highest, updateId);
      const parsed = telegramMessageUpdateSchema.safeParse(raw);
      if (!parsed.success) {
        const other = telegramUnsupportedMessageSchema.safeParse(raw);
        if (other.success) {
          const { message } = other.data;
          unsupported.push(Object.freeze({ updateId, messageId: message.message_id ?? null, senderId: message.from.id, chatId: message.chat.id }));
        } else {
          dropped += 1;
        }
        continue;
      }
      accepted.push(this.toTurn(parsed.data));
    }
    if (highest >= this.nextOffset) this.nextOffset = highest + 1;
    return Object.freeze({
      nextOffset: this.nextOffset,
      accepted: Object.freeze(accepted),
      unsupported: Object.freeze(unsupported),
      dropped,
    });
  }

  private updateId(raw: unknown): number | null {
    if (typeof raw !== 'object' || raw === null || !('update_id' in raw)) return null;
    const value = (raw as { update_id?: unknown }).update_id;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  private toTurn(update: TelegramMessageUpdate): TelegramInboundTurn {
    return Object.freeze({
      updateId: update.update_id,
      messageId: update.message.message_id ?? null,
      senderId: update.message.from.id,
      chatId: update.message.chat.id,
      text: update.message.text,
    });
  }
}
