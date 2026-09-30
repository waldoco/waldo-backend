// Pure response helpers. Core must authenticate exact owner/revision, apply session/CSRF
// and pass already-admitted data. This module does not parse routes or grant file access.
import type { FileMeta } from '../../../workspace/src/store';
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox" };
export const workspaceDownload = (bytes: Uint8Array, meta: FileMeta): Response => {
  // MIME is metadata, not permission to run active content. Download as opaque bytes.
  const name = meta.path.split('/').at(-1) ?? 'file';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(bytes.slice().buffer, { headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength), 'content-disposition': `attachment; filename="file"; filename*=UTF-8''${encoded}` } });
};
export const workspacePage = (files: readonly FileMeta[]): Response => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace</title></head><body><h1>Private workspace</h1>${files.length ? `<ul>${files.map(f => `<li>${escape(f.path)} - ${f.byte_size} bytes, revision ${f.revision}</li>`).join('')}</ul>` : '<p>No retained files.</p>'}<p>Files are private. Upload, download and remove controls are unavailable until authenticated routes are connected.</p></body></html>`, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
