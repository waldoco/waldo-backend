// Download helper for exported PDF snapshots. Served by the owner DO at /console/exports/<id> behind the console session (the helper itself
// authenticates no one; the caller must have validated the session and scoped the store and bucket to that owner).
//
// This helper does NOT authenticate anyone. The caller must construct `exports` and `binaries`
// for ONE owner, and only after the console host has validated that owner's session and selected
// that owner's Durable Object (the same contract as artifactPage in artifact-delivery.ts). Isolation
// between owners comes from those per-owner stores; the helper only refuses to read outside them.
// Live creation and readback of exports through a route is unwired: until a reviewed route calls this,
// nothing serves an export. Snapshots have no expiry and stay downloadable if the source artifact
// moves to a newer revision; missing bytes are a 404.
import { artifactReadAdmission } from './artifact-delivery';
import type { ArtifactBinaries, ExportRow } from './artifact-exports';

export const ARTIFACT_EXPORT_PATH = '/console/exports';
// Matches the renderer's own ceiling with headroom. The cap bounds the store read itself (getBytes maxBytes),
// not only the response, so an oversized stored object is refused before its body is read.
export const ARTIFACT_EXPORT_MAX_BYTES = 5 * 1024 * 1024;
const EXPORT_ID = /^exp:[a-zA-Z0-9_-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FILENAME = 'artifact.pdf';

const baseHeaders = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
} as const;
// Fixed bodies only: never a key, id, digest, size or exception text.
const fail = (status: 404 | 405 | 503, body: 'not found' | 'method not allowed' | 'temporarily unavailable') =>
  new Response(body, { status, headers: { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' } });

export type ArtifactExportStore = Readonly<{ byId(id: string): ExportRow | null }>;
export type ArtifactExportDownloadDeps = Readonly<{
  exports: ArtifactExportStore;
  binaries: Pick<ArtifactBinaries, 'getBytes'>;
  limiter: RateLimit | undefined;
  ownerScope: string;
}>;

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

const validRow = (row: ExportRow): boolean =>
  row.format === 'pdf' && row.mime_type === 'application/pdf'
  && Number.isInteger(row.byte_size) && row.byte_size > 0 && row.byte_size <= ARTIFACT_EXPORT_MAX_BYTES
  && typeof row.sha256 === 'string' && SHA256.test(row.sha256)
  && typeof row.r2_key === 'string' && row.r2_key.length > 0;

// Magic-byte check only ("%PDF-" prefix). It is not PDF validation; integrity comes from the size and sha256 match.
const isPdf = (bytes: Uint8Array): boolean => bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;

// Returns null when the path is not an export path, so a host can fall through to other handlers.
export const artifactExportDownload = async (request: Request, deps: ArtifactExportDownloadDeps): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${ARTIFACT_EXPORT_PATH}/`)) return null;
  if (request.method !== 'GET') return fail(405, 'method not allowed');
  let id: string;
  try { id = decodeURIComponent(url.pathname.slice(ARTIFACT_EXPORT_PATH.length + 1)); } catch { return fail(404, 'not found'); }
  if (!EXPORT_ID.test(id)) return fail(404, 'not found');
  // Admission runs before any store access. Absent limiter is 503, denied is 429 (artifactReadAdmission).
  const denied = await artifactReadAdmission(deps.limiter, deps.ownerScope);
  if (denied !== null) return denied;
  let row: ExportRow | null;
  try { row = deps.exports.byId(id); } catch { return fail(503, 'temporarily unavailable'); }
  if (row === null) return fail(404, 'not found');
  if (!validRow(row)) return fail(503, 'temporarily unavailable');
  let bytes: Uint8Array | null;
  try { bytes = await deps.binaries.getBytes(row.r2_key, ARTIFACT_EXPORT_MAX_BYTES); } catch { return fail(503, 'temporarily unavailable'); }
  if (bytes === null) return fail(404, 'not found');
  if (bytes.length > ARTIFACT_EXPORT_MAX_BYTES || bytes.length !== row.byte_size || !isPdf(bytes)) return fail(503, 'temporarily unavailable');
  let digest: string;
  try { digest = await sha256Hex(bytes); } catch { return fail(503, 'temporarily unavailable'); }
  if (digest !== row.sha256) return fail(503, 'temporarily unavailable');
  return new Response(bytes, {
    status: 200,
    headers: {
      ...baseHeaders,
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${FILENAME}"`,
      'content-length': String(bytes.length),
    },
  });
};

// The owner-authenticated download URL for a stored export. Same origin rules as artifactDelivery: https, a bare origin, no credentials.
export const exportDownloadUrl = (base: string | null, exportId: string): string | null => {
  if (!base || !EXPORT_ID.test(exportId)) return null;
  let url: URL; try { url = new URL(base); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== base || url.username || url.password) return null;
  return `${base}${ARTIFACT_EXPORT_PATH}/${encodeURIComponent(exportId)}`;
};
