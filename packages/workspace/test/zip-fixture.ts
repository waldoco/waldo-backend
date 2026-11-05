// Builds zips byte by byte, so a test can make the headers lie the way a hostile archive does.
export type FixtureEntry = Readonly<{ name: string; data?: Uint8Array; text?: string; deflate?: boolean; symlink?: boolean; encrypted?: boolean; declaredSize?: number; crc?: number; method?: number }>;

const table = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = (bytes: Uint8Array): number => { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export const deflateRaw = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer.write(bytes.slice()); void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
};

export const buildZip = async (entries: readonly FixtureEntry[]): Promise<Uint8Array> => {
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const plain = entry.data ?? new TextEncoder().encode(entry.text ?? '');
    const body = entry.deflate ? await deflateRaw(plain) : plain;
    const method = entry.method ?? (entry.deflate ? 8 : 0);
    const flags = 0x800 | (entry.encrypted ? 1 : 0);
    const crc = entry.crc ?? crc32(plain);
    const size = entry.declaredSize ?? plain.length;
    const local = new Uint8Array(30 + name.length + body.length); const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, flags, true); lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true);
    local.set(name, 30); local.set(body, 30 + name.length);
    const central = new Uint8Array(46 + name.length); const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, entry.symlink ? (3 << 8) | 20 : 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true); cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true); cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true); cv.setUint32(38, entry.symlink ? (0o120777 << 16) >>> 0 : 0, true); cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
};
