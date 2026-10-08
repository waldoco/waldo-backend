import type { Download, Page } from '@cloudflare/playwright';
import { LIMITS, validId, validatePath } from '@waldo/workspace';
import type { workspaceOwnerHost } from './workspace-host';

export type BrowserFileReceipt = Readonly<{ file_id: string; revision: number; byte_size: number; sha256: string; provenance: 'provider_import';
  url: string; audience: 'owner_authenticated'; retrieval: 'verified' }>;
export class BrowserDownloadError extends Error {
  constructor(readonly code: 'rejected' | 'unavailable' | 'oversize' | 'integrity_unavailable') { super(`browser_download_${code}`); }
}

// Consume the native download before context close. The supplied workspace is the
// existing authenticated owner store; provider URLs/IDs and file bytes are not tool data.
export async function browserDownloadToWorkspace(options: Readonly<{
  download: Download; page: Page; workspace: Awaited<ReturnType<typeof workspaceOwnerHost>>;
  operationId: string; deadline: number; now(): number; assertCurrent(): Promise<void>; origin: string; sourceOrigin: string;
  signal?: AbortSignal;
}>): Promise<BrowserFileReceipt> {
  let timer: ReturnType<typeof setTimeout> | undefined, expired = false;
  let stream: Awaited<ReturnType<Download['createReadStream']>> | undefined;
  let reject!: (error: Error) => void;
  const interrupted = new Promise<never>((_, no) => { reject = no; }); void interrupted.catch(() => {});
  const abort = () => { expired = true; stream?.destroy(); reject(new BrowserDownloadError('unavailable')); };
  const checked = async () => {
    if (expired || options.signal?.aborted || !Number.isSafeInteger(options.deadline) || options.now() >= options.deadline) throw new BrowserDownloadError('rejected');
    await options.assertCurrent();
    if (expired || options.signal?.aborted || options.now() >= options.deadline) throw new BrowserDownloadError('rejected');
  };
  const step = async <T>(run: () => Promise<T>) => { await Promise.race([checked(), interrupted]); return Promise.race([Promise.resolve().then(() => { if (expired || options.signal?.aborted || options.now() >= options.deadline) throw new BrowserDownloadError('rejected'); return run(); }), interrupted]); };
  try {
    const duration = options.deadline - options.now();
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 2147483647 || !validId(options.operationId) || options.download.page() !== options.page) throw new BrowserDownloadError('rejected');
    const origin = new URL(options.origin);
    if (origin.protocol !== 'https:' || origin.origin !== options.origin || origin.username || origin.password) throw new BrowserDownloadError('rejected');
    // Native redirects can produce a download without committing a page URL.
    // Check the actual native URL against this slice's approved private site.
    const source = new URL(options.sourceOrigin), target = new URL(options.download.url());
    if (source.protocol !== 'https:' || source.origin !== options.sourceOrigin || target.protocol !== 'https:' || target.origin !== source.origin || target.username || target.password) throw new BrowserDownloadError('rejected');
    const name = options.download.suggestedFilename();
    if (typeof name !== 'string' || name.includes('/')) throw new BrowserDownloadError('rejected');
    const path = `browser-downloads/${options.operationId}/${name}`; validatePath(path);
    options.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, duration);
    if (await step(() => options.download.failure()) !== null) throw new BrowserDownloadError('unavailable');
    stream = await step(() => {
      const opening = options.download.createReadStream();
      void opening.then(value => { if (expired || options.signal?.aborted) value?.destroy(); }, () => {});
      return opening;
    });
    if (!stream) throw new BrowserDownloadError('unavailable');
    const iterator = stream[Symbol.asyncIterator](), chunks: Uint8Array[] = []; let count = 0;
    for (;;) {
      const part = await step(() => iterator.next()); if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new BrowserDownloadError('unavailable');
      count += part.value.byteLength;
      if (count > LIMITS.fileBytes) throw new BrowserDownloadError('oversize');
      chunks.push(new Uint8Array(part.value));
    }
    if (!count) throw new BrowserDownloadError('unavailable');
    const bytes = new Uint8Array(count); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const meta = await step(() => options.workspace.write({ path, bytes, mime: 'application/octet-stream', provenance: 'provider_import', expected_revision: 0, operation_id: options.operationId }));
    const retrieved = await step(() => options.workspace.export(meta.file_id, meta.revision, LIMITS.fileBytes));
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (retrieved.bytes.length !== count || retrieved.meta.sha256 !== digest || meta.sha256 !== digest) throw new BrowserDownloadError('integrity_unavailable');
    await step(() => options.download.delete()); await Promise.race([checked(), interrupted]);
    return { file_id: meta.file_id, revision: meta.revision, byte_size: meta.byte_size, sha256: meta.sha256, provenance: 'provider_import',
      url: `${options.origin}/console/workspace/file?id=${encodeURIComponent(meta.file_id)}&revision=${meta.revision}`, audience: 'owner_authenticated', retrieval: 'verified' };
  } catch (error) {
    stream?.destroy(); void options.download.cancel().catch(() => {});
    throw error instanceof BrowserDownloadError ? error : new BrowserDownloadError('unavailable');
  } finally { if (timer !== undefined) clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
