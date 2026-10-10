import { ownerByteCustody } from '../src/rights/write-custody';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { workspaceStore, r2Bodies, type OwnerBinding } from '@waldo/workspace';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { artifactBook, r2ArtifactBodies } from '../src/channels/artifacts';
import { artifactExports, r2ArtifactBinaries } from '../src/channels/artifact-exports';
import { workspaceMetadata } from '../src/channels/workspace-host';
import { buildOwnerRightsExport, saveOwnerRightsExport, readOwnerArtifactBinaries } from '../src/rights/export';
import { exportOwnerRuntime, rightsInventory } from '../src/rights/custody';

const bucket = (env as typeof env & { ARTIFACTS: R2Bucket }).ARTIFACTS;
const stub = () => env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`rights-export-${crypto.randomUUID()}`)) as DurableObjectStub<TelegramOwnerDO>;
it('exports and reopens actual owner workspace/artifact immutable revisions without security state', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    let live = true;
    const binding: OwnerBinding = { ownerId: crypto.randomUUID(), environment: 'test', namespace: 'owner', doName: 'synthetic-owner', doId: state.id.toString(), stateVersion: 1, mappingVersion: 1 };
    const admit = async () => ({ status: live ? 'ok' as const : 'rejected' as const });
    const bodies = await r2Bodies(bucket, binding, admit), metadata = workspaceMetadata(state.storage);
    const openWorkspace = () => workspaceStore({ binding, admit, metadata, bodies, now: Date.now, newId: () => crypto.randomUUID() });
    const store = await openWorkspace(), book = artifactBook(state.storage.sql, r2ArtifactBodies(bucket, state.id.toString(), ownerByteCustody(state.storage, async () => { if (!live) throw Error('revoked'); })), { timezone: 'UTC', now: () => new Date() }, () => crypto.randomUUID());
    const file = await store.write({ path: 'brief.md', expected_revision: 0, operation_id: crypto.randomUUID(), bytes: new TextEncoder().encode('first actual revision'), mime: 'text/markdown', provenance: 'owner_upload' });
    await store.write({ path: 'brief.md', expected_revision: 1, operation_id: crypto.randomUUID(), bytes: new TextEncoder().encode('second actual revision'), mime: 'text/markdown', provenance: 'owner_upload' });
    const artifactBodies = r2ArtifactBodies(bucket, state.id.toString(), ownerByteCustody(state.storage, async () => { if (!live) throw Error('revoked'); })), binaries = r2ArtifactBinaries(bucket, state.id.toString(), ownerByteCustody(state.storage, async () => { if (!live) throw Error('revoked'); }));
    const savedExports = artifactExports(state.storage.sql, book, artifactBodies, binaries, { timezone: 'UTC', now: () => new Date() }, () => crypto.randomUUID());
    const artifact = await book.create({ name: 'Working note', kind: 'document', body_markdown: 'first artifact revision' }, 'synthetic');
    await book.revise({ artifact_id: artifact.id, expected_revision: 1, body_markdown: 'second artifact revision' }, 'synthetic');
    expect((await savedExports.exportPdf({ artifact_id: artifact.id, expected_revision: 2, format: 'pdf' })).ok).toBe(true);
    state.storage.sql.exec('CREATE TABLE private_session_fixture(secret TEXT)'); state.storage.sql.exec('INSERT INTO private_session_fixture VALUES(?)','credential-must-not-export');
    const host = { accountRef: 'acct_synthetic', now: Date.now, assertCurrent: async () => { if (!live) throw Error('revoked'); }, inventory: await rightsInventory(), productState: async () => ({ product: exportOwnerRuntime(state.storage.sql), messages: [{ role: 'user', text: 'actual owner note' }] }), directoryMetadata: async () => ({ settings: { timezone: 'UTC' } }), openWorkspace: async () => openWorkspace(), artifacts: book, binaryArtifacts: () => readOwnerArtifactBinaries(state.storage.sql, binaries) };
    const bytes = await buildOwnerRightsExport(host), text = new TextDecoder().decode(bytes);
    expect(text).not.toContain('credential-must-not-export'); expect(text).not.toContain('r2_key');
    const document = JSON.parse(text) as { files: { file: { artifact_id: string; revision: number }; content: string }[]; artifacts: { revision: number; content: string }[]; binary_artifacts: { content: string }[]; exclusions: string[] };
    expect(document.files.map(f => f.file.artifact_id)).toEqual([file.file_id, file.file_id]); expect(document.files.map(f => f.file.revision)).toEqual([2,1]);
    expect(document.files.map(f => atob(f.content))).toEqual(['second actual revision','first actual revision']);
    expect(document.artifacts.map(a => a.content)).toEqual(['second artifact revision','first artifact revision']); expect(document.exclusions).toContain('raw_health_separate_authority');
    expect(document.binary_artifacts).toHaveLength(1); expect(atob(document.binary_artifacts[0]!.content).slice(0,5)).toBe('%PDF-');
    const exportReceiptId = crypto.randomUUID();
    const receipt = await saveOwnerRightsExport(store, exportReceiptId, bytes), reopened = await store.export(receipt.artifact_id, receipt.revision);
    expect(new TextDecoder().decode(reopened.bytes)).toBe(text); expect(reopened.meta.sha256).toBe(receipt.sha256);
    expect(await saveOwnerRightsExport(store, exportReceiptId, new TextEncoder().encode('new snapshot after uncertain save'))).toEqual(receipt);
    live = false; await expect(buildOwnerRightsExport(host)).rejects.toThrow('revoked');
  });
});
it('refuses a completed export when a retained artifact revision body is missing', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const book = artifactBook(state.storage.sql, { put: async () => {}, get: async () => null }, { timezone: 'UTC', now: () => new Date() }, () => crypto.randomUUID());
    await book.create({ name: 'Missing body', kind: 'document', body_markdown: 'saved without durable bytes' }, 'synthetic');
    await expect(buildOwnerRightsExport({ accountRef: 'acct_synthetic', now: Date.now, assertCurrent: async () => {}, inventory: await rightsInventory(), productState: async () => ({}), directoryMetadata: async () => ({}), openWorkspace: async () => ({ list: async () => ({ files: [], next_cursor: null }) }) as never, artifacts: book, binaryArtifacts: async () => [] })).rejects.toThrow('rights_unavailable');
  });
});
it('refuses truncated or overlong bytes at an immutable artifact revision', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    let content = '';
    const book = artifactBook(state.storage.sql, { put: async (_key, body) => { content = body; }, get: async () => content }, { timezone: 'UTC', now: () => new Date() }, () => crypto.randomUUID());
    await book.create({ name: 'Immutable source', kind: 'document', body_markdown: 'four' }, 'synthetic');
    const host = { accountRef: 'acct_synthetic', now: Date.now, assertCurrent: async () => {}, inventory: await rightsInventory(), productState: async () => ({}), directoryMetadata: async () => ({}), openWorkspace: async () => ({ list: async () => ({ files: [], next_cursor: null }) }) as never, artifacts: book, binaryArtifacts: async () => [] };
    content = 'fo'; await expect(buildOwnerRightsExport(host)).rejects.toThrow('rights_unavailable');
    content = 'four-extra'; await expect(buildOwnerRightsExport(host)).rejects.toThrow('rights_unavailable');
  });
});
