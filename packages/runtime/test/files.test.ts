import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { fileBook, fileResponse } from '../src/channels/files';
import { renderConsole } from '../src/channels/console';
import { SAMPLE_CONSOLE_VIEW } from './fixtures/console-sample';

describe('owner files', () => {
  it('records Telegram media references newest first and removes them', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('owner-files'));
    await runInDurableObject(stub, async (_instance, state) => {
      const book = fileBook(state.storage.sql);
      book.record({ kind: 'photo', fileId: 'a', fileName: null, mimeType: null, fileSize: 1000 }, '', 1);
      book.record({ kind: 'document', fileId: 'b', fileName: 'plan.pdf', mimeType: 'application/pdf', fileSize: 5000 }, 'read this', 2);
      const [first, second] = book.list();
      expect([first?.name, second?.name, second?.mime]).toEqual(['plan.pdf', 'photo.jpg', 'image/jpeg']);
      expect(book.remove(second!.id)).toBe(true);
      expect(book.remove(second!.id)).toBe(false);
      expect(book.get(first!.id)?.caption).toBe('read this');
    });
  });

  it('serves images and PDFs inline and everything else as a download', () => {
    const file = SAMPLE_CONSOLE_VIEW.files[0]!;
    expect(fileResponse(file, new Uint8Array([1])).headers.get('content-disposition')).toBe('inline; filename="blood-panel-sept.pdf"');
    const html = fileResponse({ ...file, name: 'x".html', mime: 'text/html' }, new Uint8Array([1]));
    expect(html.headers.get('content-type')).toBe('application/octet-stream');
    expect(html.headers.get('content-disposition')).toBe('attachment; filename="x_.html"');
  });

  it('lists files in the console with open and remove controls', () => {
    const page = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(page).toContain('id="files"');
    expect(page).toContain('href="/console/file?id=2"');
    expect(page).toContain('value="file.remove"');
  });
});
