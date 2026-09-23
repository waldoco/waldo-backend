import { describe, expect, it } from 'vitest';
import { createTelegramFileDownloader, loadTelegramMedia, toBase64 } from '../src/channels/telegram-media';

const photo = { kind: 'photo' as const, fileId: 'big', fileName: null, mimeType: 'image/jpeg', fileSize: 3 };

describe('telegram media', () => {
  it('attaches a downloaded photo and notes it in the conversation text', async () => {
    const loaded = await loadTelegramMedia(photo, async () => new Uint8Array([1, 2, 3]));
    expect(loaded).toEqual({ note: '[Owner sent a photo, attached.]', attachment: { kind: 'image', mime_type: 'image/jpeg', filename: 'photo.jpg', data_base64: 'AQID' } });
  });

  it('reads supported documents by extension and explains the ones it cannot read', async () => {
    const bytes = async () => new Uint8Array([104, 105]);
    const pdf = await loadTelegramMedia({ kind: 'document', fileId: 'd', fileName: 'Plan.PDF', mimeType: null, fileSize: 2 }, bytes);
    expect(pdf.attachment).toMatchObject({ kind: 'file', mime_type: 'application/pdf', filename: 'Plan.PDF' });
    const zip = await loadTelegramMedia({ kind: 'document', fileId: 'z', fileName: 'a.zip', mimeType: 'application/zip', fileSize: 2 }, bytes);
    expect(zip).toEqual({ note: '[Owner sent a file "a.zip". This file type cannot be read yet.]' });
  });

  it('does not download oversized files and survives download failures', async () => {
    let called = false;
    const big = await loadTelegramMedia({ ...photo, fileSize: 21 * 1024 * 1024 }, async () => { called = true; return new Uint8Array(); });
    expect(called).toBe(false);
    expect(big.attachment).toBeUndefined();
    const failed = await loadTelegramMedia(photo, async () => { throw new Error('down'); });
    expect(failed).toEqual({ note: '[Owner sent a photo, but it could not be downloaded.]' });
  });

  it('resolves the file path with getFile before downloading', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return url.endsWith('/getFile')
        ? new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/f.jpg' } }))
        : new Response(new Uint8Array([7]));
    }) as unknown as typeof fetch;
    expect(await createTelegramFileDownloader('T', fetcher)('big')).toEqual(new Uint8Array([7]));
    expect(urls).toEqual(['https://api.telegram.org/botT/getFile', 'https://api.telegram.org/file/botT/photos/f.jpg']);
  });

  it('encodes large buffers in chunks', () => {
    const bytes = new Uint8Array(100_000).fill(65);
    expect(atob(toBase64(bytes)).length).toBe(100_000);
  });
});
