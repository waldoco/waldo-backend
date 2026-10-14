import { REPLY_QUOTE_LIMIT, type ReplyContext } from './owner-turn-envelope';
import { inboundTurn, type InboundPart, type OwnerInboundTurn } from './owner-inbound-turn';
import { telegramMessageUpdateSchema, telegramUnsupportedMessageSchema, type TelegramMessageUpdate } from '@waldo/contracts';

export type TelegramPollingClient = Readonly<{
  getUpdates(request: Readonly<{ offset: number; timeout: number }>): Promise<readonly unknown[]>;
}>;

export type TelegramMedia = Readonly<{
  kind: 'photo' | 'document' | 'voice' | 'audio';
  fileId: string;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  forwarded?: true;
}>;

export type TelegramInboundTurn = OwnerInboundTurn;

export type TelegramUnsupportedTurn = Omit<TelegramInboundTurn, 'text' | 'parts' | 'sentAt' | 'media'> & Readonly<{ note?: string }>;

// Parse-failure detail for the hop log: field paths and schema codes only - never message
// content - so an unsupported reply stays diagnosable when Telegram's payload shape drifts.
const unsupportedNote = (issues: readonly { code: string; path: readonly PropertyKey[]; keys?: string[] }[]): string =>
  issues.slice(0, 5).map((issue) => {
    const path = issue.path.map(String).join('.') || 'update';
    return issue.code === 'unrecognized_keys' && issue.keys !== undefined
      ? `${path}:unknown_keys(${issue.keys.slice(0, 5).join(',')})`
      : `${path}:${issue.code}`;
  }).join('; ').slice(0, 300);

export type TelegramPollResult = Readonly<{
  nextOffset: number;
  accepted: readonly TelegramInboundTurn[];
  unsupported: readonly TelegramUnsupportedTurn[];
  dropped: number;
}>;

const replyProvenance = (
  reply: { from?: { id: number; is_bot: boolean } | undefined } & Record<string, unknown>,
  senderId: number,
  chatType: string,
): NonNullable<ReplyContext['provenance']> => {
  const forwarded = ['forward_origin', 'forward_date', 'forward_from', 'forward_sender_name', 'is_automatic_forward'].some(key => key in reply);
  if (forwarded || reply.from === undefined) return { author: 'other', forwarded };
  if (reply.from.is_bot && chatType === 'private') return { author: 'waldo', forwarded };
  if (!reply.from.is_bot && reply.from.id === senderId) return { author: 'owner', forwarded };
  return { author: 'other', forwarded };
};

const QUOTE_ENTITIES = new Set(['blockquote', 'expandable_blockquote', 'pre', 'code']);

// Entity offsets count UTF-16 code units, as JavaScript strings do, so they index the text directly. A forward is
// someone else's text throughout, a quote inside it included.
const textParts = (text: string, entities: readonly Readonly<{ type: string; offset: number; length: number }>[], forwarded: boolean): readonly InboundPart[] => {
  if (!text) return [];
  if (forwarded) return [{ authorship: 'forwarded', text }];
  const quotes: { start: number; end: number }[] = [];
  for (const entity of entities.filter(entity => QUOTE_ENTITIES.has(entity.type)).sort((a, b) => a.offset - b.offset)) {
    const last = quotes.at(-1), end = entity.offset + entity.length;
    if (last && entity.offset <= last.end) last.end = Math.max(last.end, end);
    else quotes.push({ start: entity.offset, end });
  }
  // Quote markup that does not fit the text cannot be placed, so none of the text counts as the owner's own words.
  if (quotes.some(quote => quote.end > text.length)) return [{ authorship: 'quoted', text }];
  const parts: InboundPart[] = [];
  let at = 0;
  for (const quote of quotes) {
    if (quote.start > at) parts.push({ authorship: 'owner', text: text.slice(at, quote.start) });
    parts.push({ authorship: 'quoted', text: text.slice(quote.start, quote.end) });
    at = quote.end;
  }
  if (at < text.length) parts.push({ authorship: 'owner', text: text.slice(at) });
  return parts;
};

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
          unsupported.push(Object.freeze({ updateId, messageId: message.message_id ?? null, senderId: message.from.id, chatId: message.chat.id, note: unsupportedNote(parsed.error.issues) }));
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
    const { message } = update;
    const photo = message.photo?.at(-1);
    const media: TelegramMedia | undefined = photo
      ? { kind: 'photo', fileId: photo.file_id, fileName: null, mimeType: 'image/jpeg', fileSize: photo.file_size ?? null }
      : message.document
        ? { kind: 'document', fileId: message.document.file_id, fileName: message.document.file_name ?? null, mimeType: message.document.mime_type ?? null, fileSize: message.document.file_size ?? null }
        : message.voice
          ? { kind: 'voice', fileId: message.voice.file_id, fileName: 'voice.ogg', mimeType: message.voice.mime_type ?? 'audio/ogg', fileSize: message.voice.file_size ?? null }
          : message.audio
            ? { kind: 'audio', fileId: message.audio.file_id, fileName: message.audio.file_name ?? 'audio', mimeType: message.audio.mime_type ?? null, fileSize: message.audio.file_size ?? null }
            : undefined;
    return inboundTurn({
      updateId: update.update_id,
      messageId: message.message_id ?? null,
      senderId: message.from.id,
      chatId: message.chat.id,
      sentAt: message.date === undefined ? null : message.date * 1000,
      parts: message.text === undefined
        ? textParts(message.caption ?? '', message.caption_entities ?? [], message.forward_origin !== undefined)
        : textParts(message.text, message.entities ?? [], message.forward_origin !== undefined),
      ...(message.reply_to_message ? { replyTo: Object.freeze({
        surface: 'telegram',
        messageId: String(message.reply_to_message.message_id),
        conversationRef: message.reply_to_message.chat ? `telegram-${message.reply_to_message.chat.id}` : null,
        authorId: message.reply_to_message.from ? String(message.reply_to_message.from.id) : null,
        authorIsBot: message.reply_to_message.from?.is_bot ?? null,
        text: (message.reply_to_message.text ?? message.reply_to_message.caption ?? '').slice(0, REPLY_QUOTE_LIMIT),
        truncated: (message.reply_to_message.text ?? message.reply_to_message.caption ?? '').length > REPLY_QUOTE_LIMIT,
        sourceTaint: 'external' as const,
        provenance: replyProvenance(message.reply_to_message, message.from.id, message.chat.type),
      }) } : {}),
      ...(media ? { media: Object.freeze(message.forward_origin === undefined ? media : { ...media, forwarded: true as const }) } : {}),
    });
  }
}
