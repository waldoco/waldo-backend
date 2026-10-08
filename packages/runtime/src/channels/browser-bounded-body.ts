export class BrowserBodyError extends Error { constructor(readonly status: number) { super('browser body rejected'); } }
// Whole-body deadline and byte bound also cover chunked/slow responses.
export async function browserBoundedText(message: Request | Response, maxBytes = 4096, timeoutMs = 10000): Promise<string> {
  const declared = message.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new BrowserBodyError(413);
  if (!message.body) throw Error('browser body unavailable');
  const reader = message.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(Error('browser body timeout')); void reader.cancel().catch(() => undefined); }, timeoutMs); });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new BrowserBodyError(413);
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  finally { clearTimeout(timer); reader.releaseLock(); }
}

export async function browserBoundedJson(message: Request | Response, maxBytes = 4096, timeoutMs = 10000): Promise<unknown> { return JSON.parse(await browserBoundedText(message, maxBytes, timeoutMs)); }
