import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_CHAT_CAPTION_MAX_CHARS, APP_CHAT_PHOTO_TYPES, APP_CHAT_UPLOAD_KIND_HEADER, APP_CHAT_UPLOAD_MAX_BYTES, APP_CHAT_UPLOAD_NAME_HEADER, APP_CHAT_UPLOAD_PATH, appSendRequestV1Schema } from '../../contracts/src/app/core';
import { appThreadSendV1Schema } from '../../contracts/src/app/threads';
import { CAPTION_MAX_CHARS, formatBytes, kindOf, NAME_MAX_CHARS, PHOTO_TYPES, plainName, retryable, UPLOAD_KIND_HEADER, UPLOAD_MAX_BYTES, UPLOAD_NAME_HEADER, UPLOAD_URL, uploadChatAttachment, uploadFailureLine, uploadRefusal, uploadType } from './chat-attachments';
import { ChatRequestError, ChatSignInRequired, sendChatMessage } from './chat-model';

afterEach(() => vi.unstubAllGlobals());
const UP = `up_${'A'.repeat(22)}`;
// The name rule the upload route applies (runtime app-uploads appUploadName).
const routeTakesName = (name: string) => /^[^/\\\p{Cc}]{1,128}$/u.test(name) && !name.startsWith('.');

describe('the console attachment rules are the app contract’s', () => {
  it('uses the contract’s limits, headers and photo types', () => {
    expect([UPLOAD_MAX_BYTES, CAPTION_MAX_CHARS, UPLOAD_KIND_HEADER, UPLOAD_NAME_HEADER]).toEqual([APP_CHAT_UPLOAD_MAX_BYTES, APP_CHAT_CAPTION_MAX_CHARS, APP_CHAT_UPLOAD_KIND_HEADER, APP_CHAT_UPLOAD_NAME_HEADER]);
    expect([...PHOTO_TYPES].sort()).toEqual(Object.keys(APP_CHAT_PHOTO_TYPES).sort());
    // The console route maps one to one onto the app's upload path.
    expect(APP_CHAT_UPLOAD_PATH).toBe('/app/v1/chat/uploads');
    expect(UPLOAD_URL).toBe('/console/dashboard/api/v1/chat/uploads');
  });

  it('sends a photo type as a photo and everything else, other images included, as a file under a well-formed type', () => {
    expect(kindOf({ type: 'image/png' })).toBe('photo');
    expect(kindOf({ type: 'IMAGE/JPEG' })).toBe('photo');
    expect(kindOf({ type: 'image/heic' })).toBe('file');
    expect(kindOf({ type: 'application/pdf' })).toBe('file');
    expect(uploadType({ type: 'text/plain;charset=utf-8' })).toBe('text/plain');
    expect(uploadType({ type: '' })).toBe('application/octet-stream');
    expect(uploadType({ type: 'not a type' })).toBe('application/octet-stream');
  });

  it('names a file the way the route takes, keeping its extension when it has to shorten it', () => {
    expect(plainName('Lease 2026.pdf')).toBe('Lease 2026.pdf');
    expect(plainName('C:\\Users\\me\\notes.md')).toBe('notes.md');
    expect(plainName('.env')).toBe('env');
    expect(plainName('a\u0007b.txt')).toBe('ab.txt');
    expect(plainName('')).toBe('file');
    const long = plainName(`${'é'.repeat(200)}.docx`);
    expect([...long].length).toBe(NAME_MAX_CHARS);
    expect(long.endsWith('.docx')).toBe(true);
    for (const raw of ['Lease 2026.pdf', '.env', `${'x'.repeat(300)}`, 'a/b', 'tab\there.txt', '日本語の書類.pdf']) expect(routeTakesName(plainName(raw))).toBe(true);
  });

  it('refuses what the route would refuse before sending it, and says why in plain words', () => {
    expect(uploadRefusal({ size: 0 })).toBe(400);
    expect(uploadRefusal({ size: UPLOAD_MAX_BYTES + 1 })).toBe(413);
    expect(uploadRefusal({ size: UPLOAD_MAX_BYTES })).toBeNull();
    expect(uploadFailureLine(413, 'file')).toBe('That file is too big. The limit is 20 MB.');
    expect(uploadFailureLine(415, 'photo')).toBe('Waldo can’t take that kind of image.');
    expect(uploadFailureLine(429, 'file')).toMatch(/^Too many attachments/);
    expect(uploadFailureLine(404, 'file')).toBe('Waldo doesn’t take attachments here yet.');
    expect(uploadFailureLine(0, 'file')).toBe('The file didn’t upload. Try again.');
    expect([0, 400, 404, 413, 415, 429, 500, 503].filter(retryable)).toEqual([0, 429, 500, 503]);
    expect([formatBytes(900), formatBytes(2048), formatBytes(1_572_864), formatBytes(15 * 1024 * 1024)]).toEqual(['900 B', '2 KB', '1.5 MB', '15 MB']);
  });
});

describe('uploading through the console chat route', () => {
  it('posts the raw bytes under their own type, with the kind and the percent-encoded name, same-origin with the console header', async () => {
    const fetch = vi.fn(async () => Response.json({ upload_id: UP, kind: 'file', bytes: 5, expires_at: 1 }, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const file = new File(['hello'], 'Résumé – 2026.pdf', { type: 'application/pdf' });
    expect(await uploadChatAttachment(file)).toEqual({ upload_id: UP, bytes: 5 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/console/dashboard/api/v1/chat/uploads');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(init.body).toBe(file);
    const headers = init.headers as Record<string, string>;
    expect([headers['x-waldo-console'], headers['content-type'], headers['x-waldo-upload-kind']]).toEqual(['1', 'application/pdf', 'file']);
    expect(headers['x-waldo-upload-name']).toBe('R%C3%A9sum%C3%A9%20%E2%80%93%202026.pdf');
    expect(decodeURIComponent(headers['x-waldo-upload-name']!)).toBe('Résumé – 2026.pdf');
  });

  it('reads each refusal as its status, a signed-out session as a sign-in, and an unreadable answer as a failure', async () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    for (const status of [400, 404, 413, 415, 429, 503]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unavailable' }, { status })));
      await expect(uploadChatAttachment(file)).rejects.toMatchObject({ status });
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await expect(uploadChatAttachment(file)).rejects.toBeInstanceOf(ChatSignInRequired);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ upload_id: 'https://elsewhere.invalid/x' }, { status: 201 })));
    await expect(uploadChatAttachment(file)).rejects.toBeInstanceOf(ChatRequestError);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(uploadChatAttachment(file)).rejects.toMatchObject({ status: 0 });
  });

  it('sends a message that names its upload, with its words as the caption, in main chat and in a thread', async () => {
    const fetch = vi.fn(async () => Response.json({ accepted: true, message_id: 'app-5', state: 'admitted' }, { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    await sendChatMessage('console-abcdefgh', '', null, undefined, UP);
    await sendChatMessage('console-abcdefgh', 'Which one is the receipt?', 'thr_x', 3, UP);
    const bodies = fetch.mock.calls.map(call => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
    expect(bodies).toEqual([
      { client_message_id: 'console-abcdefgh', text: '', attachments: [{ upload_id: UP }] },
      { client_message_id: 'console-abcdefgh', text: 'Which one is the receipt?', attachments: [{ upload_id: UP }], expected_revision: 3 },
    ]);
    expect([appSendRequestV1Schema.safeParse(bodies[0]).success, appThreadSendV1Schema.safeParse(bodies[1]).success]).toEqual([true, true]);
  });
});
