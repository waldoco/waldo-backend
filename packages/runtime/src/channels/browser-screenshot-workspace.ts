import { LIMITS, validId } from '@waldo/workspace';
import type { workspaceOwnerHost } from './workspace-host';
import { generalDigest } from './general-browser-observation';

export type BrowserScreenshotReceipt = Readonly<{file_id:string;revision:number;byte_size:number;sha256:string;provenance:'provider_import';url:string;audience:'owner_authenticated';retrieval:'verified'}>;

export class BrowserScreenshotError extends Error {
  constructor(readonly code: 'rejected' | 'unavailable' | 'oversize' | 'integrity_unavailable') { super(`browser_screenshot_${code}`); }
}

// Existing owner workspace custody is the delivery boundary, never a provider
// screenshot URL. Native bytes remain external evidence and are not task success.
export async function browserScreenshotToWorkspace(options: Readonly<{
  image: Uint8Array; maxScreenshotBytes: number; workspace: Awaited<ReturnType<typeof workspaceOwnerHost>>;
  operationId: string; origin: string; deadline: number; now(): number; assertCurrent(): Promise<void>;
}>): Promise<BrowserScreenshotReceipt> {
  let timer: ReturnType<typeof setTimeout> | undefined, expired = false;
  const duration = options.deadline - options.now();
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 2147483647 || !validId(options.operationId)
    || !Number.isSafeInteger(options.maxScreenshotBytes) || options.maxScreenshotBytes < 1 || !(options.image instanceof Uint8Array)) throw new BrowserScreenshotError('rejected');
  if (options.image.length > Math.min(options.maxScreenshotBytes, LIMITS.fileBytes)) throw new BrowserScreenshotError('oversize');
  const bytes = new Uint8Array(options.image);
  if (bytes.length < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) throw new BrowserScreenshotError('rejected');
  try {
    const origin = new URL(options.origin);
    if (origin.protocol !== 'https:' || origin.origin !== options.origin || origin.username || origin.password) throw new BrowserScreenshotError('rejected');
    const interrupted = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new BrowserScreenshotError('unavailable')); }, duration); });
    const checked = async () => {
      if (expired || options.now() >= options.deadline) throw new BrowserScreenshotError('rejected');
      await options.assertCurrent();
      if (expired || options.now() >= options.deadline) throw new BrowserScreenshotError('rejected');
    };
    const step = async <T>(run: () => Promise<T>) => {
      await Promise.race([checked(), interrupted]);
      return Promise.race([Promise.resolve().then(() => { if (expired || options.now() >= options.deadline) throw new BrowserScreenshotError('rejected'); return run(); }), interrupted]);
    };
    const sha256 = await step(() => generalDigest(bytes));
    const meta = await step(() => options.workspace.write({ path: `browser-screenshots/${options.operationId}/page.png`, bytes, mime: 'image/png', provenance: 'provider_import', expected_revision: 0, operation_id: options.operationId }));
    const retrieved = await step(() => options.workspace.export(meta.file_id, meta.revision, LIMITS.fileBytes));
    if (meta.byte_size !== bytes.length || meta.sha256 !== sha256 || retrieved.bytes.length !== bytes.length || retrieved.meta.sha256 !== sha256 || await step(() => generalDigest(retrieved.bytes)) !== sha256) throw new BrowserScreenshotError('integrity_unavailable');
    await Promise.race([checked(), interrupted]);
    return { file_id: meta.file_id, revision: meta.revision, byte_size: meta.byte_size, sha256, provenance: 'provider_import',
      url: `${options.origin}/console/workspace/file?id=${encodeURIComponent(meta.file_id)}&revision=${meta.revision}`, audience: 'owner_authenticated', retrieval: 'verified' };
  } catch (error) { throw error instanceof BrowserScreenshotError ? error : new BrowserScreenshotError('unavailable'); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
