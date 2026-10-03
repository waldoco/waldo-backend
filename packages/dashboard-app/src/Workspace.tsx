import { useEffect, useRef, useState } from 'react';
import { SignInRequired } from './model';

export type WorkspaceFile = { file_id: string; path: string; revision: number; byte_size: number; mime: string; provenance: 'owner_upload' | 'agent_generated' | 'provider_import' | 'sandbox_output'; created_at: number; updated_at: number; state: 'ready' | 'tombstoned' };
export type WorkspaceRead = { version: 1; csrf: string; files: WorkspaceFile[]; next_cursor: string | null };
export type UploadAttempt = { csrf: string; file: File; path: string; expected_revision: number; operation_id: string };
export type RemoveAttempt = { csrf: string; file: WorkspaceFile };
export type UploadReceipt = { file_id: string; revision: number; byte_size: number };
export type RemoveReceipt = { status: 'cleanup_pending' | 'purged' };
const PATH = '/console/workspace';
const FILE_BYTES = 10 * 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const epoch = (v: unknown): v is number => count(v) && v <= 8_640_000_000_000_000;
const uuid = (v: unknown): v is string => text(v) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export class WorkspaceActionError extends Error {
  constructor(readonly uncertain: boolean, message: string) { super(message); }
}
const unavailable = () => new Error('Private workspace access is unavailable. Namespace configuration, owner mapping or storage may be unavailable; this read cannot identify which. Retry, or ask Waldo in chat.');
export function readWorkspace(raw: unknown): WorkspaceRead {
  if (!object(raw) || raw.version !== 1 || !text(raw.csrf) || !raw.csrf || !Array.isArray(raw.files) || !(raw.next_cursor === null || uuid(raw.next_cursor))) throw unavailable();
  const files = raw.files.map(row => {
    if (!object(row) || !uuid(row.file_id) || !text(row.path) || !count(row.revision) || row.revision < 1 || !count(row.byte_size) || !text(row.mime) || !['owner_upload', 'agent_generated', 'provider_import', 'sandbox_output'].includes(String(row.provenance)) || !epoch(row.created_at) || !epoch(row.updated_at) || !['ready', 'tombstoned'].includes(String(row.state))) throw unavailable();
    return { file_id: row.file_id, path: row.path, revision: row.revision, byte_size: row.byte_size, mime: row.mime, provenance: row.provenance as WorkspaceFile['provenance'], created_at: row.created_at, updated_at: row.updated_at, state: row.state as WorkspaceFile['state'] };
  });
  if (new Set(files.map(file => file.file_id)).size !== files.length) throw unavailable();
  return { version: 1, csrf: raw.csrf, files, next_cursor: raw.next_cursor };
}
export async function fetchWorkspace(cursor: string | null, signal: AbortSignal): Promise<WorkspaceRead> {
  const result = await fetch(`${PATH}${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`, { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
  if (result.status === 401) throw new SignInRequired();
  if (!result.ok) throw unavailable();
  try { return readWorkspace(await result.json()); } catch { throw unavailable(); }
}
export function workspaceDownloadLink(file: WorkspaceFile): string { return `${PATH}/file?${new URLSearchParams({ id: file.file_id, revision: String(file.revision) })}`; }
async function post(action: 'upload' | 'remove', form: FormData): Promise<unknown> {
  let result: Response;
  try { result = await fetch(`${PATH}/${action}`, { method: 'POST', body: form, headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error' }); }
  catch { throw new WorkspaceActionError(true, 'The workspace request outcome is unconfirmed. Keep this operation and check it before starting another.'); }
  if (result.status === 401) throw new SignInRequired();
  if (!result.ok) {
    let code: unknown; try { const body: unknown = await result.json(); if (object(body)) code = body.error; } catch { /* Status still identifies refusal versus an unknown result. */ }
    if (result.status === 503 || result.status === 403 || code === 'workspace_pending') throw new WorkspaceActionError(true, code === 'workspace_pending' ? 'The workspace operation is still pending. Retry the same operation after it settles; do not generate another upload ID.' : unavailable().message);
    throw new WorkspaceActionError(false, result.status === 409 ? 'The revision or operation conflicts with current workspace state. Refresh and review before changing it.' : result.status === 413 ? 'The workspace rejected the upload quota. A file may be at most 10 MiB; retained revisions also use workspace capacity.' : 'The workspace refused this request. Refresh and review its permissions and file revision.');
  }
  try { return await result.json(); } catch { throw new WorkspaceActionError(true, 'The workspace response is unreadable and the outcome is unconfirmed. Check the same operation.'); }
}
export async function uploadWorkspace(attempt: UploadAttempt): Promise<UploadReceipt> {
  const form = new FormData();
  form.set('csrf', attempt.csrf); form.set('file', attempt.file); form.set('path', attempt.path); form.set('expected_revision', String(attempt.expected_revision)); form.set('operation_id', attempt.operation_id);
  const raw = await post('upload', form);
  if (!object(raw) || !uuid(raw.file_id) || !count(raw.revision) || raw.revision !== attempt.expected_revision + 1 || !count(raw.byte_size) || raw.byte_size !== attempt.file.size) throw new WorkspaceActionError(true, 'Upload outcome is unconfirmed. Check the same upload operation.');
  return { file_id: raw.file_id, revision: raw.revision, byte_size: raw.byte_size };
}
export async function removeWorkspace(attempt: RemoveAttempt): Promise<RemoveReceipt> {
  const form = new FormData(); form.set('csrf', attempt.csrf); form.set('file_id', attempt.file.file_id); form.set('revision', String(attempt.file.revision));
  const raw = await post('remove', form);
  if (!object(raw) || !['cleanup_pending', 'purged'].includes(String(raw.status))) throw new WorkspaceActionError(true, 'Removal outcome is unconfirmed. Check this exact file revision before relying on deletion.');
  return { status: raw.status as RemoveReceipt['status'] };
}
export function workspaceRemovalMessage(path: string, status: RemoveReceipt['status']): string {
  return status === 'cleanup_pending' ? `Removal of ${path} is recorded, but workspace body cleanup is pending. Retained bytes are not yet certified purged. Retry cleanup with this same file revision.` : `The workspace reports its inventoried bodies for ${path} purged, including retained revisions. This does not certify Telegram copies, exports or retained bytes outside this workspace.`;
}
export function WorkspaceFiles({ read, busy, onRemove }: { read: WorkspaceRead; busy: boolean; onRemove: (file: WorkspaceFile) => void }) {
  return <section className="panel"><h2>Retained workspace files</h2><p>{read.files.length} files returned on this page. This is private workspace storage, separate from Telegram-hosted references.</p>{read.files.map(file => <article className="workspace-file activity-record" key={file.file_id}><h3>{file.path}</h3><p>{file.byte_size} bytes · Revision {file.revision} · {file.mime}</p><p className="muted">{file.provenance} · {file.state} · Updated {new Date(file.updated_at).toISOString()}</p><div className="control-actions">{file.state === 'ready' && <a className="button-link" href={workspaceDownloadLink(file)} download>Download this revision</a>}<button disabled={busy} onClick={() => { if (window.confirm(`Remove ${file.path} at revision ${file.revision}? The workspace will remove this file and its inventoried retained revisions. Cleanup may remain pending.`)) onRemove(file); }}>Remove {file.path}</button></div></article>)}{!read.files.length && <p>No files returned on this page. This does not prove other pages or stores are empty.</p>}<p className="muted">Sharing is unavailable. Saved file content remains external provenance; retaining it does not make it authoritative owner memory.</p></section>;
}
function WorkspaceUpload({ csrf, busy, locked, onUpload }: { csrf: string; busy: boolean; locked: boolean; onUpload: (attempt: UploadAttempt) => void }) {
  const [file, setFile] = useState<File | null>(null), [path, setPath] = useState(''), [revision, setRevision] = useState('0'), [error, setError] = useState<string | null>(null);
  return <section className="panel"><h2>Upload privately</h2><p>Choose a relative workspace path. Use revision 0 for a new file, or the exact current revision to replace one. Retained older revisions still consume storage. Keep this view open while an upload is pending; its exact retry copy is held only in this page.</p><form className="control-form" onSubmit={event => { event.preventDefault(); if (busy || locked || !file) return; if (file.size > FILE_BYTES || !Number.isSafeInteger(Number(revision)) || Number(revision) < 0) { setError('Choose a file up to 10 MiB and a nonnegative expected revision.'); return; } setError(null); onUpload({ csrf, file, path, expected_revision: Number(revision), operation_id: crypto.randomUUID() }); }}><label>File<input name="file" type="file" required disabled={busy || locked} onChange={event => { const chosen = event.currentTarget.files?.[0] ?? null; setFile(chosen); if (!path && chosen) setPath(chosen.name); }}/></label><label>Relative workspace path<input required maxLength={240} value={path} disabled={busy || locked} onChange={event => setPath(event.target.value)}/></label><label>Expected revision<input type="number" min="0" step="1" required value={revision} disabled={busy || locked} onChange={event => setRevision(event.target.value)}/></label><button disabled={busy || locked || !file}>Upload privately</button></form>{error && <p role="alert">{error}</p>}{locked && <p role="alert">An upload outcome is unresolved. Its file, path, revision and operation ID are retained in this page; use “Check same upload” before starting another. Leaving this page loses the retry copy.</p>}</section>;
}
export function WorkspacePanel() {
  const [read, setRead] = useState<WorkspaceRead | null>(null), [readError, setReadError] = useState<string | null>(null), [signedOut, setSignedOut] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null), [uncertain, setUncertain] = useState(false), [locked, setLocked] = useState(false);
  const upload = useRef<UploadAttempt | null>(null), removal = useRef<RemoveAttempt | null>(null), inFlight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const abort = new AbortController(); setRead(null); setReadError(null);
    fetchWorkspace(cursor, abort.signal).then(value => { if (!abort.signal.aborted) { setRead(value); setSignedOut(false); } }).catch(error => { if (!abort.signal.aborted) { setReadError(error instanceof SignInRequired ? 'Sign in to read your private workspace.' : unavailable().message); setSignedOut(error instanceof SignInRequired); } });
    return () => abort.abort();
  }, [cursor, refresh]);
  const run = async (kind: 'upload' | 'remove') => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setMessage(null);
    try {
      if (kind === 'upload' && upload.current) {
        const result = await uploadWorkspace(upload.current);
        if (!mounted.current) return;
        setMessage(`Upload recorded: ${upload.current.path}, revision ${result.revision}, ${result.byte_size} bytes. This receipt does not certify the file content as truth.`); upload.current = null; setLocked(false); setUncertain(false);
      } else if (kind === 'remove' && removal.current) {
        const result = await removeWorkspace(removal.current);
        if (!mounted.current) return;
        const path = removal.current.file.path;
        setMessage(workspaceRemovalMessage(path, result.status));
        setUncertain(result.status === 'cleanup_pending'); if (result.status === 'purged') removal.current = null;
      }
      setCursor(null); setRefresh(number => number + 1);
    } catch (error) {
      if (!mounted.current) return;
      const expired = error instanceof SignInRequired, unknown = !(error instanceof WorkspaceActionError) || error.uncertain || (kind === 'upload' && locked);
      setMessage(expired ? 'Sign in before inspecting this workspace request outcome.' : error instanceof WorkspaceActionError ? error.message : 'Workspace outcome unconfirmed. Check the same request before continuing.');
      setUncertain(unknown); setSignedOut(expired);
      if (kind === 'upload') { setLocked(unknown); if (!unknown) upload.current = null; }
      else if (!unknown) removal.current = null;
      if (expired) setRead(null);
      else setRefresh(number => number + 1);
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  return <><div className="controls-section-heading"><span className="eyebrow">Private retained storage</span><h2>Workspace files.</h2><p>Keep files with Waldo and inspect exact revisions. Telegram references remain a separate Files subview.</p></div>{message && <section className="panel control-receipt" role={uncertain ? 'alert' : 'status'}><p>{message}</p></section>}{!signedOut && upload.current && <button disabled={busy} onClick={() => void run('upload')}>Check same upload</button>}{!signedOut && removal.current && <button disabled={busy} onClick={() => void run('remove')}>Retry same file cleanup</button>}{readError && <section className="panel" role="alert"><h3>Workspace unavailable.</h3><p>{readError}</p>{signedOut ? <a href="/console/signin">Sign in</a> : <button disabled={busy} onClick={() => setRefresh(number => number + 1)}>Retry workspace read</button>}<p>Ask Waldo in your existing chat to inspect availability. No sharing or upload succeeded merely because this panel opened.</p></section>}{!read && !readError && <p role="status">Reading your private workspace…</p>}{read && !signedOut && <><WorkspaceFiles read={read} busy={busy || locked || !!removal.current} onRemove={file => { if (inFlight.current || locked || removal.current) return; removal.current = { csrf: read.csrf, file }; void run('remove'); }}/><WorkspaceUpload csrf={read.csrf} busy={busy || !!removal.current} locked={locked} onUpload={attempt => { if (inFlight.current || locked || removal.current) return; upload.current = attempt; void run('upload'); }}/><nav className="memory-pagination" aria-label="Private workspace file pages"><button disabled={busy || !cursor} onClick={() => setCursor(null)}>First page</button><button disabled={busy || !read.next_cursor} onClick={() => setCursor(read.next_cursor)}>Next files</button><button disabled={busy} onClick={() => setRefresh(number => number + 1)}>Refresh files</button></nav></>}</>;
}
