import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fetchWorkspace, readWorkspace, removeWorkspace, uploadWorkspace, workspaceDownloadLink, workspaceRemovalMessage, WorkspaceActionError, WorkspaceFiles, type UploadAttempt, type WorkspaceFile } from './Workspace';
const id = '11111111-1111-4111-8111-111111111111';
const next = '22222222-2222-4222-8222-222222222222';
const file: WorkspaceFile = { file_id: id, path: '<script>private.txt</script>', revision: 3, byte_size: 4, mime: 'text/plain', provenance: 'owner_upload', created_at: 1790884800000, updated_at: 1790884800000, state: 'ready' };
const wire = () => ({ version: 1, csrf: 'csrf-current', files: [file], next_cursor: next });
const attempt = (): UploadAttempt => ({ csrf: 'csrf-current', file: new File(['test'], 'private.txt', { type: 'text/plain' }), path: 'notes/private.txt', expected_revision: 2, operation_id: '33333333-3333-4333-8333-333333333333' });
afterEach(() => vi.unstubAllGlobals());
describe('private workspace read and presentation', () => {
  it('drops unrelated secret and internal metadata without inventing file readiness', () => {
    const read = readWorkspace({ ...wire(), owner: 'other', files: [{ ...file, sha256: 'private-hash', source_taint: 'external', blob_id: 'private-location' }] });
    expect(read.files[0]).toEqual(file);
    expect(JSON.stringify(read)).not.toContain('private-hash'); expect(JSON.stringify(read)).not.toContain('private-location');
    for (const invalid of [{ ...wire(), version: 2 }, { ...wire(), files: [{ ...file, state: 'purged' }] }, { ...wire(), next_cursor: 'invented-cursor' }, { ...wire(), files: [file, file] }]) expect(() => readWorkspace(invalid)).toThrow('unavailable');
  });
  it('renders escaped source-backed file metadata and exact revision download paths', () => {
    const html = renderToStaticMarkup(<WorkspaceFiles read={readWorkspace(wire())} busy={false} onRemove={() => {}}/>);
    expect(html).toContain('&lt;script&gt;private.txt&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('4 bytes · Revision 3 · text/plain'); expect(html).toContain('owner_upload');
    expect(html).toContain(`/console/workspace/file?id=${id}&amp;revision=3`);
    expect(html).toContain('separate from Telegram-hosted references'); expect(html).toContain('Sharing is unavailable');
    expect(workspaceDownloadLink(file)).toBe(`/console/workspace/file?id=${id}&revision=3`);
  });
  it('does not call an empty page proof of no retained bytes or offer a tombstoned download', () => {
    const empty = renderToStaticMarkup(<WorkspaceFiles read={{ ...readWorkspace(wire()), files: [] }} busy={false} onRemove={() => {}}/>);
    expect(empty).toContain('does not prove other pages or stores are empty'); expect(empty).not.toContain('No retained files');
    const tombstoned = renderToStaticMarkup(<WorkspaceFiles read={{ ...readWorkspace(wire()), files: [{ ...file, state: 'tombstoned' }] }} busy onRemove={() => {}}/>);
    expect(tombstoned).not.toContain('Download this revision'); expect(tombstoned).toContain('disabled=""');
  });
  it('uses provided pagination cursors, no-store JSON and abortable same-origin reads', async () => {
    const mock = vi.fn(async () => Response.json(wire())); vi.stubGlobal('fetch', mock);
    const signal = new AbortController().signal;
    await fetchWorkspace(next, signal);
    expect(mock).toHaveBeenCalledWith(`/console/workspace?cursor=${next}`, expect.objectContaining({ headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }));
    mock.mockResolvedValue(new Response('private failure', { status: 503 }));
    await expect(fetchWorkspace(null, signal)).rejects.toThrow('Namespace configuration, owner mapping or storage may be unavailable');
    mock.mockResolvedValue(new Response(null, { status: 401 })); await expect(fetchWorkspace(null, signal)).rejects.toThrow('Sign in');
  });
});
describe('durable upload operation continuity', () => {
  it('retains exact bytes, path, revision, CSRF and operation ID across a lost-response retry', async () => {
    const mock = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(Response.json({ file_id: id, revision: 3, byte_size: 4, sha256: 'discarded' })); vi.stubGlobal('fetch', mock);
    const saved = attempt();
    await expect(uploadWorkspace(saved)).rejects.toMatchObject({ uncertain: true });
    expect(await uploadWorkspace(saved)).toEqual({ file_id: id, revision: 3, byte_size: 4 });
    expect(mock).toHaveBeenCalledTimes(2);
    for (const [url, init] of mock.mock.calls as [string, RequestInit][]) {
      expect(url).toBe('/console/workspace/upload'); expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      const form = init.body as FormData;
      expect(form.get('operation_id')).toBe(saved.operation_id); expect(form.get('expected_revision')).toBe('2'); expect(form.get('path')).toBe(saved.path); expect(form.get('csrf')).toBe(saved.csrf);
      expect(await (form.get('file') as File).text()).toBe('test'); expect(form.has('owner')).toBe(false);
    }
  });
  it('rejects success-looking mismatched metadata as an unknown upload outcome', async () => {
    const mock = vi.fn(async () => Response.json({ file_id: id, revision: 4, byte_size: 4 })); vi.stubGlobal('fetch', mock);
    await expect(uploadWorkspace(attempt())).rejects.toMatchObject({ uncertain: true });
    mock.mockResolvedValue(Response.json({ file_id: id, revision: 3, byte_size: 99 }));
    await expect(uploadWorkspace(attempt())).rejects.toMatchObject({ uncertain: true });
  });
  it('distinguishes pending, permission uncertainty and quota rejection without rendering raw provider detail', async () => {
    const mock = vi.fn(async () => Response.json({ error: 'workspace_pending', detail: 'private-provider-secret' }, { status: 409 })); vi.stubGlobal('fetch', mock);
    await expect(uploadWorkspace(attempt())).rejects.toMatchObject({ uncertain: true });
    mock.mockResolvedValue(Response.json({ error: 'workspace_rejected', detail: 'private-provider-secret' }, { status: 403 }));
    await expect(uploadWorkspace(attempt())).rejects.toMatchObject({ uncertain: true });
    mock.mockResolvedValue(Response.json({ error: 'workspace_quota', detail: 'private-provider-secret' }, { status: 413 }));
    try { await uploadWorkspace(attempt()); throw new Error('expected refusal'); } catch (error) { expect(error).toBeInstanceOf(WorkspaceActionError); expect(error).toMatchObject({ uncertain: false }); expect(String(error)).not.toContain('private-provider-secret'); }
  });
});
describe('revision-bound file removal', () => {
  it('scopes purge receipts to inventoried workspace bodies and preserves partial-removal honesty', () => {
    expect(workspaceRemovalMessage('saved.txt', 'cleanup_pending')).toContain('Retained bytes are not yet certified purged');
    const purged = workspaceRemovalMessage('saved.txt', 'purged');
    expect(purged).toContain('inventoried bodies for saved.txt purged, including retained revisions');
    expect(purged).toContain('does not certify Telegram copies, exports or retained bytes outside this workspace');
  });
  it('keeps pending cleanup distinct from purged and retries exactly the saved removal target', async () => {
    const mock = vi.fn().mockResolvedValueOnce(Response.json({ status: 'cleanup_pending' })).mockResolvedValueOnce(Response.json({ status: 'purged' })); vi.stubGlobal('fetch', mock);
    const saved = { csrf: 'csrf-current', file };
    expect(await removeWorkspace(saved)).toEqual({ status: 'cleanup_pending' });
    expect(await removeWorkspace(saved)).toEqual({ status: 'purged' });
    for (const [url, init] of mock.mock.calls as [string, RequestInit][]) { expect(url).toBe('/console/workspace/remove'); const form = init.body as FormData; expect(form.get('file_id')).toBe(id); expect(form.get('revision')).toBe('3'); expect(form.get('csrf')).toBe(saved.csrf); }
  });
  it('does not treat an empty or generic success response as proof that bytes were purged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok' })));
    await expect(removeWorkspace({ csrf: 'csrf', file })).rejects.toMatchObject({ uncertain: true });
  });
});
