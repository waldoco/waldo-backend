// Which files the model reads, as every surface decides it: by what a file declares and, once its bytes are read, by what
// its bytes are. A name alone never decides that a PDF or photo cannot be read.
import { describe, expect, it } from 'vitest';
import { readableBytes, readableFile, typeUndeclared } from '../src/channels/readable-file';

const bytes = (...values: number[]) => new Uint8Array(values);
const PDF = new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n%'), 0xe2, 0xe3, 0xcf, 0xd3]);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const WEBP = new Uint8Array([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8 ')]);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0, 0);

describe('readableFile, from what a file declares', () => {
  it('reads a declared type when the name has no extension, and names the file with one', () => {
    expect(readableFile('application/pdf', 'Invoice 2026')).toEqual({ kind: 'file', mime_type: 'application/pdf', filename: 'Invoice 2026.pdf' });
    expect(readableFile('application/pdf', 'file')).toEqual({ kind: 'file', mime_type: 'application/pdf', filename: 'file.pdf' });
    expect(readableFile('APPLICATION/PDF; name="x"', 'x.pdf')).toEqual({ kind: 'file', mime_type: 'application/pdf', filename: 'x.pdf' });
  });

  it('takes the names senders give JPEG and PNG, and any text type as plain text', () => {
    expect(readableFile('image/jpg', 'photo.jpg')).toEqual({ kind: 'image', mime_type: 'image/jpeg', filename: 'photo.jpg' });
    expect(readableFile('image/pjpeg', 'scan')).toEqual({ kind: 'image', mime_type: 'image/jpeg', filename: 'scan.jpg' });
    expect(readableFile('text/x-python', 'job.py')).toEqual({ kind: 'file', mime_type: 'text/plain', filename: 'job.py.txt' });
  });

  it('still reads by extension when the type says nothing, and reads nothing it cannot', () => {
    expect(readableFile(null, 'Plan.PDF')).toEqual({ kind: 'file', mime_type: 'application/pdf', filename: 'Plan.PDF' });
    expect(readableFile('application/octet-stream', 'notes.docx')).toMatchObject({ kind: 'file', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    expect(readableFile('application/zip', 'a.zip')).toBeNull();
    expect(readableFile('image/heic', 'IMG_0001.heic')).toBeNull();
    expect(readableFile('video/mp4', 'clip.mp4')).toBeNull();
  });

  it('knows which declared types leave the bytes to decide', () => {
    expect([null, '', 'application/octet-stream', 'binary/octet-stream'].every(typeUndeclared)).toBe(true);
    expect(['application/zip', 'image/heic', 'application/pdf'].some(typeUndeclared)).toBe(false);
  });
});

describe('readableBytes, once the bytes are in hand', () => {
  it('reads a PDF by its bytes whatever its name or declared type', () => {
    for (const [mime, name] of [[null, 'file'], ['application/octet-stream', 'Scan'], ['application/zip', 'x.zip']] as const) {
      expect(readableBytes(PDF, mime, name)).toEqual({ kind: 'file', mime_type: 'application/pdf', filename: `${name}.pdf` });
    }
  });

  it('gives an image the type its bytes show, which the providers check against the data', () => {
    expect(readableBytes(PNG, 'image/jpeg', 'photo.jpg')).toEqual({ kind: 'image', mime_type: 'image/png', filename: 'photo.jpg.png' });
    expect(readableBytes(JPEG, 'image/jpg', 'IMG_1.jpeg')).toEqual({ kind: 'image', mime_type: 'image/jpeg', filename: 'IMG_1.jpeg' });
    expect(readableBytes(WEBP, null, 'sticker')).toEqual({ kind: 'image', mime_type: 'image/webp', filename: 'sticker.webp' });
  });

  it('reads plain text of no declared type as text, and never a binary file as text', () => {
    expect(readableBytes(new TextEncoder().encode('Train leaves at 07:40.\r\n\tPlatform 3\n'), 'application/octet-stream', 'notes'))
      .toEqual({ kind: 'file', mime_type: 'text/plain', filename: 'notes.txt' });
    expect(readableBytes(bytes(0x4d, 0x5a, 0x90), 'application/octet-stream', 'tool.exe')).toBeNull();
    expect(readableBytes(bytes(0x61, 0x00, 0x62), null, 'data')).toBeNull();
    expect(readableBytes(bytes(0xc3, 0x28), null, 'data')).toBeNull();
    expect(readableBytes(new Uint8Array(), null, 'empty')).toBeNull();
  });

  it('leaves a declared archive or unknown binary unread', () => {
    expect(readableBytes(ZIP, 'application/zip', 'photos.zip')).toBeNull();
    expect(readableBytes(bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70), 'image/heic', 'IMG.heic')).toBeNull();
  });
});
