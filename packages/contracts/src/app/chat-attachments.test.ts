import { expect, it } from 'vitest';
import { APP_CHAT_CAPTION_MAX_CHARS, APP_CHAT_UPLOAD_MAX_BYTES, appChatUploadResultV1Schema, appSendRequestV1Schema } from './core';
import { appThreadSendV1Schema } from './threads';

const upload_id = `up_${'A'.repeat(22)}`;
const send = { client_message_id: 'client-message-0001' };

it('a send still needs text without an attachment, and every send an old build makes reads as before', () => {
  expect(appSendRequestV1Schema.safeParse({ ...send, text: 'hello' }).success).toBe(true);
  expect(appSendRequestV1Schema.safeParse({ ...send, text: '' }).success).toBe(false);
  expect(appSendRequestV1Schema.safeParse({ ...send, text: '   ' }).success).toBe(false);
  expect(appSendRequestV1Schema.safeParse({ ...send, text: 'x'.repeat(4000) }).success).toBe(true);
});

it('one attachment may carry an empty caption or one up to the caption cap, never more, and only by an upload id', () => {
  expect(appSendRequestV1Schema.safeParse({ ...send, text: '', attachments: [{ upload_id }] }).success).toBe(true);
  expect(appSendRequestV1Schema.safeParse({ ...send, text: 'x'.repeat(APP_CHAT_CAPTION_MAX_CHARS), attachments: [{ upload_id }] }).success).toBe(true);
  expect(appSendRequestV1Schema.safeParse({ ...send, text: 'x'.repeat(APP_CHAT_CAPTION_MAX_CHARS + 1), attachments: [{ upload_id }] }).success).toBe(false);
  expect(appSendRequestV1Schema.safeParse({ ...send, text: '', attachments: [] }).success).toBe(false);
  expect(appSendRequestV1Schema.safeParse({ ...send, text: '', attachments: [{ upload_id }, { upload_id }] }).success).toBe(false);
  expect(appSendRequestV1Schema.safeParse({ ...send, text: '', attachments: [{ upload_id: 'https://elsewhere.invalid/a.png' }] }).success).toBe(false);
  expect(appSendRequestV1Schema.safeParse({ ...send, text: '', attachments: [{ upload_id, url: 'x' }] }).success).toBe(false);
});

it('a thread send takes the same attachment rules and still needs its revision', () => {
  expect(appThreadSendV1Schema.safeParse({ ...send, text: '', attachments: [{ upload_id }], expected_revision: 1 }).success).toBe(true);
  expect(appThreadSendV1Schema.safeParse({ ...send, text: '', expected_revision: 1 }).success).toBe(false);
  expect(appThreadSendV1Schema.safeParse({ ...send, text: 'hi', attachments: [{ upload_id }] }).success).toBe(false);
});

it('an upload result names its id, kind, size within the cap and expiry, and nothing else', () => {
  const result = { upload_id, kind: 'voice', bytes: 1, expires_at: 1 };
  expect(appChatUploadResultV1Schema.safeParse(result).success).toBe(true);
  expect(appChatUploadResultV1Schema.safeParse({ ...result, kind: 'sticker' }).success).toBe(false);
  expect(appChatUploadResultV1Schema.safeParse({ ...result, bytes: APP_CHAT_UPLOAD_MAX_BYTES + 1 }).success).toBe(false);
  expect(appChatUploadResultV1Schema.safeParse({ ...result, url: 'x' }).success).toBe(false);
});
