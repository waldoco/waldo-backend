import { describe, expect, it } from 'vitest';
import { TelegramPollingAdapter } from '../src/channels/telegram-polling';

const message = (updateId: number, text = 'hello') => ({
  update_id: updateId,
  message: { from: { id: 7, is_bot: false }, chat: { id: 9, type: 'private' }, text },
});

describe('TelegramPollingAdapter', () => {
  it('polls from the durable offset and advances past the highest update', async () => {
    const requests: unknown[] = [];
    const adapter = new TelegramPollingAdapter({
      async getUpdates(request) { requests.push(request); return [message(4), message(5)]; },
    }, 4);
    expect(await adapter.poll()).toEqual({
      nextOffset: 6,
      accepted: [
        { updateId: 4, messageId: null, senderId: 7, chatId: 9, sentAt: null, text: 'hello' },
        { updateId: 5, messageId: null, senderId: 7, chatId: 9, sentAt: null, text: 'hello' },
      ],
      unsupported: [],
      dropped: 0,
    });
    expect(requests).toEqual([{ offset: 4, timeout: 25 }]);
  });

  it('drops duplicates and group/bot updates, flags media as unsupported, and checkpoints all of them', async () => {
    const adapter = new TelegramPollingAdapter({
      async getUpdates() {
        return [
          message(9),
          message(10),
          { ...message(11), message: { ...message(11).message, chat: { id: 9, type: 'group' } } },
          { ...message(12), message: { ...message(12).message, from: { id: 7, is_bot: true } } },
          { update_id: 13, message: { from: { id: 7, is_bot: false }, chat: { id: 9, type: 'private' } } },
        ];
      },
    }, 10);
    expect(await adapter.poll(0)).toEqual({
      nextOffset: 14,
      accepted: [{ updateId: 10, messageId: null, senderId: 7, chatId: 9, sentAt: null, text: 'hello' }],
      unsupported: [{ updateId: 13, messageId: null, senderId: 7, chatId: 9 }],
      dropped: 3,
    });
  });

  it('accepts photos, documents and voice notes and keeps video notes unsupported', async () => {
    const owner = { from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' } };
    const adapter = new TelegramPollingAdapter({
      async getUpdates() {
        return [
          { update_id: 1, message: { ...owner, caption: 'lunch', photo: [{ file_id: 'small', file_unique_id: 's', width: 90, height: 90 }, { file_id: 'big', file_unique_id: 'b', width: 1280, height: 1280, file_size: 2048 }] } },
          { update_id: 2, message: { ...owner, document: { file_id: 'doc', file_unique_id: 'd', file_name: 'plan.pdf', mime_type: 'application/pdf', file_size: 4096 } } },
          { update_id: 3, message: { ...owner, voice: { file_id: 'v', file_unique_id: 'vu', duration: 3, mime_type: 'audio/ogg', file_size: 900 } } },
          { update_id: 4, message: { ...owner, video_note: { file_id: 'vn', duration: 3 } } },
        ];
      },
    }, 1);
    const polled = await adapter.poll(0);
    expect(polled.accepted.slice(0, 2)).toEqual([
      { updateId: 1, messageId: null, senderId: 7, chatId: 7, sentAt: null, text: 'lunch', media: { kind: 'photo', fileId: 'big', fileName: null, mimeType: 'image/jpeg', fileSize: 2048 } },
      { updateId: 2, messageId: null, senderId: 7, chatId: 7, sentAt: null, text: '', media: { kind: 'document', fileId: 'doc', fileName: 'plan.pdf', mimeType: 'application/pdf', fileSize: 4096 } },
    ]);
    expect(polled.accepted[2]).toMatchObject({ updateId: 3, text: '', media: { kind: 'voice', fileId: 'v', fileName: 'voice.ogg', mimeType: 'audio/ogg', fileSize: 900 } });
    expect(polled.unsupported).toEqual([{ updateId: 4, messageId: null, senderId: 7, chatId: 7 }]);
  });

  it('does not advance the offset when the transport fails', async () => {
    const adapter = new TelegramPollingAdapter({ async getUpdates() { throw new Error('network'); } }, 8);
    await expect(adapter.poll()).rejects.toThrow('network');
    expect(adapter.offset()).toBe(8);
  });

  it('rejects unsafe offsets and poll timeouts', async () => {
    expect(() => new TelegramPollingAdapter({ async getUpdates() { return []; } }, -1)).toThrow('offset');
    const adapter = new TelegramPollingAdapter({ async getUpdates() { return []; } });
    await expect(adapter.poll(51)).rejects.toThrow('timeout');
  });
});
