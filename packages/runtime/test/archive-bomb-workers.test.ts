import { afterEach, expect, it, vi } from 'vitest';
import { Inflate } from 'fflate';
import { INFLATE_SLICE_BYTES, inflateEntry, readZipDirectory } from '@waldo/workspace';

// In workerd, not Node: the platform DecompressionStream inflates whatever it is handed without backpressure, so a capped
// reader still let a lying-header bomb fill the isolate. The inflater must stop within one compressed slice of the cap.
// What reaches the inflater bounds what it can produce (DEFLATE expands at most about 1032:1), so counting the compressed
// bytes pushed bounds the bytes ever held.
const zeros = async (total: number): Promise<Uint8Array> => {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const read = new Response(stream.readable).arrayBuffer();
  const block = new Uint8Array(16 * 1024 * 1024);
  for (let left = total; left > 0; left -= block.length) await writer.write(block.subarray(0, Math.min(left, block.length)));
  await writer.close();
  return new Uint8Array(await read);
};
// One deflated entry whose header claims declaredSize bytes.
const zipOf = (compressed: Uint8Array, declaredSize: number): Uint8Array => {
  const name = new TextEncoder().encode('bomb.bin');
  const local = new Uint8Array(30 + name.length + compressed.length); const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true); lv.setUint32(18, compressed.length, true); lv.setUint32(22, declaredSize, true); lv.setUint16(26, name.length, true);
  local.set(name, 30); local.set(compressed, 30 + name.length);
  const central = new Uint8Array(46 + name.length); const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true); cv.setUint32(20, compressed.length, true); cv.setUint32(24, declaredSize, true); cv.setUint16(28, name.length, true);
  central.set(name, 46);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, central.length, true); ev.setUint32(16, local.length, true);
  const out = new Uint8Array(local.length + central.length + 22); out.set(local); out.set(central, local.length); out.set(end, local.length + central.length);
  return out;
};

afterEach(() => { vi.restoreAllMocks(); });

it('a lying-header bomb (declares 1 MiB, inflates to 256 MiB) stops within one slice of the cap', async () => {
  const compressed = await zeros(256 * 1024 * 1024);
  const zip = zipOf(compressed, 1024 * 1024);
  const [entry] = readZipDirectory(zip);
  let pushed = 0;
  const push = Inflate.prototype.push;
  vi.spyOn(Inflate.prototype, 'push').mockImplementation(function (this: Inflate, chunk: Uint8Array, final?: boolean) { pushed += chunk.byteLength; return push.call(this, chunk, final); });
  await expect(inflateEntry(zip, entry!, 50 * 1024 * 1024)).rejects.toMatchObject({ reason: 'corrupt' });
  // The cap is 1 MiB; at about 1030:1 that is about one slice of zeros. Two slices allow for the block where it is crossed.
  expect(pushed).toBeGreaterThan(0);
  expect(pushed).toBeLessThanOrEqual(2 * INFLATE_SLICE_BYTES);
  expect(compressed.length).toBeGreaterThan(100 * INFLATE_SLICE_BYTES);
}, 120_000);

it('an honest entry still inflates whole in workerd', async () => {
  const text = new TextEncoder().encode('alpha beta gamma '.repeat(5000));
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter(); void writer.write(text); void writer.close();
  const compressed = new Uint8Array(await new Response(stream.readable).arrayBuffer());
  const zip = zipOf(compressed, text.length);
  const view = new DataView(zip.buffer);
  const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let crc = 0xffffffff; for (const b of text) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8); crc = (crc ^ 0xffffffff) >>> 0;
  view.setUint32(14, crc, true); view.setUint32(30 + 8 + compressed.length + 16, crc, true);
  const [entry] = readZipDirectory(zip);
  expect(new TextDecoder().decode(await inflateEntry(zip, entry!, 50 * 1024 * 1024))).toBe(new TextDecoder().decode(text));
});
