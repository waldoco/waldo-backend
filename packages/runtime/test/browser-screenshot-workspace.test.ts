import { expect, it } from 'vitest';
import { workspaceStore, type WorkspaceState } from '@waldo/workspace';
import { browserScreenshotToWorkspace } from '../src/channels/browser-screenshot-workspace';

const png = () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
async function fixture(corrupt = false) {
  const state: WorkspaceState = { binding: null, files: [], bodies: [], operations: [] }, bodies = new Map<string, Uint8Array>();
  const workspace = await workspaceStore({ binding: { ownerId: '12345678-1234-1234-1234-123456789abc', environment: 'staging', namespace: 'fixture', doName: 'owner', doId: 'physical', stateVersion: 1, mappingVersion: 1 },
    admit: async () => ({ status: 'ok' }), metadata: { transaction: work => work(state) }, bodies: {
      put: async (meta, bytes) => { bodies.set(meta.blob_id, bytes.slice()); }, get: async meta => corrupt ? new Uint8Array([0]) : bodies.get(meta.blob_id) ?? null, remove: async () => {},
    }, now: Date.now, newId: () => crypto.randomUUID() });
  return { state, workspace, options: { image: png(), maxScreenshotBytes: 64, workspace, operationId: crypto.randomUUID(), origin: 'https://owner.invalid', deadline: Date.now() + 60000, now: Date.now, assertCurrent: async () => {} } };
}
it('persists native screenshot bytes under owner custody and verifies exact retrieval', async () => {
  const f = await fixture(), receipt = await browserScreenshotToWorkspace(f.options);
  expect(receipt).toMatchObject({ audience: 'owner_authenticated', retrieval: 'verified', provenance: 'provider_import', byte_size: 8 });
  expect(new URL(receipt.url).origin).toBe('https://owner.invalid');
  expect((await f.workspace.export(receipt.file_id, receipt.revision)).bytes).toEqual(png());
  expect(f.state.files[0]?.path).toBe(`browser-screenshots/${f.options.operationId}/page.png`);
});
it.each(['authority', 'image_cap', 'invalid_png', 'origin'] as const)('screenshot %s refuses persistence', async mode => {
  const f = await fixture();
  await expect(browserScreenshotToWorkspace({ ...f.options,
    ...(mode === 'authority' ? { assertCurrent: async () => { throw Error('owner changed'); } } : {}),
    ...(mode === 'image_cap' ? { maxScreenshotBytes: 1 } : {}), ...(mode === 'invalid_png' ? { image: new Uint8Array([1]) } : {}),
    ...(mode === 'origin' ? { origin: 'https://owner.invalid/foreign' } : {}),
  })).rejects.toThrow('browser_screenshot_');
  expect(f.state.files).toHaveLength(0);
});
it('corrupt screenshot readback has no verified receipt', async () => {
  const f = await fixture(true);
  await expect(browserScreenshotToWorkspace(f.options)).rejects.toThrow('browser_screenshot_');
});
it('stalled screenshot authority settles at the actual task deadline without persistence', async () => {
  const f = await fixture();
  await expect(browserScreenshotToWorkspace({ ...f.options, deadline: Date.now() + 20, assertCurrent: () => new Promise<void>(() => {}) })).rejects.toThrow('browser_screenshot_unavailable');
  expect(f.state.files).toHaveLength(0);
});
