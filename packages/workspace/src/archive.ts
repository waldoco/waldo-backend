import { LIMITS, validatePath, WorkspaceError, type WorkspaceStore } from './store';

// Hard limits for unpacking an archive inside the Worker. These are safety bounds (zip bombs, memory), not judgment:
// what to unpack and why is the model's call. The ratio is only enforced past ratioFloorBytes, where it means something.
export const ARCHIVE_LIMITS = {
  directoryEntries: 2000, listedEntries: 200, writesPerCall: 25, totalBytesPerCall: 50 * 1024 * 1024,
  entryBytes: LIMITS.fileBytes, ratio: 100, ratioFloorBytes: 1024 * 1024,
} as const;

export type ArchiveErrorCode = 'not_zip' | 'corrupt' | 'unsupported' | 'unsafe_path' | 'too_many_entries';
const MESSAGES: Record<ArchiveErrorCode, string> = {
  not_zip: 'This file is not a zip archive.',
  corrupt: 'The archive is damaged or incomplete, so it cannot be unpacked. Ask the owner to send it again.',
  unsupported: 'This archive uses a zip variant that cannot be unpacked here (multi-part or zip64).',
  unsafe_path: 'The archive names a file outside its own folder (an absolute path or ".."), so nothing in it was unpacked.',
  too_many_entries: `The archive lists more than ${ARCHIVE_LIMITS.directoryEntries} entries, so it was not unpacked.`,
};
export class ArchiveError extends Error { constructor(public readonly code: ArchiveErrorCode) { super(MESSAGES[code]); } }

export type ArchiveEntry = Readonly<{
  name: string; kind: 'file' | 'directory' | 'symlink'; size: number; compressed_size: number;
  method: number; encrypted: boolean; crc32: number; data_start: number;
}>;

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (bytes: Uint8Array): number => { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const latin = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

// An entry name made safe to place under a folder, or 'unsafe' for one that escapes it. "." and empty segments drop out;
// a backslash is a separator, since Windows tools write them and "..\" is the classic escape.
const entryName = (raw: string): string | 'unsafe' => {
  const name = raw.replaceAll('\\', '/');
  if (name.startsWith('/') || /^[a-z]:/i.test(name) || /[\x00-\x1f\x7f]/.test(name)) return 'unsafe';
  const segments = name.split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.some(segment => segment === '..')) return 'unsafe';
  return segments.join('/');
};

// Reads the central directory. Every entry's local header is checked and data ranges may not overlap, so one stretch of
// compressed bytes cannot be counted as many files. Throws ArchiveError; never inflates.
export const readZipDirectory = (bytes: Uint8Array): readonly ArchiveEntry[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true), u32 = (at: number) => view.getUint32(at, true);
  if (bytes.length < 22 || u32(0) !== 0x04034b50 && u32(0) !== 0x06054b50) throw new ArchiveError('not_zip');
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) if (u32(at) === 0x06054b50) { eocd = at; break; }
  if (eocd < 0) throw new ArchiveError('corrupt');
  const count = u16(eocd + 10), size = u32(eocd + 12), offset = u32(eocd + 16);
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0 || u16(eocd + 8) !== count) throw new ArchiveError('unsupported');
  if (count === 0xffff || offset === 0xffffffff || size === 0xffffffff) throw new ArchiveError('unsupported');
  if (count > ARCHIVE_LIMITS.directoryEntries) throw new ArchiveError('too_many_entries');
  if (offset + size > eocd) throw new ArchiveError('corrupt');
  const entries: ArchiveEntry[] = [];
  const ranges: [number, number][] = [];
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > offset + size || u32(at) !== 0x02014b50) throw new ArchiveError('corrupt');
    const madeBy = u16(at + 4), flags = u16(at + 8), method = u16(at + 10), crc = u32(at + 16);
    const compressed = u32(at + 20), uncompressed = u32(at + 24), nameLength = u16(at + 28), extra = u16(at + 30), comment = u16(at + 32);
    const external = u32(at + 38), local = u32(at + 42);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || local === 0xffffffff) throw new ArchiveError('unsupported');
    if (at + 46 + nameLength > offset + size) throw new ArchiveError('corrupt');
    const rawName = (flags & 0x800 ? utf8 : latin).decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
    if (local + 30 > bytes.length || u32(local) !== 0x04034b50) throw new ArchiveError('corrupt');
    const dataStart = local + 30 + u16(local + 26) + u16(local + 28);
    if (dataStart + compressed > offset) throw new ArchiveError('corrupt');
    ranges.push([local, dataStart + compressed]);
    const name = entryName(rawName);
    if (name === 'unsafe') throw new ArchiveError('unsafe_path');
    const symlink = madeBy >> 8 === 3 && ((external >>> 16) & 0o170000) === 0o120000;
    entries.push({ name, kind: symlink ? 'symlink' : rawName.endsWith('/') || rawName.endsWith('\\') ? 'directory' : 'file',
      size: uncompressed, compressed_size: compressed, method, encrypted: (flags & 1) === 1, crc32: crc, data_start: dataStart });
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1]![1])) throw new ArchiveError('corrupt');
  return entries;
};

export type EntrySkip = 'symlink' | 'encrypted' | 'unsupported_method' | 'too_large' | 'compression_ratio' | 'corrupt';
const EntryFailure = class extends Error { constructor(public readonly reason: EntrySkip) { super(reason); } };

// Inflates one entry. Output is capped while it streams: never more than the entry claims, the entry cap, or the ratio,
// so a header that lies cannot make the Worker hold more than the cap. A checksum mismatch is corruption.
export const inflateEntry = async (bytes: Uint8Array, entry: ArchiveEntry, budget: number): Promise<Uint8Array> => {
  if (entry.kind === 'symlink') throw new EntryFailure('symlink');
  if (entry.encrypted) throw new EntryFailure('encrypted');
  if (entry.method !== 0 && entry.method !== 8) throw new EntryFailure('unsupported_method');
  const limit = Math.min(entry.size, ARCHIVE_LIMITS.entryBytes, budget);
  if (entry.size > limit) throw new EntryFailure('too_large');
  const ratioOk = (out: number) => out <= ARCHIVE_LIMITS.ratioFloorBytes || out <= Math.max(1, entry.compressed_size) * ARCHIVE_LIMITS.ratio;
  if (!ratioOk(entry.size)) throw new EntryFailure('compression_ratio');
  const data = bytes.subarray(entry.data_start, entry.data_start + entry.compressed_size);
  let out: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressed_size !== entry.size) throw new EntryFailure('corrupt');
    out = data.slice();
  } else {
    const stream = new DecompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    writer.write(data).catch(() => undefined);
    writer.close().catch(() => undefined);
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > limit) { await reader.cancel().catch(() => undefined); throw new EntryFailure(total > entry.size ? 'corrupt' : 'too_large'); }
        if (!ratioOk(total)) { await reader.cancel().catch(() => undefined); throw new EntryFailure('compression_ratio'); }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof EntryFailure) throw error;
      throw new EntryFailure('corrupt');
    }
    out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  }
  if (out.length !== entry.size || crc32(out) !== entry.crc32) throw new EntryFailure('corrupt');
  return out;
};

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  xml: 'application/xml', html: 'text/html', htm: 'text/html', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const mimeForName = (name: string): string => MIME_BY_EXTENSION[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export type ExtractRequest = Readonly<{
  file_id: string; revision: number;
  // Exact entry names, or every file entry under a prefix. Neither: the whole archive when it fits one call.
  entries?: readonly string[]; prefix?: string;
  // Stable per entry for this call, so a retried call is the same write.
  operationIdFor(entry: string): Promise<string>;
}>;
export type ExtractSkip = Readonly<{ entry: string; reason: EntrySkip | 'duplicate' | 'exists' | 'name_too_long' | 'not_in_archive' | 'not_selected' }>;
export type ExtractResult = Readonly<{
  archive_path: string; folder: string;
  entries_total: number; listing: readonly Readonly<{ name: string; kind: ArchiveEntry['kind']; size: number }>[]; listing_truncated: boolean;
  written: readonly Readonly<{ entry: string; path: string; file_id: string; revision: number; byte_size: number; mime: string }>[];
  skipped: readonly ExtractSkip[];
  stopped?: 'per_call_limit' | 'workspace_full';
}>;

// The archive's folder sits beside it, named after it: uploads/report.zip unpacks into uploads/report/.
const folderFor = (path: string): string => {
  const name = path.split('/').at(-1)!;
  const stem = name.includes('.') && !name.startsWith('.') ? name.slice(0, name.lastIndexOf('.')) : `${name}-files`;
  return [...path.split('/').slice(0, -1), stem].join('/');
};

// Unpacks selected entries of a workspace zip into a folder beside it. Nested archives are written as files and never
// opened here. Each written file keeps the archive's provenance. The listing is always returned so the model can choose.
export const extractArchive = async (store: WorkspaceStore, request: ExtractRequest): Promise<ExtractResult> => {
  const { bytes, meta } = await store.export(request.file_id, request.revision);
  const directory = readZipDirectory(bytes);
  const folder = folderFor(meta.path);
  const files = directory.filter(entry => entry.kind !== 'directory');
  const listed = request.prefix ? files.filter(entry => entry.name.startsWith(request.prefix!)) : files;
  const listing = listed.slice(0, ARCHIVE_LIMITS.listedEntries).map(entry => ({ name: entry.name, kind: entry.kind, size: entry.size }));
  const skipped: ExtractSkip[] = [];
  let chosen: readonly ArchiveEntry[];
  if (request.entries?.length) {
    chosen = request.entries.flatMap(name => {
      const found = files.find(entry => entry.name === name);
      if (!found) skipped.push({ entry: name, reason: 'not_in_archive' });
      return found ? [found] : [];
    });
  } else chosen = request.prefix !== undefined || listed.length <= ARCHIVE_LIMITS.writesPerCall ? listed : [];
  const written: { entry: string; path: string; file_id: string; revision: number; byte_size: number; mime: string }[] = [];
  const seen = new Set<string>();
  let budget = ARCHIVE_LIMITS.totalBytesPerCall;
  let stopped: ExtractResult['stopped'];
  for (const entry of chosen) {
    if (written.length >= ARCHIVE_LIMITS.writesPerCall) { stopped = 'per_call_limit'; break; }
    const key = entry.name.normalize('NFC').toLowerCase();
    if (seen.has(key)) { skipped.push({ entry: entry.name, reason: 'duplicate' }); continue; }
    seen.add(key);
    const path = `${folder}/${entry.name}`.normalize('NFC');
    try { validatePath(path); } catch { skipped.push({ entry: entry.name, reason: 'name_too_long' }); continue; }
    let out: Uint8Array;
    try { out = await inflateEntry(bytes, entry, budget); }
    catch (error) { if (error instanceof EntryFailure) { skipped.push({ entry: entry.name, reason: error.reason }); continue; } throw error; }
    budget -= out.length;
    const mime = mimeForName(entry.name);
    try {
      const file = await store.write({ path, bytes: out, mime, expected_revision: 0, provenance: meta.provenance, operation_id: await request.operationIdFor(entry.name) });
      written.push({ entry: entry.name, path, file_id: file.file_id, revision: file.revision, byte_size: file.byte_size, mime });
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      if (error.code === 'conflict') { skipped.push({ entry: entry.name, reason: 'exists' }); continue; }
      if (error.code === 'quota' || error.code === 'capacity') { stopped = 'workspace_full'; break; }
      throw error;
    }
  }
  if (!stopped && !request.entries?.length && request.prefix === undefined && chosen.length === 0 && listed.length > 0) stopped = 'per_call_limit';
  return { archive_path: meta.path, folder, entries_total: files.length, listing, listing_truncated: listed.length > listing.length, written, skipped, ...(stopped ? { stopped } : {}) };
};
