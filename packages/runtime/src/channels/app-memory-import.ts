import {
  APP_MEMORY_IMPORT_PATH_V1, appMemoryImportRequestV1Schema, appMemoryImportResultV1Schema,
  type AppMemoryImportResultV1, type AppMemoryImportSourceV1,
} from '../../../contracts/src/app/memory-import';
import type { DocImportCounts } from '../memory/doc-import';
import { bodyDigest, type RequestBook } from '../onboarding/request-book';

export type AppMemoryImportHost = Readonly<{
  // MEMORY_IMPORT_DOC: off, GET says unavailable and POST keeps nothing.
  on: boolean;
  requests: RequestBook;
  importDoc(source: AppMemoryImportSourceV1, text: string): Promise<DocImportCounts>;
}>;

const NO_STORE = { 'cache-control': 'no-store' };
const refuse = (error: 'invalid_request' | 'request_reused' | 'unavailable', status: number) => Response.json({ error }, { status, headers: NO_STORE });
const things = (count: number) => count === 1 ? '1 thing' : `${count} things`;

export const memoryImportResult = (counts: DocImportCounts): AppMemoryImportResultV1 => appMemoryImportResultV1Schema.parse({
  version: 1, state: counts.added ? 'imported' : 'nothing_new', ...counts,
  message: counts.added ? `Waldo kept ${things(counts.added)} from it. They show as "Waldo thinks" in What Waldo knows until you confirm them.`
    : counts.already_known ? 'Nothing new: Waldo already knew what this says.'
    : 'Waldo did not find anything in this to keep.',
});

// The owner object's half of the memory import. The model call runs in the owner's serial lane, as the welcome build's do, so
// a request sent twice reads the first one's answer instead of reading the summary again.
export const appMemoryImportRequest = async (request: Request, host: AppMemoryImportHost): Promise<Response> => {
  if (request.method === 'GET') return Response.json({ version: 1, available: host.on }, { headers: NO_STORE });
  if (request.method !== 'POST') return refuse('invalid_request', 405);
  if (!host.on) return refuse('unavailable', 503);
  let parsed: unknown;
  try { parsed = await request.json(); } catch { return refuse('invalid_request', 400); }
  const body = appMemoryImportRequestV1Schema.safeParse(parsed);
  if (!body.success) return refuse('invalid_request', 400);
  const digest = await bodyDigest(body.data);
  const seen = host.requests.find(APP_MEMORY_IMPORT_PATH_V1, body.data.request_id, digest);
  if (seen.kind === 'replay') return Response.json(seen.result, { headers: NO_STORE });
  if (seen.kind === 'reused') return refuse('request_reused', 409);
  let result: AppMemoryImportResultV1;
  try { result = memoryImportResult(await host.importDoc(body.data.source, body.data.text)); }
  catch (error) {
    // A fixed code only: the error may carry the summary's text.
    console.error(JSON.stringify({ hop: 'memory_import', ok: false, code: error instanceof SyntaxError ? 'reply_shape' : 'import_failed' }));
    return refuse('unavailable', 503);
  }
  host.requests.record(APP_MEMORY_IMPORT_PATH_V1, body.data.request_id, digest, result);
  return Response.json(result, { headers: NO_STORE });
};
