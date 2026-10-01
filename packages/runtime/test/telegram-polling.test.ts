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
      unsupported: [{ updateId: 13, messageId: null, senderId: 7, chatId: 9, note: expect.stringContaining('message') }],
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
    expect(polled.unsupported).toEqual([{ updateId: 4, messageId: null, senderId: 7, chatId: 7, note: expect.stringContaining('unknown_keys(video_note)') }]);
  });

  it('accepts a text message carrying decorative entity drift (text_link), keeps forwards unsupported with a naming note', async () => {
    const linked = { ...message(20), message: { ...message(20).message, text: 'browse https://x.test', entities: [{ type: 'text_link', offset: 7, length: 14, url: 'https://x.test' }] } };
    const forwarded = { ...message(21), message: { ...message(21).message, forward_origin: { type: 'hidden_user', date: 1 } } };
    const adapter = new TelegramPollingAdapter({ async getUpdates() { return [linked, forwarded]; } }, 20);
    const polled = await adapter.poll(0);
    expect(polled.accepted).toEqual([{ updateId: 20, messageId: null, senderId: 7, chatId: 9, sentAt: null, text: 'browse https://x.test' }]);
    expect(polled.unsupported).toHaveLength(1);
    expect(polled.unsupported[0]).toMatchObject({ updateId: 21 });
    expect(polled.unsupported[0]!.note).toContain('unknown_keys(forward_origin)');
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
it('preserves a real reply target as bounded external quote with observed author provenance', async () => {
  const raw = { update_id: 100, message: {
    message_id: 10, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: '?',
    reply_to_message: { message_id: 9, date: 1, from: { id: 88, is_bot: true, first_name: 'Claims owner' },
      chat: { id: 7, type: 'private' }, text: 'Still checking the export. ' + 'x'.repeat(3000),
      reply_to_message: { text: 'NESTED_ATTACK' } },
  } };
  const adapter = new TelegramPollingAdapter({ getUpdates: async () => [raw] });
  const turn = (await adapter.poll(0)).accepted[0]!;
  expect(turn).toMatchObject({ text: '?', replyTo: { surface: 'telegram', messageId: '9', conversationRef: 'telegram-7',
    authorId: '88', authorIsBot: true, sourceTaint: 'external', text: expect.stringContaining('Still checking'), truncated: true } });
  expect(turn.replyTo!.text.length).toBe(2048);
  expect(JSON.stringify(turn.replyTo)).not.toContain('NESTED_ATTACK');
  expect(JSON.stringify(turn.replyTo)).not.toContain('Claims owner');
});
it('keeps caption-only and missing-author reply targets without inventing identities', async () => {
  const adapter = new TelegramPollingAdapter({ getUpdates: async () => [{
    update_id: 101, message: { message_id: 11, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: '!',
      reply_to_message: { message_id: 8, caption: 'Export preview', photo: [{ file_id: 'not-fetched' }] } },
  }] });
  expect((await adapter.poll(0)).accepted[0]!.replyTo).toEqual({
    surface: 'telegram', messageId: '8', conversationRef: null, authorId: null, authorIsBot: null,
    text: 'Export preview', truncated: false, sourceTaint: 'external',
  });
});
