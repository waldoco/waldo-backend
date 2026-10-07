import { LIMITS, validId, validatePath, type FileMeta } from '@waldo/workspace';
import { generalDigest } from './general-browser-observation';
import { GENERAL_BROWSER_REDIRECT_LIMIT } from './general-browser-redirects';
export class GeneralFileError extends Error {
  constructor(readonly code: 'rejected' | 'file_oversize' | 'file_unavailable' | 'outcome_uncertain', readonly diagnostic?: Readonly<{ status: number }>) { super(`browser_${code}`); }
}
export type GeneralFileScope = Readonly<{ ownerId: string; sessionId: string; generation: number; targetId: string; observationRevision: string }>;
export type GeneralCapturedFile = GeneralFileScope & Readonly<{ sourceUrl: string; observedSourceUrl: string; transport: 'public_http'; bytes: Uint8Array; mime: string; sha256: string; provenance: 'provider_import'; source_taint: 'external' }>;
export type GeneralFileControl = Readonly<{
  maxBytes: number; signal: AbortSignal; fetch: typeof fetch;
  beforeFileCapture(intentDigest: string, signal: AbortSignal): Promise<void>;
  // Existing owner workspace write/revision/idempotency admission, not a new
  // ledger. The host must fence late writes against this signal and actual scope.
  persist(file: GeneralCapturedFile, signal: AbortSignal): Promise<FileMeta>;
}>;
// Supported public HTTP retrieval from a freshly observed browser link. No
// browser cookies, auth headers, native artifact paths, blob URLs or uploads.
export async function captureGeneralBrowserFile(options: GeneralFileControl & Readonly<{ scope: GeneralFileScope; sourceUrl: string; now(): number; deadline(): number; admit(): Promise<void>; authorize(url: string): Promise<void>; onPersistAttempt?(): void }>) {
  const remaining = options.deadline() - options.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0 || options.maxBytes > LIMITS.fileBytes || options.signal.aborted) throw new GeneralFileError('rejected');
  const lease = new AbortController(); let persistAttempted = false, rejectLease!: (error: GeneralFileError) => void;
  const failure = new Promise<never>((_, reject) => { rejectLease = reject; }); void failure.catch(() => {});
  const abort = () => { lease.abort(); rejectLease(new GeneralFileError(persistAttempted ? 'outcome_uncertain' : 'rejected')); };
  options.signal.addEventListener('abort', abort, { once: true }); const timer = setTimeout(abort, remaining);
  const check = () => { if (lease.signal.aborted || options.signal.aborted || options.now() >= options.deadline()) throw new GeneralFileError(persistAttempted ? 'outcome_uncertain' : 'rejected'); };
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => { check(); const result = await Promise.race([operation(), failure]); check(); return result; };
  const admit = () => bounded(async () => { try { await options.admit(); } catch { throw new GeneralFileError('rejected'); } });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, response: Response | undefined;
  try {
    await admit();
    const intent = await bounded(() => generalDigest(JSON.stringify({ scope: options.scope, sourceUrl: options.sourceUrl, operation: 'public_http_file', maxBytes: options.maxBytes })));
    await bounded(async () => { try { await options.beforeFileCapture(intent, lease.signal); } catch { throw new GeneralFileError('rejected'); } }); await admit();
    let url = options.sourceUrl; const visited = new Set<string>();
    for (;;) {
      if (visited.has(url) || visited.size > GENERAL_BROWSER_REDIRECT_LIMIT) throw new GeneralFileError('rejected'); visited.add(url);
      const target = new URL(url); if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new GeneralFileError('rejected');
      await bounded(async () => { try { await options.authorize(url); } catch { throw new GeneralFileError('rejected'); } }); await admit();
      response = await bounded(async () => {
        const fetched = await options.fetch(url, { method: 'GET', redirect: 'manual', headers: { accept: '*/*' }, signal: lease.signal });
        if (lease.signal.aborted) { await fetched.body?.cancel(); throw new GeneralFileError('rejected'); } return fetched;
      });
      await admit();
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const next = response.headers.get('location'); await bounded(async () => { await response?.body?.cancel(); });
      if (!next) throw new GeneralFileError('file_unavailable', { status: response.status }); url = new URL(next, url).href;
    }
    if (response.status !== 200 || !response.body) throw new GeneralFileError('file_unavailable', { status: response.status });
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > options.maxBytes)) throw new GeneralFileError('file_oversize');
    const mime = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime)) throw new GeneralFileError('file_unavailable');
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let count = 0;
    for (;;) {
      const part = await bounded(() => reader!.read()); await admit(); if (part.done) break;
      count += part.value.byteLength; if (count > options.maxBytes) throw new GeneralFileError('file_oversize'); chunks.push(part.value);
    }
    if (!count || declared !== null && !response.headers.get('content-encoding') && count !== Number(declared)) throw new GeneralFileError('file_unavailable');
    const bytes = new Uint8Array(count); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const sha256 = await bounded(() => generalDigest(bytes)); await admit();
    options.onPersistAttempt?.(); persistAttempted = true;
    const meta = await bounded(() => options.persist({ ...options.scope, sourceUrl: url, observedSourceUrl: options.sourceUrl, transport: 'public_http', bytes, mime, sha256, provenance: 'provider_import', source_taint: 'external' }, lease.signal));
    await admit();
    if (!validId(meta.file_id) || !Number.isSafeInteger(meta.revision) || meta.revision < 1 || meta.sha256 !== sha256 || meta.byte_size !== count || meta.mime !== mime || meta.provenance !== 'provider_import' || meta.source_taint !== 'external' || meta.state !== 'ready') throw new GeneralFileError('outcome_uncertain'); validatePath(meta.path);
    const sourceRef = `file-source:${(await bounded(() => generalDigest(JSON.stringify({ scope: options.scope, observedUrl: options.sourceUrl, finalUrl: url, sha256 })))).slice(0, 24)}`; await admit();
    return { file: meta, source: { session_id: options.scope.sessionId, generation: options.scope.generation, observation_revision: options.scope.observationRevision, source_ref: sourceRef, transport: 'public_http' as const } };
  } catch (error) {
    if (error instanceof GeneralFileError && !persistAttempted) throw error;
    throw new GeneralFileError(persistAttempted ? 'outcome_uncertain' : 'file_unavailable', error instanceof GeneralFileError ? error.diagnostic : undefined);
  } finally {
    clearTimeout(timer); options.signal.removeEventListener('abort', abort); lease.abort();
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
}
