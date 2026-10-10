import { ownerByteCustody } from '../src/rights/write-custody';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { workspaceStore, r2Bodies, type OwnerBinding } from '@waldo/workspace';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { appArtifactsRequest, type AppArtifactsDeps } from '../src/channels/app-artifacts';
import { artifactBook, r2ArtifactBodies } from '../src/channels/artifacts';
import { workspaceMetadata } from '../src/channels/workspace-host';
import { appFileResultV1Schema } from '../../contracts/src/app/artifacts';

const bucket = (env as typeof env & { ARTIFACTS: R2Bucket }).ARTIFACTS;
const stub = () => env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`app-artifacts-${crypto.randomUUID()}`)) as DurableObjectStub<TelegramOwnerDO>;
const request = (path: string, body?: object) => new Request(`https://fixture.invalid/app/v1/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
const fixture = async (state: DurableObjectState) => {
  let active = true;
  const binding: OwnerBinding = { ownerId: crypto.randomUUID(), environment: 'test', namespace: 'owner', doName: 'synthetic-owner', doId: state.id.toString(), stateVersion: 1, mappingVersion: 1 };
  const admit = async () => ({ status: active ? 'ok' as const : 'rejected' as const });
  const bodies = await r2Bodies(bucket, binding, admit);
  const openWorkspace = () => workspaceStore({ binding, admit, metadata: workspaceMetadata(state.storage), bodies, now: Date.now, newId: () => crypto.randomUUID() });
  const deps: AppArtifactsDeps = { openWorkspace, book: artifactBook(state.storage.sql, r2ArtifactBodies(bucket, state.id.toString(), ownerByteCustody(state.storage, async () => { if (!active) throw Error('revoked'); })), { timezone: 'UTC', now: () => new Date() }, () => crypto.randomUUID()), operationScope: state.id.toString(), assertCurrent: async () => { if (!active) throw Error('revoked'); }, origin: async () => 'https://fixture.invalid', uploadLease: async () => ({ assert() {}, release() {} }) };
  return { deps, revoke: () => { active = false; } };
};

it('serves one durable file identity through create, revise, history, search, native DOCX export and exact binary reopen', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const f = await fixture(state), send = (req: Request) => appArtifactsRequest(req, f.deps);
    const write = { path: 'brief.md', expected_revision: 0, text: '# Brief\nनमस्ते café\nSaved original', mime: 'text/markdown', operation_id: crypto.randomUUID() };
    const saved = await send(request('files/write', write)); expect(saved?.status).toBe(200);
    const first = appFileResultV1Schema.parse(await saved!.json());
    const id = first.file.artifact_id;
    expect(first.delivery?.audience).toBe('owner_authenticated');
    const revised = appFileResultV1Schema.parse(await (await send(request('files/write', { ...write, expected_revision: 1, text: '# Revised\nनमस्ते café\nNew facts', operation_id: crypto.randomUUID() })))!.json());
    expect(revised.file.artifact_id).toBe(id); expect(revised.file.revision).toBe(2);
    const pinned = await send(request(`files/${id}/content?revision=1`)); expect(await pinned!.text()).toContain('Saved original');
    expect(await (await send(request(`files/${id}/revisions`)))!.json()).toMatchObject({ revisions: [{ revision: 2 }, { revision: 1 }] });
    expect(await (await send(request('files/search?query=New%20facts')))!.json()).toMatchObject({ hits: [{ file_id: id, revision: 2 }] });
    const render = { source_revision: 2, path: 'exports/brief.docx', expected_revision: 0, format: 'docx', operation_id: crypto.randomUUID() };
    const exportedResponse = await send(request(`files/${id}/render`, render)); expect(exportedResponse?.status).toBe(200);
    const exported = appFileResultV1Schema.parse(await exportedResponse!.json());
    const binary = await send(request(`files/${exported.file.artifact_id}/content?revision=1`));
    const bytes = await binary!.arrayBuffer(), zip = await JSZip.loadAsync(bytes);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('नमस्ते café');
    expect(binary?.headers.get('content-type')).toContain('wordprocessingml');
    const retry = appFileResultV1Schema.parse(await (await send(request(`files/${id}/render`, render)))!.json());
    expect(retry.file).toEqual(exported.file);
    expect((await send(request(`files/${id}/render`, { ...render, source_revision: 1 })))?.status).toBe(409);
    expect((await send(request('files/write', { ...write, operation_id: crypto.randomUUID(), owner_id: crypto.randomUUID() })))?.status).toBe(400);
    expect((await send(request(`files/${id}/remove`, { expected_revision: 1 })))?.status).toBe(409);
    expect(await (await send(request(`files/${id}/remove`, { expected_revision: 2 })))!.json()).toEqual({ status: 'purged' });
    expect((await send(request(`files/${id}/content?revision=1`)))?.status).toBe(404);
  });
});

it('exports exact saved working artifact revision into owner workspace and withholds data after session revocation', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const f = await fixture(state), book = f.deps.book;
    const meta = await book.create({ name: 'Research', kind: 'research', body_markdown: '# Original\nSource-backed detail' }, 'test');
    await book.revise({ artifact_id: meta.id, expected_revision: 1, body_markdown: '# Later\nChanged detail' }, 'test');
    const exportArgs = { source_revision: 1, path: 'research.md', expected_revision: 0, format: 'markdown', operation_id: crypto.randomUUID() };
    const result = await appArtifactsRequest(request(`artifacts/${encodeURIComponent(meta.id)}/export`, exportArgs), f.deps);
    expect(result?.status).toBe(200);
    const file = appFileResultV1Schema.parse(await result!.json()).file;
    const reopened = await appArtifactsRequest(request(`files/${file.artifact_id}/content?revision=1`), f.deps);
    expect(await reopened!.text()).toContain('Source-backed detail');
    f.revoke();
    const withheld = await appArtifactsRequest(request(`artifacts/${encodeURIComponent(meta.id)}?revision=1`), f.deps);
    expect(withheld?.status).toBe(503); expect(await withheld!.text()).not.toContain('Source-backed detail');
  });
});

it('scopes retained file ids to the selected owner even when another owner supplies the exact id', async () => {
  const id = await runInDurableObject(stub(), async (_instance, state) => {
    const f = await fixture(state), out = await appArtifactsRequest(request('files/write', { path: 'private.txt', text: 'Owner A', mime: 'text/plain', expected_revision: 0, operation_id: crypto.randomUUID() }), f.deps);
    return appFileResultV1Schema.parse(await out!.json()).file.artifact_id;
  });
  await runInDurableObject(stub(), async (_instance, state) => {
    const f = await fixture(state), out = await appArtifactsRequest(request(`files/${id}/content?revision=1`), f.deps);
    expect(out?.status).toBe(404); expect(await out!.text()).not.toContain('Owner A');
  });
});

it('retains bounded owner multipart attachments, deduplicates exact retries and rejects changed or ambiguous uploads', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const f = await fixture(state), operation = crypto.randomUUID();
    const upload = (text = 'Retained attachment', extras?: Record<string, string>) => {
      const form = new FormData();
      form.set('file', new File([text], 'attachment.txt', { type: 'text/plain' }));
      form.set('path', 'attachments/attachment.txt'); form.set('expected_revision', '0'); form.set('operation_id', operation);
      for (const [key, value] of Object.entries(extras ?? {})) form.append(key, value);
      return new Request('https://fixture.invalid/app/v1/files', { method: 'POST', body: form });
    };
    const saved = await appArtifactsRequest(upload(), f.deps); expect(saved?.status).toBe(200);
    const file = appFileResultV1Schema.parse(await saved!.json()).file;
    expect(appFileResultV1Schema.parse(await (await appArtifactsRequest(upload(), f.deps))!.json()).file).toEqual(file);
    expect((await appArtifactsRequest(upload('Changed bytes'), f.deps))?.status).toBe(409);
    expect((await appArtifactsRequest(upload(undefined, { expected_revision: '1' }), f.deps))?.status).toBe(400);
    expect((await appArtifactsRequest(upload(undefined, { owner_id: crypto.randomUUID() }), f.deps))?.status).toBe(400);
    const tooLarge = new Request('https://fixture.invalid/app/v1/files', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=test', 'content-length': String(11 * 1024 * 1024) }, body: 'small' });
    expect((await appArtifactsRequest(tooLarge, f.deps))?.status).toBe(413);
    const opened = await appArtifactsRequest(request(`files/${file.artifact_id}/content?revision=1`), f.deps);
    expect(await opened!.text()).toBe('Retained attachment');
  });
});
