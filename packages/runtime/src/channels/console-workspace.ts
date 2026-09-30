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
export const workspacePage = (files: readonly FileMeta[], csrf: string, nextCursor: string | null): Response => {
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escape(value)}">`;
  const rows = files.map(f => `<li><span>${escape(f.path)} - ${f.byte_size} bytes, revision ${f.revision}</span> <a href="/console/workspace/file?id=${encodeURIComponent(f.file_id)}&amp;revision=${f.revision}">Download</a><form method="post" action="/console/workspace/remove">${hidden('file_id', f.file_id)}${hidden('revision', String(f.revision))}${hidden('csrf', csrf)}<button type="submit">Remove ${escape(f.path)}</button></form></li>`).join('');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace</title></head><body><h1>Private workspace</h1>${files.length ? `<ul>${rows}</ul>` : '<p>No retained files.</p>'}<h2>Upload a file</h2><form method="post" action="/console/workspace/upload" enctype="multipart/form-data">${hidden('csrf', csrf)}${hidden('operation_id', crypto.randomUUID())}<p><label>File <input type="file" name="file" required></label></p><p><label>Relative path <input name="path" maxlength="240" required></label></p><p><label>Expected revision (0 for a new file) <input type="number" name="expected_revision" min="0" value="0" required></label></p><button type="submit">Upload privately</button></form>${nextCursor ? `<p><a href="/console/workspace?cursor=${encodeURIComponent(nextCursor)}">Next files</a></p>` : ''}<p>Files stay private. Remove submits this exact revision for deletion; cleanup may still be pending.</p></body></html>`, { headers: { ...headers, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; form-action 'self'", 'content-type': 'text/html; charset=utf-8' } });
};
