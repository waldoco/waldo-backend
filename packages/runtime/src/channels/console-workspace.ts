// Pure response helpers. Core must authenticate exact owner/revision, apply session/CSRF
// and pass already-admitted data. This module does not parse routes or grant file access.
import type { FileMeta } from '../../../workspace/src/store';
import { pageHeading, resultCard, standalonePage } from './standalone-page';
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox" };
export const workspaceDownload = (bytes: Uint8Array, meta: FileMeta): Response => {
  // Preserve only these download types. All other metadata stays opaque; never inline.
  const mime = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/markdown', 'text/plain'].includes(meta.mime) ? meta.mime : 'application/octet-stream';
  const name = meta.path.split('/').at(-1) ?? 'file';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(bytes.slice().buffer, { headers: { ...headers, 'content-type': mime, 'content-length': String(bytes.byteLength), 'content-disposition': `attachment; filename="file"; filename*=UTF-8''${encoded}` } });
};
const size = (bytes: number) => bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB (${bytes} bytes)` : `${(bytes / 1024 / 1024).toFixed(1)} MB (${bytes} bytes)`;
// Styles ride a per-response nonce: the page still allows no scripts and no other style source.
const pageHeaders = (nonce: string) => ({ ...headers, 'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`, 'content-type': 'text/html; charset=utf-8' });
const filesLink = '<a class="button-link" href="/console/workspace">Back to private workspace</a>';
const backToFiles = { href: '/console/workspace', label: 'Back to private workspace' } as const;
export const workspacePage = (files: readonly FileMeta[], csrf: string, nextCursor: string | null): Response => {
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escape(value)}">`;
  const rows = files.map(f => `<li><div class="row-head"><h3>${escape(f.path)}</h3><span class="chip">Revision ${f.revision}</span></div><p class="meta">${escape(size(f.byte_size))}, revision ${f.revision}</p><div class="actions"><a class="button-link" href="/console/workspace/file?id=${encodeURIComponent(f.file_id)}&amp;revision=${f.revision}">Download</a><form method="post" action="/console/workspace/remove">${hidden('file_id', f.file_id)}${hidden('revision', String(f.revision))}${hidden('csrf', csrf)}<button type="submit" class="danger">Remove ${escape(f.path)}</button></form></div></li>`).join('');
  const list = `<section class="tile" aria-labelledby="files-heading"><h2 id="files-heading">Retained files <span class="count">${files.length}</span></h2>${files.length ? `<ul class="records">${rows}</ul>` : '<p class="empty">No retained files.</p>'}${nextCursor ? `<div class="actions"><a href="/console/workspace?cursor=${encodeURIComponent(nextCursor)}">Next files</a></div>` : ''}</section>`;
  const upload = `<section class="tile" aria-labelledby="upload-heading"><h2 id="upload-heading">Upload a file</h2><p>Use revision 0 for a new file, or the exact current revision to replace one. A file may be at most 10 MiB.</p><form method="post" action="/console/workspace/upload" enctype="multipart/form-data" class="stack">${hidden('csrf', csrf)}${hidden('operation_id', crypto.randomUUID())}<label>File <input type="file" name="file" required></label><label>Relative path <input name="path" maxlength="240" required aria-describedby="path-help"></label><p id="path-help" class="help">For example notes/plan.md. Uploading to an existing path needs that file's current revision.</p><label>Expected revision (0 for a new file) <input type="number" name="expected_revision" min="0" value="0" required></label><div class="actions"><button type="submit" class="primary">Upload privately</button></div></form></section>`;
  const nonce = crypto.randomUUID();
  return new Response(standalonePage({ title: 'Private workspace · Waldo', nonce, body: `${pageHeading('Private workspace', 'Files stay private. Remove submits this exact revision for deletion; cleanup may still be pending.', 'Files')}${list}${upload}` }), { headers: pageHeaders(nonce) });
};
type Outcome = Readonly<{ status: number; body: unknown }>;
const failureCopy = (code: string, status: number): { title: string; body: string; uncertain: boolean } => {
  if (code === 'workspace_pending') return { title: 'Still pending.', body: 'The workspace operation is still pending. Retry the same operation after it settles.', uncertain: true };
  if (status === 409) return { title: 'Revision conflict.', body: 'The revision or operation conflicts with current workspace state. Refresh and review before changing it.', uncertain: false };
  if (status === 413) return { title: 'Over the upload limit.', body: 'The workspace rejected the upload quota. A file may be at most 10 MiB; retained revisions also use workspace capacity.', uncertain: false };
  if (status === 404) return { title: 'File not found.', body: 'This exact file revision is not in your private workspace. It may have been replaced or removed.', uncertain: false };
  if (status === 503 || status === 403) return { title: 'Outcome unconfirmed.', body: 'Private workspace access is unavailable or the request was refused. The outcome may be unknown; check your files before trying again.', uncertain: true };
  return { title: 'Request refused.', body: 'The workspace refused this request. Refresh and review its permissions and file revision.', uncertain: false };
};
// Native form posts and direct links land here with the JSON outcome; API callers never do.
export const workspaceReceipt = (action: 'list' | 'upload' | 'remove' | 'download', outcome: Outcome): Response => {
  const body = (outcome.body && typeof outcome.body === 'object' ? outcome.body : {}) as Record<string, unknown>;
  let card: string;
  if (outcome.status >= 400 && (action === 'list' || action === 'download')) {
    const missing = outcome.status === 404;
    card = resultCard({ tone: 'negative', title: missing ? 'File not found.' : 'Private workspace unavailable.', body: missing ? '<p>This exact file revision is not in your private workspace. It may have been replaced or removed.</p>' : '<p>This read could not be completed. Nothing was changed. Try again shortly.</p>', actions: filesLink });
  } else if (outcome.status >= 400) {
    const copy = failureCopy(String(body.error ?? ''), outcome.status);
    card = resultCard({ tone: copy.uncertain ? 'neutral' : 'negative', alert: true, title: copy.title, body: `<p>${escape(copy.body)}</p>`, actions: filesLink });
  } else if (action === 'upload') {
    card = resultCard({ tone: 'positive', title: 'Upload saved.', body: `<p>Saved privately as revision ${escape(String(body.revision ?? ''))}, ${escape(size(Number(body.byte_size) || 0))}.</p>`, actions: filesLink });
  } else {
    const pending = body.status === 'cleanup_pending';
    card = resultCard({ tone: pending ? 'neutral' : 'positive', title: pending ? 'Removal recorded.' : 'Removed.', body: pending ? '<p>Removal is recorded, but workspace body cleanup is pending. Retained bytes are not yet certified purged. Retry cleanup with this same file revision.</p>' : '<p>The workspace reports its inventoried bodies purged, including retained revisions. This does not certify Telegram copies, exports or retained bytes outside this workspace.</p>', actions: filesLink });
  }
  const nonce = crypto.randomUUID();
  return new Response(standalonePage({ title: 'Private workspace · Waldo', layout: 'card', home: true, back: backToFiles, nonce, body: card }), { status: outcome.status, headers: pageHeaders(nonce) });
};

export const workspaceRead = (files: readonly FileMeta[], csrf: string, next_cursor: string | null): Response => Response.json({version:1,csrf,next_cursor,files:files.map(f=>({file_id:f.file_id,path:f.path,revision:f.revision,mime:f.mime,byte_size:f.byte_size,provenance:f.provenance,created_at:f.created_at,updated_at:f.updated_at,state:f.state}))},{headers:{...headers,'content-security-policy':"default-src 'none'; frame-ancestors 'none'"}});
