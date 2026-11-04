import type { TelegramMedia } from './telegram-polling';

type Sql = Pick<SqlStorage, 'exec'>;

export type StoredFile = Readonly<{ id: number; kind: string; file_id: string; name: string; mime: string | null; size: number | null; caption: string; at: number }>;

const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);

// Files the owner sent Waldo on Telegram. Bytes stay with Telegram; only the reference is kept.
export const fileBook = (sql: Sql) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS owner_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, file_id TEXT NOT NULL, name TEXT NOT NULL,
    mime TEXT, size INTEGER, caption TEXT NOT NULL, at INTEGER NOT NULL)`);
  return {
    record(media: TelegramMedia, caption: string, at: number): void {
      const name = media.fileName ?? (media.kind === 'photo' ? 'photo.jpg' : media.kind === 'voice' ? 'voice-note.ogg' : 'file');
      const mime = media.mimeType ?? (media.kind === 'photo' ? 'image/jpeg' : null);
      sql.exec('INSERT INTO owner_files (kind, file_id, name, mime, size, caption, at) VALUES (?, ?, ?, ?, ?, ?, ?)', media.kind, media.fileId, name, mime, media.fileSize, caption.slice(0, 300), at);
    },
    list(): readonly StoredFile[] {
      return sql.exec<StoredFile>('SELECT * FROM owner_files ORDER BY at DESC LIMIT 200').toArray();
    },
    get(id: number): StoredFile | null {
      return sql.exec<StoredFile>('SELECT * FROM owner_files WHERE id = ?', id).toArray()[0] ?? null;
    },
    remove(id: number): boolean {
      return sql.exec('DELETE FROM owner_files WHERE id = ?', id).rowsWritten > 0;
    },
  };
};
export type FileBook = ReturnType<typeof fileBook>;

export const fileResponse = (file: StoredFile, bytes: Uint8Array): Response => {
  const inline = file.mime !== null && INLINE_TYPES.has(file.mime);
  const name = file.name.replace(/[^\w.\- ]/g, '_');
  return new Response(bytes, {
    headers: {
      'content-type': inline ? file.mime! : 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
      'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    },
  });
};
